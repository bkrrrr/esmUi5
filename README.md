# esmUi5

esmUi5 converts OpenUI5 1.154 npm packages into native browser ES modules. It builds both
individual modules and lazy shared bundles, plus themes and a demo app. This is a proof of concept,
not a production-ready replacement for the UI5 toolchain.

## Quick start

Requires Node.js 24 or newer.

```sh
npm ci
npm run build
npm test
npm run check
npm run check:build-report # compare conversion warnings and unresolved imports to reviewed baseline
npm run serve
```

Open [http://localhost:8080/](http://localhost:8080/) for the demo. The ESM and bundle versions
are available at `/esm/` and `/bundles/`.

## Output

- `dist/esm/` — one ES module per UI5 module
- `dist/bundles/` — shared, lazy-loaded library bundles with matching module paths
- `dist/runtime/` — runtime support for UI5's by-name module loading
- `dist/demo/` — the same Todo app using either output

Import the bootstrap before UI5 modules:

```js
import { ready } from "./dist/esm/esm-ui5-bootstrap.js";
import Button from "./dist/esm/sap/m/Button.js";

await ready;
new Button({ text: "Hello" }).placeAt("content");
```

## Limitations

Apps must use ES modules and choose either `esm/` or `bundles/` per page. This targets OpenUI5 1.x;
`sap.ui.requireSync` only works for modules already loaded. SAPUI5-only libraries are not included.
