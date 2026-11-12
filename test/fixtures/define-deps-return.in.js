/*!
 * Header comment
 */
sap.ui.define(["sap/m/Button", "./util/Helper"], function(Button, Helper) {
	"use strict";

	var MyButton = Button.extend("my.MyButton", {
		renderer: Helper.renderer
	});

	return MyButton;
});
