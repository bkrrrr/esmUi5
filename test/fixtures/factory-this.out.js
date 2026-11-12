var Util = {
	init: function() {
		return this; // the Util object, not changed
	}
};
Util.months = getMonths.call(globalThis);
function getMonths() {
	return this === globalThis ? ["Jan"] : [];
}
export default Util;
