/*!
 * Some script without sap.ui.define
 */
/* global window */
window.init = function() {
	var Log = sap.ui.require("sap/base/Log");
	sap.ui.require(["sap/m/App"], function(App) {
		Log.info(App.getMetadata().getName());
	});
};
