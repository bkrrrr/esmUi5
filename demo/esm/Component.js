import UIComponent from "../../esm/sap/ui/core/UIComponent.js";
// imported statically, so it loads together with the component (the view asks for it by name)
import "./controller/App.controller.js";

export default class Component extends UIComponent {
	static {
		UIComponent.defineClass("demo.todo.Component", {
			metadata: {
				manifest: "json",
				interfaces: ["sap.ui.core.IAsyncContentCreation"],
			},
			constructor: this,
		}, UIComponent.getMetadata().constructor);
	}
}
