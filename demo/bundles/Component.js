import UIComponent from "../../bundles/sap/ui/core/UIComponent.js";
// imported statically, so it loads together with the component (the view asks for it by name)
import "./controller/App.controller.js";

export default UIComponent.extend("demo.todo.Component", {
	metadata: {
		manifest: "json",
		interfaces: ["sap.ui.core.IAsyncContentCreation"],
	},
});
