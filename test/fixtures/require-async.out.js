function load(fnDone, fnError) {
	Promise.all([import("/sap/m/Dialog.js"), import("/sap/m/Button.js")]).then(([{ default: Dialog }, { default: Button }]) => {
		fnDone(new Dialog({ buttons: [new Button()] }));
	}).catch(fnError);
	Promise.all([import("/sap/m/MessageToast.js")]).then(async ([{ default: MessageToast }]) => (MessageToast.show("hi")));
	Promise.all([import("/sap/m/library.js")]);
	Promise.all([import("/sap/m/Popover.js")]).then(() => {
		fnDone(globalThis);
	});
}
