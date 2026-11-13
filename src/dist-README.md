# esmUi5 (OpenUI5 __VERSION__ as native ES modules)

| folder | content |
|---|---|
| `esm/` | one ES module per UI5 module (`sap/m/Button.js`, ...), assets, built theme CSS, and `esm-ui5-bootstrap.js` |
| `bundles/` | shared library bundles: facades at the same paths as `esm/` (`sap/m/Button.js`) into per-package bundles (`sap.ui.core.js`, `sap.m.js`, side bundles like `sap.m_sap.ui.fl.js`); modules run on first use; `esm-ui5-bootstrap.js` |
| `runtime/` | `esm-ui5-runtime.js` for `esm/`: name resolution for dynamic loading, `sap.ui.require`, `toUrl`, `preload` |
| `demo/` | the same Todo app (Component, manifest, i18n, view, controller) on `esm/` and on `bundles/` |
| `reports/` | `esm-ui5-report.json` (conversion), `esm-ui5-packages.json` (file -> package), `bundle-report.json` (sizes, chunks, imports) |

Import the bootstrap of one tree first, then UI5 modules statically, with the same paths in both:
`import { ready } from "./bundles/esm-ui5-bootstrap.js"; import Button from "./bundles/sap/m/Button.js";`
(or `./esm/...`). Use one tree per page.
Serve this folder with any static server and open `demo/index.html`.
