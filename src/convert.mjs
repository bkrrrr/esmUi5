// AMD (sap.ui.define / sap.ui.require) -> native ES module converter.
// Pure functions only: no fs, no path resolution. The caller passes spec(dep),
// which maps a UI5 dependency name to the import specifier to write.
import * as acorn from "acorn";

const BASE_OPTS = { ecmaVersion: "latest", allowHashBang: true, locations: true };

/** Dependency name that the build maps to the root ui5-next-runtime.js. */
export const RUNTIME_DEP = "ui5-next-runtime";

export function parse(src, sourceType = "script") {
	return acorn.parse(src, { ...BASE_OPTS, sourceType });
}

function parseAny(src) {
	try {
		return parse(src, "script");
	} catch (err) {
		try {
			return parse(src, "module");
		} catch {
			throw err;
		}
	}
}

/** Generic AST walk. visit(node, parent) may return false to skip children. */
function walk(node, visit, parent = null) {
	if (visit(node, parent) === false) return;
	for (const key in node) {
		if (key === "loc") continue;
		const v = node[key];
		if (Array.isArray(v)) {
			for (const c of v) if (c && typeof c.type === "string") walk(c, visit, node);
		} else if (v && typeof v.type === "string") {
			walk(v, visit, node);
		}
	}
}

const FUNCTION_TYPES = new Set(["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"]);

function sapUiMember(callee) {
	if (
		callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" &&
		callee.object.type === "MemberExpression" && !callee.object.computed &&
		callee.object.property.type === "Identifier" && callee.object.property.name === "ui" &&
		callee.object.object.type === "Identifier" && callee.object.object.name === "sap"
	) {
		const name = callee.property.name;
		if (name === "define" || name === "require" || name === "requireSync") return name;
	}
	return null;
}

/** All sap.ui.define / sap.ui.require / sap.ui.requireSync calls in an AST. */
function loaderCalls(ast) {
	const out = [];
	walk(ast, (n) => {
		if (n.type === "CallExpression") {
			const kind = sapUiMember(n.callee);
			if (kind) out.push({ kind, node: n });
		}
	});
	return out;
}

/**
 * True if src is already an ES module without any sap.ui.* loader call:
 * it fails to parse as a script but parses as a module.
 */
export function isPlainModule(src) {
	try {
		parse(src, "script");
		return false;
	} catch {
		/* not a script */
	}
	let ast;
	try {
		ast = parse(src, "module");
	} catch {
		return false;
	}
	return loaderCalls(ast).length === 0;
}

const isStr = (n) => n?.type === "Literal" && typeof n.value === "string";

function applyEdits(str, edits, offset = 0) {
	const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
	for (const e of sorted) {
		str = str.slice(0, e.start - offset) + e.text + str.slice(e.end - offset);
	}
	return str;
}

/**
 * `this` expressions that belong to the given function body (not to nested non-arrow
 * functions or class members). The UI5 loader calls factories and callbacks with
 * this === globalThis, so these become `globalThis`.
 */
function ownThis(body) {
	const found = [];
	walk(body, (n) => {
		if (n.type === "FunctionExpression" || n.type === "FunctionDeclaration") return false;
		if (n.type === "PropertyDefinition" || n.type === "StaticBlock") return false;
		if (n.type === "ThisExpression") found.push(n);
	});
	return found;
}

/** Uses of `this` / `arguments` that would change meaning in an arrow function. */
function usesThisOrArguments(fnBody) {
	let found = null;
	walk(fnBody, (n) => {
		if (found) return false;
		if (n.type === "FunctionExpression" || n.type === "FunctionDeclaration") return false;
		if (n.type === "ThisExpression") found = "this";
		else if (n.type === "Identifier" && n.name === "arguments") found = "arguments";
	});
	return found;
}

const isSingle = (c) => c.kind !== "define" && c.node.arguments.length === 1 && isStr(c.node.arguments[0]);
const isProbe = (c) => c.kind === "require" && isSingle(c);

/**
 * Convert one AMD source file.
 * @param {string} src
 * @param {(dep: string) => string} spec
 * @param {{syncRequire?: "hoist" | "probe"}} [options]
 *   syncRequire "hoist" (default): sap.ui.require("a/b") becomes a hoisted static import.
 *   "probe": it is left as a runtime call; with the runtime shim it returns the module if it
 *   is already loaded, as with the UI5 loader (no forced loading, no new import cycles).
 *   sap.ui.requireSync("a/b") is left as a runtime call too (it only works for loaded modules).
 * @returns {{code: string, warnings: string[]} | null} null = nothing to do
 */
