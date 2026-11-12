/*!
 * Some script without sap.ui.define
 */
/* global window */
import _sap_base_Log from "/sap/base/Log.js";

window.init = function() {
	var Log = _sap_base_Log;
	Promise.all([import("/sap/m/App.js")]).then(([{ default: App }]) => {
		Log.info(App.getMetadata().getName());
	});
};
