// Fixture for sap/ui/core/mvc/Controller: extend() gives a class with the controller's methods and
// the two framework methods the Todo controller uses. A test passes a fake view.
export default {
	extend(name, methods) {
		class Controller {
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
		Object.assign(Controller.prototype, methods);
		Controller.controllerName = name;
		return Controller;
	},
};
