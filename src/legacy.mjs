// Pure helpers for the parts of the legacy UI5 bootstrap that esmUi5 replaces:
//  - modules that ui5loader-autoconfig.js defines inline (configuration providers)
//  - the loader's thirdparty "shim" configuration (exports/deps of classic scripts)
//  - ES module wrappers for classic thirdparty scripts
//  - self registration of converted modules with the runtime shim
import { parse } from "./convert.mjs";

function walk(node, visit) {
	if (visit(node) === false) return;
	for (const key in node) {
		if (key === "loc") continue;
		const v = node[key];
		if (Array.isArray(v)) {
			for (const c of v) if (c && typeof c.type === "string") walk(c, visit);
		} else if (v && typeof v.type === "string") {
			walk(v, visit);
		}
	}
}

const isFn = (n) => n?.type === "FunctionExpression" || n?.type === "ArrowFunctionExpression";
const src = (code, n) => code.slice(n.start, n.end);

/** Evaluate an object/array literal of plain literals; anything else becomes undefined. */
function literal(n) {
	switch (n?.type) {
		case "Literal": return n.value;
		case "ArrayExpression": return n.elements.map(literal);
		case "ObjectExpression": {
			const o = {};
			for (const p of n.properties) {
				if (p.type !== "Property" || p.computed) continue;
				const key = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
				o[key] = literal(p.value);
			}
			return o;
		}
		default: return undefined;
	}
}

/**
 * Analyse ui5loader-autoconfig.js.
 * @returns {{modules: Map<string,string>, shim: object, map: object}}
 *   modules: module name -> synthetic AMD source (sap.ui.define) of each inline module
 *   shim: the loader's shim config; map: the loader's "*" module name map
 */
export function analyseAutoconfig(code) {
	const ast = parse(code, "script");
	const result = { modules: new Map(), shim: {}, map: {} };
	const iife = ast.body.find((s) => s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && isFn(s.expression.callee));
	if (!iife) return result;
	const body = iife.expression.callee.body.body;

	const fnDecls = new Map();
	for (const s of body) if (s.type === "FunctionDeclaration") fnDecls.set(s.id.name, s);

	// providers registered by _setupConfiguration(): BaseConfiguration.registerProvider(sap.ui.require("X"))
	const providers = [];
	let configModule = null;
	const setup = fnDecls.get("_setupConfiguration");
	if (setup) {
		walk(setup, (n) => {
			if (n.type === "VariableDeclarator" && n.init?.type === "CallExpression" && n.init.arguments[0]?.type === "Literal") {
				configModule ??= n.init.arguments[0].value;
			}
			if (n.type === "CallExpression" && n.callee.property?.name === "registerProvider") {
				const arg = n.arguments[0];
				if (arg?.type === "CallExpression" && arg.arguments[0]?.type === "Literal") providers.push(arg.arguments[0].value);
			}
		});
	}

	const usedHelpers = (node) => {
		const used = new Set();
		const visit = (n) =>
			walk(n, (x) => {
				if (x.type === "Identifier" && fnDecls.has(x.name) && !used.has(x.name)) {
					used.add(x.name);
					visit(fnDecls.get(x.name));
				}
			});
		visit(node);
		return [...used];
	};
	const usesIdent = (node, name) => {
		let found = false;
		walk(node, (x) => {
			if (x.type === "Identifier" && x.name === name) found = true;
		});
		return found;
	};

	for (const s of body) {
		const e = s.expression;
		if (s.type !== "ExpressionStatement" || e.type !== "CallExpression") continue;

		// define("name", [deps], factory)
		if (e.callee.type === "Identifier" && e.callee.name === "define") {
			const [name, deps, factory] = e.arguments;
			if (name?.type !== "Literal" || deps?.type !== "ArrayExpression" || !isFn(factory)) continue;
			const helpers = usedHelpers(factory);
			let prelude = "";
			if (usesIdent(factory, "ui5loader") || helpers.some((h) => usesIdent(fnDecls.get(h), "ui5loader"))) {
				prelude += "var ui5loader = globalThis.sap.ui.loader;\n";
			}
			for (const h of helpers) prelude += src(code, fnDecls.get(h)) + "\n";
			let define;
			if (name.value === configModule && providers.length) {
				// register the configuration providers, as _setupConfiguration() did
				const depNames = literal(deps);
				const params = depNames.map((_, i) => `__d${i}`);
				const provParams = providers.map((_, i) => `__p${i}`);
				define =
					`sap.ui.define(${JSON.stringify([...depNames, ...providers])}, function(${[...params, ...provParams].join(", ")}) {\n` +
					`\tvar Configuration = (${src(code, factory)})(${params.join(", ")});\n` +
					provParams.map((p) => `\tConfiguration.registerProvider(${p});\n`).join("") +
					`\treturn Configuration;\n});\n`;
			} else {
				define = `sap.ui.define(${src(code, deps)}, ${src(code, factory)});\n`;
			}
			result.modules.set(name.value, `/* extracted from ui5loader-autoconfig.js by esm-ui5 */\n${prelude}${define}`);
		}

		// ui5loader.config({ ..., map, shim })
		if (e.callee.type === "MemberExpression" && e.callee.object.name === "ui5loader" && e.callee.property.name === "config") {
			const cfg = literal(e.arguments[0]) ?? {};
			if (cfg.shim) Object.assign(result.shim, cfg.shim);
			if (cfg.map?.["*"]) Object.assign(result.map, cfg.map["*"]);
		}
	}
	return result;
}

