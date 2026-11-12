/*!
 * A UMD-style module like sap/ui/Device.js
 */
import __ui5_dep0 from "/sap/base/Log.js";

let __ui5_default;
function __ui5_define(...args) {
	const factory = args.filter((a) => !Array.isArray(a) && typeof a !== "string" && typeof a !== "boolean").pop();
	__ui5_default = typeof factory === "function" ? factory.call(globalThis, __ui5_dep0) : factory;
}

(function() {
	var Device = { system: {} };
	window.sap = window.sap || {};
	if (__ui5_define) {
		__ui5_define("sap/ui/Device", ["sap/base/Log"], function(Log) {
			Log.info("Device");
			return Device;
		});
	}
}());

export { __ui5_default as default };
