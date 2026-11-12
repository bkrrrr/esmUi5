sap.ui.define(["sap/ui/core/Control"], function(Control) {
	"use strict";
	return Control.extend("my.Lazy", {
		open: function() {
			return new Promise(function(resolve) {
				sap.ui.require(["sap/m/Dialog"], function(Dialog) {
					sap.ui.require(["sap/m/Button"], function(Button) {
						resolve(new Dialog({ content: new Button() }));
					});
				});
			});
		}
	});
});