/** Literal shim configs of sap.ui.loader.config({ shim: {...} }) calls in a module. */
export function shimConfigOf(code) {
	let ast;
	try {
		ast = parse(code, "script");
	} catch {
		return {};
	}
	const shim = {};
	walk(ast, (n) => {
		const c = n.callee;
		if (
			n.type === "CallExpression" && c?.type === "MemberExpression" && c.property.name === "config" &&
			c.object.type === "MemberExpression" && c.object.property.name === "loader" &&
			n.arguments[0]?.type === "ObjectExpression"
		) {
			Object.assign(shim, literal(n.arguments[0]).shim ?? {});
		}
	});
	return shim;
}

const globalExpr = (global) =>
	global.split(".").map((p, i) => (i === 0 ? `globalThis[${JSON.stringify(p)}]` : `?.[${JSON.stringify(p)}]`)).join("");

/**
 * ES module wrapper for a thirdparty UMD/global script listed in src/thirdparty-globals.json:
 *   import "./<dep>.js"; ...        (loader shim deps, e.g. jQuery before jQuery UI)
 *   import "./<name>.orig.js";
 *   export default globalThis["<global>"];
 * @param {{origFile: string, global: string|null, depSpecs?: string[]}} opts
 */
export function thirdpartyWrapper({ origFile, global, depSpecs = [] }) {
	return [
		...depSpecs.map((s) => `import ${JSON.stringify(s)};`),
		`import ${JSON.stringify("./" + origFile)};`,
		`export default ${global ? globalExpr(global) : "undefined"};`,
		"",
	].join("\n");
}

/**
 * The <name>.orig.js file: the original script, run the way a classic <script> runs it as far as
 * ES modules allow. `this` is globalThis (UMD wrappers like URI.js pass `this` as the root) and the
 * listed global is published if the script only declared it (`var html = ...` stays module-local
 * otherwise). module/exports/define/require are shadowed with undefined, so UMD headers take their
 * browser-global path, and bundlers do not treat the file as CommonJS (which would make jQuery
 * skip setting window.jQuery). Module code is strict, so scripts that rely on sloppy mode fail.
 */
/**
 * Sloppy-mode `this` that strict module code would turn into undefined: `this` at top level and
 * inside directly invoked function expressions (IIFEs, `(function(){...})()` /
 * `(function(){...}).call(this)` excluded) is the global object in a classic script, so it
 * becomes `globalThis`; so does `this` passed as an argument to an IIFE (`})(jQuery, this)`).
 * `this` in methods, constructors and callbacks is left alone.
 */
