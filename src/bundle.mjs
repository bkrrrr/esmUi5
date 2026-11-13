// The "bundle" step: esmUi5 as shared library bundles (dist/bundles), built with Rolldown from
// dist/esm. Designed for many apps on one UI5 (launchpad): transport per package, execution on
// demand, chunks cut along real dependencies.
//
//   <pkg>.js                      a package's modules whose static dependencies stay within the
//                                 libraries the package declares as (non-lazy) dependencies
//   <pkg>+<other>....js           the package's modules that reach further (e.g. sap.m's flexibility
//                                 handlers -> sap.ui.fl); loaded only when such a module is needed
//   package registry               resolves UI5 module names to lazy imports inside the chunks
//   esm-ui5-bootstrap.js          config, runtime (inside sap.ui.core.js), Core
// Every module is wrapped by Rolldown (strictExecutionOrder) and runs only when something needs it,
// like a module in a UI5 library-preload file.
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import * as acorn from "acorn";
import { LAYOUT, RUNTIME_FILE, RUNTIME_TARGET, writeJson, freshDir } from "./build.mjs";

export const MINIFIERS = ["rolldown", "oxc", "none"];
/**
 * Not bundled, unless a bundled module imports them: a package bundle runs every module it
 * contains when it is loaded, and these modules do something on load that only makes sense when
 * they are requested explicitly. They stay available as single ES modules in esm/.
 */
