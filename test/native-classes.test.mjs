import { test } from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";
import { transformNativeClasses } from "../src/native-classes.mjs";

test("native class conversion preserves inheritance and post-registration prototype methods", () => {
	const source = `
var Child = Base.extend("example.Child", {
	metadata: {},
	constructor: function(value) {
		Base.apply(this, arguments);
		this.value = value;
	},
	read: function() {
		return this.value;
	}
});
Child.prototype.afterRegistration = function() {
	return "after";
};
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.match(transformed, /class Child extends Base/);
	assert.match(transformed, /Symbol\.for\("esm-ui5\.native-class-initializer"\)/);
	assert.doesNotMatch(transformed, /\.extend\s*\(/);

	class TestMetadata {
		constructor(name, info) {
			this.name = name;
			this.publicMethods = info.metadata.publicMethods;
		}
		getName() {
			return this.name;
		}
	}
	const baseMetadata = { constructor: TestMetadata };
	class Base {
		constructor(value) {
			this.parentValue = value;
		}
		static [Symbol.for("esm-ui5.native-class-initializer")](instance, args) {
			instance.parentValue = args[0];
		}
		static getMetadata() {
			return baseMetadata;
		}
		static defineClass(name, info, MetadataImpl) {
			const metadata = new MetadataImpl(name, info);
			const Class = info.constructor;
			Class.getMetadata = Class.prototype.getMetadata = () => metadata;
			for (const key of Object.getOwnPropertyNames(Class.prototype)) {
				if (key !== "constructor") {
					const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, key);
					descriptor.enumerable = true;
					Object.defineProperty(Class.prototype, key, descriptor);
				}
			}
			return metadata;
		}
	}
	const ChildClass = new Function("Base", `${transformed}\nreturn Child;`)(Base);
	const instance = new ChildClass("value");
	assert.equal(instance.parentValue, "value");
	assert.equal(instance.read(), "value");
	assert.equal(instance.afterRegistration(), "after");
	assert.equal(Object.getOwnPropertyDescriptor(ChildClass.prototype, "afterRegistration").enumerable, true);
	assert.deepEqual(ChildClass.getMetadata().publicMethods, ["read"]);
	assert.equal(ChildClass.extend, undefined);
	const proxyInstance = Object.create(ChildClass.prototype);
	ChildClass.apply(proxyInstance, ["proxy"]);
	assert.equal(proxyInstance.parentValue, "proxy");
	assert.equal(proxyInstance.value, "proxy");
});

test("static function assignments remain constructible after conversion", () => {
	const source = `
var Base = Metadata.createClass("example.Base", {});
Base.Factory = function() {
	this.value = 42;
};
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	const Metadata = {
		registerClass(Class, name) {
			const metadata = { getName: () => name };
			Class.getMetadata = Class.prototype.getMetadata = () => metadata;
			return metadata;
		},
	};
	const Base = new Function("Metadata", `${transformed}\nreturn Base;`)(Metadata);
	assert.equal(new Base.Factory().value, 42);
});

test("class names ending in Renderer are converted unless they use the renderer extension API", () => {
	const source = `
var ContentRenderer = Base.extend("example.ContentRenderer", {});
var RendererComposition = Renderer.extend("example.RendererComposition", {});
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	assert.match(transformed, /class ContentRenderer extends Base/);
	assert.match(transformed, /Renderer\.extend\("example\.RendererComposition"/);
});

test("class expressions do not shadow a superclass with the same name", () => {
	const source = `
var createFilterPanel = (FilterPanel) => FilterPanel.extend("sap.ui.mdc.p13n.panels.FilterPanel", {});
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.match(transformed, /class extends FilterPanel/);
	assert.doesNotMatch(transformed, /class FilterPanel extends FilterPanel/);
});

