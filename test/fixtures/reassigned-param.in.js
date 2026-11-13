sap.ui.define(["sap/base/util/fetch", "sap/base/util/mixedFetch"], function(fetch, mixedFetch) {
	"use strict";
	if (mixedFetch) {
		fetch = mixedFetch;
	}
	return fetch;
});
