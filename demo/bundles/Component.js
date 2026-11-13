import { require } from "../../bundles/esm-ui5-bootstrap.js";
import "./controller/App.controller.js";

const [UIComponent] = await require(["sap/ui/core/UIComponent"]);

export default UIComponent.extend("demo.todo.Component", {
	metadata: {
		manifest: "json",
		interfaces: ["sap.ui.core.IAsyncContentCreation"],
	},
});
