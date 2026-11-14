import * as acorn from "acorn";

const UI5_INITIALIZER = 'Symbol.for("esm-ui5.native-class-initializer")';

function parseSource(source, comments) {
	const options = { ecmaVersion: "latest", sourceType: "script", allowHashBang: true };
	if (comments) options.onComment = comments;
	try {
		return acorn.parse(source, options);
	} catch (scriptError) {
		try {
			return acorn.parse(source, { ...options, sourceType: "module" });
		} catch {
			throw scriptError;
		}
	}
}

function walk(node, visit, parent = null) {
	if (!node || typeof node.type !== "string") return;
	visit(node, parent);
	for (const key in node) {
		if (key === "loc") continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) walk(child, visit, node);
		} else if (value && typeof value.type === "string") {
			walk(value, visit, node);
		}
	}
}

function sourceEdits(source, edits) {
	let result = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

function memberName(node) {
	if (!node) return null;
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (node.computed && node.property.type === "Literal") return String(node.property.value);
	return null;
}

function propertyName(source, property) {
	if (property.computed) {
		if (property.key.type !== "Literal") return null;
		return String(property.key.value);
	}
	return property.key.type === "Identifier" ? property.key.name : String(property.key.value);
}

function methodKey(source, property) {
	const keyNode = property.type === "MemberExpression" ? property.property : property.key;
	const key = source.slice(keyNode.start, keyNode.end);
	return property.computed ? `[${key}]` : key;
}

function functionParameters(source, fn) {
	const open = source.lastIndexOf("(", fn.params[0]?.start ?? fn.body.start);
	const close = source.lastIndexOf(")", fn.body.start);
	if (open < 0 || close < open) throw new SyntaxError("cannot locate function parameters while converting a UI5 class");
	return source.slice(open, close + 1);
}

function functionMethod(source, key, fn) {
	const params = functionParameters(source, fn);
	const prefix = `${fn.async ? "async " : ""}${fn.generator ? "*" : ""}`;
	return `${prefix}${key}${params}${source.slice(fn.body.start, fn.body.end)}`;
}

function isFunctionProperty(property) {
	return property.type === "Property"
		&& (property.method || property.kind === "init")
		&& property.value?.type === "FunctionExpression";
}

function isPublicMethod(name) {
	return name != null && !/^_|^on|^init$|^exit$/.test(name);
}

function leadingComments(source, comments, previousEnd, nodeStart) {
	const relevant = comments.filter((comment) => comment.start >= previousEnd && comment.end <= nodeStart);
	return relevant.map((comment) => source.slice(comment.start, comment.end)).join("\n");
}

function nearestFunction(node, parents) {
	for (let current = node; current; current = parents.get(current)) {
		if (current.type === "FunctionExpression" || current.type === "FunctionDeclaration" || current.type === "ArrowFunctionExpression") {
			return current;
		}
	}
	return null;
}

function statementContainer(node, parents, expectedFunction) {
	const container = parents.get(node);
	if (container?.type === "Program" && !expectedFunction) return { block: container };
	if (container?.type === "BlockStatement" && container === expectedFunction?.body) return { block: container };
	return null;
}

function constructorBody(source, fn, base, parents) {
	const edits = [];
	walk(fn.body, (node, parent) => {
		if (nearestFunction(node, parents) !== fn) return;
		if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
		const operation = memberName(node.callee);
		if (operation !== "apply" && operation !== "call") return;
		const receiver = source.slice(node.callee.object.start, node.callee.object.end);
		if (receiver !== base && !/\.prototype\.constructor$/.test(receiver)) return;
		const args = node.arguments;
		if (args[0]?.type !== "ThisExpression") return;
		const parentClass = receiver.replace(/\.prototype\.constructor$/, "");
		if (parentClass === "Object") return;
		const forwarded = operation === "apply"
			? args[1] ? source.slice(args[1].start, args[1].end) : "[]"
			: `[${args.slice(1).map((arg) => source.slice(arg.start, arg.end)).join(", ")}]`;
		edits.push({
			start: node.start,
			end: node.end,
			text: initializerCall(parentClass, "this", forwarded),
		});
	}, parents);
	const body = sourceEdits(source.slice(fn.body.start, fn.body.end), edits.map((edit) => ({
		...edit,
		start: edit.start - fn.body.start,
		end: edit.end - fn.body.start,
	})));
	return body;
}

function initializerCall(base, instance, args) {
	return `(typeof ${base}[${UI5_INITIALIZER}] === "function"
		? ${base}[${UI5_INITIALIZER}](${instance}, ${args})
		: ${base}.apply(${instance}, ${args}))`;
}

function initializerApiMethods() {
	return [
		`static apply(instance, args) {
			return this[${UI5_INITIALIZER}](instance, args);
		}`,
		`static call(instance, ...args) {
			return this[${UI5_INITIALIZER}](instance, args);
		}`,
	];
}

function transformMetadataClass(source) {
	const comments = [];
	const ast = parseSource(source, comments);
	const parents = new Map();
	const nodes = [];
	walk(ast, (node, parent) => {
		nodes.push(node);
		if (parent) parents.set(node, parent);
	});
	const declaration = nodes.find((node) =>
		node.type === "VariableDeclarator" &&
		node.id.type === "Identifier" &&
		node.id.name === "Metadata" &&
		node.init?.type === "FunctionExpression"
	);
	if (!declaration) return null;

	const methods = [];
	const edits = [];
	let getterMethod = null;
	let createClassStatement = null;
	for (const node of nodes) {
		if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type === "MemberExpression") {
			const target = node.left.object;
			const name = memberName(node.left);
			if (
				target.type === "MemberExpression" && !target.computed &&
				target.object.type === "Identifier" && target.object.name === "Metadata" &&
				memberName(target) === "prototype" &&
				node.right.type === "FunctionExpression"
			) {
				const statement = parents.get(node);
				if (statement?.type !== "ExpressionStatement") continue;
				const methodName = name === "extend" ? "applyClassInfo" : name;
				methods.push(functionMethod(source, methodName, node.right));
				edits.push({ start: statement.start, end: statement.end, text: "" });
				continue;
			}
			if (target.type === "Identifier" && target.name === "Metadata" && name === "createClass") {
				const statement = parents.get(node);
				if (statement?.type === "ExpressionStatement") {
					createClassStatement = statement;
					edits.push({ start: statement.start, end: statement.end, text: "" });
				}
			}
		}
		if (
			node.type === "CallExpression" &&
			node.callee.type === "MemberExpression" &&
			node.callee.object.type === "Identifier" && node.callee.object.name === "Object" &&
			memberName(node.callee) === "defineProperty" &&
			node.arguments[0]?.type === "MemberExpression" &&
			node.arguments[0].object.name === "Metadata" &&
			memberName(node.arguments[0]) === "prototype" &&
			node.arguments[1]?.type === "Literal" && node.arguments[1].value === "_mImplementedTypes"
		) {
			const descriptor = node.arguments[2];
			const getter = descriptor?.properties.find((property) => propertyName(source, property) === "get")?.value;
			if (getter?.type === "FunctionExpression") {
				getterMethod = `get _mImplementedTypes() ${source.slice(getter.body.start, getter.body.end)}`;
				const statement = parents.get(node);
				if (statement?.type === "ExpressionStatement") edits.push({ start: statement.start, end: statement.end, text: "" });
			}
		}
	}

	const constructorSource = functionMethod(source, "constructor", declaration.init);
	const constructorEdits = [];
	walk(declaration.init.body, (node) => {
		if (nearestFunction(node, parents) !== declaration.init) return;
		if (node.type === "CallExpression" && node.callee.type === "MemberExpression"
			&& node.callee.object.type === "ThisExpression" && memberName(node.callee) === "extend") {
			constructorEdits.push({ start: node.callee.property.start, end: node.callee.property.end, text: "applyClassInfo" });
		}
	});
	const constructorBody = sourceEdits(
		source.slice(declaration.init.body.start, declaration.init.body.end),
		constructorEdits.map((edit) => ({
			...edit,
			start: edit.start - declaration.init.body.start,
			end: edit.end - declaration.init.body.start,
		}))
	);
	const ctor = constructorSource.replace(
		source.slice(declaration.init.body.start, declaration.init.body.end),
		() => constructorBody
	);
	const initializerMethod = `static [${UI5_INITIALIZER}](instance, args) {
		return (function${functionParameters(source, declaration.init)}${constructorBody}).apply(instance, args);
	}`;
	const registrationMethod = `static registerClass(fnClass, sClassName, oClassInfo, FNMetaImpl) {
		FNMetaImpl = FNMetaImpl || Metadata;
		oClassInfo = oClassInfo || {};
		if (typeof FNMetaImpl.preprocessClassInfo === "function") {
			oClassInfo = FNMetaImpl.preprocessClassInfo(oClassInfo);
		}
		oClassInfo = oClassInfo || {};
		oClassInfo.constructor = fnClass;
		oClassInfo.metadata = oClassInfo.metadata || {};
		var fnBaseClass = Object.getPrototypeOf(fnClass);
		if (fnBaseClass && typeof fnBaseClass.getMetadata === "function") {
			oClassInfo.metadata.baseType = fnBaseClass;
		} else {
			delete oClassInfo.metadata.baseType;
		}
		ObjectPath.set(sClassName, fnClass);
		var oMetadata = new FNMetaImpl(sClassName, oClassInfo);
		var getMetadata = function() { return oMetadata; };
		fnClass.getMetadata = fnClass.prototype.getMetadata = getMetadata;
		for (var sName of Object.getOwnPropertyNames(fnClass.prototype)) {
			if (sName !== "constructor" && sName !== "_mImplementedTypes") {
				var oDescriptor = Object.getOwnPropertyDescriptor(fnClass.prototype, sName);
				oDescriptor.enumerable = true;
				Object.defineProperty(fnClass.prototype, sName, oDescriptor);
			}
		}
		return oMetadata;
	}`;
	const classBody = [
		ctor,
		...initializerApiMethods(),
		initializerMethod,
		...methods,
		getterMethod,
		registrationMethod,
		`static {
			for (var sName of Object.getOwnPropertyNames(this.prototype)) {
				if (sName !== "constructor" && sName !== "_mImplementedTypes") {
					var oDescriptor = Object.getOwnPropertyDescriptor(this.prototype, sName);
					oDescriptor.enumerable = true;
					Object.defineProperty(this.prototype, sName, oDescriptor);
				}
			}
		}`,
	].filter(Boolean).join("\n");
	edits.push({
		start: declaration.init.start,
		end: declaration.init.end,
		text: `class Metadata {\n${classBody}\n}`,
	});
	if (!createClassStatement) throw new SyntaxError("Metadata class factory was not found");
	return sourceEdits(source, edits);
}

