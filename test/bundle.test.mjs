import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { build } from "../src/build.mjs";
import {
	bundle, packageShortName, selectModules, sizesOf, findCycles, bundleImports, importsOf, allowedPackages, assignChunks, hotModules,
	prefixMap, packageOfName, lazyRegistrySource, stubSource, chunkKind, bundlesBootstrapSources,
} from "../src/bundle.mjs";
import { init, require as rtRequire, load, toUrl, _reset } from "../src/runtime.js";
import { checkDom } from "../scripts/demo-check.mjs";
import { createStaticServer } from "../src/serve.mjs";
import { bootstrapFiles } from "../src/bootstrap.mjs";
import { parse } from "../src/convert.mjs";

describe("lazy registry and stubs", () => {
	test("names are string literals, modules are reached through stubs", () => {
		const src = lazyRegistrySource([
			{ name: "sap/m/Button", stub: "/t/stubs/sap/m/Button.js" },
			{ name: 'we"ird/na-me$1', stub: '/t/stubs/we"ird.js' },
		], { runtimeFile: "/d/runtime/ui5-next-runtime.js", preload: { "sap/m/manifest.json": "{}" } });
		assert.equal(src, [
			'import { preload } from "/d/runtime/ui5-next-runtime.js";',
			'preload({"sap/m/manifest.json":"{}"});',
			"",
			"export default {",
			'\t"sap/m/Button": () => import("/t/stubs/sap/m/Button.js"),',
			'\t"we\\"ird/na-me$1": () => import("/t/stubs/we\\"ird.js"),',
			"};",
			"",
		].join("\n"));
		parse(src, "module");
	});
	test("stubs re-export namespace and default (if any)", () => {
		assert.equal(stubSource("/e/sap/m/Button.js", true), 'export * from "/e/sap/m/Button.js";\nexport { default } from "/e/sap/m/Button.js";\n');
		assert.equal(stubSource("/e/x/Named.js", false), 'export * from "/e/x/Named.js";\n');
	});
	test("selectModules: only real modules, no .orig.js, exclusions propagate", () => {
		const manifest = {
			"sap/a/A.js": "@openui5/pkg.a", "sap/a/B.js": "@openui5/pkg.a", "sap/a/lib.orig.js": "@openui5/pkg.a", "sap/a/lib.js": "@openui5/pkg.a",
			"sap/a/classic.js": "@openui5/pkg.a", "sap/a/Bad.js": "@openui5/pkg.a", "sap/a/view.xml": "@openui5/pkg.a",
			"sap/b/C.js": "@openui5/pkg.b", "sap/b/UsesMissing.js": "@openui5/pkg.b", "sap/b/UsesThat.js": "@openui5/pkg.b",
			"sap/ui/test/Opa.js": "@openui5/pkg.b", "sap/b/UsesClassic.js": "@openui5/pkg.b", "sap-ui-core.js": "@openui5/pkg.a",
		};
		const files = {
			"sap/a/A.js": 'import B from "./B.js"; import "../../../runtime/ui5-next-runtime.js"; export default B;',
			"sap/a/B.js": "export default 1;",
			"sap/a/lib.orig.js": "(function(){}).call(globalThis);",
			"sap/a/lib.js": 'import "./lib.orig.js"; export default globalThis.lib;',
			"sap/b/C.js": 'import A from "../a/A.js"; export default A;',
			"sap/b/UsesMissing.js": 'import X from "../suite/X.js"; export default X;',
			"sap/b/UsesThat.js": 'import X from "./UsesMissing.js"; export default X;',
			"sap/ui/test/Opa.js": "export default 1;",
			"sap/b/UsesClassic.js": 'import C from "../a/classic.js"; export default C;',
		};
		const report = { classicScripts: ["sap/a/classic.js"], skipped: [{ file: "sap/a/Bad.js" }], obsoleteBootstrap: ["sap-ui-core.js"] };
		const { byPackage, excluded } = selectModules(manifest, report, "/esm", (f) => files[path.relative("/esm", f).split(path.sep).join("/")]);
		assert.deepEqual(Object.fromEntries(byPackage), { "pkg.a": ["sap/a/A.js", "sap/a/B.js", "sap/a/lib.js"], "pkg.b": ["sap/b/C.js"] });
		assert.deepEqual(Object.fromEntries(excluded.map((e) => [e.module, e.reason])), {
			"sap/b/UsesClassic.js": "imports sap/a/classic.js, which is not an ES module",
			"sap/b/UsesMissing.js": "imports sap/suite/X.js, which is missing",
			"sap/b/UsesThat.js": "imports excluded sap/b/UsesMissing.js",
			"sap/ui/test/Opa.js": "test infrastructure (sets up QUnit/OPA/coverage on load)",
		});
	});
});

