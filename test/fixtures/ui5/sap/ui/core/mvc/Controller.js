// Fixture for sap/ui/core/mvc/Controller: extend() gives a class with the controller's methods and
// the two framework methods the Todo controller uses. A test passes a fake view.
export default class Controller {
	static extend(name, methods) {
		if (Object.getPrototypeOf(methods) !== Object.prototype) {
			throw new TypeError("Controller.extend requires a plain methods object");
		}
		class TypedController {
			constructor(view) {
				this.view = view;
			}
			getOwnerComponent() {
				return this.view.component;
			}
			byId(id) {
				return this.view.byId(id);
			}
		}
		Object.assign(TypedController.prototype, methods);
		TypedController.controllerName = name;
		return TypedController;
	}
}
