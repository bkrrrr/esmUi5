// UI5 Next runtime shim (dist/runtime/ui5-next-runtime.js): the loader API for dynamic code
// (view/controller names, lazy libraries) plus the small part of the legacy loader API
// (sap.ui.loader) that UI5 itself still calls. Dependency free. It does not recreate
// namespace globals (sap.m.Button, ...).
//
//   init({ mode: "esm" | "bundles", esmBase, bundlesBase, paths })
//
// Name resolution for a module name like "sap/m/Button":
//   1. paths prefix (app modules outside the UI5 tree)  -> <url>/<rest>.js
//   2. mode "bundles": package (prefix map from init({ packages }), else modules.json)
//      -> <bundlesBase>/<pkg>.registry.js -> { <name>: () => import(...) } (runs the module on first use)
//   3. otherwise                                        -> <esmBase>/<name>.js
// Non-JS resources (views, i18n, themes, manifests) always come from paths or esmBase.
const here = import.meta.url;
const state = {
	mode: "esm",
	esmBase: new URL("../esm/", here).href,
	bundlesBase: new URL("../bundles/", here).href,
	paths: new Map(), // module name prefix -> URL prefix ending with "/"
	packages: null, // bundles: module name prefix -> package ({ "sap/m": "sap.m", ... })
	registries: null, // bundles: package -> () => import(<its registry>), else <bundlesBase>/<pkg>.registry.js
	import: (url) => import(url),
	fetch: (url) => fetch(url),
};
const cache = new Map(); // module name -> { ns } (self-registered module namespace) | { value }
const pending = new Map(); // module name -> Promise<value>
let modulesJson = null; // Promise<{ name: package }>
const registries = new Map(); // package -> Promise<registry>
const preloaded = new Map(); // resource name -> raw content (sap.ui.require.preload, e.g. CLDR data)

const baseUrl = () => (typeof document !== "undefined" && document.baseURI) || here;
const dirUrl = (u) => {
	const s = new URL(String(u), baseUrl()).href;
	return s.endsWith("/") ? s : s + "/";
};

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

function setPath(prefix, url) {
	const p = moduleName(prefix).replace(/\/+$/, "");
	const u = url && typeof url === "object" && !(url instanceof URL) ? url.url : url;
	if (u == null) state.paths.delete(p);
	else state.paths.set(p, dirUrl(u));
}

/**
 * Configure the runtime. Call it before loading UI5 modules.
 * @param {{mode?: "esm"|"bundles", esmBase?: string|URL, bundlesBase?: string|URL,
 *          paths?: Object<string, string|URL>, import?: Function, fetch?: Function}} [options]
 *   paths values are resolved against the page (document.baseURI).
 *   import/fetch replace the native functions (for tests).
 */
export function init(options = {}) {
	if (options.mode !== undefined) {
		if (options.mode !== "esm" && options.mode !== "bundles") throw new Error(`ui5-next-runtime: unknown mode "${options.mode}"`);
		state.mode = options.mode;
	}
	if (options.esmBase) state.esmBase = dirUrl(options.esmBase);
	if (options.bundlesBase) state.bundlesBase = dirUrl(options.bundlesBase);
	for (const [prefix, url] of Object.entries(options.paths ?? {})) setPath(prefix, url);
	if (options.packages) state.packages = options.packages;
	if (options.registries) state.registries = options.registries;
	if (options.import) state.import = options.import;
	if (options.fetch) state.fetch = options.fetch;
	modulesJson = null;
	registries.clear();
	return { mode: state.mode, esmBase: state.esmBase, bundlesBase: state.bundlesBase, paths: Object.fromEntries(state.paths) };
}

/** Forget all loaded modules and configuration (tests). */
export function _reset() {
	cache.clear();
	preloaded.clear();
	pending.clear();
	state.paths.clear();
	state.packages = null;
	state.registries = null;
	modulesJson = null;
	registries.clear();
}

