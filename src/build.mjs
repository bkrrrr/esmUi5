// The "esm" step: merge all @<scope>/* UI5 packages into one tree, convert AMD to ESM, wrap
// thirdparty scripts, build themes, and write dist/esm, dist/runtime and the reports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, isPlainModule, parse, RUNTIME_DEP } from "./convert.mjs";
import { analyseAutoconfig, thirdpartyWrapper, origEnvelope, addRegistration, libraryManifest, shimConfigOf } from "./legacy.mjs";
import { buildThemes, findThemes, DEFAULT_THEMES } from "./themes.mjs";
import { writeBootstrap } from "./bootstrap.mjs";
import { writeLicenses } from "./licenses.mjs";

export { DEFAULT_THEMES };

const posix = path.posix;
/** dist/ layout */
export const LAYOUT = { esm: "esm", bundles: "bundles", runtime: "runtime", demo: "demo", reports: "reports" };
export const RUNTIME_FILE = "ui5-next-runtime.js";
/** the runtime, seen from the root of dist/esm */
export const RUNTIME_TARGET = `../${LAYOUT.runtime}/${RUNTIME_FILE}`;
// replaces what ui5loader-autoconfig.js defined inline (not the app-facing bootstrap)
const AUTOCONFIG_FILE = "ui5-next-autoconfig.js";
const RUNTIME_SRC = fileURLToPath(new URL("./runtime.js", import.meta.url));
const THIRDPARTY_GLOBALS = fileURLToPath(new URL("./thirdparty-globals.json", import.meta.url));

const NEVER_COPY = [/(^|\/)\.DS_Store$/, /-dbg\.js$/, /\.min\.js$/, /-preload\.js$/, /-preload\.json$/, /\.js\.map$/];
const LEGACY = {
	"jQuery.sap.": /jQuery\.sap\./g,
	"sap.ui.requireSync": /sap\.ui\.requireSync/g,
	"sap.ui.getCore(": /sap\.ui\.getCore\(/g,
};

/**
 * Map a dependency of the file at relative path `file` to an import specifier.
 * @param {string} file relative posix path of the importing file
 * @param {string} dep UI5 dependency name
 * @param {Set<string>} roots top-level namespace names of the merged tree
 * @returns {{specifier: string, target: string|null, external: boolean}}
 */
export function resolveSpecifier(file, dep, roots, aliases = {}, exists = () => false) {
	const ext = { specifier: dep, target: null, external: true };
	if (dep.includes("!")) return ext;
	if (Object.hasOwn(aliases, dep)) dep = aliases[dep];
	const dir = posix.dirname(file);
	let target;
	if (dep === RUNTIME_DEP) {
		// lives outside the esm tree (dist/runtime), shared by esm/ and bundles/
		let specifier = posix.relative(dir, RUNTIME_TARGET);
		if (!specifier.startsWith("../")) specifier = "./" + specifier;
		return { specifier, target: RUNTIME_TARGET, external: false };
	} else if (dep.startsWith("./") || dep.startsWith("../")) target = posix.normalize(posix.join(dir, dep));
	else if (roots.has(dep.split("/")[0])) target = posix.normalize(dep);
	else return ext;
	if (target === ".." || target.startsWith("../") || target.startsWith("/")) return ext;
	// UI5 module names never carry ".js"; "x.css" is the module x.css.js if that exists
	if (!/\.m?js$/.test(target) && (!/\.(json|css)$/.test(target) || exists(target + ".js"))) target += ".js";
	let specifier = posix.relative(dir, target);
	if (!specifier.startsWith("../")) specifier = "./" + specifier;
	return { specifier, target, external: false };
}

/** Find packages under <from>/node_modules/@<scope>/*. */
export function discoverPackages(from, scopes) {
	const packages = [];
	const ignoredPackages = [];
	for (const scope of scopes) {
		const scopeDir = path.join(from, "node_modules", "@" + scope);
		if (!fs.existsSync(scopeDir)) continue;
		for (const entry of fs.readdirSync(scopeDir).sort()) {
			const dir = path.join(scopeDir, entry);
			const pjPath = path.join(dir, "package.json");
			if (!fs.existsSync(pjPath)) continue;
			const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
			const rootName = ["src", "resources"].find((r) => {
				try {
					return fs.statSync(path.join(dir, r)).isDirectory();
				} catch {
					return false;
				}
			});
			if (!rootName) {
				ignoredPackages.push({ name: pj.name, version: pj.version, reason: "no src or resources folder" });
				continue;
			}
			packages.push({ name: pj.name, version: pj.version, root: path.join(dir, rootName), rootName });
		}
	}
	return { packages, ignoredPackages };
}

function* walkFiles(dir, rel = "") {
	for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const r = rel ? rel + "/" + e.name : e.name;
		if (e.isDirectory()) yield* walkFiles(path.join(dir, e.name), r);
		else if (e.isFile()) yield [r, path.join(dir, e.name)];
	}
}

