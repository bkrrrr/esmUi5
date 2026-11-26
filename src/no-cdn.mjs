// No requests to other hosts.
//
// OpenUI5 1.154 ships two copies of UI5 Web Components (sap/f/thirdparty/ManagedStyles.js and
// sap/ui/integration/thirdparty/webcomponents/bundle.esm-*.js). Out of the box they load SAP's 72
// font from cdn.jsdelivr.net, and they (and sap/f/thirdparty/webcomponents-fiori.js) load
// English locale data from sdk.openui5.org or cdn.jsdelivr.net. In classic UI5 the font loading is
// usually skipped because the components detect the UI5 core; esmUi5 does not rely on that. Loading fonts or data from another host sends
// the visitor's IP address there, which in the EU needs a legal basis (LG München I, 3 O 17493/20,
// on Google Fonts). esmUi5 already ships the 72 font with OpenUI5's themes and the locale data in
// sap/ui/core/cldr/, so the copies use those instead:
//   - the @font-face rules with CDN URLs are removed, and default font loading is switched off
//     (the theme's own @font-face rules for "72" apply),
//   - locale data is fetched from this package via sap.ui.require.toUrl.

export const NO_CDN_NOTICE = "/* Modified by esm-ui5: no font or locale data is loaded from other hosts; the 72 font and locale data come from this package (see README, \"No requests to other hosts\"). */";

const CDN_FONT_FACE = /@font-face\{[^{}]*?url\(https?:\/\/cdn\.jsdelivr\.net\/[^)]*\)[^{}]*\}/g;
const FONT_LOADING_ON = /\bdefaultFontLoading:(?:true|!0)/g;
// sdk.openui5.org/<version>/resources/… and cdn.jsdelivr.net/npm/@openui5/sap.ui.core@<version>/src/…
const CDN_CLDR = /fetch\(\s*(["'`])https?:\/\/(?:sdk\.openui5\.org\/[\d.]+\/resources|cdn\.jsdelivr\.net\/npm\/@openui5\/sap\.ui\.core@[\d.]+\/src)\/(sap\/ui\/core\/cldr\/[\w-]+\.json)\1\s*\)/g;

/**
 * @param {string} src  module source
 * @returns {{ code: string, changes: number }}  changes = number of replacements (0: unchanged)
 */
export function withoutCdn(src) {
	if (!/cdn\.jsdelivr\.net|sdk\.openui5\.org|defaultFontLoading:(?:true|!0)/.test(src)) return { code: src, changes: 0 };
	let changes = 0;
	const count = (replacement) => () => (changes++, replacement);
	let code = src
		.replace(CDN_FONT_FACE, count(""))
		.replace(FONT_LOADING_ON, count("defaultFontLoading:false"))
		.replace(CDN_CLDR, (all, quote, path) => (changes++, `fetch(globalThis.sap.ui.require.toUrl("${path}"))`));
	if (changes) code = `${NO_CDN_NOTICE}\n${code}`;
	return { code, changes };
}

/** Places in a source that would still load from cdn.jsdelivr.net or sdk.openui5.org. */
export function cdnLoads(src) {
	return [...src.matchAll(/(?:url\(\s*["'`]?|fetch\(\s*["'`]|import\(\s*["'`]|src=["'])https?:\/\/(?:cdn\.jsdelivr\.net|sdk\.openui5\.org|ui5\.sap\.com|unpkg\.com)[^"'`)\s]*/g)].map((m) => m[0]);
}