export const BUNDLE_EXCLUDE = [
	{ test: /^sap\/ui\/(qunit|test)\//, reason: "test infrastructure (sets up QUnit/OPA/coverage on load)" },
	{ test: /^sap\/ui\/core\/boot(\.js|\/_runBoot\.js|\/loadModules\.js|\/onInit\.js)$/, reason: "legacy bootstrap entry (starts a UI5 boot / loads libraries on load; replaced by esm-ui5-bootstrap.js)" },
	{ test: /^sap\/ui\/thirdparty\/jqueryui\/jquery-effects-/, reason: "deprecated alias module (logs a 'renamed' warning on load)" },
];
// chosen by measurement (npm run bundle:compare, see README): smallest output that passes the demo check
export const DEFAULT_MINIFIER = "oxc";
const RUNTIME_SRC = fileURLToPath(new URL("./runtime.js", import.meta.url));
const CORE = "sap.ui.core";
/** Notice at the top of every bundle with OpenUI5 code (a legal comment, so minifiers keep it). */
export const BUNDLE_NOTICE = "/*! Modified by esm-ui5: OpenUI5 (c) SAP SE or an SAP affiliate company, Apache-2.0; converted to ES modules, bundled and minified. Licenses: ../LICENSE, ../NOTICE, ../licenses/ */";

/** "@openui5/sap.m" -> "sap.m" (the bundle file name). */
export const packageShortName = (pkg) => pkg.replace(/^@[^/]+\//, "");

/**
 * The libraries each package may depend on statically: itself plus the transitive non-lazy
 * dependencies from its library manifest (sap.ui5/dependencies/libs, from .library).
 * @param {(pkg: string) => object|null} readManifest  library manifest.json of a package, or null
 */
export function allowedPackages(packages, readManifest) {
	const direct = new Map();
	for (const pkg of packages) {
		const libs = readManifest(pkg)?.["sap.ui5"]?.dependencies?.libs ?? {};
		direct.set(pkg, Object.entries(libs).filter(([, v]) => !v?.lazy).map(([k]) => k).filter((k) => packages.includes(k)));
	}
	const allowed = new Map();
	const closure = (pkg, seen = new Set()) => {
		if (seen.has(pkg)) return seen;
		seen.add(pkg);
		for (const d of direct.get(pkg) ?? []) closure(d, seen);
		return seen;
	};
	for (const pkg of packages) allowed.set(pkg, closure(pkg));
	return allowed;
}

/**
 * Chunk of every module: "<pkg>" if all packages in its static dependency closure are allowed
 * for its package, else "<pkg>+<the other packages>".
 * @param {Map<string, string[]>} deps  module -> static dependencies (modules)
 * @param {(rel: string) => string} pkgOf
 */
export function assignChunks(deps, pkgOf, allowed) {
	const closure = new Map([...deps.keys()].map((rel) => [rel, new Set([pkgOf(rel)])]));
	let changed = true;
	while (changed) {
		changed = false;
		for (const [rel, targets] of deps) {
			const c = closure.get(rel);
			for (const t of targets) {
				for (const p of closure.get(t) ?? [pkgOf(t)]) {
					if (!c.has(p)) {
						c.add(p);
						changed = true;
					}
				}
			}
		}
	}
	const chunkOf = new Map();
	for (const [rel, c] of closure) {
		const pkg = pkgOf(rel);
		const extra = [...c].filter((p) => !(allowed.get(pkg)?.has(p) ?? p === pkg)).sort();
		chunkOf.set(rel, extra.length ? `${pkg}+${extra.join("+")}` : pkg);
	}
	return chunkOf;
}

/**
 * The hot part of the boot package (sap.ui.core, which every page loads): what the boot path
 * needs (static and import() closure of the roots within the package, plus modules it names in
 * string literals, which UI5 loads by name: `aModules.push("sap/ui/core/boot/FieldHelpEndpoint")`)
 * and everything the main bundles of the other packages import from it. The rest of its main
 * bundle is "cold" and goes into a lazy chunk, loaded only when an app uses it.
 * @param {(rel: string) => string[]} [literalsOf] module names in string literals of a module
 */
export function hotModules({ pkg, roots, deps, dynamicDeps, pkgOf, chunkOf, literalsOf = () => [] }) {
	const hot = new Set();
	const add = (rel) => {
		if (hot.has(rel) || !deps.has(rel)) return;
		hot.add(rel);
		for (const t of deps.get(rel)) add(t);
		for (const t of dynamicDeps.get(rel) ?? []) if (pkgOf(t) === pkg) add(t);
		if (pkgOf(rel) === pkg) for (const n of literalsOf(rel)) if (deps.has(n + ".js") && pkgOf(n + ".js") === pkg) add(n + ".js");
	};
	for (const r of roots) add(r);
	for (const [rel, chunk] of chunkOf) {
		if (pkgOf(rel) === pkg || chunk !== pkgOf(rel)) continue; // main bundles of other packages
		for (const t of deps.get(rel)) if (pkgOf(t) === pkg) add(t);
	}
	return hot;
}

/**
 * Smallest prefix map for module name -> package: the top-most name prefixes whose modules all
 * belong to one package ({ "sap/m": "sap.m", "sap/ui/core": "sap.ui.core", ... }).
 */
export function prefixMap(namesToPkg) {
	const root = { children: new Map(), pkgs: new Set() };
	for (const [name, pkg] of Object.entries(namesToPkg)) {
		let node = root;
		node.pkgs.add(pkg);
		for (const seg of name.split("/")) {
			if (!node.children.has(seg)) node.children.set(seg, { children: new Map(), pkgs: new Set() });
			node = node.children.get(seg);
			node.pkgs.add(pkg);
		}
	}
	const map = {};
	const walk = (node, prefix) => {
		for (const [seg, child] of node.children) {
			const p = prefix ? `${prefix}/${seg}` : seg;
			if (child.pkgs.size === 1) map[p] = [...child.pkgs][0];
			else walk(child, p);
		}
	};
	walk(root, "");
	return map;
}

/** Package of a module name from a prefix map (longest matching prefix). */
export function packageOfName(name, map) {
	for (let p = name; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
		if (Object.hasOwn(map, p)) return map[p];
	}
	return null;
}

/**
 * Lazy registry of one package: { "<name>": () => import(<stub>) }. The stubs re-export the module
 * and are no entries, so Rolldown resolves the import() inside the package chunk (no facade
 * request) and runs the module on first use. preload: resources inlined into the registry (the
 * library manifest, as in library-preload.js).
 */
export function lazyRegistrySource(modules, { runtimeFile = null, preload = null } = {}) {
	const lines = [];
	if (preload && runtimeFile) lines.push(`import { preload } from ${JSON.stringify(runtimeFile)};`, `preload(${JSON.stringify(preload)});`, "");
	lines.push("export default {");
	for (const m of modules) lines.push(`	${JSON.stringify(m.name)}: () => import(${JSON.stringify(m.stub.split(path.sep).join("/"))}),`);
	lines.push("};", "");
	return lines.join("\n");
}

/** Stub re-exporting one module (namespace and, if present, default). */
export const stubSource = (file, hasDefault) => {
	const f = JSON.stringify(file.split(path.sep).join("/"));
	return `export * from ${f};\n${hasDefault ? `export { default } from ${f};\n` : ""}`;
};

/** The bundles setup + bootstrap modules (both end up in sap.ui.core.js; the bootstrap is an entry). */
export function bundlesBootstrapSources({ runtimeFile, coreFile, packages, registries = {}, preload }) {
	const regs = Object.entries(registries).map(([pkg, file]) => `\t${JSON.stringify(pkg)}: () => import(${JSON.stringify(file.split(path.sep).join("/"))}),`);
	const setup = [
		`// esmUi5 bundles: setup, runs before any UI5 module`,
		`import { init, preload } from ${JSON.stringify(runtimeFile)};`,
		`// module name -> package, and each package's lazy registry (loading it loads the package bundle)`,
		`const registries = {`,
		...regs,
		`};`,
		`init({ mode: "bundles", bundlesBase: new URL("./", import.meta.url), packages: ${JSON.stringify(packages)}, registries });`,
		`globalThis["sap-ui-config"] = { theme: "sap_horizon", compatVersion: "edge", async: true, ...globalThis["sap-ui-config"] };`,
		`preload(${JSON.stringify(preload)});`,
		``,
	].join("\n");
	const bootstrap = (setupFile) => [
		`// esmUi5 bootstrap (dist/bundles/): replaces sap-ui-core.js and ui5loader. Import it first.`,
		`import ${JSON.stringify(setupFile)};`,
		`import Core from ${JSON.stringify(coreFile)};`,
		``,
		`if (typeof Core.boot === "function") Core.boot();`,
		``,
		`/** Resolves with the Core when it is ready (DOM ready, libraries loaded, theme applied). */`,
		`export const ready = Core.ready().then(() => Core);`,
		`export default Core;`,
		`export { require, toUrl, preload } from ${JSON.stringify(runtimeFile)};`,
		``,
	].join("\n");
	return { setup, bootstrap };
}

/** Static and dynamic import specifiers of an ES module. */
export function importsOf(code) {
	const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
	const statics = [];
	const dynamics = [];
	let hasDefault = false;
	for (const n of ast.body) {
		if (n.type === "ExportDefaultDeclaration") hasDefault = true;
		if (n.type === "ExportNamedDeclaration" && n.specifiers.some((sp) => (sp.exported.name ?? sp.exported.value) === "default")) hasDefault = true;
		if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source) {
			statics.push(n.source.value);
		}
	}
	(function walk(n) {
		if (!n || typeof n.type !== "string") return;
		if (n.type === "ImportExpression" && n.source.type === "Literal") dynamics.push(n.source.value);
		for (const k in n) {
			const v = n[k];
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v.type === "string") walk(v);
		}
	})(ast);
	return { statics, dynamics, hasDefault };
}