export function convert(src, spec, options = {}) {
	const probe = options.syncRequire === "probe";
	const warnings = [];
	const hoisted = new Map(); // dep -> identifier
	const usedIdents = new Set();
	let code = src;
	let changed = false;

	const identFor = (dep) => {
		if (hoisted.has(dep)) return hoisted.get(dep);
		const base = "_" + dep.replace(/[^A-Za-z0-9_$]/g, "_");
		let name = base;
		for (let i = 2; usedIdents.has(name); i++) name = `${base}_${i}`;
		usedIdents.add(name);
		hoisted.set(dep, name);
		return name;
	};

	// ---- Pass 1: sap.ui.require / sap.ui.requireSync, last call first ----
	let cursor = Infinity;
	for (;;) {
		const ast = parseAny(code);
		let call = null;
		for (const c of loaderCalls(ast)) {
			if (c.kind === "define" || (probe && isSingle(c))) continue;
			if (c.node.start < cursor && (!call || c.node.start > call.node.start)) call = c;
		}
		if (!call) break;
		cursor = call.node.start;
		const replacement = convertRequire(code, call, spec, identFor, warnings);
		if (replacement != null) {
			code = code.slice(0, call.node.start) + replacement + code.slice(call.node.end);
			changed = true;
		}
	}

	const hoistedImports = () =>
		// pass 1 runs last-to-first, so reverse to get source order
		[...hoisted].reverse().map(([dep, id]) => `import ${id} from ${JSON.stringify(spec(dep))};`);

	// ---- Pass 2: sap.ui.define ----
	const ast = parseAny(code);
	const defines = loaderCalls(ast).filter((c) => c.kind === "define");
	if (defines.length > 1) throw fail("multiple sap.ui.define calls in one file", defines[1].node);

	if (defines.length === 0) {
		if (hoisted.size) {
			const at = ast.body.length ? ast.body[0].start : code.length;
			code = code.slice(0, at) + hoistedImports().join("\n") + "\n\n" + code.slice(at);
			changed = true;
		}
		if (!changed) return warnings.length ? finish(src, warnings) : null;
		return finish(code, warnings);
	}

	const def = defines[0].node;
	const stmt = ast.body.find((s) => s.type === "ExpressionStatement" && s.expression === def);
	if (!stmt) return convertNestedDefine(code, ast, def, spec, hoistedImports(), warnings);

	// sap.ui.define([sModuleName], [aDependencies], vFactory, [bExport])
	const { deps, factory } = defineArgs(def);

	// 1st choice: a flat module (imports + factory body + export default)
	let flatError;
	try {
		const flat = convertFlat(code, deps, factory, spec, hoistedImports());
		return finish(code.slice(0, stmt.start) + flat + code.slice(stmt.end), warnings);
	} catch (err) {
		flatError = err;
	}
	// fallback: keep the factory as a function and call it with the imports
	const kept = keepFactory(code, deps, factory, spec, hoistedImports());
	const result = finish(code.slice(0, stmt.start) + kept + code.slice(stmt.end), warnings);
	result.warnings.push(`line ${def.loc.start.line}: factory kept as a function (${reasonText(flatError)})`);
	return result;
}

function reasonText(err) {
	return String(err?.message ?? err).replace(/\s*\(\d+:\d+\)/g, "");
}

function defineArgs(def) {
	const args = def.arguments;
	let i = 0;
	if (args.some((a) => a.type === "SpreadElement")) throw fail("sap.ui.define with spread arguments", def);
	if (isStr(args[i])) i++;
	let deps = [];
	if (args[i]?.type === "ArrayExpression") {
		if (!args[i].elements.every(isStr)) throw fail("dependency list contains non-literal entries", def);
		deps = args[i].elements.map((e) => e.value);
		i++;
	}
	const factory = args[i++];
	if (args[i]?.type === "Literal" && typeof args[i].value === "boolean") i++;
	if (!factory) throw fail("sap.ui.define without a factory", def);
	if (i !== args.length) throw fail("unexpected sap.ui.define arguments", def);
	return { deps, factory };
}

const isFn = (n) => n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";

