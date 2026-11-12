import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, isPlainModule, parse } from "../src/convert.mjs";
import { resolveSpecifier, build } from "../src/build.mjs";
import { analyseAutoconfig, classicWrapper, addRegistration, libraryManifest, shimConfigOf } from "../src/legacy.mjs";
import { loadLess, compileTheme, themeFooter, findThemes } from "../src/themes.mjs";

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
	test("runtime", () => {
		assert.equal(resolveSpecifier("sap/m/a.js", "ui5-next-runtime", roots).specifier, "../../ui5-next-runtime.js");
	});
});

const LESS_JS = fileURLToPath(new URL("../node_modules/@openui5/sap.ui.core/src/sap/ui/thirdparty/less.js", import.meta.url));
const haveLess = fs.existsSync(LESS_JS);

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
		// the extracted sources convert to valid modules
		for (const src of info.modules.values()) assert.ok(convert(src, spec));
	});
	test("shimConfigOf reads sap.ui.loader.config calls", () => {
		assert.deepEqual(shimConfigOf('sap.ui.loader.config({ shim: { "a/b": { exports: "B" } } }); sap.ui.define([], function() {});'), { "a/b": { exports: "B" } });
		assert.deepEqual(shimConfigOf("var x = 1;"), {});
	});
	test("classicWrapper", () => {
		const code = classicWrapper({ classicFile: "lib.classic.js", deps: ["x/dep"], exports: "jQuery.mobile", runtimeSpec: "../rt.js", depSpecs: (d) => `./${d}.js` });
		assert.equal(code, [
			"/* UI5 Next: ES module wrapper; the original classic script is ./lib.classic.js */",
			'import { _loadScript } from "../rt.js";',
			'import "./x/dep.js";',
			"",
			'await _loadScript(new URL("./lib.classic.js", import.meta.url).href);',
			"",
			'export default globalThis["jQuery"]?.["mobile"];',
			"",
		].join("\n"));
		parse(code, "module");
	});
	test("addRegistration keeps the header comment first", () => {
		const code = addRegistration("/*!\n * (c)\n */\nimport A from \"./A.js\";\n\nexport default A;\n", "sap/x/Y", "../../rt.js", "./Y.js");
		assert.equal(code, '/*!\n * (c)\n */\nimport { _register as __ui5_register } from "../../rt.js";\nimport * as __ui5_self from "./Y.js";\nimport A from "./A.js";\n\nexport default A;\n\n__ui5_register("sap/x/Y", __ui5_self);\n');
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
});

