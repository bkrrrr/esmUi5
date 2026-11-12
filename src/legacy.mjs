// Pure helpers for the parts of the legacy UI5 bootstrap that UI5 Next replaces:
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
			result.modules.set(name.value, `/* extracted from ui5loader-autoconfig.js by ui5-next */\n${prelude}${define}`);
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

/**
 * ES module wrapper for a classic script: loads its shim dependencies, runs the original
 * file as a classic script (so `this`, sloppy mode and globals behave as before) and
 * exports the global named by the shim config.
 */
export function classicWrapper({ classicFile, deps = [], exports, runtimeSpec, depSpecs }) {
	const lines = [
		`/* UI5 Next: ES module wrapper; the original classic script is ./${classicFile} */`,
		`import { _loadScript } from ${JSON.stringify(runtimeSpec)};`,
		...deps.map((d) => `import ${JSON.stringify(depSpecs(d))};`),
		``,
		`await _loadScript(new URL(${JSON.stringify("./" + classicFile)}, import.meta.url).href);`,
		``,
	];
	if (exports) {
		const pathExpr = exports.split(".").map((p, i) => (i === 0 ? `globalThis[${JSON.stringify(p)}]` : `?.[${JSON.stringify(p)}]`)).join("");
		lines.push(`export default ${pathExpr};`);
	} else {
		lines.push(`export default undefined;`);
	}
	return lines.join("\n") + "\n";
}

const LEADING_COMMENTS = /^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*[ \t]*\r?\n?/;

/**
 * Make a converted module import the runtime first (so sap.ui.loader & co. exist before any
 * dependency runs) and register itself, so sync probes like sap.ui.require("x") work.
 */
export function addRegistration(code, moduleName, runtimeSpec, selfSpec) {
	const head = code.match(LEADING_COMMENTS)[0];
	return (
		head +
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