function convertFlat(code, deps, factory, spec, hoistedImports) {
	if (!isFn(factory) || factory.generator) throw new Error("factory is not an inline function");
	if (factory.async) throw new Error("async factory");
	if (!factory.params.every((p) => p.type === "Identifier")) throw new Error("factory has non-identifier parameters");
	if (factory.params.length > deps.length) throw new Error("factory has more parameters than dependencies");

	const imports = [];
	deps.forEach((dep, k) => {
		const param = factory.params[k]?.name;
		if (dep === "exports" || dep === "module") throw new Error(`CommonJS dependency "${dep}"`);
		if (dep === "require") {
			// module-local require -> the runtime shim (root-relative names only)
			const what = param === "require" ? "require" : `require as ${param}`;
			if (param) imports.push(`import { ${what} } from ${JSON.stringify(spec(RUNTIME_DEP))};`);
			return;
		}
		const s = JSON.stringify(spec(dep));
		imports.push(param ? `import ${param} from ${s};` : `import ${s};`);
	});
	imports.push(...hoistedImports);

	const body = factory.body.type !== "BlockStatement"
		? `export default (${code.slice(factory.body.start, factory.body.end)});`
		: convertFactoryBody(code, factory.body);
	const out = (imports.length ? imports.join("\n") + "\n\n" : "") + body;
	parse(out, "module"); // e.g. `var X` that redeclares an imported name
	return out;
}

/** Imports for a factory that is called as a function: one binding per dependency. */
function factoryCall(deps, nParams, spec) {
	const imports = [];
	const args = [];
	let cjs = false;
	deps.forEach((dep, k) => {
		const id = `__ui5_dep${k}`;
		const used = k < nParams;
		if (dep === "exports" || dep === "module") {
			cjs = true;
			if (used) args.push(dep === "module" ? "__ui5_module" : "__ui5_module.exports");
			return;
		}
		if (dep === "require") {
			if (used) {
				imports.push(`import { require as ${id} } from ${JSON.stringify(spec(RUNTIME_DEP))};`);
				args.push(id);
			}
			return;
		}
		const s = JSON.stringify(spec(dep));
		imports.push(used ? `import ${id} from ${s};` : `import ${s};`);
		if (used) args.push(id);
	});
	return { imports, args, cjs };
}

function keepFactory(code, deps, factory, spec, hoistedImports) {
	const text = code.slice(factory.start, factory.end);
	if (!isFn(factory)) {
		const { imports } = factoryCall(deps, 0, spec);
		const head = [...imports, ...hoistedImports].join("\n");
		return (head ? head + "\n\n" : "") + `export default (${text});`;
	}
	const { imports, args, cjs } = factoryCall(deps, Math.max(factory.params.length, deps.length), spec);
	const head = [...imports, ...hoistedImports].join("\n") + (imports.length + hoistedImports.length ? "\n\n" : "");
	const call = `(${text}).call(globalThis${args.map((a) => ", " + a).join("")})`;
	if (!cjs) return `${head}export default ${call};`;
	return `${head}const __ui5_module = { exports: {} };\nconst __ui5_result = ${call};\n` +
		`export default __ui5_result !== undefined ? __ui5_result : __ui5_module.exports;`;
}

/**
 * sap.ui.define that is not a top-level statement (UMD wrappers, `if (sap.ui.define) ...`):
 * keep the code, route sap.ui.define to a local function that calls the factory with the
 * imports and exports its result.
 */
function convertNestedDefine(code, ast, def, spec, hoistedImports, warnings) {
	const args = def.arguments;
	let deps = [];
	let k = args.length > 1 && args[0].type !== "ArrayExpression" ? 1 : 0; // module name
	if (args[k]?.type === "ArrayExpression") {
		if (!args[k].elements.every(isStr)) throw fail("dependency list contains non-literal entries", def);
		deps = args[k].elements.map((e) => e.value);
	}
	const { imports, args: callArgs, cjs } = factoryCall(deps, deps.length, spec);
	if (cjs) throw fail("CommonJS dependency in a nested sap.ui.define", def);

	const edits = [];
	walk(ast, (n) => {
		if (n.type === "MemberExpression" && sapUiMember(n) === "define") {
			edits.push({ start: n.start, end: n.end, text: "__ui5_define" });
			return false;
		}
	});
	const helper =
		`let __ui5_default;\n` +
		`function __ui5_define(...args) {\n` +
		`\tconst factory = args.filter((a) => !Array.isArray(a) && typeof a !== "string" && typeof a !== "boolean").pop();\n` +
		`\t__ui5_default = typeof factory === "function" ? factory.call(globalThis${callArgs.map((a) => ", " + a).join("")}) : factory;\n` +
		`}\n`;
	const at = ast.body.length ? ast.body[0].start : code.length;
	const head = [...imports, ...hoistedImports].join("\n");
	let out = applyEdits(code, edits);
	out = out.slice(0, at) + (head ? head + "\n\n" : "") + helper + "\n" + out.slice(at);
	out = out.replace(/\s*$/, "\n\nexport { __ui5_default as default };\n");
	const result = finish(out, warnings);
	result.warnings.push(`line ${def.loc.start.line}: sap.ui.define is not a top-level statement; its result is exported`);
	return result;
}

