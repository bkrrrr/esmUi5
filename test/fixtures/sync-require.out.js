import Log from "/sap/base/Log.js";
import _sap_ui_Device from "/sap/ui/Device.js";
import _sap_ui_core_Lib from "/sap/ui/core/Lib.js";

function a() {
	var Device = _sap_ui_Device;
	return Device && _sap_ui_Device.system;
}
function b() {
	return _sap_ui_core_Lib;
}
export default { a: a, b: b, log: Log };
