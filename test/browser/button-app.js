// App code: plain static imports of esmUi5 modules (loaded after boot()).
import Button from "../../dist/esm/sap/m/Button.js";
import MessageToast from "../../dist/esm/sap/m/MessageToast.js";

new Button({
	text: "Hello esmUi5",
	type: "Emphasized",
	press: () => MessageToast.show("Native ES modules, no loader")
}).placeAt("content");
