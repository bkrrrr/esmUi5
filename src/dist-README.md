# esmUi5 (OpenUI5 __VERSION__ as native ES modules)

| folder | content |
|---|---|
| `esm/` | one ES module per UI5 module (`sap/m/Button.js`, ...), assets, built theme CSS, and `esm-ui5-bootstrap.js` |
| `bundles/` | shared lazy-loaded library bundles (`sap.ui.core.js`, `sap.m.js`, side bundles like `sap.m_sap.ui.fl.js`); UI5 modules load by name through the registry; no per-module facade files; `esm-ui5-bootstrap.js` |
| `runtime/` | `esm-ui5-runtime.js`: name resolution for dynamic loading, `sap.ui.require`, `toUrl`, `preload` |
| `demo/` | the same Todo app (Component, manifest, i18n, view, controller) on `esm/` and on `bundles/` |
| `reports/` | `esm-ui5-report.json` (conversion), `esm-ui5-packages.json` (file -> package), `bundle-report.json` (sizes, chunks, imports) |

Import the bootstrap first. In `esm/`, import UI5 modules statically by path; in `bundles/`, load UI5 modules by name:
`import { ready, require } from "./bundles/esm-ui5-bootstrap.js"; const [Button] = await require(["sap/m/Button"]);`
Use one tree per page.
Serve this folder with any static server and open `demo/index.html`.
No fonts or data are loaded from other hosts: the 72 font and locale data come from this package.
