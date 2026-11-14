// Fixture for sap/ui/core/mvc/Controller: defineClass() registers a typed subclass with
// the two framework methods the Todo controller uses. A test passes a fake view.
export default class Controller {
	constructor(view) {
		this.view = view;
	}

	static defineClass(name, classInfo) {
		if (!classInfo || typeof classInfo !== "object") {
			throw new TypeError("Controller.defineClass requires class info");
		}
		const TypedController = classInfo.constructor;
		Object.assign(TypedController.prototype, Object.fromEntries(
			Object.entries(classInfo).filter(([key]) => key !== "constructor" && key !== "metadata")
		));
		TypedController.controllerName = name;
		const metadata = { constructor: TypedController, getName: () => name, getClass: () => TypedController };
		TypedController.getMetadata = TypedController.prototype.getMetadata = () => metadata;
		return metadata;
	}

	getOwnerComponent() {
		return this.view.component;
	}

	byId(id) {
		return this.view.byId(id);
	}
}
