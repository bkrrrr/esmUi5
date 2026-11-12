/*!
 * Header comment
 */
import Button from "/sap/m/Button.js";
import Helper from "./util/Helper.js";

var MyButton = Button.extend("my.MyButton", {
	renderer: Helper.renderer
});

export default MyButton;
