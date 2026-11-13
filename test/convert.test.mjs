import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, isPlainModule, parse } from "../src/convert.mjs";
import { resolveSpecifier, build, packageManifest, removeDir } from "../src/build.mjs";
import { analyseAutoconfig, thirdpartyWrapper, origEnvelope, globalizeSloppyThis, addRegistration, libraryManifest, shimConfigOf } from "../src/legacy.mjs";
import { findThemes, themeFiles, buildThemes } from "../src/themes.mjs";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (f) => fs.readFileSync(path.join(FIX, f), "utf8");
const spec = (d) => (d.startsWith(".") ? d : "/" + d) + ".js";

// fixture -> warnings expected (substring match, in order)
const CASES = {
	"define-deps-return": [],
	"define-unused-deps": [],
	"no-return": [],
	"bare-return": [],
	"paren-return": [],
	"arrow-expression": [],
	"module-name": [],
	"use-strict": [],
	"template-literal": [],
	"require-async": [],
	"nested-require": [],
	"sync-require": ['line 8: sap.ui.requireSync("sap/ui/core/Lib") converted to a static import'],
	"require-nonliteral": ["line 4: left sap.ui.require(...) as is (non-literal dependency list)", "sap.ui.require still present"],
	"require-only": [],
	"require-dependency": [],
	// fallbacks: the factory is kept as a function, called with the imports
	"factory-nested-return": ["factory kept as a function (return statement nested"],
	"factory-destructured-param": ["factory kept as a function (factory has non-identifier parameters)"],
	"factory-extra-params": ["factory kept as a function (factory has more parameters than dependencies)"],
	"factory-commonjs": ['factory kept as a function (CommonJS dependency "exports")'],
	"factory-this": [],
	"nested-define": ["line 8: sap.ui.define is not a top-level statement; its result is exported"],
	// probe mode (used by the build): sync require stays a runtime call
	"probe-require": ["sap.ui.requireSync still present"],
	// a reassigned parameter cannot be an import binding (read-only)
	"reassigned-param": [],
};
const optionsFor = (name) => (name.startsWith("probe-") ? { syncRequire: "probe" } : {});

describe("convert: fixtures", () => {
	for (const [name, expectedWarnings] of Object.entries(CASES)) {
		test(name, () => {
			const result = convert(read(`${name}.in.js`), spec, optionsFor(name));
			assert.ok(result, "expected a conversion result");
			assert.equal(result.code, read(`${name}.out.js`));
			assert.equal(result.warnings.length, expectedWarnings.length, JSON.stringify(result.warnings));
			expectedWarnings.forEach((w, i) => assert.ok(result.warnings[i].includes(w), `${result.warnings[i]} should contain ${w}`));
			parse(result.code, "module");
		});
	}
});