test("nested class factories and prototype methods are embedded in native class methods", () => {
	const source = `
var Outer = Base.extend("example.Outer", {});
Outer.prototype.create = function() {
	var Inner = Base.extend("example.Inner", {});
	Inner.prototype.value = function() {
		return 42;
	};
	return "$&" + new Inner().value();
};
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.doesNotMatch(transformed, /Outer\.prototype\.create/);
	assert.doesNotMatch(transformed, /Inner\.prototype\.value/);
	assert.match(transformed, /class Outer extends Base/);

	class TestMetadata {
		constructor(name, info) {
			this.name = name;
			this.publicMethods = info.metadata.publicMethods;
		}
	}
	const baseMetadata = { constructor: TestMetadata };
	class Base {
		static [Symbol.for("esm-ui5.native-class-initializer")]() {}
		static getMetadata() {
			return baseMetadata;
		}
		static defineClass(name, info, MetadataImpl) {
			const Class = info.constructor;
			const metadata = new MetadataImpl(name, info);
			Class.getMetadata = Class.prototype.getMetadata = () => metadata;
			return metadata;
		}
	}
	const OuterClass = new Function("Base", `${transformed}\nreturn Outer;`)(Base);
	assert.equal(new OuterClass().create(), "$&42");
});

test("prototype value assignments keep their original order after class conversion", () => {
	const source = `
var Widget = Base.extend("example.Widget", {});
var Enabler = Base.extend("example.Enabler", {});
Enabler.prototype.enable = function() {
	return true;
};
Widget.prototype.enable = Enabler.prototype.enable;
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.ok(transformed.indexOf("var Enabler = class") < transformed.indexOf("Widget.prototype.enable = Enabler.prototype.enable"));
	assert.match(transformed, /Widget\.prototype\.enable = Enabler\.prototype\.enable/);
});