describe("chunks: dependencies, hot/cold, names", () => {
	test("package short name", () => {
		assert.equal(packageShortName("@openui5/sap.m"), "sap.m");
		assert.equal(packageShortName("@sapui5/sap.suite.ui.commons"), "sap.suite.ui.commons");
		assert.equal(packageShortName("plain"), "plain");
	});
	test("allowedPackages: transitive non-lazy library dependencies", () => {
		const manifests = {
			"sap.ui.core": { "sap.ui5": { dependencies: { libs: {} } } },
			"sap.m": { "sap.ui5": { dependencies: { libs: { "sap.ui.core": {}, "sap.ui.layout": { lazy: true } } } } },
			"sap.f": { "sap.ui5": { dependencies: { libs: { "sap.m": {} } } } },
		};
		const allowed = allowedPackages(["sap.ui.core", "sap.m", "sap.f", "sap.ui.layout"], (p) => manifests[p] ?? null);
		assert.deepEqual([...allowed.get("sap.f")].sort(), ["sap.f", "sap.m", "sap.ui.core"]);
		assert.deepEqual([...allowed.get("sap.m")].sort(), ["sap.m", "sap.ui.core"]);
		assert.deepEqual([...allowed.get("sap.ui.layout")], ["sap.ui.layout"]);
	});
	test("assignChunks: main bundle only if the dependency closure stays within the allowed packages", () => {
		const pkg = { "c/Core.js": "core", "c/Support.js": "core", "m/Button.js": "m", "m/Flex.js": "m", "m/UsesFlex.js": "m", "fl/Api.js": "fl" };
		const deps = new Map([
			["c/Core.js", []], ["c/Support.js", ["m/Button.js"]], // core's support tool needs sap.m
			["m/Button.js", ["c/Core.js"]], ["m/Flex.js", ["fl/Api.js"]], ["m/UsesFlex.js", ["m/Flex.js"]],
			["fl/Api.js", ["c/Core.js"]],
		]);
		const allowed = new Map([["core", new Set(["core"])], ["m", new Set(["m", "core"])], ["fl", new Set(["fl", "core"])]]);
		const chunks = assignChunks(deps, (r) => pkg[r], allowed);
		assert.deepEqual(Object.fromEntries(chunks), {
			"c/Core.js": "core", "c/Support.js": "core+m", "m/Button.js": "m", "m/Flex.js": "m+fl", "m/UsesFlex.js": "m+fl", "fl/Api.js": "fl",
		});
	});
	test("hotModules: boot roots, import() and string-literal names in the package, what other main bundles need", () => {
		const pkg = (r) => r.split("/")[0];
		const deps = new Map([
			["core/Core.js", ["core/Lib.js"]], ["core/Lib.js", []], ["core/Theme.js", []], ["core/Endpoint.js", []],
			["core/Control.js", []], ["core/OData.js", []], ["core/Mock.js", ["core/OData.js"]], ["m/Button.js", ["core/Control.js"]],
		]);
		const dynamicDeps = new Map([["core/Lib.js", ["core/Theme.js"]]]);
		const chunkOf = new Map([...deps.keys()].map((r) => [r, pkg(r)]));
		const hot = hotModules({
			pkg: "core", roots: ["core/Core.js"], deps, dynamicDeps, pkgOf: pkg, chunkOf,
			literalsOf: (r) => (r === "core/Core.js" ? ["core/Endpoint", "elsewhere/X"] : []),
		});
		assert.deepEqual([...hot].sort(), ["core/Control.js", "core/Core.js", "core/Endpoint.js", "core/Lib.js", "core/Theme.js"]);
		assert.equal(hot.has("core/Mock.js"), false); // cold: nobody needs it at boot
		assert.equal(hot.has("core/OData.js"), false);
	});
	test("prefixMap / packageOfName", () => {
		const map = prefixMap({ "sap/m/Button": "sap.m", "sap/m/Text": "sap.m", "sap/ui/core/Core": "sap.ui.core", "sap/ui/core/support/X": "sap.ui.core", "sap/ui/layout/Grid": "sap.ui.layout", "jquery.sap.global": "sap.ui.core" });
		assert.deepEqual(map, { "sap/m": "sap.m", "sap/ui/core": "sap.ui.core", "sap/ui/layout": "sap.ui.layout", "jquery.sap.global": "sap.ui.core" });
		assert.equal(packageOfName("sap/m/upload/Uploader", map), "sap.m");
		assert.equal(packageOfName("jquery.sap.global", map), "sap.ui.core");
		assert.equal(packageOfName("sap/x/Y", map), null);
	});
	test("chunkKind", () => {
		const pk = ["sap.m"];
		assert.equal(chunkKind({ name: "ui5-next-bootstrap", isEntry: true, fileName: "ui5-next-bootstrap.js" }, pk), "bootstrap");
		assert.equal(chunkKind({ name: "sap/m/Button", isEntry: true, fileName: "sap/m/Button.js" }, pk), "facade");
		assert.equal(chunkKind({ name: "sap.m", isEntry: false, fileName: "sap.m.js" }, pk), "package");
		assert.equal(chunkKind({ name: "x", isEntry: false, fileName: "sap.m_sap.ui.fl.js" }, pk), "extra");
		assert.equal(chunkKind({ name: "x", isEntry: false, fileName: "rolldown-runtime.js" }, pk), "runtime");
	});
	test("bundles bootstrap: setup first (registries, packages, preload), then the Core", () => {
		const { setup, bootstrap } = bundlesBootstrapSources({ runtimeFile: "/r/rt.js", coreFile: "/e/sap/ui/core/Core.js", packages: { "sap/m": "sap.m" }, registries: { "sap.m": "/t/sap.m.registry.js" }, preload: { "sap-ui-version.json": "{}" } });
		assert.match(setup, /"sap\.m": \(\) => import\("\/t\/sap\.m\.registry\.js"\)/);
		assert.match(setup, /init\(\{ mode: "bundles", bundlesBase: new URL\("\.\/", import\.meta\.url\), packages: \{"sap\/m":"sap\.m"\}, registries \}\);/);
		const boot = bootstrap("/t/setup.js");
		assert.ok(boot.indexOf('import "/t/setup.js";') < boot.indexOf('import Core from "/e/sap/ui/core/Core.js";'));
		assert.match(boot, /export \{ require, toUrl, preload \} from "\/r\/rt\.js";/);
		parse(setup, "module");
		parse(boot, "module");
	});
});