/**
 * The modules that go into the bundles: every .js module of the manifest except .orig.js files
 * and files that are not ES modules (classic scripts, skipped AMD files). Modules whose static
 * imports cannot be bundled (missing targets such as SAPUI5-only libraries, or non-module
 * scripts) are excluded, transitively, so a bundle never contains a broken static import.
 * @returns {{byPackage, excluded, hasDefault, deps: Map<string, string[]>, dynamicDeps: Map<string, string[]>}}
 */
export function selectModules(manifest, esmReport, esmRoot, readFile = (f) => fs.readFileSync(f, "utf8")) {
	const notModules = new Set([
		...(esmReport.classicScripts ?? []),
		...(esmReport.skipped ?? []).map((s) => s.file),
		...(esmReport.obsoleteBootstrap ?? []), // legacy loader/bootstrap scripts, copied as is
	]);
	const candidates = Object.keys(manifest).filter((rel) => rel.endsWith(".js") && !rel.endsWith(".orig.js") && !notModules.has(rel));
	const known = new Set(Object.keys(manifest).filter((rel) => rel.endsWith(".js") && !notModules.has(rel)));
	const reasons = new Map();
	const deps = new Map();
	const dynamicDeps = new Map();
	const hasDefault = new Map();
	for (const rel of candidates) {
		let imp;
		try {
			imp = importsOf(readFile(path.join(esmRoot, ...rel.split("/"))));
		} catch (err) {
			reasons.set(rel, `not parseable as an ES module: ${err.message}`);
			continue;
		}
		hasDefault.set(rel, imp.hasDefault);
		dynamicDeps.set(rel, imp.dynamics.filter((s) => s.startsWith(".")).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), s))));
		const targets = [];
		for (const s of imp.statics) {
			if (!s.startsWith(".")) {
				reasons.set(rel, `imports external "${s}"`);
				break;
			}
			const t = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
			if (t === RUNTIME_TARGET) continue;
			if (!known.has(t)) {
				reasons.set(rel, `imports ${t}, which is ${manifest[t] ? "not an ES module" : "missing"}`);
				break;
			}
			targets.push(t);
		}
		deps.set(rel, targets);
	}
	// excludable modules that no other bundled module needs (transitively)
	const ruleOf = (rel) => BUNDLE_EXCLUDE.find((r) => r.test.test(rel));
	const isTest = (rel) => !!ruleOf(rel);
	const needed = new Set();
	const need = (rel) => {
		if (needed.has(rel)) return;
		needed.add(rel);
		for (const t of deps.get(rel) ?? []) need(t);
	};
	for (const rel of candidates) if (!isTest(rel)) need(rel);
	for (const rel of candidates) {
		if (isTest(rel) && !needed.has(rel) && !reasons.has(rel)) reasons.set(rel, ruleOf(rel).reason);
	}
	// propagate: importing an excluded module excludes the importer
	let changed = true;
	while (changed) {
		changed = false;
		for (const [rel, targets] of deps) {
			if (reasons.has(rel)) continue;
			const bad = targets.find((t) => reasons.has(t));
			if (bad) {
				reasons.set(rel, `imports excluded ${bad}`);
				changed = true;
			}
		}
	}
	const byPackage = new Map();
	for (const rel of candidates) {
		if (reasons.has(rel)) continue;
		const pkg = packageShortName(manifest[rel]);
		if (!byPackage.has(pkg)) byPackage.set(pkg, []);
		byPackage.get(pkg).push(rel);
	}
	const excluded = [...reasons].map(([module, reason]) => ({ module, reason })).sort((a, b) => (a.module < b.module ? -1 : 1));
	const selectedDeps = new Map([...deps].filter(([rel]) => !reasons.has(rel)));
	const selectedDynamic = new Map([...dynamicDeps].filter(([rel]) => !reasons.has(rel)).map(([rel, t]) => [rel, t.filter((x) => selectedDeps.has(x))]));
	return { byPackage, excluded, hasDefault, deps: selectedDeps, dynamicDeps: selectedDynamic };
}

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);
const gzipSize = async (buf) => (await gzip(buf, { level: 9 })).length;
const brotliSize = async (buf) => (await brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })).length;