/** URL of a resource ("sap/m/themes/x.css", "my/app/App.view.xml") via paths, else esm/. */
function resourceUrl(resource) {
	let best = null;
	for (const prefix of state.paths.keys()) {
		if ((resource === prefix || resource.startsWith(prefix + "/")) && (best === null || prefix.length > best.length)) best = prefix;
	}
	if (best !== null) return new URL(resource.slice(best.length).replace(/^\//, ""), state.paths.get(best)).href;
	return new URL(resource, state.esmBase).href;
}
const pathsMatch = (resource) => [...state.paths.keys()].some((p) => resource === p || resource.startsWith(p + "/"));

function valueOf(entry) {
	if (!entry) return undefined;
	if (!("ns" in entry)) return entry.value;
	try {
		return entry.ns.default;
	} catch {
		return undefined; // registered but not evaluated yet (TDZ)
	}
}

function loadModulesJson() {
	modulesJson ??= Promise.resolve(state.fetch(new URL("modules.json", state.bundlesBase).href)).then((r) => {
		if (!r.ok) throw new Error(`ui5-next-runtime: cannot load ${state.bundlesBase}modules.json (${r.status})`);
		return r.json();
	});
	return modulesJson;
}

function loadRegistry(pkg) {
	if (!registries.has(pkg)) {
		// the registry's module namespace: one named export per module ("sap/m/Button")
		const loader = state.registries?.[pkg];
		registries.set(pkg, Promise.resolve(loader ? loader() : state.import(new URL(`${pkg}.registry.js`, state.bundlesBase).href)));
	}
	return registries.get(pkg);
}

/** Package of a module name: longest matching prefix in the packages map. */
function packageOf(name) {
	for (let p = name; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
		if (Object.hasOwn(state.packages, p)) return state.packages[p];
	}
	return null;
}

async function resolve(n) {
	const file = /\.m?js$/.test(n) ? n : n + ".js";
	if (pathsMatch(n)) return (await state.import(resourceUrl(file))).default; // 1. paths
	if (state.mode === "bundles") {
		const pkg = state.packages ? packageOf(n) : (await loadModulesJson())[n]; // 2. bundles
		if (pkg) {
			const registry = await loadRegistry(pkg);
			const lazy = registry.default;
			if (lazy && typeof lazy === "object" && typeof lazy[n] === "function") {
				// lazy registry (app build): import() the module on first use
				const ns = await lazy[n]();
				return cache.has(n) ? valueOf(cache.get(n)) : "default" in ns ? ns.default : ns;
			}
			if (n in registry) return registry[n];
		}
	}
	if (state.mode === "bundles" && !pathsMatch(n)) {
		// not in any bundle: the esm/ file and its imports become a second copy next to the bundles
		logger.warning(`"${n}" is not in bundles/; loading it from esm/ (its UI5 imports are duplicated)`);
	}
	const ns = await state.import(resourceUrl(file)); // 3. esm
	return cache.has(n) ? valueOf(cache.get(n)) : ns.default;
}

/** Load one module by name; resolves with its default export. Cached by name. */
export function load(name) {
	const n = moduleName(name);
	if (cache.has(n)) return Promise.resolve(valueOf(cache.get(n)));
	if (!pending.has(n)) {
		pending.set(n, resolve(n).then(
			(value) => {
				if (!cache.has(n)) cache.set(n, { value });
				pending.delete(n);
				return valueOf(cache.get(n));
			},
			(err) => {
				pending.delete(n);
				throw err;
			}
		));
	}
	return pending.get(n);
}

/** Called by every converted module: makes it visible to sync probes. */
export function _register(name, namespace) {
	cache.set(moduleName(name), { ns: namespace });
}

/**
 * require(["a/b", ...], cb?, errCb?) -> Promise; cb gets each default export in order
 * (without cb the Promise resolves with the array of exports).
 * require("a/b") -> default export if already loaded, else undefined.
 */
export function require(names, cb, errCb) {
	if (typeof names === "string") return valueOf(cache.get(moduleName(names)));
	names.forEach(moduleName); // relative names throw synchronously
	return Promise.all(names.map(load)).then(
		(values) => (typeof cb === "function" ? cb(...values) : values),
		(err) => {
			if (typeof errCb === "function") return errCb(err);
			throw err;
		}
	);
}

/** toUrl("sap/m/themes") -> absolute URL of a resource. */
export function toUrl(name) {
	if (typeof name !== "string") throw new TypeError("ui5-next-runtime: invalid resource name");
	if (name.startsWith("./") || name.startsWith("../")) moduleName(name); // throws
	return resourceUrl(name.replace(/^\/+/, ""));
}
require.toUrl = toUrl;

/**
 * preload({ "sap/ui/core/cldr/en.json": content, ... }): raw resource content that
 * LoaderExtensions.loadResource then gets without a request (like ui5loader's preload).
 */
export function preload(resources) {
	for (const [name, content] of Object.entries(resources ?? {})) preloaded.set(name.replace(/^\/+/, ""), content);
}
require.preload = preload;

// ---- sap.ui.loader compatibility (used by UI5 1.x internals) ----
const logger = {
	debug() {}, info() {}, isLoggable: () => false,
	warning: (...a) => console.warn("[ui5-next]", ...a),
	error: (...a) => console.error("[ui5-next]", ...a),
};
const loaderConfig = { async: true, amd: false, noConflict: true };

function config(cfg) {
	if (cfg === undefined) return { ...loaderConfig, paths: Object.fromEntries(state.paths) };
	for (const [prefix, url] of Object.entries(cfg.paths ?? {})) setPath(prefix, url);
	const { paths: _p, ...rest } = cfg;
	Object.assign(loaderConfig, rest);
	return undefined;
}

const loader = {
	config,
	_: {
		logger,
		// 0 = initial, 4 = ready
		getModuleState: (resource) => (cache.has(moduleName(resource)) || preloaded.has(String(resource).replace(/^\/+/, "")) ? 4 : 0),
		getAllModules: () => Object.fromEntries([...cache].map(([n, e]) => [n + ".js", { name: n + ".js", state: 4, ui5: n, content: valueOf(e) }])),
		getSyncCallBehavior: () => 0,
		loadJSResourceAsync: (resource) => load(resource),
		declareModule: () => {},
		defineModuleSync: (resource, value) => cache.set(moduleName(resource), { value }),
		getModuleContent: (name, url) => {
			const n = name ? name.replace(/^\/+/, "") : loader._.guessResourceName(url);
			return n && preloaded.has(n) ? preloaded.get(n) : undefined;
		},
		guessResourceName: (url) => {
			const href = new URL(url, baseUrl()).href;
			for (const [prefix, u] of state.paths) if (href.startsWith(u)) return prefix + "/" + href.slice(u.length);
			return href.startsWith(state.esmBase) ? href.slice(state.esmBase.length) : undefined;
		},
		// like ui5loader: URL of a resource name, with an optional suffix
		getResourcePath: (name, suffix = "") => resourceUrl(String(name).replace(/^\/+/, "")).replace(/\/$/, "") + suffix,
		getUrlPrefixes: () => Object.fromEntries([["", state.esmBase], ...state.paths].map(([p, u]) => [p, { url: u, absoluteUrl: u }])),
		resolveURL: (url) => new URL(url, baseUrl()).href,
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