function makeClassExpression(source, call, parent, factory, extraMethods) {
	const classInfo = factory.classInfo;
	const properties = classInfo?.properties ?? [];
	const methods = [];
	const registrationProperties = [];
	const publicMethodNames = [];
	let metadataProperty;
	let constructorProperty = factory.constructorProperty;

	for (const property of properties) {
		const name = propertyName(source, property);
		if (name === "metadata") {
			metadataProperty = property;
			continue;
		}
		if (name === "constructor") {
			constructorProperty = property;
			continue;
		}
		if (isFunctionProperty(property)) {
			if (property.computed && name == null) {
				throw new SyntaxError(`dynamic computed class method in ${factory.className}`);
			}
			methods.push(functionMethod(source, methodKey(source, property), property.value));
		} else {
			registrationProperties.push(source.slice(property.start, property.end));
		}
		if (isPublicMethod(name)) publicMethodNames.push(name);
	}

	const emptyConstructor = constructorProperty?.value?.type === "Literal" && constructorProperty.value.value == null
		|| constructorProperty?.value?.type === "Identifier" && constructorProperty.value.name === "undefined";
	let constructorFunction = null;
	if (constructorProperty && !emptyConstructor) {
		constructorFunction = constructorProperty.value?.type === "FunctionExpression"
			? constructorProperty.value
			: factory.constructorFunction;
		if (!constructorFunction) {
			throw new SyntaxError(`non-function constructor in ${factory.className}`);
		}
	}
	const constructorImpl = constructorFunction
		? `return (function${functionParameters(source, constructorFunction)}${constructorBody(source, constructorFunction, factory.base, factory.parents)}).apply(instance, args);`
		: factory.base && factory.base !== "Object"
			? `return ${initializerCall(factory.base, "instance", "args")};`
			: "return undefined;";
	methods.unshift(
		`constructor(...args) {
			const instance = Object.create(new.target.prototype);
			const result = new.target[${UI5_INITIALIZER}](instance, args);
			return result !== null && (typeof result === "object" || typeof result === "function") ? result : instance;
		}`,
		...initializerApiMethods(),
		`static [${UI5_INITIALIZER}](instance, args) {
			${constructorImpl}
		}`
	);

	const className = factory.localName || factory.className.split(/[./~]/).filter(Boolean).at(-1);
	const declarationName = className && className !== factory.base && /^[A-Za-z_$][\w$]*$/.test(className) ? ` ${className}` : "";
	const extendsClause = factory.base ? ` extends ${factory.base}` : "";
	const metadataSource = metadataProperty ? source.slice(metadataProperty.value.start, metadataProperty.value.end) : "{}";
	const publicMethods = publicMethodNames.length
		? `__ui5ClassMetadata.publicMethods = [...(__ui5ClassMetadata.publicMethods || []), ${publicMethodNames.map((name) => JSON.stringify(name)).join(", ")}];`
		: "";
	const registrationBase = factory.base
		? `${factory.base}.getMetadata().constructor`
		: "undefined";
	const metadataImpl = factory.metadataImpl || registrationBase;
	const factoryObject = factory.classInfoSource && !classInfo
		? `__ui5ClassInfo`
		: `{ metadata: __ui5ClassMetadata, constructor: this${registrationProperties.length ? `, ${registrationProperties.join(", ")}` : ""} }`;
	const nameArg = factory.classNameSource ?? JSON.stringify(factory.className);
	const postNames = [...new Set(extraMethods.map((method) => method.name).filter(Boolean))];
	const capture = postNames.length
		? `const __ui5PostMethods = [${postNames.map((name) => `[${JSON.stringify(name)}, Object.getOwnPropertyDescriptor(this.prototype, ${JSON.stringify(name)})?.value]`).join(", ")}];`
		: "";
	const hidePostMethods = postNames.map((name) => `delete this.prototype[${JSON.stringify(name)}];`).join(" ");
	const methodValues = new Map(postNames.map((name, index) => [name, `__ui5PostMethods[${index}][1]`]));
	const restore = extraMethods.map((method) => {
		const key = JSON.stringify(method.name);
		const value = method.isMethod ? methodValues.get(method.name) : method.value;
		return `Object.defineProperty(this.prototype, ${key}, { value: ${value}, writable: true, configurable: true, enumerable: true });`;
	}).join(" ");
	const staticMethods = (factory.staticMethods ?? []).map((method) => method.code).join(" ");
	const bodyMethods = [...methods, ...extraMethods.map((method) => method.code)].join("\n");
	const metadataInit = factory.classInfoSource && !classInfo
		? `const __ui5ClassInfo = ${factory.classInfoSource} || {}; __ui5ClassInfo.constructor = this; __ui5ClassInfo.metadata = __ui5ClassInfo.metadata || {};`
		: `const __ui5ClassMetadata = { ...(${metadataSource} || {}) }; ${publicMethods}`;
	const classInfoInit = `${capture} ${hidePostMethods} ${metadataInit} ${factory.base
		? `${factory.base}.defineClass(${nameArg}, ${factoryObject}, ${metadataImpl});`
		: `${factory.receiver}.registerClass(this, ${nameArg}, ${factoryObject}, ${metadataImpl});`
	} ${restore} ${staticMethods}`;
	const body = bodyMethods ? `\n${bodyMethods}\n` : "\n";
	return `class${declarationName}${extendsClause} { static { ${classInfoInit} }${body}}`;
}