describe("themes", () => {
	test("findThemes", () => {
		assert.deepEqual(findThemes(["sap/m/themes/sap_horizon/library.source.less", "sap/m/themes/base/Button.less"]), [
			{ lib: "sap.m", theme: "sap_horizon", dir: "sap/m/themes/sap_horizon" },
		]);
	});
	test("themeFooter: parameters (URI component encoded) and metadata (plain JSON)", () => {
		const css = themeFooter("sap.m", "sap_horizon", "1.0.0", { a: "#fff" });
		assert.ok(css.includes("#sap-ui-theme-sap\\.m{background-image:url('data:text/plain;utf-8,%7B%22a%22%3A%22%23fff%22%7D')}"));
		assert.ok(css.includes('.sapThemeMetaData-UI5-sap-m{background-image:url(\'data:text/plain;utf-8,{"Path":"UI5.sap/m.sap_horizon"'));
	});
	test("compileTheme with the bundled LESS", { skip: !haveLess && "bundled less.js not installed" }, async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-less-"));
		fs.mkdirSync(path.join(tmp, "base/img"), { recursive: true });
		fs.mkdirSync(path.join(tmp, "theme"));
		fs.writeFileSync(path.join(tmp, "base/vars.less"), "@sapColor: #123456;\n.b { background: url('img/x.png'); }\n");
		fs.writeFileSync(path.join(tmp, "theme/library.source.less"), '@import "../base/vars.less";\n@sapDark: darken(@sapColor, 10%);\n.x { color: @sapDark; }\n');
		const less = loadLess(fs.readFileSync(LESS_JS, "utf8"));
		const { css, parameters } = await compileTheme(less, path.join(tmp, "theme/library.source.less"));
		assert.match(css, /\.x \{\s*color: #091a2c;/);
		assert.match(css, /url\('\.\.\/base\/img\/x\.png'\)/); // rewritten relative to the entry file
		assert.deepEqual(parameters, { sapColor: "#123456", sapDark: "#091a2c" });
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("build (integration)", () => {
	test("tiny fake node_modules", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-"));
		const put = (rel, content) => {
			const f = path.join(tmp, rel);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, content);
		};
		const pkg = (name) => put(`node_modules/@openui5/${name}/package.json`, JSON.stringify({ name: `@openui5/${name}`, version: "9.9.9" }));
		pkg("pkg.a");
		pkg("pkg.b");
		pkg("pkg.typings");
		const A = "node_modules/@openui5/pkg.a/src/";
		const B = "node_modules/@openui5/pkg.b/src/";
		put(A + "sap/a/A.js", 'sap.ui.define(["./B"], function(B) { "use strict"; return { b: B }; });\n');
		put(A + "sap/a/B.js", 'sap.ui.define([], function() { return 1; });\n');
		put(A + "sap/a/A-dbg.js", "never copied");
		put(A + "sap/a/thirdparty/lib.js", "window.lib = { define: sap.ui.define };\n");
		put(A + "sap/a/thirdparty/used.js", "window.usedLib = 42;\n");
		put(A + "sap/a/thirdparty/dep.js", "window.depLib = 1;\n");
		put(A + "ui5loader.js", "/* old loader */ var x = 1;\n");
		put(A + "ui5loader-autoconfig.js", '(function() { var ui5loader = sap.ui.loader; function helper() { return 2; }\ndefine("sap/x/Inline", [], function() { return helper(); });\n}());\n');
		put(A + "sap/shared.js", 'sap.ui.define([], function() { return "a"; });\n');
		put(A + "sap/same.properties", "k=v\n");
		put(A + "sap/a/view.xml", "<mvc:View/>\n");
		put(A + "sap/a/.library", "<library><name>sap.a</name><version>9.9.9</version><dependencies><dependency><libraryName>sap.b</libraryName></dependency></dependencies></library>\n");
		put(A + "sap/a/messagebundle.properties", "x=y\n");
		put(A + "sap/a/themes/base/library.source.less", "@sapA: #123456;\n.x { color: @sapA; }\n");
		if (haveLess) put(A + "sap/ui/thirdparty/less.js", fs.readFileSync(LESS_JS, "utf8"));
		put(B + "sap/shared.js", 'sap.ui.define([], function() { return "b"; });\n');
		put(B + "sap/same.properties", "k=v\n");
		put(B + "sap/b/C.js", 'sap.ui.loader.config({ shim: { "sap/a/thirdparty/used": { exports: "usedLib", deps: ["sap/a/thirdparty/dep"] } } });\n' +
			'sap.ui.define(["sap/a/A", "sap/missing/X", "ext/lib", "sap/a/thirdparty/used"], function(A, X, L, U) { return A; });\n');
		put(B + "sap/b/Bad.js", 'sap.ui.define([], function() { return 1; });\nsap.ui.define([], function() { return 2; });\n');
		put(B + "sap/b/Nested.js", 'sap.ui.define([], function() { if (1) { return 1; } return 2; });\n');
		put(B + "sap/b/Esm.js", "export default 42;\n");
		put("node_modules/@openui5/pkg.typings/types/index.d.ts", "");

		const out = path.join(tmp, "dist");
		const report = await build({ from: tmp, out, scopes: ["openui5"], themes: ["base"], log: () => {} });
		const outFile = (rel) => path.join(out, rel);
		const outText = (rel) => fs.readFileSync(outFile(rel), "utf8");

		assert.deepEqual(report.packages.map((p) => p.name), ["@openui5/pkg.a", "@openui5/pkg.b"]);
		assert.deepEqual(report.ignoredPackages.map((p) => p.name), ["@openui5/pkg.typings"]);
		// converted modules import the runtime first and register themselves
		assert.equal(outText("sap/a/A.js"), [
			'import { _register as __ui5_register } from "../../ui5-next-runtime.js";',
			'import * as __ui5_self from "./A.js";',
			'import B from "./B.js";',
			"",
			"export default { b: B };",
			"",
			'__ui5_register("sap/a/A", __ui5_self);',
			"",
		].join("\n"));
		const c = outText("sap/b/C.js");
		assert.ok(c.includes('import A from "../a/A.js";\nimport X from "../missing/X.js";\nimport L from "ext/lib";\nimport U from "../a/thirdparty/used.js";\n'));
		assert.equal(fs.existsSync(outFile("sap/a/A-dbg.js")), false);
		// collision: first package wins, identical files are not reported
		assert.match(outText("sap/shared.js"), /"a"/);
		assert.deepEqual(report.collisions, [{ file: "sap/shared.js", kept: "@openui5/pkg.a", ignored: "@openui5/pkg.b" }]);
		// classic scripts: imported/shimmed ones are wrapped, the others copied as is
		assert.equal(outText("sap/a/thirdparty/lib.js"), "window.lib = { define: sap.ui.define };\n");
		assert.deepEqual(report.wrappedClassicScripts, ["sap/a/thirdparty/dep.js", "sap/a/thirdparty/used.js"]);
		assert.ok(report.classicScripts.includes("sap/a/thirdparty/lib.js"));
		assert.equal(outText("sap/a/thirdparty/used.classic.js"), "window.usedLib = 42;\n");
		const used = outText("sap/a/thirdparty/used.js");
		assert.ok(used.includes('import "./dep.js";'));
		assert.ok(used.includes('await _loadScript(new URL("./used.classic.js", import.meta.url).href);'));
		assert.ok(used.includes('export default globalThis["usedLib"];'));
		// legacy bootstrap: copied, reported, and its inline modules extracted
		assert.equal(outText("ui5loader.js"), "/* old loader */ var x = 1;\n");
		assert.deepEqual(report.obsoleteBootstrap.sort(), ["ui5loader-autoconfig.js", "ui5loader.js"]);
		assert.deepEqual(report.extracted, ["sap/x/Inline.js", "ui5-next-bootstrap.js"]);
		assert.match(outText("sap/x/Inline.js"), /function helper\(\) \{ return 2; \}[\s\S]*export default helper\(\);/);
		assert.match(outText("ui5-next-bootstrap.js"), /import "\.\/sap\/x\/Inline\.js";/);
		assert.equal(outText("sap/a/view.xml"), "<mvc:View/>\n");
		// generated: library manifest, version info, themes
		const manifest = JSON.parse(outText("sap/a/manifest.json"));
		assert.deepEqual(manifest["sap.ui5"].dependencies.libs, { "sap.b": {} });
		assert.equal(JSON.parse(outText("sap-ui-version.json")).version, "9.9.9");
		if (haveLess) {
			assert.deepEqual(report.themes.compiled, ["sap.a:base"]);
			assert.match(outText("sap/a/themes/base/library.css"), /color: #123456;[\s\S]*#sap-ui-theme-sap\\.a\{/);
			assert.deepEqual(JSON.parse(outText("sap/a/themes/base/library-parameters.json")), { sapA: "#123456" });
		}
		// a factory with a nested return is kept as a function; multiple defines are skipped
		assert.match(outText("sap/b/Nested.js"), /export default \(function\(\) \{ if \(1\)/);
		assert.equal(report.skipped.length, 1);
		assert.equal(report.skipped[0].file, "sap/b/Bad.js");
		assert.match(report.skipped[0].reason, /multiple sap\.ui\.define/);
		assert.match(outText("sap/b/Bad.js"), /^sap\.ui\.define/);
		// ES module copied unchanged
		assert.equal(outText("sap/b/Esm.js"), "export default 42;\n");
		assert.equal(report.stats.unchanged, 1);
		assert.equal(report.stats.converted, 7); // A, B, shared, C, Nested, Inline, bootstrap
		// imports
		assert.deepEqual(report.unresolvedImports, [{ target: "sap/missing/X.js", firstImportedBy: "sap/b/C.js" }]);
		assert.deepEqual(report.externalSpecifiers, { "ext/lib": 1 });
		// extra files
		assert.deepEqual(JSON.parse(outText("package.json")), { name: "ui5-next", version: "9.9.9", type: "module" });
		for (const f of ["ui5-next-runtime.js", "ui5-next-boot.js", "ui5-next-report.json"]) assert.ok(fs.existsSync(outFile(f)), f);

		// non-empty out dir needs --force, --clean refuses dangerous targets
		await assert.rejects(build({ from: tmp, out, scopes: ["openui5"], themes: [], log: () => {} }), /not empty/);
		await build({ from: tmp, out, scopes: ["openui5"], force: true, themes: [], log: () => {} });
		await assert.rejects(build({ from: tmp, out: tmp, scopes: ["openui5"], clean: true, log: () => {} }), /--clean refused/);
		await assert.rejects(build({ from: tmp, out, scopes: ["nope"], log: () => {} }), (e) => e.code === "NO_PACKAGES");

		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("runtime shim", () => {
	test("require/toUrl", async () => {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-rt-")));
		fs.copyFileSync(fileURLToPath(new URL("../src/runtime.js", import.meta.url)), path.join(tmp, "ui5-next-runtime.js"));
		fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
		fs.mkdirSync(path.join(tmp, "my"));
		fs.writeFileSync(path.join(tmp, "my/Mod.js"), "export default { hello: 'world' };\n");
		const rt = await import(new URL("file://" + path.join(tmp, "ui5-next-runtime.js")).href);
		assert.equal(globalThis.sap.ui.require, rt.require);
		assert.equal(rt.require("my/Mod"), undefined);
		const got = await rt.require(["my/Mod"], (M) => M.hello);
		assert.equal(got, "world");
		assert.equal(rt.require("my/Mod").hello, "world");
		assert.equal(rt.toUrl("my/x.css"), new URL("file://" + path.join(tmp, "my/x.css")).href);
		assert.throws(() => rt.require(["./rel"]), /relative module name/);
		let failed;
		await rt.require(["my/Nope"], () => {}, (e) => (failed = e));
		assert.ok(failed);
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
