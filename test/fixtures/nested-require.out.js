import Control from "/sap/ui/core/Control.js";

export default Control.extend("my.Lazy", {
	open: function() {
		return new Promise(function(resolve) {
			Promise.all([import("/sap/m/Dialog.js")]).then(([{ default: Dialog }]) => {
				Promise.all([import("/sap/m/Button.js")]).then(([{ default: Button }]) => {
					resolve(new Dialog({ content: new Button() }));
				});
			});
		});
	}
});
