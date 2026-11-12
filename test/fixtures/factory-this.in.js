sap.ui.define([], function() {
	"use strict";
	var Util = {
		init: function() {
			return this; // the Util object, not changed
		}
	};
	Util.months = getMonths.call(this);
	function getMonths() {
		return this === globalThis ? ["Jan"] : [];
	}
	return Util;
});
