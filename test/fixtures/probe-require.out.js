import Log from "/sap/base/Log.js";

export default function() {
	var Core = sap.ui.require("sap/ui/core/Core");
	var Lib = sap.ui.requireSync("sap/ui/core/Lib");
	Promise.all([import("/sap/m/Button.js")]).then(([{ default: Button }]) => {
		Log.info(Core, Lib, Button);
	});
};