/**
 * Converts UI5 class-factory calls and the class's prototype methods to native classes.
 * Renderer extension calls are not class factories and are intentionally left alone.
 */
export function transformNativeClasses(source, moduleName = "") {
	if (moduleName.endsWith("sap/ui/base/Metadata.js")) {
		return transformMetadataClass(source);
	}
	if (!/\.\s*(?:extend|createClass)\s*\(/.test(source)) return null;
	const comments = [];
	const ast = parseSource(source, comments);
	const parents = new Map();
	const factories = [];
	const byLocalName = new Map();
	const allNodes = [];
	walk(ast, (node, parent) => {
		allNodes.push(node);
		if (parent) parents.set(node, parent);
		if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
		const method = memberName(node.callee);
		if (method !== "extend" && method !== "createClass") return;
		const receiverName = node.callee.object.type === "Identifier"
			? node.callee.object.name
			: node.callee.object.type === "MemberExpression" ? memberName(node.callee.object) : null;
		const isRendererExtension = method === "extend"
			&& typeof receiverName === "string" && /Renderer$/.test(receiverName);
		const isFactory = method === "createClass"
			? node.callee.object.type === "Identifier" && node.callee.object.name === "Metadata"
			: node.arguments[0]?.type === "Literal" && typeof node.arguments[0].value === "string" && !isRendererExtension;
		if (!isFactory) return;

		let className;
		let classNameSource;
		let base = null;
		let classInfo;
		let classInfoSource;
		let metadataImpl = null;
		let receiver = null;
		let infoIndex;
		if (method === "extend") {
			className = node.arguments[0].value;
			classNameSource = JSON.stringify(className);
			base = source.slice(node.callee.object.start, node.callee.object.end);
			classInfo = node.arguments[1]?.type === "ObjectExpression" ? node.arguments[1] : null;
			classInfoSource = node.arguments[1] ? source.slice(node.arguments[1].start, node.arguments[1].end) : null;
			infoIndex = 1;
			if (node.arguments[2]) metadataImpl = source.slice(node.arguments[2].start, node.arguments[2].end);
		} else {
			receiver = source.slice(node.callee.object.start, node.callee.object.end);
			if (node.arguments[0]?.type === "Literal" && typeof node.arguments[0].value === "string") {
				className = node.arguments[0].value;
				classNameSource = JSON.stringify(className);
				classInfo = node.arguments[1]?.type === "ObjectExpression" ? node.arguments[1] : null;
				classInfoSource = node.arguments[1] ? source.slice(node.arguments[1].start, node.arguments[1].end) : null;
				infoIndex = 1;
				if (node.arguments[2]) metadataImpl = source.slice(node.arguments[2].start, node.arguments[2].end);
			} else if (node.arguments.length >= 3) {
				base = source.slice(node.arguments[0].start, node.arguments[0].end);
				className = source.slice(node.arguments[1].start, node.arguments[1].end);
				classNameSource = className;
				classInfo = node.arguments[2]?.type === "ObjectExpression" ? node.arguments[2] : null;
				classInfoSource = node.arguments[2] ? source.slice(node.arguments[2].start, node.arguments[2].end) : null;
				infoIndex = 2;
				if (node.arguments[3]) metadataImpl = source.slice(node.arguments[3].start, node.arguments[3].end);
			} else {
				return;
			}
		}
		const callParent = parents.get(node);
		let localName;
		if (callParent?.type === "VariableDeclarator" && callParent.id.type === "Identifier") localName = callParent.id.name;
		else if (callParent?.type === "AssignmentExpression" && callParent.left.type === "Identifier") localName = callParent.left.name;
		else if (callParent?.type === "AssignmentExpression" && callParent.left.type === "MemberExpression") localName = memberName(callParent.left);
		else if (callParent?.type === "ExportDefaultDeclaration") localName = className.split(/[./~]/).filter(Boolean).at(-1);
		const factory = {
			call: node, parent: callParent, className, classNameSource, localName, base, classInfo,
			classInfoSource, classInfoStart: node.arguments[infoIndex]?.start, classInfoEnd: node.arguments[infoIndex]?.end,
			metadataImpl, receiver, parents, scopeFunction: nearestFunction(node, parents),
		};
		factories.push(factory);
		if (localName) {
			if (byLocalName.has(localName)) throw new SyntaxError(`multiple native class declarations named ${localName}`);
			byLocalName.set(localName, factory);
		}
	});

	if (!factories.length) return null;

	for (const factory of factories) {
		let constructorProperty = factory.classInfo?.properties.find((property) => propertyName(source, property) === "constructor");
		if (!constructorProperty && factory.classInfoSource) {
			const start = factory.classInfoStart;
			const end = factory.classInfoEnd;
			factory.constructorProperty = allNodes
				.filter((node) => node.type === "Property"
					&& propertyName(source, node) === "constructor"
					&& node.start >= start && node.end <= end)
				.sort((a, b) => b.start - a.start)[0];
			constructorProperty = factory.constructorProperty;
		}
		if (constructorProperty?.value?.type !== "Identifier") continue;
		const constructorName = constructorProperty.value.name;
		const declaration = allNodes
			.filter((node) => node.type === "FunctionDeclaration" && node.id?.name === constructorName)
			.filter((node) => nearestFunction(parents.get(node), parents) === factory.scopeFunction)
			.sort((a, b) => Math.abs(a.start - factory.call.start) - Math.abs(b.start - factory.call.start))[0];
		if (declaration) factory.constructorFunction = declaration;
	}

	for (const node of allNodes) {
		if (node.type !== "AssignmentExpression" || node.operator !== "=" || node.left.type !== "MemberExpression") continue;
		if (node.left.object.type === "Identifier" && node.right.type === "FunctionExpression") {
			const factory = byLocalName.get(node.left.object.name);
			const statement = parents.get(node);
			const container = statement?.type === "ExpressionStatement"
				? statementContainer(statement, parents, factory?.scopeFunction)
				: null;
			const name = memberName(node.left);
			if (factory && container && factory.className === "sap.ui.base.Object" && name === "defineClass") {
				const value = `function(sClassName, oStaticInfo, FNMetaImpl) {
						var oClass = oStaticInfo.constructor;
						var oMetadata = Metadata.registerClass(oClass, sClassName, oStaticInfo, FNMetaImpl || Metadata);
						Log.debug("defined class '" + sClassName + "'" + (oMetadata.getParent() ? " as subclass of " + oMetadata.getParent().getName() : ""));
						return oMetadata;
					}`;
				const code = `Object.defineProperty(this, ${JSON.stringify(name)}, { value: ${value}, writable: true, configurable: true, enumerable: true });`;
				factory.staticMethods ??= [];
				factory.staticMethods.push({ name, code });
				factory.removals ??= [];
				factory.removals.push(statement);
				continue;
			}
		}
		const prototype = node.left.object;
		if (prototype.type !== "MemberExpression" || prototype.computed || memberName(prototype) !== "prototype") continue;
		if (prototype.object.type !== "Identifier") continue;
		const factory = byLocalName.get(prototype.object.name);
		if (!factory) continue;
		const property = node.left;
		const name = memberName(property);
		if (name == null) continue;
		const statement = parents.get(node);
		if (statement?.type !== "ExpressionStatement" || statement.expression !== node) continue;
		const container = statementContainer(statement, parents, factory.scopeFunction);
		if (!container) continue;
		const previous = container.block.body
			.filter((item) => item.end <= statement.start)
			.at(-1);
		const commentsText = leadingComments(source, comments, previous?.end ?? container.block.start, statement.start);
		if (node.right.type === "FunctionExpression" && name !== "constructor") {
			const key = methodKey(source, property);
			factory.prototypeMethods ??= [];
			factory.prototypeMethods.push({
				name, key, functionNode: node.right, commentsText, code: "", statement, isMethod: true,
			});
		} else {
			factory.prototypeMethods ??= [];
			factory.prototypeMethods.push({
				name,
				code: "",
				statement,
				isMethod: false,
				value: source.slice(node.right.start, node.right.end),
			});
		}
	}

	const removedFactoryCalls = new Set();
	for (const owner of factories) {
		for (const statement of owner.removals ?? []) {
			for (const factory of factories) {
				if (factory !== owner && factory.call.start >= statement.start && factory.call.end <= statement.end) {
					removedFactoryCalls.add(factory);
				}
			}
		}
	}
	if (removedFactoryCalls.size) {
		for (const factory of removedFactoryCalls) {
			if (factory.localName && byLocalName.get(factory.localName) === factory) byLocalName.delete(factory.localName);
		}
		for (let i = factories.length - 1; i >= 0; i--) {
			if (removedFactoryCalls.has(factories[i])) factories.splice(i, 1);
		}
	}

	for (const factory of factories) {
		const seen = new Set();
		for (const method of [...(factory.prototypeMethods ?? [])].sort((a, b) => a.statement.start - b.statement.start)) {
			if (!method.isMethod) continue;
			if (seen.has(method.name)) {
				method.isMethod = false;
			} else {
				seen.add(method.name);
			}
		}
	}

	const allPrototypeMethods = factories.flatMap((factory) => factory.prototypeMethods ?? []);
	const contains = (container, node) => container.start <= node.start && node.end <= container.end;
	const isInsideOtherMethod = (node, except) => allPrototypeMethods.some((method) =>
		method !== except && method.functionNode && contains(method.functionNode.body, node)
	);
	const renderedFactories = new Map();
	function renderFactory(factory) {
		if (renderedFactories.has(factory)) return renderedFactories.get(factory);
		const extraMethods = (factory.prototypeMethods ?? []).filter((method) => method.isMethod).sort((a, b) => a.statement.start - b.statement.start);
		for (const method of extraMethods) {
			const fn = method.functionNode;
			const body = source.slice(fn.body.start, fn.body.end);
			const nestedFactories = factories
				.filter((candidate) => candidate !== factory && contains(fn.body, candidate.call))
				.filter((candidate) => !isInsideOtherMethod(candidate.call, method))
				.filter((candidate, _, candidates) => !candidates.some((other) =>
					other !== candidate && contains(other.call, candidate.call)
				));
			const nestedEdits = [];
			for (const nested of nestedFactories) {
				nestedEdits.push({
					start: nested.call.start - fn.body.start,
					end: nested.call.end - fn.body.start,
					text: renderFactory(nested),
				});
				for (const nestedMethod of nested.prototypeMethods ?? []) {
					if (nestedMethod.isMethod && contains(fn.body, nestedMethod.statement) && !isInsideOtherMethod(nestedMethod.statement, method)) {
						nestedEdits.push({
							start: nestedMethod.statement.start - fn.body.start,
							end: nestedMethod.statement.end - fn.body.start,
							text: "",
						});
					}
				}
				for (const statement of nested.removals ?? []) {
					if (contains(fn.body, statement) && !isInsideOtherMethod(statement, method)) {
						nestedEdits.push({
							start: statement.start - fn.body.start,
							end: statement.end - fn.body.start,
							text: "",
						});
					}
				}
			}
			const convertedBody = nestedEdits.length ? sourceEdits(body, nestedEdits) : body;
			const methodCode = functionMethod(source, method.key, fn)
				.replace(source.slice(fn.body.start, fn.body.end), () => convertedBody);
			method.code = `${method.commentsText ? method.commentsText + "\n" : ""}${methodCode}`;
		}
		const converted = makeClassExpression(source, factory.call, factory.parent, factory, extraMethods);
		renderedFactories.set(factory, converted);
		return converted;
	}

	const edits = [];
	for (const factory of factories) {
		const extraMethods = (factory.prototypeMethods ?? []).sort((a, b) => a.statement.start - b.statement.start);
		if (!isInsideOtherMethod(factory.call, null)) {
			edits.push({
				start: factory.call.start,
				end: factory.call.end,
				text: renderFactory(factory),
			});
		}
		for (const method of extraMethods) {
			if (method.isMethod && !isInsideOtherMethod(method.statement, method)) {
				edits.push({ start: method.statement.start, end: method.statement.end, text: "" });
			}
		}
		for (const statement of factory.removals ?? []) {
			if (!isInsideOtherMethod(statement, null)) {
				edits.push({ start: statement.start, end: statement.end, text: "" });
			}
		}
	}
	return sourceEdits(source, edits);
}
