// UI5 Next runtime shim: the loader API for dynamic code, plus the small part of the
// legacy loader API (sap.ui.loader) that UI5 itself still calls.
// It does not recreate namespace globals (sap.m.Button, ...).
const root = new URL("./", import.meta.url);
const registry = new Map(); // module name (no .js) -> module namespace or {default}
const paths = new Map(); // name prefix -> URL prefix (sap.ui.loader.config({paths}))
const scripts = new Map(); // url -> Promise (classic scripts)

function moduleName(name) {
	if (typeof name !== "string" || !name) throw new TypeError(`ui5-next-runtime: invalid module name ${String(name)}`);
	if (name.startsWith("./") || name.startsWith("../")) {
		throw new Error(
			`ui5-next-runtime: relative module name "${name}" is not supported (there is no calling-module context); ` +
			`use a root-relative name such as "sap/m/Button" or a static import`
		);
	}
	return name.replace(/^\/+/, "").replace(/\.js$/, "");
}

function resourceUrl(resource) {
	let best = "";
	for (const prefix of paths.keys()) {
		if ((resource === prefix || resource.startsWith(prefix + "/")) && prefix.length > best.length) best = prefix;
	}
	if (best) return new URL(paths.get(best) + resource.slice(best.length), document.baseURI).href;
	return new URL(resource, root).href;
}

function moduleUrl(name) {
	moduleName(name); // validates
	const n = name.replace(/^\/+/, "");
	return resourceUrl(/\.(m?js|json|css)$/.test(n) ? n : n + ".js");
}

function defaultOf(entry) {
	try {
		return entry.default;
	} catch {
		return undefined; // module registered but not evaluated yet (TDZ)
	}
}

/** Called by every converted module: makes it visible to sync probes. */
export function _register(name, namespace) {
	registry.set(moduleName(name), namespace);
}

/** Load a classic (non-module) script once; resolves when it has run. */
export function _loadScript(url) {
	if (!scripts.has(url)) {
		scripts.set(url, new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = url;
			s.async = false;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error(`ui5-next-runtime: failed to load script ${url}`));
			document.head.appendChild(s);
		}));
	}
	return scripts.get(url);
}

function load(name) {
	const n = moduleName(name);
	if (registry.has(n)) return Promise.resolve(defaultOf(registry.get(n)));
	return import(moduleUrl(name)).then((m) => {
		if (!registry.has(n)) registry.set(n, m);
		return defaultOf(registry.get(n));
	});
}

/**
 * require(["a/b", ...], cb?, errCb?) -> Promise, cb gets each default export in order.
 * require("a/b") -> default export if already loaded, else undefined.
 */
export function require(names, cb, errCb) {
	if (typeof names === "string") {
		const n = moduleName(names);
		return registry.has(n) ? defaultOf(registry.get(n)) : undefined;
	}
	const pending = names.map((n) => (moduleName(n), n));
	return Promise.all(pending.map(load)).then(
		(values) => (typeof cb === "function" ? cb(...values) : values),
		(err) => {
			if (typeof errCb === "function") return errCb(err);
			console.error(err);
			throw err;
		}
	);
}

/** toUrl("sap/m/themes") -> absolute URL below the UI5 Next root. */
export function toUrl(name) {
	if (typeof name !== "string") throw new TypeError("ui5-next-runtime: invalid resource name");
	if (name.startsWith("./") || name.startsWith("../")) moduleName(name); // throws
	return resourceUrl(name.replace(/^\/+/, ""));
}
require.toUrl = toUrl;

// ---- sap.ui.loader compatibility (used by UI5 1.x internals) ----
const logger = {
	debug() {}, info() {}, isLoggable: () => false,
	warning: (...a) => console.warn("[ui5-next]", ...a),
	error: (...a) => console.error("[ui5-next]", ...a),
};
const loaderConfig = { async: true, amd: false, noConflict: true };

function config(cfg) {
	if (cfg === undefined) return { ...loaderConfig, paths: Object.fromEntries(paths) };
	for (const [prefix, url] of Object.entries(cfg.paths ?? {})) {
		const p = moduleName(prefix);
		const u = typeof url === "object" && url ? url.url : url;
		if (u == null) paths.delete(p);
		else paths.set(p, String(u).replace(/\/?$/, "/").replace(/\/$/, ""));
	}
	const { paths: _p, ...rest } = cfg;
	Object.assign(loaderConfig, rest);
	return undefined;
}

const loader = {
	config,
	_: {
		logger,
		// 0 = initial, 4 = ready
		getModuleState: (resource) => (registry.has(moduleName(resource)) ? 4 : 0),
		getAllModules: () => Object.fromEntries([...registry].map(([n, e]) => [n + ".js", { name: n + ".js", state: 4, ui5: n, content: defaultOf(e) }])),
		getSyncCallBehavior: () => 0,
		loadJSResourceAsync: (resource) => load(resource),
		declareModule: () => {},
		defineModuleSync: (resource, value) => registry.set(moduleName(resource), { default: value }),
		getModuleContent: () => undefined, // no preload bundles: raw content is never cached
		guessResourceName: (url) => {
			const href = new URL(url, document.baseURI).href;
			return href.startsWith(root.href) ? href.slice(root.href.length) : undefined;
		},
		// like ui5loader: URL of a resource name, with an optional suffix
		getResourcePath: (name, suffix = "") => resourceUrl(String(name).replace(/^\/+/, "")).replace(/\/$/, "") + suffix,
		getUrlPrefixes: () => Object.fromEntries([["", root.href], ...paths].map(([p, u]) => [p, { url: u, absoluteUrl: new URL(u, document.baseURI).href }])),
		resolveURL: (url) => new URL(url, document.baseURI).href,
		translate: (url) => url,
	},
};

function requireSync(name) {
	const value = require(name);
	if (value === undefined) {
		logger.warning(`sap.ui.requireSync("${name}"): module was not loaded before; synchronous loading is not supported`);
	}
	return value;
}

const g = globalThis;
g.sap ??= {};
g.sap.ui ??= {};
if (!g.sap.ui.require) g.sap.ui.require = require;
g.sap.ui.requireSync ??= requireSync;
g.sap.ui.loader ??= loader;

/** Modules that depended on the legacy loader (ui5loader*.js) get the loader API. */
export default g.sap.ui.loader;