function finish(code, warnings) {
	let ast;
	try {
		ast = parse(code, "module");
	} catch (err) {
		const e = new Error(`result is not a valid ES module: ${err.message}`);
		if (err.loc) e.line = err.loc.line;
		throw e;
	}
	const left = loaderCalls(ast).filter((c) => !isProbe(c));
	if (left.length) {
		const kinds = [...new Set(left.map((c) => "sap.ui." + c.kind))].join(", ");
		warnings.push(`${kinds} still present in the output (${left.length} call(s))`);
	}
	return { code, warnings };
}

/** Returns the replacement text, or null when the call is left as is. */
function convertRequire(code, { kind, node }, spec, identFor, warnings) {
	const args = node.arguments;
	const line = node.loc.start.line;
	const leave = (reason) => {
		warnings.push(`line ${line}: left sap.ui.${kind}(...) as is (${reason})`);
		return null;
	};
	if (args.some((a) => a.type === "SpreadElement")) return leave("spread arguments");

	if (args.length === 1 && isStr(args[0])) {
		if (kind === "requireSync") {
			warnings.push(`line ${line}: sap.ui.requireSync("${args[0].value}") converted to a static import`);
		}
		return identFor(args[0].value);
	}
	if (kind === "requireSync") return leave("not a single string literal");

	if (args[0]?.type !== "ArrayExpression") return leave("non-literal dependency list");
	if (!args[0].elements.every(isStr)) return leave("non-literal dependency list");
	if (args.length > 3) return leave("too many arguments");
	const deps = args[0].elements.map((e) => e.value);
	const all = `Promise.all([${deps.map((d) => `import(${JSON.stringify(spec(d))})`).join(", ")}])`;
	if (args.length === 1) return all;

	const cb = args[1];
	if ((cb.type !== "FunctionExpression" && cb.type !== "ArrowFunctionExpression") || cb.generator) {
		return leave("callback is not an inline function");
	}
	if (!cb.params.every((p) => p.type === "Identifier")) return leave("callback has non-identifier parameters");
	if (cb.params.length > deps.length) return leave("callback has more parameters than dependencies");
	if (cb.type === "FunctionExpression") {
		const used = usesThisOrArguments(cb.body);
		if (used === "arguments") warnings.push(`line ${line}: callback uses \`arguments\`, which changes meaning in an arrow function`);
	}
	const pattern = cb.params.length ? `([${cb.params.map((p) => `{ default: ${p.name} }`).join(", ")}])` : "()";
	const thisEdits = cb.type === "FunctionExpression" ? ownThis(cb.body).map((n) => ({ start: n.start, end: n.end, text: "globalThis" })) : [];
	let bodyText = code.slice(cb.body.start, cb.body.end);
	// arrow params are destructured (non-simple), where "use strict" is a syntax error;
	// the output is a module, which is strict anyway
	const strict = cb.body.type === "BlockStatement" && cb.body.body.find((s) => s.directive === "use strict");
	if (strict) {
		let a = strict.start;
		let b = strict.end;
		const ls = lineStartOf(code, a);
		const nl = code.indexOf("\n", b);
		if (/^[ \t]*$/.test(code.slice(ls, a)) && nl !== -1 && /^[ \t;]*\r?$/.test(code.slice(b, nl))) {
			a = ls;
			b = nl + 1;
		}
		thisEdits.push({ start: a, end: b, text: "" });
	}
	if (thisEdits.length) bodyText = applyEdits(bodyText, thisEdits, cb.body.start);
	const body = cb.body.type === "BlockStatement" ? bodyText : `(${bodyText})`;
	let out = `${all}.then(${cb.async ? "async " : ""}${pattern} => ${body})`;
	if (args[2]) out += `.catch(${code.slice(args[2].start, args[2].end)})`;
	return out;
}

function fail(message, node) {
	const err = new Error(message);
	if (node?.loc) err.line = node.loc.start.line;
	return err;
}

function findNestedReturn(stmt) {
	let found = null;
	walk(stmt, (n) => {
		if (found || FUNCTION_TYPES.has(n.type)) return false;
		if (n.type === "ReturnStatement") found = n;
	});
	return found;
}