describe("convert: details", () => {
	test("unused deps become side-effect imports", () => {
		const { code } = convert(read("define-unused-deps.in.js"), spec);
		assert.match(code, /^import "\/sap\/ui\/core\/Core\.js";$/m);
	});
	test("no return / bare return export undefined", () => {
		assert.match(convert(read("no-return.in.js"), spec).code, /export default undefined;\s*$/);
		const bare = convert(read("bare-return.in.js"), spec).code;
		assert.match(bare, /export default undefined;\s*$/);
		assert.doesNotMatch(bare, /return/);
	});
	test("use strict removed only at factory level", () => {
		const { code } = convert(read("use-strict.in.js"), spec);
		assert.equal(code.match(/"use strict"/g).length, 1);
		assert.match(code, /^function helper/);
	});
	test("template literal lines keep their indentation", () => {
		const { code } = convert(read("template-literal.in.js"), spec);
		assert.ok(code.includes("<div>\n\t<span>kept as is</span>\n\t\t</div>`"));
		assert.match(code, /^if \(sHtml\) \{\n\tsHtml/m);
	});
	test("sync require is hoisted and deduped", () => {
		const { code } = convert(read("sync-require.in.js"), spec);
		assert.equal(code.match(/import _sap_ui_Device from/g).length, 1);
		assert.doesNotMatch(code, /sap\.ui\.require/);
	});
	test("a file without loader calls returns null", () => {
		assert.equal(convert("var x = 1;\n", spec), null);
	});
	test("an existing ES module is detected and left alone", () => {
		const src = read("es-module.in.js");
		assert.equal(isPlainModule(src), true);
		assert.equal(convert(src, spec), null);
		assert.equal(isPlainModule(read("define-deps-return.in.js")), false);
		assert.equal(isPlainModule('import x from "./x.js";\nsap.ui.require(["a"]);\n'), false);
	});
	test("throws: multiple defines", () => {
		assert.throws(() => convert(read("throws/multiple-defines.js"), spec), /multiple sap\.ui\.define/);
	});
	test("kept factories behave like the AMD factory (this === globalThis, args in order)", async () => {
		for (const name of ["factory-nested-return", "factory-extra-params", "factory-destructured-param"]) {
			const { code } = convert(read(`${name}.in.js`), spec);
			assert.match(code, /\.call\(globalThis/);
		}
		const { code } = convert(read("factory-nested-return.in.js"), spec);
		const url = "data:text/javascript," + encodeURIComponent(code);
		globalThis.done = true;
		assert.equal((await import(url)).default, 1);
		delete globalThis.done;
	});
	test("factory-level this becomes globalThis, nested this is kept", () => {
		const { code } = convert(read("factory-this.in.js"), spec);
		assert.match(code, /getMonths\.call\(globalThis\)/);
		assert.match(code, /return this; \/\/ the Util object/);
		assert.match(code, /return this === globalThis/);
	});
	test("probe mode keeps sync require calls", () => {
		const { code } = convert(read("probe-require.in.js"), spec, { syncRequire: "probe" });
		assert.match(code, /sap\.ui\.require\("sap\/ui\/core\/Core"\)/);
		assert.doesNotMatch(code, /^import _sap/m);
	});
	test("require with too many callback params is left as is", () => {
		const r = convert('sap.ui.require(["a/b"], function(A, B) {});\n', spec);
		assert.match(r.warnings[0], /more parameters than dependencies/);
		assert.match(r.code, /sap\.ui\.require\(\["a\/b"\]/);
	});
});

describe("resolveSpecifier", () => {
	const roots = new Set(["sap", "jquery.sap.global"]);
	test("sibling", () => {
		assert.deepEqual(resolveSpecifier("sap/m/Button.js", "./Text", roots), { specifier: "./Text.js", target: "sap/m/Text.js", external: false });
	});
	test("parent", () => {
		assert.equal(resolveSpecifier("sap/m/upload/X.js", "../library", roots).specifier, "../library.js");
	});
	test("aliases and module names with .css", () => {
		assert.equal(resolveSpecifier("sap/m/a.js", "jquery", roots, { jquery: "sap/ui/thirdparty/jquery" }).specifier, "../ui/thirdparty/jquery.js");
		assert.equal(resolveSpecifier("sap/f/thirdparty/A.js", "./x.css", roots, {}, (t) => t === "sap/f/thirdparty/x.css.js").specifier, "./x.css.js");
		assert.equal(resolveSpecifier("sap/f/thirdparty/A.js", "./y.css", roots, {}, () => false).specifier, "./y.css");
	});
	test("namespace (root-relative)", () => {
		assert.deepEqual(resolveSpecifier("sap/m/Button.js", "sap/ui/core/Control", roots), {
			specifier: "../ui/core/Control.js", target: "sap/ui/core/Control.js", external: false,
		});
		assert.equal(resolveSpecifier("sap/m/Button.js", "sap/m/Text", roots).specifier, "./Text.js");
		assert.equal(resolveSpecifier("sap/m/a.js", "jquery.sap.global", roots).specifier, "../../jquery.sap.global.js");
	});
	test("keeps known extensions", () => {
		assert.equal(resolveSpecifier("sap/m/a.js", "sap/m/data.json", roots).specifier, "./data.json");
	});
	test("external", () => {
		assert.deepEqual(resolveSpecifier("sap/m/Button.js", "lodash/merge", roots), { specifier: "lodash/merge", target: null, external: true });
		assert.equal(resolveSpecifier("sap/a.js", "../../outside", roots).external, true);
	});
	test("loader plugin", () => {
		assert.deepEqual(resolveSpecifier("sap/m/a.js", "sap/ui/text!./x.txt", roots), { specifier: "sap/ui/text!./x.txt", target: null, external: true });
	});
	test("runtime (outside the esm tree, in dist/runtime)", () => {
		assert.deepEqual(resolveSpecifier("sap/m/a.js", "esm-ui5-runtime", roots), {
			specifier: "../../../runtime/esm-ui5-runtime.js", target: "../runtime/esm-ui5-runtime.js", external: false,
		});
		assert.equal(resolveSpecifier("x.js", "esm-ui5-runtime", roots).specifier, "../runtime/esm-ui5-runtime.js");
	});
});

describe("legacy helpers", () => {
	const autoconfig = `(function() {
	"use strict";
	var ui5loader = globalThis.sap && sap.ui.loader;
	function helper() { return ui5loader ? 1 : 0; }
	function _setupConfiguration() {
		var BaseConfiguration = sap.ui.require("my/_Config");
		BaseConfiguration.registerProvider(sap.ui.require("my/Provider"));
	}
	define("my/Provider", [], function() { return { name: "provider" }; });
	define("my/_Config", [], function() { return { registerProvider: function() {} , h: helper() }; });
	ui5loader.config({ map: { "*": { jquery: "sap/ui/thirdparty/jquery" } }, shim: { "x/old": { exports: "Old", deps: ["x/dep"] } } });
}());`;
	test("analyseAutoconfig extracts inline modules, shim and map", () => {
		const info = analyseAutoconfig(autoconfig);
		assert.deepEqual([...info.modules.keys()], ["my/Provider", "my/_Config"]);
		const cfg = info.modules.get("my/_Config");
		assert.match(cfg, /var ui5loader = globalThis\.sap\.ui\.loader;/);
		assert.match(cfg, /function helper\(\)/);
		assert.match(cfg, /sap\.ui\.define\(\["my\/Provider"\], function\(__p0\)/);
		assert.match(cfg, /Configuration\.registerProvider\(__p0\)/);
		assert.deepEqual(info.shim, { "x/old": { exports: "Old", deps: ["x/dep"] } });
		assert.deepEqual(info.map, { jquery: "sap/ui/thirdparty/jquery" });
		for (const src of info.modules.values()) assert.ok(convert(src, spec));
	});
	test("shimConfigOf reads sap.ui.loader.config calls", () => {
		assert.deepEqual(shimConfigOf('sap.ui.loader.config({ shim: { "a/b": { exports: "B" } } }); sap.ui.define([], function() {});'), { "a/b": { exports: "B" } });
		assert.deepEqual(shimConfigOf("var x = 1;"), {});
	});
	test("thirdpartyWrapper", () => {
		assert.equal(thirdpartyWrapper({ origFile: "jquery.orig.js", global: "jQuery" }),
			'import "./jquery.orig.js";\nexport default globalThis["jQuery"];\n');
		const code = thirdpartyWrapper({ origFile: "mobile.orig.js", global: "jQuery.mobile", depSpecs: ["./jquery.js"] });
		assert.equal(code, 'import "./jquery.js";\nimport "./mobile.orig.js";\nexport default globalThis["jQuery"]?.["mobile"];\n');
		assert.equal(thirdpartyWrapper({ origFile: "x.orig.js", global: null }), 'import "./x.orig.js";\nexport default undefined;\n');
		parse(code, "module");
	});
	test("origEnvelope: global this, shadowed CommonJS/AMD names, published global", async () => {
		const src = "(function (root, factory) {\n  if (typeof module === 'object') module.exports = factory();\n  else root.Lib = factory();\n}(this, function () { return { v: 1 }; }));\nvar helper = 2;";
		const env = origEnvelope(src, "helper");
		parse(env, "module");
		assert.match(env, /\(function \(module, exports, define, require\) \{/);
		assert.match(env, /\}\(globalThis, function/);
		delete globalThis.Lib;
		delete globalThis.helper;
		await import("data:text/javascript," + encodeURIComponent(env));
		assert.deepEqual(globalThis.Lib, { v: 1 });
		assert.equal(globalThis.helper, 2);
		delete globalThis.Lib;
		delete globalThis.helper;
	});
	test("globalizeSloppyThis: only where sloppy this is the global object", () => {
		assert.equal(
			globalizeSloppyThis("var a=this;(function(r){var b=this;o={f:function(){return this}};(function(x){})(1,this);g.call(this)})(this);function F(){this.x=1}"),
			"var a=globalThis;(function(r){var b=globalThis;o={f:function(){return this}};(function(x){})(1,globalThis);g.call(globalThis)})(globalThis);function F(){this.x=1}"
		);
		assert.equal(globalizeSloppyThis("f(function(){ (function(a,w){})(jQuery,this); o.m(this); })"), "f(function(){ (function(a,w){})(jQuery,globalThis); o.m(this); })");
	});
	test("addRegistration keeps the header comment first", () => {
		const code = addRegistration("/*!\n * (c)\n */\nimport A from \"./A.js\";\n\nexport default A;\n", "sap/x/Y", "../../rt.js", "./Y.js");
		assert.equal(code, '/*!\n * (c)\n */\n/* Modified by esm-ui5: converted from the OpenUI5 AMD source to an ES module. */\nimport { _register as __ui5_register } from "../../rt.js";\nimport * as __ui5_self from "./Y.js";\nimport A from "./A.js";\n\nexport default A;\n\n__ui5_register("sap/x/Y", __ui5_self);\n');
	});
	test("libraryManifest", () => {
		const xml = "<library><name>sap.x</name><version>1.2.3</version><documentation>X lib</documentation><dependencies><dependency><libraryName>sap.ui.core</libraryName></dependency><dependency><libraryName>sap.m</libraryName><lazy>true</lazy></dependency></dependencies></library>";
		const m = libraryManifest(xml, ["messagebundle.properties", "messagebundle_de.properties", "library.js"]);
		assert.equal(m["sap.app"].id, "sap.x");
		assert.equal(m["sap.app"].applicationVersion.version, "1.2.3");
		assert.deepEqual(m["sap.ui5"].dependencies.libs, { "sap.ui.core": {}, "sap.m": { lazy: true } });
		assert.deepEqual(m["sap.ui5"].library.i18n, { bundleUrl: "messagebundle.properties", supportedLocales: ["", "de"] });
		assert.equal(libraryManifest(xml, [])["sap.ui5"].library.i18n, false);
	});
	test("packageManifest sorts by path", () => {
		assert.deepEqual(Object.keys(packageManifest([["b.js", "@x/p"], ["a/c.js", "@x/q"]])), ["a/c.js", "b.js"]);
	});
});

describe("themes (less-openui5)", () => {
	test("findThemes", () => {
		assert.deepEqual(findThemes(["sap/m/themes/sap_horizon/library.source.less", "sap/m/themes/base/Button.less", "sap/a/themes/base/library.source.less"]), [
			{ lib: "sap.a", theme: "base", dir: "sap/a/themes/base" },
			{ lib: "sap.m", theme: "sap_horizon", dir: "sap/m/themes/sap_horizon" },
		]);
	});
	test("themeFiles", () => {
		const files = themeFiles({ css: "a", cssRtl: "b", variables: { x: "1" }, cssVariables: "c", cssVariablesSource: "d", cssSkeleton: "e", cssSkeletonRtl: "f" });
		assert.deepEqual(Object.keys(files), ["library.css", "library-RTL.css", "library-parameters.json", "css_variables.css", "css_variables.source.less", "library_skeleton.css", "library_skeleton-RTL.css"]);
		assert.equal(files["library-parameters.json"], '{"x":"1"}\n');
	});
	test("buildThemes: cross-library imports, inline parameters, failures are reported", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "esm-ui5-themes-"));
		const put = (rel, c) => {
			fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
			fs.writeFileSync(path.join(tmp, rel), c);
		};
		put("sap/core/themes/t/base.less", "@sapColor: #123456;\n");
		put("sap/a/themes/t/library.source.less", '@import "../../../core/themes/t/base.less";\n@sapA: darken(@sapColor, 10%);\n.x { color: @sapA; float: left; }\n');
		put("sap/b/themes/t/library.source.less", '@import "missing.less";\n');
		const r = await buildThemes(tmp, findThemes(["sap/a/themes/t/library.source.less", "sap/b/themes/t/library.source.less"]));
		assert.deepEqual(r.compiled, ["sap.a:t"]);
		assert.equal(r.themeFailures.length, 1);
		assert.equal(r.themeFailures[0].library, "sap.b");
		const css = fs.readFileSync(path.join(tmp, "sap/a/themes/t/library.css"), "utf8");
		assert.match(css, /\.x\{color:#091a2c;float:left\}/);
		assert.match(css, /#sap-ui-theme-sap\\\.a\{background-image:url\('data:text\/plain;utf-8,/);
		assert.match(fs.readFileSync(path.join(tmp, "sap/a/themes/t/library-RTL.css"), "utf8"), /float:right/);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "sap/a/themes/t/library-parameters.json"), "utf8")), { sapA: "#091a2c" });
		assert.match(fs.readFileSync(path.join(tmp, "sap/a/themes/t/css_variables.css"), "utf8"), /--sapA:#091a2c/);
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("esm step (integration)", () => {
	test("tiny fake node_modules", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "esm-ui5-"));
		const put = (rel, content) => {
			const f = path.join(tmp, rel);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, content);
		};
		const pkg = (name) => {
			put(`node_modules/@openui5/${name}/package.json`, JSON.stringify({ name: `@openui5/${name}`, version: "9.9.9" }));
			put(`node_modules/@openui5/${name}/LICENSE.txt`, "Apache License 2.0\n");
			put(`node_modules/@openui5/${name}/THIRDPARTY.txt`, name === "pkg.b" ? "other components\n" : "components\n");
			put(`node_modules/@openui5/${name}/LICENSES/MIT.txt`, "MIT\n");
		};
		pkg("pkg.a");
		pkg("pkg.b");
		pkg("pkg.typings");
		const A = "node_modules/@openui5/pkg.a/src/";
		const B = "node_modules/@openui5/pkg.b/src/";
		put(A + "sap/a/A.js", 'sap.ui.define(["./B"], function(B) { "use strict"; return { b: B }; });\n');
		put(A + "sap/a/B.js", 'sap.ui.define([], function() { return 1; });\n');
		put(A + "sap/a/A-dbg.js", "never copied");
		put(A + "sap/ui/thirdparty/lib.js", "window.lib = { define: sap.ui.define };\n");
		put(A + "sap/ui/thirdparty/used.js", "(function (root) { root.usedLib = 42; }(this));\n");
		put(A + "sap/ui/thirdparty/dep.js", "window.depLib = 1;\n");
		put(A + "sap/ui/thirdparty/unlisted.js", "window.unlisted = 1;\n");
		put(A + "ui5loader.js", "/* old loader */ var x = 1;\n");
		put(A + "ui5loader-autoconfig.js", '(function() { var ui5loader = sap.ui.loader; function helper() { return 2; }\ndefine("sap/x/Inline", [], function() { return helper(); });\n}());\n');
		put(A + "sap/shared.js", 'sap.ui.define([], function() { return "a"; });\n');
		put(A + "sap/same.properties", "k=v\n");
		put(A + "sap/a/view.xml", "<mvc:View/>\n");
		put(A + "sap/a/.library", "<library><name>sap.a</name><version>9.9.9</version><dependencies><dependency><libraryName>sap.b</libraryName></dependency></dependencies></library>\n");
		put(A + "sap/a/messagebundle.properties", "x=y\n");
		put(A + "sap/a/themes/base/library.source.less", "@sapA: #123456;\n.x { color: @sapA; }\n");
		put(B + "sap/shared.js", 'sap.ui.define([], function() { return "b"; });\n');
		put(B + "sap/same.properties", "k=v\n");
		put(B + "sap/b/C.js", 'sap.ui.loader.config({ shim: { "sap/ui/thirdparty/used": { deps: ["sap/ui/thirdparty/dep"] } } });\n' +
			'sap.ui.define(["sap/a/A", "sap/missing/X", "ext/lib", "sap/ui/thirdparty/used", "sap/ui/thirdparty/unlisted"], function(A, X, L, U, N) { return A; });\n');
		put(B + "sap/b/Bad.js", 'sap.ui.define([], function() { return 1; });\nsap.ui.define([], function() { return 2; });\n');
		put(B + "sap/b/Nested.js", 'sap.ui.define([], function() { if (1) { return 1; } return 2; });\n');
		put(B + "sap/b/Esm.js", "export default 42;\n");
		put("node_modules/@openui5/pkg.typings/types/index.d.ts", "");

		const out = path.join(tmp, "dist");
		const thirdpartyGlobals = { "sap/ui/thirdparty/used": "usedLib", "sap/ui/thirdparty/dep": null };
		const report = await build({ from: tmp, out, scopes: ["openui5"], themes: ["base"], thirdpartyGlobals, log: () => {} });
		const esm = (rel) => path.join(out, "esm", rel);
		const esmText = (rel) => fs.readFileSync(esm(rel), "utf8");

		// layout
		assert.deepEqual(fs.readdirSync(out).sort(), ["LICENSE", "NOTICE", "esm", "licenses", "reports", "runtime"]);
		// Apache-2.0 §4: license texts and attribution travel with the output
		assert.match(fs.readFileSync(path.join(out, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
		assert.match(fs.readFileSync(path.join(out, "NOTICE"), "utf8"), /OpenUI5[\s\S]*SAP SE[\s\S]*modified/);
		assert.deepEqual(fs.readdirSync(path.join(out, "reports")).sort(), ["esm-ui5-packages.json", "esm-ui5-report.json"]);
		assert.ok(fs.existsSync(path.join(out, "runtime/esm-ui5-runtime.js")));
		assert.deepEqual(JSON.parse(esmText("package.json")), { name: "esm-ui5-esm", version: "9.9.9", type: "module" });

		assert.deepEqual(report.packages.map((p) => p.name), ["@openui5/pkg.a", "@openui5/pkg.b"]);
		assert.deepEqual(report.ignoredPackages.map((p) => p.name), ["@openui5/pkg.typings"]);
		// converted modules import the runtime (dist/runtime) first and register themselves
		assert.equal(esmText("sap/a/A.js"), [
			"/* Modified by esm-ui5: converted from the OpenUI5 AMD source to an ES module. */",
			'import { _register as __ui5_register } from "../../../runtime/esm-ui5-runtime.js";',
			'import * as __ui5_self from "./A.js";',
			'import B from "./B.js";',
			"",
			"export default { b: B };",
			"",
			'__ui5_register("sap/a/A", __ui5_self);',
			"",
		].join("\n"));
		assert.ok(esmText("sap/b/C.js").includes('import A from "../a/A.js";\nimport X from "../missing/X.js";\nimport L from "ext/lib";\nimport U from "../ui/thirdparty/used.js";\n'));
		assert.equal(fs.existsSync(esm("sap/a/A-dbg.js")), false);

		// OpenUI5 license files: identical ones once, differing ones per package
		assert.deepEqual(report.licenseFiles.sort(), ["LICENSE", "NOTICE", "licenses/LICENSES/MIT.txt", "licenses/LICENSE.txt", "licenses/THIRDPARTY.txt", "licenses/pkg.b/THIRDPARTY.txt"].sort());

		// package manifest: every esm file -> package, first package wins
		const manifest = JSON.parse(fs.readFileSync(path.join(out, "reports/esm-ui5-packages.json"), "utf8"));
		assert.equal(manifest["sap/a/A.js"], "@openui5/pkg.a");
		assert.equal(manifest["sap/b/C.js"], "@openui5/pkg.b");
		assert.equal(manifest["sap/shared.js"], "@openui5/pkg.a");
		assert.equal(manifest["sap/ui/thirdparty/used.orig.js"], "@openui5/pkg.a");
		assert.equal(manifest["sap/x/Inline.js"], "@openui5/pkg.a"); // extracted from pkg.a's autoconfig
		assert.equal(manifest["sap/a/themes/base/library.css"], "@openui5/pkg.a");
		assert.deepEqual(Object.keys(manifest), [...Object.keys(manifest)].sort());
		assert.match(esmText("sap/shared.js"), /"a"/);
		assert.deepEqual(report.collisions, [{ file: "sap/shared.js", kept: "@openui5/pkg.a", ignored: "@openui5/pkg.b" }]);

		// thirdparty: listed ones wrapped (<name>.orig.js + <name>.js), unlisted imported ones reported
		assert.deepEqual(report.wrappedThirdparty, ["sap/ui/thirdparty/dep.js", "sap/ui/thirdparty/used.js"]);
		assert.equal(esmText("sap/ui/thirdparty/used.js"), 'import "./dep.js";\nimport "./used.orig.js";\nexport default globalThis["usedLib"];\n');
		assert.match(esmText("sap/ui/thirdparty/used.orig.js"), /root\.usedLib = 42; \}\(globalThis\)\);/);
		assert.deepEqual(report.unwrappedThirdparty, [{ module: "sap/ui/thirdparty/unlisted", firstImportedBy: "sap/b/C.js", suggestedGlobal: null }]);
		assert.equal(esmText("sap/ui/thirdparty/lib.js"), "window.lib = { define: sap.ui.define };\n");
		assert.ok(report.classicScripts.includes("sap/ui/thirdparty/lib.js"));

		// legacy bootstrap, generated files
		assert.deepEqual(report.obsoleteBootstrap.sort(), ["ui5loader-autoconfig.js", "ui5loader.js"]);
		assert.deepEqual(report.extracted, ["sap/x/Inline.js", "esm-ui5-autoconfig.js"]);
		assert.match(esmText("esm-ui5-autoconfig.js"), /import "\.\/sap\/x\/Inline\.js";/);
		// the app-facing bootstrap of the esm tree
		assert.match(esmText("esm-ui5-bootstrap.js"), /import "\.\/esm-ui5-setup\.js";\nimport Core from "\.\/sap\/ui\/core\/Core\.js";/);
		assert.match(esmText("esm-ui5-setup.js"), /from "\.\.\/runtime\/esm-ui5-runtime\.js"/);
		assert.match(esmText("sap/x/Inline.js"), /function helper\(\) \{ return 2; \}[\s\S]*export default helper\(\);/);
		assert.deepEqual(JSON.parse(esmText("sap/a/manifest.json"))["sap.ui5"].dependencies.libs, { "sap.b": {} });
		assert.equal(JSON.parse(esmText("sap-ui-version.json")).version, "9.9.9");
		// themes (less-openui5), next to the sources
		assert.deepEqual(report.themes.compiled, ["sap.a:base"]);
		assert.deepEqual(report.themeFailures, []);
		assert.match(esmText("sap/a/themes/base/library.css"), /\.x\{color:#123456\}[\s\S]*#sap-ui-theme-sap\\\.a\{/);
		assert.deepEqual(JSON.parse(esmText("sap/a/themes/base/library-parameters.json")), { sapA: "#123456" });
		assert.ok(fs.existsSync(esm("sap/a/themes/base/css_variables.css")));

		// fallbacks and skips
		assert.match(esmText("sap/b/Nested.js"), /export default \(function\(\) \{ if \(1\)/);
		assert.equal(report.skipped.length, 1);
		assert.equal(report.skipped[0].file, "sap/b/Bad.js");
		assert.equal(esmText("sap/b/Esm.js"), "export default 42;\n");
		assert.equal(report.stats.unchanged, 1);
		assert.equal(report.stats.converted, 7); // A, B, shared, C, Nested, Inline, bootstrap
		assert.deepEqual(report.unresolvedImports, [{ target: "sap/missing/X.js", firstImportedBy: "sap/b/C.js" }]);
		assert.deepEqual(report.externalSpecifiers, { "ext/lib": 1 });

		// non-empty esm/ needs --force, --clean refuses dangerous targets
		await assert.rejects(build({ from: tmp, out, scopes: ["openui5"], themes: [], thirdpartyGlobals, log: () => {} }), /not empty/);
		await build({ from: tmp, out, scopes: ["openui5"], force: true, themes: [], thirdpartyGlobals, log: () => {} });
		assert.throws(() => removeDir(tmp, tmp), /--clean refused: .* the --from directory/);
		fs.mkdirSync(path.join(tmp, "x/node_modules"), { recursive: true });
		assert.throws(() => removeDir(path.join(tmp, "x"), path.join(tmp, "elsewhere")), /contains node_modules/);
		assert.throws(() => removeDir(process.cwd()), /current directory/);
		await assert.rejects(build({ from: tmp, out, scopes: ["nope"], log: () => {} }), (e) => e.code === "NO_PACKAGES");

		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
