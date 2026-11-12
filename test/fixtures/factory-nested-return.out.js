export default (function() {
	"use strict";
	if (globalThis.done) {
		return 1;
	}
	return 2;
}).call(globalThis);