export function globalizeSloppyThis(src) {
	let ast;
	try {
		ast = parse(src, "script");
	} catch {
		return src;
	}
	const edits = [];
	const visit = (node, globalThisCtx, parent) => {
		if (!node || typeof node.type !== "string") return;
		if (node.type === "ThisExpression") {
			// `(function (root) {...})(this)`: the idiom for passing the global object
			const iifeArg = parent?.type === "CallExpression" && parent.arguments.includes(node) && parent.callee.type === "FunctionExpression";
			if (globalThisCtx || iifeArg) edits.push(node);
			return;
		}
		let ctx = globalThisCtx;
		if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") {
			// an IIFE called plainly: f() — not f.call(x)/f.apply(x), not new f()
			ctx = node.type === "FunctionExpression" && parent?.type === "CallExpression" && parent.callee === node;
		}
		if (node.type === "PropertyDefinition" || node.type === "StaticBlock" || node.type === "ClassBody") ctx = false;
		for (const key in node) {
			if (key === "loc") continue;
			const v = node[key];
			if (Array.isArray(v)) v.forEach((c) => visit(c, ctx, node));
			else if (v && typeof v.type === "string") visit(v, ctx, node);
		}
	};
	visit(ast, true, null);
	edits.sort((a, b) => b.start - a.start);
	let out = src;
	for (const e of edits) out = out.slice(0, e.start) + "globalThis" + out.slice(e.end);
	return out;
}

export function origEnvelope(src, global) {
	src = globalizeSloppyThis(src);
	const simple = global && /^[A-Za-z_$][\w$]*$/.test(global) ? global : null;
	return (
		`/* Modified by esm-ui5: the original script, wrapped to run as an ES module (this === globalThis). */\n` +
		`(function (module, exports, define, require) {\n${src.replace(/\s*$/, "")}\n` +
		(simple ? `;if (typeof ${simple} !== "undefined" && globalThis[${JSON.stringify(simple)}] === undefined) globalThis[${JSON.stringify(simple)}] = ${simple};\n` : "") +
		`}).call(globalThis);\n`
	);
}

/** Apache-2.0 §4(b): modified files carry a notice that they were changed. */
export const MODIFIED_NOTICE = "/* Modified by esm-ui5: converted from the OpenUI5 AMD source to an ES module. */";

const LEADING_COMMENTS = /^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*[ \t]*\r?\n?/;

/**
 * Make a converted module import the runtime first (so sap.ui.loader & co. exist before any
 * dependency runs) and register itself, so sync probes like sap.ui.require("x") work.
 */
export function addRegistration(code, moduleName, runtimeSpec, selfSpec) {
	const head = code.match(LEADING_COMMENTS)[0];
	return (
		head +
		`${MODIFIED_NOTICE}\n` +
		`import { _register as __ui5_register } from ${JSON.stringify(runtimeSpec)};\n` +
		`import * as __ui5_self from ${JSON.stringify(selfSpec)};\n` +
		code.slice(head.length).replace(/\s*$/, "\n") +
		`\n__ui5_register(${JSON.stringify(moduleName)}, __ui5_self);\n`
	);
}

/**
 * Library manifest.json from a .library file, like the UI5 tooling's manifest creator does
 * (only the parts the runtime reads: id, version, dependencies, i18n).
 * @param {string} xml content of .library
 * @param {string[]} files relative paths of the library folder's files (for i18n locales)
 */
export function libraryManifest(xml, files) {
	const tag = (src, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(src)?.[1].trim();
	const name = tag(xml, "name");
	const version = tag(xml, "version");
	const libs = {};
	for (const [, dep] of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
		const lib = tag(dep, "libraryName");
		if (!lib) continue;
		libs[lib] = tag(dep, "lazy") === "true" ? { lazy: true } : {};
	}
	let i18n = false;
	const bundles = files.filter((f) => /^messagebundle(_[A-Za-z0-9_]+)?\.properties$/.test(f));
	if (bundles.includes("messagebundle.properties")) {
		i18n = {
			bundleUrl: "messagebundle.properties",
			supportedLocales: bundles.map((f) => f.replace(/^messagebundle_?|\.properties$/g, "")).sort(),
		};
	}
	return {
		"_version": "1.21.0",
		"sap.app": { id: name, type: "library", embeds: [], applicationVersion: { version }, title: tag(xml, "documentation") ?? name },
		"sap.ui": { technology: "UI5" },
		"sap.ui5": { dependencies: { libs }, library: { i18n } },
	};
}
