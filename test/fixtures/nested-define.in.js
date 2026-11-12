/*!
 * A UMD-style module like sap/ui/Device.js
 */
(function() {
	var Device = { system: {} };
	window.sap = window.sap || {};
	if (sap.ui.define) {
		sap.ui.define("sap/ui/Device", ["sap/base/Log"], function(Log) {
			Log.info("Device");
			return Device;
		});
	}
}());
