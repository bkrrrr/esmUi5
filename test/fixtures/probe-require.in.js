sap.ui.define(["sap/base/Log"], function(Log) {
	"use strict";
	return function() {
		var Core = sap.ui.require("sap/ui/core/Core");
		var Lib = sap.ui.requireSync("sap/ui/core/Lib");
		sap.ui.require(["sap/m/Button"], function(Button) {
			Log.info(Core, Lib, Button);
		});
	};
});
