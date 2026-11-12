function load(fnDone, fnError) {
	sap.ui.require(["sap/m/Dialog", "sap/m/Button"], function(Dialog, Button) {
		fnDone(new Dialog({ buttons: [new Button()] }));
	}, fnError);
	sap.ui.require(["sap/m/MessageToast"], async (MessageToast) => MessageToast.show("hi"));
	sap.ui.require(["sap/m/library"]);
	sap.ui.require(["sap/m/Popover"], function() {
		"use strict";
		fnDone(this);
	});
}
