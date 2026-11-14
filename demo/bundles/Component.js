import { require } from "../../bundles/esm-ui5-bootstrap.js";
import "./controller/App.controller.js";

const [UIComponent] = await require(["sap/ui/core/UIComponent"]);

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
