import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutCdn, cdnLoads, NO_CDN_NOTICE } from "../src/no-cdn.mjs";

const FONT = '@font-face{font-family:"72";font-style:normal;font-weight:400;src:url(https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content@11.36.4/content/Base/baseLib/baseTheme/fonts/72-Regular.woff2) format("woff2"),local("72");unicode-range:U+00}';

test("CDN font faces are removed and default font loading is switched off", () => {
	const src = `const css='${FONT}${FONT}';const config={fetchDefaultLanguage:false,defaultFontLoading:true};const b={defaultFontLoading:!0};`;
	const { code, changes } = withoutCdn(src);
	assert.equal(changes, 4);
	assert.ok(code.startsWith(NO_CDN_NOTICE));
	assert.doesNotMatch(code, /cdn\.jsdelivr\.net/);
	assert.match(code, /const css='';/);
	assert.equal(code.match(/defaultFontLoading:false/g).length, 2);
	assert.deepEqual(cdnLoads(code), []);
});

test("locale data comes from this package, not sdk.openui5.org", () => {
	const src = 'C("en",(async()=>(await fetch("https://sdk.openui5.org/1.120.17/resources/sap/ui/core/cldr/en.json")).json()));';
	assert.equal(cdnLoads(src).length, 1);
	const { code, changes } = withoutCdn(src);
	assert.equal(changes, 1);
	assert.match(code, /fetch\(globalThis\.sap\.ui\.require\.toUrl\("sap\/ui\/core\/cldr\/en\.json"\)\)/);
	assert.deepEqual(cdnLoads(code), []);
});

test("locale data from cdn.jsdelivr.net (sap.f) is local too", () => {
	const src = 'await fetch(`https://cdn.jsdelivr.net/npm/@openui5/sap.ui.core@1.120.17/src/sap/ui/core/cldr/en.json`)';
	const { code, changes } = withoutCdn(src);
	assert.equal(changes, 1);
	assert.match(code, /toUrl\("sap\/ui\/core\/cldr\/en\.json"\)/);
	assert.deepEqual(cdnLoads(code), []);
});

test("other sources stay unchanged, help links in texts are not loads", () => {
	const src = 'throw new Error("see https://sdk.openui5.org/topic/123")';
	assert.deepEqual(withoutCdn(src), { code: src, changes: 0 });
	assert.deepEqual(cdnLoads(src), []);
});
