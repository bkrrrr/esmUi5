// Merge all @<scope>/* UI5 packages into one tree, convert AMD to ESM, write, report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, isPlainModule, parse, RUNTIME_DEP } from "./convert.mjs";
import { analyseAutoconfig, classicWrapper, addRegistration, libraryManifest, shimConfigOf } from "./legacy.mjs";
import { loadLess, compileTheme, themeFooter, findThemes } from "./themes.mjs";

export const DEFAULT_THEMES = ["sap_horizon", "sap_horizon_dark", "sap_horizon_hcb", "sap_horizon_hcw"];

const posix = path.posix;
const RUNTIME_FILE = "ui5-next-runtime.js";
const BOOTSTRAP_FILE = "ui5-next-bootstrap.js";
const RUNTIME_SRC = fileURLToPath(new URL("./runtime.js", import.meta.url));
const BOOT_FILE = "ui5-next-boot.js";
const BOOT_SRC = fileURLToPath(new URL("./boot.js", import.meta.url));

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
	if (dep === RUNTIME_DEP) target = RUNTIME_FILE;
	else if (dep.startsWith("./") || dep.startsWith("../")) target = posix.normalize(posix.join(dir, dep));
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

function prepareOut(out, from, { clean, force }) {
	const absOut = path.resolve(out);
	if (clean && fs.existsSync(absOut)) {
		const cwd = process.cwd();
		const absFrom = path.resolve(from);
		const inside = (child, parent) => {
			const r = path.relative(parent, child);
			return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
		};
		if (absOut === cwd || inside(cwd, absOut)) throw new Error(`--clean refused: ${absOut} is (or contains) the current directory`);
		if (inside(absFrom, absOut)) throw new Error(`--clean refused: ${absOut} is (or contains) the --from directory`);
		if (fs.existsSync(path.join(absOut, "node_modules"))) throw new Error(`--clean refused: ${absOut} contains node_modules`);
		fs.rmSync(absOut, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
	if (fs.existsSync(absOut) && fs.readdirSync(absOut).length && !force) {
		throw new Error(`output directory ${absOut} is not empty (use --force to overwrite or --clean to remove it)`);
	}
	fs.mkdirSync(absOut, { recursive: true });
	return absOut;
}

/**
 * Run the build.
 * @param {{from?: string, out?: string, scopes?: string[], clean?: boolean, force?: boolean,
 *          themes?: string[] | "all", version?: string, log?: (msg: string) => void}} opts
 */
export async function build(opts = {}) {
	const { from = ".", out = "dist", scopes = ["openui5", "sapui5"], clean = false, force = false } = opts;
	const themes = opts.themes ?? DEFAULT_THEMES; // array of theme names, or "all"
	const log = opts.log ?? ((m) => console.log(m));

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
			tree.set(rel, { abs: null, text, pkg: "ui5loader-autoconfig.js" });
			extracted.push(rel);
		}
	}
	// the runtime shim replaces the legacy loader; ui5-next-bootstrap.js replaces what
	// ui5loader-autoconfig.js provided (the inline configuration modules)
	aliases["ui5loader"] = RUNTIME_DEP;
	if (extracted.length) {
		const deps = extracted.map((r) => r.slice(0, -3));
		tree.set(BOOTSTRAP_FILE, {
			abs: null, pkg: "ui5-next",
			text: `/* generated by ui5-next: replaces ui5loader-autoconfig.js */\nsap.ui.define(${JSON.stringify(deps)}, function() {});\n`,
		});
		extracted.push(BOOTSTRAP_FILE);
		aliases["ui5loader-autoconfig"] = BOOTSTRAP_FILE.slice(0, -3);
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

	const absOut = prepareOut(out, from, { clean, force });

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

	const write = (rel, data) => {
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
	const classic = new Map(); // thirdparty classic scripts: rel -> source

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

	// classic scripts: wrap those that modules import or a loader shim config
	// knows (plus their shim dependencies); copy the rest raw
	const shimDeps = (rel) => [].concat(shim[rel.slice(0, -3)]?.deps ?? []).filter((d) => typeof d === "string");
	const wrap = new Set();
	const want = (rel) => {
		if (!classic.has(rel) || wrap.has(rel)) return;
		wrap.add(rel);
		for (const d of shimDeps(rel)) want(d + ".js");
	};
	for (const rel of classic.keys()) {
		if (firstImportedBy.has(rel) || shim[rel.slice(0, -3)]) want(rel);
	}
	const classicScripts = [];
	for (const [rel, src] of classic) {
		if (!wrap.has(rel)) {
			write(rel, src);
			classicScripts.push(rel);
			stats.classicScripts++;
			continue;
		}
		const cfg = shim[rel.slice(0, -3)] ?? {};
		const classicFile = posix.basename(rel).replace(/\.js$/, ".classic.js");
		const fileImports = [];
		const code = classicWrapper({
			classicFile,
			deps: shimDeps(rel),
			exports: typeof cfg.exports === "string" ? cfg.exports : undefined,
			runtimeSpec: runtimeSpecFor(rel),
			depSpecs: (d) => {
				const r = resolveSpecifier(rel, d, roots, aliases);
				fileImports.push(r);
				return r.specifier;
			},
		});
		recordImports(rel, fileImports);
		write(posix.join(posix.dirname(rel), classicFile), src);
		write(rel, code);
		stats.wrapped++;
	}

	// 7. package.json, runtime, report
	fs.writeFileSync(path.join(absOut, "package.json"), JSON.stringify({ name: "ui5-next", version, type: "module" }, null, 2) + "\n");
	write(RUNTIME_FILE, fs.readFileSync(RUNTIME_SRC));
	write(BOOT_FILE, fs.readFileSync(BOOT_SRC));
	// normally generated by the UI5 tooling; Lib/VersionInfo load it at runtime
	if (!tree.has("sap-ui-version.json")) {
		fs.writeFileSync(path.join(absOut, "sap-ui-version.json"), JSON.stringify({
			name: "ui5-next", version, buildTimestamp: new Date().toISOString().replace(/\D/g, "").slice(0, 12),
			libraries: packages.filter((p) => !/themelib_/.test(p.name)).map((p) => ({ name: p.name.split("/").pop(), version: p.version })),
		}, null, 2) + "\n");
	}

	// library manifest.json from .library (normally generated by the UI5 tooling)
	let manifests = 0;
	for (const rel of tree.keys()) {
		if (!rel.endsWith("/.library")) continue;
		const dir = posix.dirname(rel);
		if (tree.has(`${dir}/manifest.json`)) continue;
		const files = [...tree.keys()].filter((k) => posix.dirname(k) === dir).map((k) => posix.basename(k));
		write(`${dir}/manifest.json`, JSON.stringify(libraryManifest(readText(tree.get(rel)), files), null, 2) + "\n");
		manifests++;
	}
	stats.libraryManifests = manifests;

	// themes: library.source.less -> library.css + library-parameters.json
	const themeReport = { compiled: [], errors: [] };
	const lessEntry = tree.get("sap/ui/thirdparty/less.js");
	const wanted = findThemes(tree.keys()).filter((t) => themes === "all" || themes.includes(t.theme));
	if (wanted.length && lessEntry) {
		const less = loadLess(readText(lessEntry));
		let n = 0;
		for (const t of wanted) {
			if (++n % 20 === 0) log(`  themes ${n}/${wanted.length}`);
			if (tree.has(`${t.dir}/library.css`)) continue; // prebuilt
			try {
				const { css, parameters } = await compileTheme(less, path.join(absOut, ...t.dir.split("/"), "library.source.less"));
				write(`${t.dir}/library.css`, css + themeFooter(t.lib, t.theme, version, parameters));
				write(`${t.dir}/library-parameters.json`, JSON.stringify(parameters) + "\n");
				themeReport.compiled.push(`${t.lib}:${t.theme}`);
			} catch (err) {
				themeReport.errors.push({ library: t.lib, theme: t.theme, reason: reasonOf(err) });
			}
		}
	}
	stats.themesCompiled = themeReport.compiled.length;
	stats.themeErrors = themeReport.errors.length;

	const present = new Set(tree.keys());
	for (const rel of wrap) present.add(rel.replace(/\.js$/, ".classic.js"));
	present.add(RUNTIME_FILE);
	present.add(BOOT_FILE);
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
		extracted,
		wrappedClassicScripts: [...wrap].sort(),
		classicScripts: classicScripts.sort(),
		themes: themeReport,
		unresolvedImports,
		externalSpecifiers: Object.fromEntries(Object.entries(externalSpecifiers).sort((a, b) => b[1] - a[1])),
		legacyReferences,
	};
	fs.writeFileSync(path.join(absOut, "ui5-next-report.json"), JSON.stringify(report, null, 2) + "\n");

	// 8. summary
	log(summary(report, absOut));
	return report;
}

export function topSkipReasons(report, n = 10) {
	const counts = new Map();
	for (const { reason } of report.skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function summary(report, absOut) {
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
		`  wrapped:      ${s.wrapped} classic scripts as ES modules; ${s.extracted} modules extracted from the bootstrap`,
		`  themes:       ${s.themesCompiled} library themes compiled, ${s.themeErrors} errors`,
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
	lines.push(`  report:       ${path.join(absOut, "ui5-next-report.json")}`);
	return lines.join("\n");
}