/** raw / minified / gzip (level 9) / brotli (quality 11) sizes; compression runs on the thread pool. */
export async function sizesOf(raw, minified) {
	const buf = Buffer.from(minified);
	const [gz, br] = await Promise.all([gzipSize(buf), brotliSize(buf)]);
	return { raw: Buffer.byteLength(raw), minified: buf.length, gzip: gz, brotli: br };
}

/** Strongly connected components with more than one file (or a self loop) = cycles. */
export function findCycles(edges) {
	let index = 0;
	const idx = new Map();
	const low = new Map();
	const stack = [];
	const on = new Set();
	const cycles = [];
	const visit = (v) => {
		idx.set(v, index);
		low.set(v, index++);
		stack.push(v);
		on.add(v);
		for (const w of edges[v] ?? []) {
			if (!idx.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (on.has(w)) {
				low.set(v, Math.min(low.get(v), idx.get(w)));
			}
		}
		if (low.get(v) === idx.get(v)) {
			const comp = [];
			let w;
			do {
				w = stack.pop();
				on.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1 || (edges[v] ?? []).includes(v)) cycles.push(comp.sort());
		}
	};
	for (const v of Object.keys(edges)) if (!idx.has(v)) visit(v);
	return cycles;
}

/** Imports between the files of an output folder (static and dynamic). */
export function bundleImports(files) {
	const statics = {};
	const dynamics = {};
	for (const [name, code] of Object.entries(files)) {
		const { statics: s, dynamics: d } = importsOf(code);
		const local = (x) => x.startsWith("./") && Object.hasOwn(files, x.slice(2));
		statics[name] = [...new Set(s.filter(local).map((x) => x.slice(2)))].sort();
		dynamics[name] = [...new Set(d.filter(local).map((x) => x.slice(2)))].sort();
	}
	return { statics, dynamics };
}

const IGNORED_LOGS = ["EVAL", "THIS_IS_UNDEFINED", "CIRCULAR_DEPENDENCY", "INEFFECTIVE_DYNAMIC_IMPORT", "COMMONJS_VARIABLE_IN_ESM"];

async function runRolldown({ input, outDir, groupName, minify, sourcemap, write, missing, stubOf = new Map(), unknownIds = new Set() }) {
	// chunk file name = its group ("sap.m", "sap.m+sap.ui.fl" -> "sap.m_sap.ui.fl"), also for groups
	// with a single module (Rolldown would name those after the module)
	const chunkFileNames = (chunk) => {
		// Rolldown keeps its helpers (\0rolldown/runtime.js) in a chunk of their own
		if (chunk.moduleIds.every((id) => id.includes("rolldown/runtime"))) return "rolldown-runtime.js";
		const g = chunk.moduleIds.map((id) => groupName(id)).find(Boolean) ?? chunk.name;
		return `${g.replace(/\+/g, "_")}.js`;
	};
	const { rolldown } = await import("rolldown");
	const bundle = await rolldown({
		input,
		plugins: [{
			name: "esm-ui5",
			resolveId(source, importer, extra) {
				if (importer && source.startsWith(".")) {
					const target = path.resolve(path.dirname(importer), source);
					if (!fs.existsSync(target)) {
						missing.add(source);
						return { id: source, external: true }; // only reachable through dynamic imports
					}
					// import() of a module: through its stub (no entry), so Rolldown resolves it inside
					// the package chunk instead of emitting a module-path facade
					if (extra?.kind === "dynamic-import" && stubOf.has(real(target))) return stubOf.get(real(target));
				}
				return null;
			},
		}],
		preserveEntrySignatures: "allow-extension",
		logLevel: "warn",
		onLog(level, log, handler) {
			if (!IGNORED_LOGS.includes(log.code)) handler(level, log);
		},
	});
	const output = {
		dir: outDir,
		format: "esm",
		entryFileNames: "[name].js",
		chunkFileNames,
		minify,
		sourcemap,
		// every module wrapped in an init function, run on first use, in ES module order
		strictExecutionOrder: true,
		codeSplitting: {
			groups: [{ name: (id) => groupName(id) ?? (unknownIds.add(id), null), debugName: "esm-ui5", priority: 10, includeDependenciesRecursively: false }],
		},
	};
	const result = write ? await bundle.write(output) : await bundle.generate(output);
	await bundle.close();
	return result.output.filter((o) => o.type === "chunk");
}

/** Kind of an output chunk: package bundle, extra bundle, facade, registry or bootstrap. */
export function chunkKind(chunk, packages) {
	if (chunk.name === "esm-ui5-bootstrap") return "bootstrap";
	if (chunk.isEntry) return chunk.name.endsWith(".registry") ? "registry" : "facade";
	if (chunk.fileName === "rolldown-runtime.js") return "runtime";
	if (packages.includes(chunk.fileName.slice(0, -3))) return "package";
	return "extra";
}

const real = (f) => {
	try {
		return fs.realpathSync(f);
	} catch {
		return f;
	}
};

/**
 * Bundle dist/esm into dist/bundles.
 * @param {{out?: string, minifier?: "rolldown"|"oxc"|"none", sourcemap?: boolean, bundlesDir?: string,
 *          log?: (msg: string) => void}} opts
 */
export async function bundle(opts = {}) {
	const distRoot = path.resolve(opts.out ?? "dist");
	const minifier = opts.minifier ?? DEFAULT_MINIFIER;
	if (!MINIFIERS.includes(minifier)) throw new Error(`unknown minifier "${minifier}" (use ${MINIFIERS.join(", ")})`);
	const sourcemap = !!opts.sourcemap;
	const log = opts.log ?? ((m) => console.log(m));
	const esmRoot = path.join(distRoot, LAYOUT.esm);
	const reportsDir = path.join(distRoot, LAYOUT.reports);
	const outDir = path.resolve(opts.bundlesDir ?? path.join(distRoot, LAYOUT.bundles));
	const manifestFile = path.join(reportsDir, "esm-ui5-packages.json");
	if (!fs.existsSync(manifestFile)) throw new Error(`no ${manifestFile}; run the esm step first`);
	const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	const esmReport = JSON.parse(fs.readFileSync(path.join(reportsDir, "esm-ui5-report.json"), "utf8"));
	const esmFile = (rel) => path.join(esmRoot, ...rel.split("/"));

	// 1. modules, dependency closure, chunks
	const { byPackage, excluded, hasDefault, deps, dynamicDeps } = selectModules(manifest, esmReport, esmRoot);
	const packages = [...byPackage.keys()].sort();
	const pkgOf = (rel) => packageShortName(manifest[rel]);
	const libManifest = (pkg) => {
		const f = esmFile(`${pkg.replace(/\./g, "/")}/manifest.json`);
		return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
	};
	const allowed = allowedPackages(packages, libManifest);
	const chunkOf = assignChunks(deps, pkgOf, allowed);
	// sap.ui.core is loaded by every page: keep its main bundle to the hot part
	// roots: the Core, the core library, and the default calendar (loaded by a computed name)
	const literalsOf = (rel) => [...fs.readFileSync(esmFile(rel), "utf8").matchAll(/["'`]((?:sap|jquery)[\w./$-]*?)["'`]/g)].map((m) => m[1].replace(/\.js$/, ""));
	const roots = ["sap/ui/core/Core.js", "sap/ui/core/library.js", "sap/ui/core/date/Gregorian.js"];
	// boot: what the boot path needs; lib: what other libraries' main bundles need on top; lazy: the rest
	const boot = hotModules({ pkg: CORE, roots, deps, dynamicDeps, pkgOf, chunkOf: new Map(), literalsOf });
	const hot = hotModules({ pkg: CORE, roots, deps, dynamicDeps, pkgOf, chunkOf, literalsOf });
	for (const [rel, chunk] of chunkOf) {
		if (chunk !== CORE || boot.has(rel)) continue;
		chunkOf.set(rel, hot.has(rel) ? `${CORE}.lib` : `${CORE}.lazy`);
	}
	const namesToPkg = Object.fromEntries([...chunkOf.keys()].map((rel) => [rel.slice(0, -3), pkgOf(rel)]));
	const packagesMap = prefixMap(namesToPkg);

	// 2. sources in a temp folder: stubs, lazy registries, setup + bootstrap
	const tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), "esm-ui5-bundles-")));
	const runtimeFile = path.join(distRoot, LAYOUT.runtime, RUNTIME_FILE);
	fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
	fs.copyFileSync(RUNTIME_SRC, runtimeFile); // shared with esm/; keep it current
	const group = new Map(); // real path -> chunk name
	const input = {};
	for (const [rel, chunk] of chunkOf) {
		group.set(real(esmFile(rel)), chunk);
		const orig = esmFile(rel.replace(/\.js$/, ".orig.js"));
		if (fs.existsSync(orig)) group.set(real(orig), chunk);
	}
	const registries = {};
	const stubOf = new Map(); // real module path -> stub
	for (const pkg of packages) {
		const modules = byPackage.get(pkg).map((rel) => {
			const stub = path.join(tmp, "stubs", ...rel.split("/"));
			fs.mkdirSync(path.dirname(stub), { recursive: true });
			fs.writeFileSync(stub, stubSource(esmFile(rel), hasDefault.get(rel)));
			group.set(stub, chunkOf.get(rel));
			stubOf.set(real(esmFile(rel)), stub);
			return { name: rel.slice(0, -3), stub };
		});
		const libManifestFile = `${pkg.replace(/\./g, "/")}/manifest.json`;
		const preload = fs.existsSync(esmFile(libManifestFile)) ? { [libManifestFile]: fs.readFileSync(esmFile(libManifestFile), "utf8") } : null;
		const file = path.join(tmp, `${pkg}.registry.js`);
		fs.writeFileSync(file, lazyRegistrySource(modules, { runtimeFile, preload }));
		registries[pkg] = file; // no entry: the setup reaches it with import(), which loads only the package bundle
		group.set(file, pkg);
	}
	const version = esmFile("sap-ui-version.json");
	const { setup, bootstrap } = bundlesBootstrapSources({
		runtimeFile, coreFile: esmFile("sap/ui/core/Core.js"), packages: packagesMap, registries,
		preload: fs.existsSync(version) ? { "sap-ui-version.json": fs.readFileSync(version, "utf8") } : {},
	});
	const setupFile = path.join(tmp, "esm-ui5-setup.js");
	const bootstrapFile = path.join(tmp, "esm-ui5-bootstrap.js");
	fs.writeFileSync(setupFile, setup);
	fs.writeFileSync(bootstrapFile, bootstrap(setupFile));
	if (fs.existsSync(esmFile("sap/ui/core/Core.js"))) input["esm-ui5-bootstrap"] = bootstrapFile;
	for (const f of [setupFile, bootstrapFile, real(runtimeFile)]) group.set(f, CORE);
	const groupName = (id) => {
		return group.get(id.replace(/[?#].*$/, "")) ?? null;
	};
	const chunkNames = [...new Set(chunkOf.values())];
	log(`  bundling ${chunkOf.size} modules of ${packages.length} packages into ${chunkNames.length} chunks (${excluded.length} excluded), minifier ${minifier}`);

	// 3. rolldown (+ minify)
	freshDir(outDir);
	const missing = new Set();
	const t0 = Date.now();
	const unknownIds = new Set();
	const rawChunks = await runRolldown({ input, outDir, groupName, minify: false, sourcemap: sourcemap && minifier !== "rolldown", write: minifier !== "rolldown", missing, stubOf, unknownIds });
	const rawCode = Object.fromEntries(rawChunks.map((c) => [c.fileName, c.code]));
	const kinds = Object.fromEntries(rawChunks.map((c) => [c.fileName, chunkKind(c, packages)]));
	let finalCode = rawCode;
	if (minifier === "rolldown") {
		const min = await runRolldown({ input, outDir, groupName, minify: true, sourcemap, write: true, missing, stubOf });
		finalCode = Object.fromEntries(min.map((c) => [c.fileName, c.code]));
	} else if (minifier === "oxc") {
		const { minifySync } = await import("oxc-minify");
		finalCode = {};
		for (const [file, code] of Object.entries(rawCode)) {
			// keep license comments (/*! ... */, @license, @preserve): Apache-2.0 / MIT / BSD notices
			const r = minifySync(path.basename(file), code, { module: true, compress: true, mangle: true, sourcemap, codegen: { legalComments: "inline" } });
			if (r.errors?.length) throw new Error(`oxc-minify ${file}: ${r.errors[0].message}`);
			finalCode[file] = r.code + (sourcemap ? `\n//# sourceMappingURL=${path.basename(file)}.map\n` : "");
			fs.writeFileSync(path.join(outDir, file), finalCode[file]);
			if (sourcemap && r.map) fs.writeFileSync(path.join(outDir, file + ".map"), JSON.stringify(r.map));
		}
	}
	// Apache-2.0 §4(b): every bundle with OpenUI5 code says that it was modified and where the licenses are
	for (const [file, code] of Object.entries(finalCode)) {
		if (kinds[file] !== "package" && kinds[file] !== "extra") continue;
		finalCode[file] = `${BUNDLE_NOTICE}\n${code}`;
		fs.writeFileSync(path.join(outDir, file), finalCode[file]);
	}
	// the bootstrap imports Rolldown's helper chunk and the core's library part directly: the browser
	// fetches (and compiles off the main thread) them in parallel with sap.ui.core.js instead of
	// discovering them later. Importing a chunk runs nothing; its modules run on first use.
	if (finalCode["esm-ui5-bootstrap.js"]) {
		const early = ["rolldown-runtime.js", `${CORE}.lib.js`].filter((f) => finalCode[f]);
		finalCode["esm-ui5-bootstrap.js"] = early.map((f) => `import "./${f}";\n`).join("") + finalCode["esm-ui5-bootstrap.js"];
		fs.writeFileSync(path.join(outDir, "esm-ui5-bootstrap.js"), finalCode["esm-ui5-bootstrap.js"]);
	}
	const seconds = (Date.now() - t0) / 1000;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });

	// 4. report
	const isFacade = (f) => kinds[f] === "facade";
	const topFiles = Object.keys(finalCode).filter((f) => !isFacade(f)).sort();
	const sizes = await Promise.all(topFiles.map(async (file) => ({ file, kind: kinds[file], ...(await sizesOf(rawCode[file] ?? finalCode[file], finalCode[file])) })));
	const facades = Object.keys(finalCode).filter(isFacade);
	const facadeBytes = facades.reduce((a, f) => a + Buffer.byteLength(finalCode[f]), 0);
	const sum = (k, list = sizes) => list.reduce((a, s) => a + s[k], 0);
	const totals = Object.fromEntries(["raw", "minified", "gzip", "brotli"].map((k) => [k, sum(k)]));
	const { statics, dynamics } = bundleImports(Object.fromEntries(topFiles.map((f) => [f, finalCode[f]])));
	const pkgFiles = sizes.filter((s) => s.kind === "package");
	const esmFiles = [...chunkOf.keys()];
	let esmRaw = 0;
	let esmGzip = 0;
	for (let i = 0; i < esmFiles.length; i += 64) {
		const bufs = esmFiles.slice(i, i + 64).map((rel) => fs.readFileSync(esmFile(rel)));
		esmRaw += bufs.reduce((a, b) => a + b.length, 0);
		esmGzip += (await Promise.all(bufs.map(gzipSize))).reduce((a, b) => a + b, 0);
	}
	const report = {
		minifier,
		minifierDetail: { rolldown: "Rolldown output.minify (Oxc minifier inside Rolldown)", oxc: "oxc-minify on each output file (compress + mangle, module)", none: "not minified" }[minifier],
		rolldownVersion: (await import("rolldown")).VERSION ?? null,
		sourcemap,
		seconds,
		packages: packages.map((pkg) => ({ package: pkg, modules: byPackage.get(pkg).length, allowedDependencies: [...allowed.get(pkg)].filter((p) => p !== pkg).sort() })),
		chunks: Object.fromEntries(chunkNames.sort().map((c) => [c, [...chunkOf.values()].filter((x) => x === c).length])), // modules per chunk ("+" is "_" in file names)
		files: sizes,
		facades: { count: facades.length, bytes: facadeBytes },
		totals,
		packageBundles: { count: pkgFiles.length, ...Object.fromEntries(["raw", "minified", "gzip", "brotli"].map((k) => [k, sum(k, pkgFiles)])) },
		esmComparison: { files: esmFiles.length, raw: esmRaw, gzipSumOfFiles: esmGzip },
		packagePrefixes: packagesMap,
		importsBetweenBundles: statics,
		dynamicImportsBetweenBundles: dynamics,
		circularImports: findCycles(statics),
		externalDynamicImports: [...missing].sort(),
		modulesWithoutChunkGroup: [...unknownIds].filter((id) => !id.endsWith("esm-ui5-bootstrap.js")).slice(0, 20),
		excludedModules: excluded,
	};
	writeJson(path.join(reportsDir, "bundle-report.json"), report);
	log(bundleSummary(report, outDir));
	return report;
}

const kb = (n) => (n / 1024).toFixed(1).padStart(9) + " KiB";

export function bundleSummary(report, outDir) {
	const lines = [``, `bundles (${report.minifier}) -> ${outDir}  [${report.seconds.toFixed(1)} s]`];
	lines.push(`  ${"file".padEnd(40)}${"raw".padStart(13)}${"min".padStart(13)}${"gzip".padStart(13)}${"brotli".padStart(13)}`);
	for (const s of report.files.filter((f) => f.kind === "package" || f.kind === "extra" || f.kind === "bootstrap")) {
		lines.push(`  ${s.file.padEnd(40)}${kb(s.raw)}${kb(s.minified)}${kb(s.gzip)}${kb(s.brotli)}`);
	}
	const t = report.totals;
	lines.push(`  ${"total (+ registries)".padEnd(40)}${kb(t.raw)}${kb(t.minified)}${kb(t.gzip)}${kb(t.brotli)}`);
	lines.push(`  ${report.facades.count} facades (${kb(report.facades.bytes).trim()}); esm/ (same modules): ${report.esmComparison.files} files, ${kb(report.esmComparison.raw).trim()} raw`);
	lines.push(`  circular imports between bundles: ${report.circularImports.length}; excluded modules: ${report.excludedModules.length}`);
	return lines.join("\n");
}
