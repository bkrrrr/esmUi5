// App code: plain static imports of UI5 Next modules (loaded after boot()).
import Button from "../dist/sap/m/Button.js";
import MessageToast from "../dist/sap/m/MessageToast.js";

new Button({
	text: "Hello UI5 Next",
	type: "Emphasized",
	press: () => MessageToast.show("Native ES modules, no loader")
}).placeAt("content");