describe("bundle report helpers", () => {
	test("sizesOf: raw, minified, gzip, brotli", async () => {
		const raw = "const   value  =  1;\n".repeat(200);
		const s = await sizesOf(raw, "const value=1;".repeat(200));
		assert.equal(s.raw, raw.length);
		assert.equal(s.minified, 14 * 200);
		assert.ok(s.gzip > 0 && s.gzip < s.minified);
		assert.ok(s.brotli > 0 && s.brotli < s.minified);
	});
	test("findCycles", () => {
		assert.deepEqual(findCycles({ a: ["b"], b: ["c"], c: [] }), []);
		assert.deepEqual(findCycles({ a: ["b"], b: ["a", "c"], c: ["d"], d: ["c"], e: ["e"] }), [["c", "d"], ["a", "b"], ["e"]]);
	});
	test("bundleImports: static and dynamic, only between output files", () => {
		const r = bundleImports({
			"a.js": 'import { x } from "./b.js"; import "../runtime/ui5-next-runtime.js"; export default () => import("./c.js");',
			"b.js": "export const x = 1;",
			"c.js": "export default 2;",
		});
		assert.deepEqual(r.statics, { "a.js": ["b.js"], "b.js": [], "c.js": [] });
		assert.deepEqual(r.dynamics, { "a.js": ["c.js"], "b.js": [], "c.js": [] });
	});
	test("importsOf detects default exports", () => {
		assert.equal(importsOf("export default 1;").hasDefault, true);
		assert.equal(importsOf("const a = 1; export { a as default };").hasDefault, true);
		assert.equal(importsOf("export const a = 1;").hasDefault, false);
	});
});

