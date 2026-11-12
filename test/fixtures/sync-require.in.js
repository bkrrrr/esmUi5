sap.ui.define(["sap/base/Log"], function(Log) {
	"use strict";
	function a() {
		var Device = sap.ui.require("sap/ui/Device");
		return Device && sap.ui.require("sap/ui/Device").system;
	}
	function b() {
		return sap.ui.requireSync("sap/ui/core/Lib");
	}
	return { a: a, b: b, log: Log };
});