function sameBytes(a, b) {
	if (fs.statSync(a).size !== fs.statSync(b).size) return false;
	return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Normalize an error message into a groupable skip reason. */
function reasonOf(err) {
	return String(err?.message ?? err).replace(/\s*\(\d+:\d+\)/g, "");
}

/** Remove a directory safely (refuses cwd, --from, folders with node_modules). */
export function removeDir(absOut, from = ".") {
	if (!fs.existsSync(absOut)) return;
	const cwd = process.cwd();
	const absFrom = path.resolve(from);
	const inside = (child, parent) => {
		const r = path.relative(parent, child);
		return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
	};
	if (absOut === cwd || inside(cwd, absOut)) throw new Error(`--clean refused: ${absOut} is (or contains) the current directory`);
	if (inside(absFrom, absOut)) throw new Error(`--clean refused: ${absOut} is (or contains) the --from directory`);
	if (fs.existsSync(path.join(absOut, "node_modules"))) throw new Error(`--clean refused: ${absOut} contains node_modules`);
	// move it away first (atomic), so a slow or failing delete (e.g. macOS Spotlight
	// indexing the tree: ENOTEMPTY) never leaves a half-deleted output behind
	// into the OS temp dir if it is on the same volume (a leftover does not matter there)
	let trash = path.join(os.tmpdir(), `ui5-next-old-${process.pid}-${Date.now()}`);
	try {
		fs.renameSync(absOut, trash);
	} catch {
		trash = `${absOut}.old-${process.pid}-${Date.now()}`;
		fs.renameSync(absOut, trash);
	}
	try {
		fs.rmSync(trash, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (err) {
		console.warn(`ui5-next: could not remove old output ${trash} (${err.code ?? err.message}); delete it manually`);
	}
}

/**
 * Empty an output folder the build owns: move it into the temp dir first (atomic), then delete;
 * a failing delete (macOS Spotlight: ENOTEMPTY) only leaves a leftover in the temp dir.
 */
export function freshDir(dir) {
	if (fs.existsSync(dir)) {
		let trash = path.join(os.tmpdir(), `ui5-next-old-${process.pid}-${Date.now()}-${path.basename(dir)}`);
		try {
			fs.renameSync(dir, trash);
		} catch {
			trash = `${dir}.old-${process.pid}-${Date.now()}`;
			fs.renameSync(dir, trash);
		}
		try {
			fs.rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			/* leftover in the temp dir */
		}
	}
	fs.mkdirSync(dir, { recursive: true });
}

function prepareOut(out, from, { clean, force }) {
	const absOut = path.resolve(out);
	if (clean) removeDir(absOut, from);
	if (fs.existsSync(absOut) && fs.readdirSync(absOut).length && !force) {
		throw new Error(`output directory ${absOut} is not empty (use --force to overwrite or --clean to remove it)`);
	}
	fs.mkdirSync(absOut, { recursive: true });
	return absOut;
}

/** Write a JSON file, creating its folder. */
export function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Package manifest: esm-relative path -> npm package name, sorted by path. */
export function packageManifest(entries) {
	return Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * The esm step.
 * @param {{from?: string, out?: string, scopes?: string[], clean?: boolean, force?: boolean,
 *          themes?: string[] | "all", thirdpartyGlobals?: object, version?: string,
 *          log?: (msg: string) => void}} opts   out = the dist root; writes out/esm, out/runtime, out/reports
 */
export async function build(opts = {}) {
	const { from = ".", out = "dist", scopes = ["openui5", "sapui5"], clean = false, force = false } = opts;
	const themes = opts.themes ?? DEFAULT_THEMES; // array of theme names, or "all"
	const log = opts.log ?? ((m) => console.log(m));
	const thirdpartyGlobals = opts.thirdpartyGlobals ?? JSON.parse(fs.readFileSync(THIRDPARTY_GLOBALS, "utf8"));
	const distRoot = path.resolve(out);
	const reportsDir = path.join(distRoot, LAYOUT.reports);

	// 1. discovery
	const { packages, ignoredPackages } = discoverPackages(from, scopes);
	if (!packages.length) {
		const err = new Error(`no packages with a src or resources folder found under ${path.resolve(from, "node_modules")} (scopes: ${scopes.join(", ")})`);
		err.code = "NO_PACKAGES";
		throw err;
	}
	const version = opts.version ?? packages.find((p) => p.name.endsWith("/sap.ui.core"))?.version ?? packages[0].version;

	// 2. merge
	const tree = new Map(); // rel -> {abs, pkg}
	const collisions = [];
	let identicalCollisions = 0;
	let neverCopied = 0;
	for (const pkg of packages) {
		for (const [rel, abs] of walkFiles(pkg.root)) {
			if (NEVER_COPY.some((re) => re.test(rel))) {
				neverCopied++;
				continue;
			}
			const prev = tree.get(rel);
			if (!prev) tree.set(rel, { abs, pkg: pkg.name });
			else if (prev.abs && sameBytes(prev.abs, abs)) identicalCollisions++;
			else collisions.push({ file: rel, kept: prev.pkg, ignored: pkg.name });
		}
	}

	// modules defined inline by the legacy bootstrap become real files
	const extracted = [];
	let shim = {};
	let aliases = {};
	const autoconfig = tree.get("ui5loader-autoconfig.js");
	if (autoconfig) {
		const info = analyseAutoconfig(fs.readFileSync(autoconfig.abs, "utf8"));
		shim = info.shim;
		aliases = info.map;
		for (const [name, text] of info.modules) {
			const rel = name + ".js";
			if (tree.has(rel)) continue;
			tree.set(rel, { abs: null, text, pkg: autoconfig.pkg, generated: true });
			extracted.push(rel);
		}
	}
	// the runtime shim replaces the legacy loader; ui5-next-bootstrap.js replaces what
	// ui5loader-autoconfig.js provided (the inline configuration modules): ui5-next-autoconfig.js
	aliases["ui5loader"] = RUNTIME_DEP;
	if (extracted.length) {
		const deps = extracted.map((r) => r.slice(0, -3));
		tree.set(AUTOCONFIG_FILE, {
			abs: null, pkg: autoconfig.pkg, generated: true,
			text: `/* generated by ui5-next: replaces ui5loader-autoconfig.js */\nsap.ui.define(${JSON.stringify(deps)}, function() {});\n`,
		});
		extracted.push(AUTOCONFIG_FILE);
		aliases["ui5loader-autoconfig"] = AUTOCONFIG_FILE.slice(0, -3);
	} else {
		aliases["ui5loader-autoconfig"] = RUNTIME_DEP;
	}
	const readText = (entry) => entry.text ?? fs.readFileSync(entry.abs, "utf8");

	const roots = new Set();
	for (const rel of tree.keys()) {
		const i = rel.indexOf("/");
		if (i > 0) roots.add(rel.slice(0, i));
		else if (rel.endsWith(".js")) roots.add(rel.slice(0, -3));
	}

	const absOut = prepareOut(path.join(distRoot, LAYOUT.esm), from, { clean, force });
	// package manifest: every file written to esm/ -> its npm package (first package wins)
	const manifest = new Map();
	const pkgOf = (rel) => tree.get(rel)?.pkg;

	// 3.-6. convert / copy
	const stats = {
		packages: packages.length, files: tree.size, neverCopied, identicalCollisions,
		differentCollisions: collisions.length, copied: 0, converted: 0, unchanged: 0,
		classicScripts: 0, wrapped: 0, extracted: extracted.length, skipped: 0, filesWithWarnings: 0, warnings: 0,
	};
	const skipped = [];
	const warnings = [];
	const obsoleteBootstrap = [];
	const firstImportedBy = new Map(); // target -> first importer
	const externalSpecifiers = {};
	const legacyReferences = Object.fromEntries(Object.keys(LEGACY).map((k) => [k, { occurrences: 0, files: 0 }]));

	const write = (rel, data, pkg = pkgOf(rel)) => {
		if (pkg) manifest.set(rel, pkg);
		const dest = path.join(absOut, ...rel.split("/"));
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, data);
		if (rel.endsWith(".js")) {
			const text = typeof data === "string" ? data : data.toString("utf8");
			for (const [k, re] of Object.entries(LEGACY)) {
				const n = (text.match(re) || []).length;
				if (n) {
					legacyReferences[k].occurrences += n;
					legacyReferences[k].files++;
				}
			}
		}
	};

	const runtimeSpecFor = (rel) => resolveSpecifier(rel, RUNTIME_DEP, roots).specifier;
	const recordImports = (rel, fileImports) => {
		for (const r of fileImports) {
			if (r.external) externalSpecifiers[r.specifier] = (externalSpecifiers[r.specifier] ?? 0) + 1;
			else if (!firstImportedBy.has(r.target)) firstImportedBy.set(r.target, rel);
		}
	};
	const classic = new Map(); // classic (non-module, non-AMD) scripts: rel -> source

	let done = 0;
	for (const [rel, entry] of tree) {
		if (++done % 500 === 0) log(`  ${done}/${tree.size} files`);
		const base = posix.basename(rel);
		const isJs = rel.endsWith(".js");
		const loader = isJs && base.startsWith("ui5loader");
		const bootstrap = isJs && !rel.includes("/") && /^sap-ui-.*\.js$/.test(base);
		const thirdparty = /(^|\/)thirdparty\//.test(rel);
		if (!isJs || loader || bootstrap) {
			if (loader || bootstrap) obsoleteBootstrap.push(rel);
			write(rel, entry.text ?? fs.readFileSync(entry.abs));
			stats.copied++;
			continue;
		}
		const src = readText(entry);
		if (thirdparty && !/\bsap\.ui\.define\s*\(/.test(src) && !isPlainModule(src)) {
			classic.set(rel, src); // a classic script, possibly using sap.ui.require at runtime
			continue;
		}
		if (isPlainModule(src)) {
			write(rel, src);
			stats.unchanged++;
			continue;
		}
		const fileImports = [];
		const spec = (dep) => {
			const r = resolveSpecifier(rel, dep, roots, aliases, (t) => tree.has(t));
			fileImports.push(r);
			return r.specifier;
		};
		let result;
		try {
			result = convert(src, spec, { syncRequire: "probe" });
		} catch (err) {
			if (thirdparty) {
				classic.set(rel, src);
				continue;
			}
			skipped.push(err?.line ? { file: rel, reason: reasonOf(err), line: err.line } : { file: rel, reason: reasonOf(err) });
			stats.skipped++;
			write(rel, src);
			continue;
		}
		if (result === null) {
			// no loader call and no import/export: a classic script (ace editor files, ...)
			classic.set(rel, src);
			continue;
		}
		recordImports(rel, fileImports);
		if (src.includes("sap.ui.loader.config")) Object.assign(shim, shimConfigOf(src));
		if (result.warnings.length) {
			stats.filesWithWarnings++;
			stats.warnings += result.warnings.length;
			warnings.push({ file: rel, warnings: result.warnings });
		}
		const name = rel.slice(0, -3);
		write(rel, addRegistration(result.code, name, runtimeSpecFor(rel), "./" + base));
		stats.converted++;
	}

	// classic scripts: wrap those listed in thirdparty-globals.json as
	//   <name>.js = import "./<name>.orig.js"; export default globalThis[<global>]
	// copy the others as is; report imported-but-unlisted ones (they cannot work as modules)
	// thirdparty-globals.json values: "<global>" | null | { "global": "<global>"|null, "deps": [...] }
	const listed = (rel) => {
		const v = thirdpartyGlobals[rel.slice(0, -3)];
		return v && typeof v === "object" ? { global: v.global ?? null, deps: v.deps ?? [] } : { global: v ?? null, deps: [] };
	};
	const shimDeps = (rel) => [...new Set([...[].concat(shim[rel.slice(0, -3)]?.deps ?? []), ...(isListed(rel) ? listed(rel).deps : [])])]
		.filter((d) => typeof d === "string");
	const isListed = (rel) => Object.hasOwn(thirdpartyGlobals, rel.slice(0, -3));
	const wrap = new Set([...classic.keys()].filter(isListed));
	const unwrapped = new Map(); // rel -> first importer
	const missingGlobals = Object.keys(thirdpartyGlobals).filter((n) => !classic.has(n + ".js") && !n.startsWith("//"));
	const classicScripts = [];
	for (const [rel, src] of classic) {
		if (!wrap.has(rel)) {
			write(rel, src);
			classicScripts.push(rel);
			stats.classicScripts++;
			continue;
		}
		const { global } = listed(rel);
		const origFile = posix.basename(rel).replace(/\.js$/, ".orig.js");
		const fileImports = [];
		const depSpecs = shimDeps(rel).map((d) => {
			const r = resolveSpecifier(rel, d, roots, aliases);
			fileImports.push(r);
			if (!wrap.has(d + ".js") && classic.has(d + ".js") && !unwrapped.has(d + ".js")) unwrapped.set(d + ".js", rel);
			return r.specifier;
		});
		recordImports(rel, fileImports);
		write(posix.join(posix.dirname(rel), origFile), origEnvelope(src, global), pkgOf(rel));
		write(rel, thirdpartyWrapper({ origFile, global, depSpecs }));
		stats.wrapped++;
	}
	for (const rel of classic.keys()) {
		if (!wrap.has(rel) && firstImportedBy.has(rel) && !unwrapped.has(rel)) unwrapped.set(rel, firstImportedBy.get(rel));
	}
	const unwrappedThirdparty = [...unwrapped]
		.map(([rel, by]) => ({ module: rel.slice(0, -3), firstImportedBy: by, suggestedGlobal: shim[rel.slice(0, -3)]?.exports ?? null }))
		.sort((a, b) => (a.module < b.module ? -1 : 1));
	stats.unwrappedThirdparty = unwrappedThirdparty.length;

	// 7. package.json, runtime, report
	const corePkg = tree.get("sap/ui/core/library.js")?.pkg ?? packages[0].name;
	fs.writeFileSync(path.join(absOut, "package.json"), JSON.stringify({ name: "ui5-next-esm", version, type: "module" }, null, 2) + "\n");
	writeBootstrap(absOut, "esm"); // esm/ui5-next-bootstrap.js + esm/ui5-next-setup.js
	// Apache-2.0 §4: LICENSE, NOTICE and the OpenUI5 license files (incl. third-party licenses)
	const licenseFilesWritten = writeLicenses(distRoot, packages);
	fs.mkdirSync(path.join(distRoot, LAYOUT.runtime), { recursive: true });
	fs.copyFileSync(RUNTIME_SRC, path.join(distRoot, LAYOUT.runtime, RUNTIME_FILE));
	// normally generated by the UI5 tooling; Lib/VersionInfo load it at runtime
	if (!tree.has("sap-ui-version.json")) {
		write("sap-ui-version.json", JSON.stringify({
			name: "ui5-next", version, buildTimestamp: new Date().toISOString().replace(/\D/g, "").slice(0, 12),
			libraries: packages.filter((p) => !/themelib_/.test(p.name)).map((p) => ({ name: p.name.split("/").pop(), version: p.version })),
		}, null, 2) + "\n", corePkg);
	}

	// library manifest.json from .library (normally generated by the UI5 tooling)
	let manifests = 0;
	for (const rel of tree.keys()) {
		if (!rel.endsWith("/.library")) continue;
		const dir = posix.dirname(rel);
		if (tree.has(`${dir}/manifest.json`)) continue;
		const files = [...tree.keys()].filter((k) => posix.dirname(k) === dir).map((k) => posix.basename(k));
		write(`${dir}/manifest.json`, JSON.stringify(libraryManifest(readText(tree.get(rel)), files), null, 2) + "\n", pkgOf(rel));
		manifests++;
	}
	stats.libraryManifests = manifests;

	// themes (less-openui5): library.source.less -> library.css & co., next to the sources
	const wanted = findThemes(tree.keys()).filter((t) => themes === "all" || themes.includes(t.theme));
	const themeResult = wanted.length ? await buildThemes(absOut, wanted, log) : { compiled: [], themeFailures: [], written: [] };
	for (const rel of themeResult.written) manifest.set(rel, pkgOf(`${posix.dirname(rel)}/library.source.less`));
	stats.themesCompiled = themeResult.compiled.length;
	stats.themeFailures = themeResult.themeFailures.length;

	const present = new Set(tree.keys());
	for (const rel of wrap) present.add(rel.replace(/\.js$/, ".orig.js"));
	present.add(RUNTIME_TARGET);
	const unresolvedImports = [...firstImportedBy]
		.filter(([target]) => !present.has(target))
		.map(([target, by]) => ({ target, firstImportedBy: by }))
		.sort((a, b) => (a.target < b.target ? -1 : 1));
	stats.unresolvedImports = unresolvedImports.length;
	stats.externalSpecifiers = Object.keys(externalSpecifiers).length;
	stats.externalImports = Object.values(externalSpecifiers).reduce((a, b) => a + b, 0);

	const report = {
		ui5Version: version,
		packages: packages.map(({ name, version, rootName }) => ({ name, version, root: rootName })),
		ignoredPackages,
		stats,
		collisions,
		skipped,
		warnings,
		obsoleteBootstrap,
		licenseFiles: licenseFilesWritten,
		extracted,
		wrappedThirdparty: [...wrap].sort(),
		unwrappedThirdparty,
		thirdpartyGlobalsWithoutScript: missingGlobals,
		classicScripts: classicScripts.sort(),
		themes: { theme: themes, compiled: themeResult.compiled },
		themeFailures: themeResult.themeFailures,
		unresolvedImports,
		externalSpecifiers: Object.fromEntries(Object.entries(externalSpecifiers).sort((a, b) => b[1] - a[1])),
		legacyReferences,
	};
	writeJson(path.join(reportsDir, "ui5-next-report.json"), report);
	writeJson(path.join(reportsDir, "ui5-next-packages.json"), packageManifest(manifest));

	// 8. summary
	log(summary(report, absOut, reportsDir));
	return report;
}

export function topSkipReasons(report, n = 10) {
	const counts = new Map();
	for (const { reason } of report.skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function summary(report, absOut, reportsDir) {
	const s = report.stats;
	const lines = [
		``,
		`UI5 Next ${report.ui5Version} -> ${absOut}`,
		`  packages:     ${s.packages} (${report.ignoredPackages.length} ignored)`,
		`  files:        ${s.files} (${s.neverCopied} never copied, collisions: ${s.identicalCollisions} identical, ${s.differentCollisions} different)`,
		`  converted:    ${s.converted}`,
		`  unchanged:    ${s.unchanged} ES modules`,
		`  classic:      ${s.classicScripts} classic scripts copied as is (not modules, no loader call)`,
		`  copied raw:   ${s.copied} (${report.obsoleteBootstrap.length} obsolete bootstrap/loader files)`,
		`  thirdparty:   ${s.wrapped} wrapped (thirdparty-globals.json), ${s.unwrappedThirdparty} imported but not listed`,
		`  extracted:    ${s.extracted} modules from the legacy bootstrap`,
		`  themes:       ${s.themesCompiled} library themes built (less-openui5), ${s.themeFailures} failures`,
		`  skipped:      ${s.skipped}`,
		`  warnings:     ${s.warnings} in ${s.filesWithWarnings} files`,
		`  unresolved:   ${s.unresolvedImports} import targets`,
		`  external:     ${s.externalSpecifiers} specifiers, ${s.externalImports} imports`,
		`  legacy refs:  ${Object.entries(report.legacyReferences).map(([k, v]) => `${k} ${v.occurrences} (${v.files} files)`).join(", ")}`,
	];
	const top = topSkipReasons(report, 5);
	if (top.length) {
		lines.push(`  top skip reasons:`);
		for (const [r, n] of top) lines.push(`    ${String(n).padStart(5)}  ${r}`);
	}
	lines.push(`  reports:      ${reportsDir}`);
	return lines.join("\n");
}

/**
 * The "themes" step on its own: (re)build themes inside an existing dist/esm and update the
 * reports (themes, themeFailures, package manifest).
 */
export async function themesStep({ out = "dist", themes = DEFAULT_THEMES, log = (m) => console.log(m) } = {}) {
	const distRoot = path.resolve(out);
	const esmRoot = path.join(distRoot, LAYOUT.esm);
	if (!fs.existsSync(esmRoot)) throw new Error(`no ${esmRoot}; run the esm step first`);
	const rels = [...walkFiles(esmRoot)].map(([rel]) => rel);
	const wanted = findThemes(rels).filter((t) => themes === "all" || themes.includes(t.theme));
	const result = await buildThemes(esmRoot, wanted, log);
	const reportFile = path.join(distRoot, LAYOUT.reports, "ui5-next-report.json");
	const manifestFile = path.join(distRoot, LAYOUT.reports, "ui5-next-packages.json");
	if (fs.existsSync(reportFile)) {
		const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
		report.themes = { theme: themes, compiled: result.compiled };
		report.themeFailures = result.themeFailures;
		report.stats.themesCompiled = result.compiled.length;
		report.stats.themeFailures = result.themeFailures.length;
		writeJson(reportFile, report);
	}
	if (fs.existsSync(manifestFile)) {
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		for (const rel of result.written) manifest[rel] = manifest[`${path.posix.dirname(rel)}/library.source.less`];
		writeJson(manifestFile, packageManifest(Object.entries(manifest)));
	}
	log(`themes: ${result.compiled.length} built, ${result.themeFailures.length} failures`);
	return result;
}