test("prototype method overrides preserve aliases to the previous implementation", () => {
	const source = `
var Widget = Base.extend("example.Widget", {});
Widget.prototype.enable = function() {
	return "enabled";
};
const originalEnable = Widget.prototype.enable;
Widget.prototype.enable = function() {
	return originalEnable.call(this) + "!";
};
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.match(transformed, /const originalEnable = Widget\.prototype\.enable/);
	assert.match(transformed, /Widget\.prototype\.enable = function/);

	class TestMetadata {}
	class Base {
		static apply(instance) {
			return instance;
		}
		static getMetadata() {
			return { constructor: TestMetadata };
		}
		static defineClass(name, info, MetadataImpl) {
			const metadata = new MetadataImpl(name, info);
			const Class = info.constructor;
			Class.getMetadata = Class.prototype.getMetadata = () => metadata;
			return metadata;
		}
	}
	const WidgetClass = new Function("Base", `${transformed}\nreturn Widget;`)(Base);
	assert.equal(new WidgetClass().enable(), "enabled!");
});

test("ancestor constructor calls preserve initializer order and skipped constructors stay skipped", () => {
	const source = `
var Child = Control.extend("example.Child", {
	constructor: function(value) {
		this.order = ["before"];
		ManagedObject.prototype.constructor.apply(this, arguments);
		this.order.push("after");
	}
});
var Empty = Base.extend("example.Empty", {
	constructor: function() {}
});
var LegacyDefault = LegacyBase.extend("example.LegacyDefault", {});
var LegacyExplicit = LegacyBase.extend("example.LegacyExplicit", {
	constructor: function(value) {
		LegacyBase.apply(this, arguments);
		this.explicit = true;
	}
});
`;
	const transformed = transformNativeClasses(source);
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.match(transformed, /class Child extends Control/);
	assert.match(transformed, /ManagedObject\[Symbol\.for\("esm-ui5\.native-class-initializer"\)\]/);
	assert.doesNotMatch(transformed, /ManagedObject\.prototype\.constructor\.apply/);
	assert.match(transformed, /static \[Symbol\.for\("esm-ui5\.native-class-initializer"\)\]/);

	const initializer = Symbol.for("esm-ui5.native-class-initializer");
	const metadata = { constructor: class Metadata {
		constructor(name, info) {
			this.name = name;
			this.info = info;
		}
	} };
	class ManagedObject {
		static [initializer](instance, args) {
			instance.order.push("parent");
			instance.parentValue = args[0];
		}
		static getMetadata() {
			return metadata;
		}
		static defineClass(name, info, MetadataImpl) {
			const classMetadata = new MetadataImpl(name, info);
			const Class = info.constructor;
			Class.getMetadata = Class.prototype.getMetadata = () => classMetadata;
			return classMetadata;
		}
	}
	class Control extends ManagedObject {}
	class Base extends ManagedObject {}
	function LegacyBase(value) {
		this.legacyValue = value;
	}
	LegacyBase.getMetadata = ManagedObject.getMetadata;
	LegacyBase.defineClass = ManagedObject.defineClass;
	const classes = new Function("Control", "ManagedObject", "Base", "LegacyBase", `${transformed}\nreturn { Child, Empty, LegacyDefault, LegacyExplicit };`)(
		Control,
		ManagedObject,
		Base,
		LegacyBase
	);
	const instance = new classes.Child("value");
	assert.deepEqual(instance.order, ["before", "parent", "after"]);
	assert.equal(instance.parentValue, "value");
	assert.deepEqual(new classes.Empty().order, undefined);
	assert.equal(new classes.LegacyDefault("default").legacyValue, "default");
	const legacyExplicit = new classes.LegacyExplicit("explicit");
	assert.equal(legacyExplicit.legacyValue, "explicit");
	assert.equal(legacyExplicit.explicit, true);
});

test("Metadata foundation conversion replaces its class factory with native registration", () => {
	const source = `
function factory() {
var Metadata = function(name, info) {
	this._aInterfaces = info.interfaces;
	this.extend(info);
};
Metadata.prototype.extend = function(info) {
	this.info = info;
};
Metadata.prototype.isA = function() {
	return this._mImplementedTypes.length;
};
Object.defineProperty(Metadata.prototype, "_mImplementedTypes", {
	get: function() {
		return this._aInterfaces;
	},
	configurable: true
});
Metadata.createClass = function() {};
return Metadata;
}
`;
	const transformed = transformNativeClasses(source, "sap/ui/base/Metadata.js");
	assert.ok(transformed);
	acorn.parse(transformed, { ecmaVersion: "latest", sourceType: "script" });
	assert.match(transformed, /class Metadata/);
	assert.match(transformed, /static registerClass/);
	assert.match(transformed, /static \[Symbol\.for\("esm-ui5\.native-class-initializer"\)\]/);
	assert.doesNotMatch(transformed, /Metadata\.createClass/);
	assert.doesNotMatch(transformed, /this\.extend/);
	const Metadata = new Function(`${transformed}\nreturn factory();`)();
	const instance = new Metadata("example.Metadata", { value: 42, interfaces: ["one", "two"] });
	assert.equal(instance.info.value, 42);
	assert.equal(instance.isA(), 2);
	assert.equal(Object.getOwnPropertyDescriptor(Metadata.prototype, "isA").enumerable, true);
	assert.equal(Object.getOwnPropertyDescriptor(Metadata.prototype, "_mImplementedTypes").enumerable, false);
	const proxy = Object.create(Object.getPrototypeOf(instance));
	for (const name in instance) {
		if (typeof instance[name] === "function") proxy[name] = instance[name].bind(instance);
	}
	assert.equal(proxy.isA(), 2);
	const ManagedObjectMetadata = new Function("Metadata", `
		function ManagedObjectMetadata(name, info) {
			Metadata.apply(this, arguments);
		}
		ManagedObjectMetadata.prototype = Object.create(Metadata.prototype);
		return ManagedObjectMetadata;
	`)(Metadata);
	const inherited = new ManagedObjectMetadata("example.SubMetadata", { value: 7 });
	assert.equal(inherited.info.value, 7);
});
