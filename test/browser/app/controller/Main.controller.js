// An ES module controller: XMLView finds it by name through sap.ui.require.
import MessageToast from "../../../../dist/esm/sap/m/MessageToast.js";

export default class {
	async onPress() {
		const name = this.getView().getModel().getProperty("/name");
		const bundle = await this.getView().getModel("i18n").getResourceBundle();
		MessageToast.show(bundle.getText("toast", [name]));
	}
}
