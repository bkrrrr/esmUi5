import __ui5_p_fetch from "/sap/base/util/fetch.js";
import mixedFetch from "/sap/base/util/mixedFetch.js";

let fetch = __ui5_p_fetch;

if (mixedFetch) {
	fetch = mixedFetch;
}
export default fetch;