describe("runtime resolution order", () => {
	const setup = (mode, { prefixes = true } = {}) => {
		_reset();
		const imports = [];
		const fetches = [];
		const registryLoads = [];
		const modules = {
			"http://x/bundles/sap.m.registry.js": { default: { "sap/m/Button": async () => ({ default: "Button from bundle" }) } },
			"http://x/esm/sap/m/Button.js": { default: "Button from esm" },
			"http://x/esm/sap/base/Log.js": { default: "Log from esm" },
			"http://x/app/App.controller.js": { default: "App controller" },
		};
		init({
			mode,
			esmBase: "http://x/esm/",
			bundlesBase: "http://x/bundles",
			paths: { "demo/todo": "http://x/app" },
			...(prefixes ? {
				packages: { "sap/m": "sap.m" },
				registries: { "sap.m": async () => (registryLoads.push("sap.m"), modules["http://x/bundles/sap.m.registry.js"]) },
			} : {}),
			import: async (url) => {
				imports.push(url);
				if (!modules[url]) throw new Error(`404 ${url}`);
				return modules[url];
			},
			fetch: async (url) => {
				fetches.push(url);
				return { ok: true, status: 200, json: async () => ({ "sap/m/Button": "sap.m" }) };
			},
		});
		return { imports, fetches, registryLoads };
	};
	test("paths -> package registry (lazy) -> esm file", async () => {
		const { imports, fetches, registryLoads } = setup("bundles");
		assert.equal(await load("demo/todo/App.controller"), "App controller"); // 1. paths
		assert.equal(await load("sap/m/Button"), "Button from bundle"); // 2. prefix map -> registry -> import()
		assert.equal(await load("sap/base/Log"), "Log from esm"); // 3. no package -> esm (with a warning)
		assert.deepEqual(imports, ["http://x/app/App.controller.js", "http://x/esm/sap/base/Log.js"]);
		assert.deepEqual(registryLoads, ["sap.m"]);
		assert.deepEqual(fetches, []); // no modules.json with a prefix map
	});
	test("without a prefix map: modules.json (fetched once) and <pkg>.registry.js", async () => {
		const { imports, fetches } = setup("bundles", { prefixes: false });
		assert.equal(await load("sap/m/Button"), "Button from bundle");
		await load("sap/base/Log");
		assert.deepEqual(imports, ["http://x/bundles/sap.m.registry.js", "http://x/esm/sap/base/Log.js"]);
		assert.deepEqual(fetches, ["http://x/bundles/modules.json"]);
	});
	test("cache by name; sync require returns cached modules only", async () => {
		const { registryLoads } = setup("bundles");
		assert.equal(rtRequire("sap/m/Button"), undefined);
		const [a, b] = await rtRequire(["sap/m/Button", "sap/m/Button"]);
		assert.equal(a, "Button from bundle");
		assert.equal(b, a);
		await rtRequire(["sap/m/Button"]);
		assert.equal(registryLoads.length, 1);
		assert.equal(rtRequire("sap/m/Button"), "Button from bundle");
		assert.equal(await rtRequire(["sap/m/Button"], (B) => `cb:${B}`), "cb:Button from bundle");
	});
	test("mode esm skips the bundles", async () => {
		const { imports, fetches, registryLoads } = setup("esm");
		assert.equal(await load("sap/m/Button"), "Button from esm");
		assert.deepEqual(imports, ["http://x/esm/sap/m/Button.js"]);
		assert.deepEqual(fetches, []);
		assert.deepEqual(registryLoads, []);
	});
	test("errors, relative names, toUrl, global installation", async () => {
		setup("bundles");
		let failed;
		await rtRequire(["sap/nope/X"], () => {}, (e) => (failed = e));
		assert.match(String(failed), /404 http:\/\/x\/esm\/sap\/nope\/X\.js/);
		assert.throws(() => rtRequire(["./rel"]), /relative module name "\.\/rel" is not supported/);
		assert.throws(() => rtRequire("../rel"), /relative module name/);
		assert.equal(toUrl("sap/m/themes/x.css"), "http://x/esm/sap/m/themes/x.css");
		assert.equal(toUrl("demo/todo/App.view.xml"), "http://x/app/App.view.xml");
		assert.equal(globalThis.sap.ui.require, rtRequire);
		assert.equal(globalThis.sap.ui.require.toUrl, toUrl);
		assert.throws(() => init({ mode: "amd" }), /unknown mode/);
		_reset();
	});
});

