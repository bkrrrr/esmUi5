// An ES module controller: XMLView finds it by name through sap.ui.require.
import Controller from "../../../dist/sap/ui/core/mvc/Controller.js";
import MessageToast from "../../../dist/sap/m/MessageToast.js";

export default Controller.extend("demo.app.controller.Main", {
	async onPress() {
		const name = this.getView().getModel().getProperty("/name");
		const bundle = await this.getView().getModel("i18n").getResourceBundle();
		MessageToast.show(bundle.getText("toast", [name]));
	}
});