function lineStartOf(code, pos) {
	return code.lastIndexOf("\n", pos - 1) + 1;
}

function convertFactoryBody(code, block) {
	const rs = block.start + 1;
	const re = block.end - 1;
	const stmts = block.body;
	const edits = [];
	const skipLines = new Set();

	// "use strict" directive (module code is always strict)
	for (const s of stmts) {
		if (!s.directive) break;
		if (s.directive !== "use strict") continue;
		const ls = lineStartOf(code, s.start);
		let le = code.indexOf("\n", s.end);
		if (le === -1 || le > re) le = re;
		if (/^[ \t]*$/.test(code.slice(ls, s.start)) && /^[ \t;]*$/.test(code.slice(s.end, le)) && ls >= rs) {
			edits.push({ start: ls, end: le < re ? le + 1 : le, text: "" });
			skipLines.add(ls);
		} else {
			edits.push({ start: s.start, end: s.end, text: "" });
		}
	}

	// the UI5 loader calls factories with this === globalThis; in a module, `this` is undefined
	for (const t of ownThis(block)) edits.push({ start: t.start, end: t.end, text: "globalThis" });

	const returns = stmts.filter((s) => s.type === "ReturnStatement");
	for (const s of stmts) {
		const nested = s.type !== "ReturnStatement" && findNestedReturn(s);
		if (nested) throw fail("return statement nested inside a block (if/for/try/...)", nested);
	}
	if (returns.length > 1) throw fail("multiple top-level return statements", returns[1]);

	let needsUndefined = true;
	const ret = returns[0];
	if (ret) {
		const after = stmts.slice(stmts.indexOf(ret) + 1);
		if (after.some((s) => s.type !== "FunctionDeclaration" && s.type !== "EmptyStatement")) {
			throw fail("statements after the top-level return", after.find((s) => s.type !== "FunctionDeclaration" && s.type !== "EmptyStatement"));
		}
		if (ret.argument) {
			needsUndefined = false;
			edits.push({ start: ret.start, end: ret.start + "return".length, text: "export default" });
			const arg = ret.argument;
			const head = code.slice(arg.start, arg.start + 30);
			const wrap =
				arg.type === "SequenceExpression" ||
				(arg.type !== "FunctionExpression" && arg.type !== "ClassExpression" &&
					/^(async\s+)?(function|class)\b/.test(head));
			if (wrap) {
				edits.push({ start: arg.start, end: arg.start, text: "(" });
				edits.push({ start: arg.end, end: arg.end, text: ")" });
			}
		} else {
			edits.push({ start: ret.start, end: ret.end, text: "" });
		}
	}

	// Dedent: common leading whitespace of all body lines, except lines that
	// start inside a template literal or a multi-line string.
	const protectedRanges = [];
	walk(block, (n) => {
		if (n.type === "TemplateLiteral" || (n.type === "Literal" && typeof n.value === "string" && n.raw.includes("\n"))) {
			protectedRanges.push([n.start, n.end]);
		}
	});
	const lines = [];
	for (let p = code.indexOf("\n", rs); p !== -1 && p < re; p = code.indexOf("\n", p + 1)) {
		const L = p + 1;
		if (L >= re || skipLines.has(L)) continue;
		if (protectedRanges.some(([a, b]) => a < L && L < b)) continue;
		let w = L;
		while (w < re && (code[w] === " " || code[w] === "\t")) w++;
		const blank = w >= re || code[w] === "\n" || code[w] === "\r";
		lines.push({ L, ws: code.slice(L, w), blank });
	}
	let common = null;
	for (const { ws, blank } of lines) {
		if (blank) continue;
		if (common === null) common = ws;
		else {
			let k = 0;
			while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
			common = common.slice(0, k);
		}
		if (!common) break;
	}
	if (common) {
		for (const { L, ws } of lines) {
			let k = 0;
			while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
			if (k) edits.push({ start: L, end: L + k, text: "" });
		}
	}

	let text = applyEdits(code.slice(rs, re), edits, rs);
	// a body that starts on the "{" line (one-liners) has no indentation to keep
	text = /^[ \t]*\r?\n/.test(code.slice(rs, re)) ? text.replace(/^[ \t]*(\r?\n)+/, "") : text.trimStart();
	text = text.replace(/\s+$/, "");
	if (needsUndefined) text += (text ? "\n\n" : "") + "export default undefined;";
	return text;
}