describe("esm bootstrap", () => {
	test("esm tree: setup first, then the Core", () => {
		for (const [mode, coreImport] of [["esm", 'import Core from "./sap/ui/core/Core.js";']]) {
			const files = bootstrapFiles(mode);
			assert.deepEqual(Object.keys(files), ["ui5-next-setup.js", "ui5-next-bootstrap.js"]);
			const boot = files["ui5-next-bootstrap.js"];
			assert.ok(boot.indexOf('import "./ui5-next-setup.js";') < boot.indexOf(coreImport), mode);
			assert.match(boot, /export const ready = Core\.ready\(\)\.then\(\(\) => Core\);/);
			assert.match(files["ui5-next-setup.js"], new RegExp(`init\\(\\{ mode: "${mode}" \\}\\);`));
			assert.match(files["ui5-next-setup.js"], /compatVersion: "edge"[\s\S]*\.\.\.globalThis\["sap-ui-config"\]/);
			parse(boot, "module");
			parse(files["ui5-next-setup.js"], "module");
		}
		assert.throws(() => bootstrapFiles("amd"), /unknown mode/);
	});
});

describe("demo check and server", () => {
	test("checkDom", () => {
		const ok = '<div class="sapMTitle sapMTitleStyleAuto"><span id="x-inner">UI5 Next Todo</span></div><ul><li id="a" class="sapMLIB sapMCLI">';
		assert.deepEqual(checkDom(ok), { title: true, listItems: 1, error: null, ok: true });
		assert.equal(checkDom("<title>UI5 Next Todo</title>").ok, false);
		const failed = checkDom('<pre id="ui5-next-error">UI5 Next demo failed: TypeError: x &lt;y&gt;</pre>');
		assert.equal(failed.ok, false);
		assert.equal(failed.error, "UI5 Next demo failed: TypeError: x <y>");
	});
	test("static server: MIME types, no-store, 404, no path traversal", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-serve-"));
		fs.mkdirSync(path.join(tmp, "demo"));
		fs.writeFileSync(path.join(tmp, "demo/index.html"), "<p>hi</p>");
		fs.writeFileSync(path.join(tmp, "a.js"), "export {}");
		fs.writeFileSync(path.join(tmp, "a.js.map"), "{}");
		fs.writeFileSync(path.join(tmp, "v.xml"), "<x/>");
		const server = createStaticServer(tmp);
		await new Promise((r) => server.listen(0, r));
		const get = (p) => new Promise((resolve) => http.get({ port: server.address().port, path: p }, (res) => {
			res.resume();
			res.on("end", () => resolve(res));
		}));
		for (const [p, type] of [["/a.js", "text/javascript"], ["/a.js.map", "application/json"], ["/v.xml", "application/xml"], ["/demo/", "text/html"]]) {
			const res = await get(p);
			assert.equal(res.statusCode, 200, p);
			assert.ok(res.headers["content-type"].startsWith(type), p);
			assert.equal(res.headers["cache-control"], "no-store");
		}
		assert.equal((await get("/nope.js")).statusCode, 404);
		assert.notEqual((await get("/../../etc/passwd")).statusCode, 200);
		server.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("bundle step (integration)", () => {
	test("dependency-cut chunks, facades, lazy execution, no cycles", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-bundle-"));
		const put = (rel, content) => {
			fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
			fs.writeFileSync(path.join(tmp, rel), content);
		};
		const pkg = (name, lib, deps = []) => {
			put(`node_modules/@openui5/${name}/package.json`, JSON.stringify({ name: `@openui5/${name}`, version: "1.0.0" }));
			put(`node_modules/@openui5/${name}/src/${lib}/.library`, `<library><name>${name}</name><version>1.0.0</version><dependencies>${deps.map((d) => `<dependency><libraryName>${d}</libraryName></dependency>`).join("")}</dependencies></library>`);
		};
		pkg("sap.ui.core", "sap/ui/core");
		pkg("sap.a", "sap/a", ["sap.ui.core"]);
		pkg("sap.b", "sap/b", ["sap.ui.core", "sap.a"]);
		const C = "node_modules/@openui5/sap.ui.core/src/";
		const A = "node_modules/@openui5/sap.a/src/";
		const B = "node_modules/@openui5/sap.b/src/";
		put(C + "sap/ui/core/Core.js", 'sap.ui.define([], function() { globalThis.__coreRuns = (globalThis.__coreRuns || 0) + 1; return { boot() {}, ready() { return Promise.resolve(); } }; });\n');
		put(C + "sap/ui/core/Cold.js", 'sap.ui.define([], function() { globalThis.__coldRuns = true; return "cold"; });\n');
		put(A + "sap/a/A.js", '/*!\n * (c) Copyright Test Corp - Apache-2.0\n */\nsap.ui.define(["sap/ui/core/Core"], function() { return { name: "A" }; });\n');
		put(A + "sap/a/Helper.js", 'sap.ui.define(["./A"], function(A) { return function() { return A.name + "!"; }; });\n');
		put(A + "sap/a/Side.js", 'sap.ui.define([], function() { globalThis.__sideRuns = true; return "side"; });\n');
		put(A + "sap/a/UsesB.js", 'sap.ui.define(["sap/b/B"], function(B) { return B.uses; });\n'); // reaches "up" into sap.b
		put(A + "sap/ui/thirdparty/glob.js", "(function (root) { root.Glob = { v: 7 }; }(this));\n");
		put(B + "sap/b/B.js", 'sap.ui.define(["sap/a/A", "sap/a/Helper", "sap/ui/thirdparty/glob"], function(A, Helper, Glob) { return { uses: A.name, helper: Helper(), glob: Glob.v }; });\n');
		const out = path.join(tmp, "dist");
		await build({ from: tmp, out, scopes: ["openui5"], themes: [], thirdpartyGlobals: { "sap/ui/thirdparty/glob": "Glob" }, log: () => {} });
		const report = await bundle({ out, minifier: "oxc", log: () => {} });
		const bundles = path.join(out, "bundles");

		// chunks: main bundles per package, sap.a's module that needs sap.b in a side bundle, the cold core part apart
		assert.deepEqual(report.chunks, { "sap.a": 4, "sap.a+sap.b": 1, "sap.b": 1, "sap.ui.core": 1, "sap.ui.core.lazy": 1 });
		const top = fs.readdirSync(bundles).filter((f) => f.endsWith(".js")).sort();
		assert.deepEqual(top.filter((f) => f !== "rolldown-runtime.js"), ["sap.a.js", "sap.a_sap.b.js", "sap.b.js", "sap.ui.core.js", "sap.ui.core.lazy.js", "ui5-next-bootstrap.js"]);
		assert.ok(fs.existsSync(path.join(bundles, "sap/b/B.js")) && fs.existsSync(path.join(bundles, "sap/a/Side.js"))); // facades at esm paths
		assert.deepEqual(report.circularImports, []);
		assert.deepEqual(report.importsBetweenBundles["sap.a.js"].filter((f) => f !== "rolldown-runtime.js"), ["sap.ui.core.js"]); // not sap.b
		assert.equal(report.minifier, "oxc");
		// licenses: the module's copyright comment survives bundling + minifying; every bundle says it was modified
		const sapA = fs.readFileSync(path.join(bundles, "sap.a.js"), "utf8");
		assert.ok(sapA.startsWith("/*! Modified by ui5-next: OpenUI5 (c) SAP SE"), sapA.slice(0, 80));
		assert.match(sapA, /\(c\) Copyright Test Corp - Apache-2\.0/);
		for (const s of report.files) assert.ok(s.raw > 0 && s.minified > 0 && s.gzip > 0 && s.brotli > 0, s.file);

		// run in Node: a facade runs exactly its module (and dependencies)
		fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
		const url = (rel) => pathToFileURL(path.join(bundles, rel)).href;
		const { require: bundlesRequire, ready } = await import(url("ui5-next-bootstrap.js"));
		await ready;
		assert.equal(globalThis.__coreRuns, 1);
		assert.deepEqual((await import(url("sap/b/B.js"))).default, { uses: "A", helper: "A!", glob: 7 });
		assert.equal(globalThis.__sideRuns, undefined); // in sap.a.js, but nobody needed it
		assert.equal(globalThis.__coldRuns, undefined);
		// by name: lazy registry, import() inside the package chunk
		assert.deepEqual(await bundlesRequire(["sap/a/Side", "sap/ui/core/Cold", "sap/a/UsesB"]), ["side", "cold", "A"]);
		assert.equal(globalThis.__sideRuns, true);
		assert.equal(globalThis.__coreRuns, 1); // one Core
		for (const k of ["__coreRuns", "__sideRuns", "__coldRuns", "Glob"]) delete globalThis[k];
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
