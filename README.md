# esmUi5

[![npm](https://img.shields.io/npm/v/esm-ui5)](https://www.npmjs.com/package/esm-ui5)

OpenUI5 1.154 as native browser ES modules — no UI5 bootstrap script tag, no AMD loader, just
`import`. This is a proof of concept, not a production-ready replacement for the UI5 toolchain.

npm: [esm-ui5](https://www.npmjs.com/package/esm-ui5)

## Install

```sh
npm install esm-ui5
```

The package ships prebuilt files only (no build step on your side):

- `esm/` — one ES module per UI5 module (`sap/m/Button.js`, …), plus themes and assets
- `bundles/` — shared, lazy-loaded library bundles; UI5 modules are loaded by name
- `runtime/` — runtime support for UI5's by-name module loading
- `demo/` — the Todo demo app, built against both trees

Serve `node_modules/esm-ui5/dist/` with any static web server, or load it from a CDN such as
`https://cdn.jsdelivr.net/npm/esm-ui5@0.1.1/dist/`.

## Usage

Import the bootstrap before any UI5 module, then import controls by path:

```js
import { ready } from "esm-ui5/esm/esm-ui5-bootstrap.js";
import Button from "esm-ui5/esm/sap/m/Button.js";

await ready;
new Button({ text: "Hello" }).placeAt("content");
```

(Without a bundler, use a full URL or an import map instead of the bare `esm-ui5/...` specifier.)

With the `bundles/` tree, load UI5 modules by name instead:

```js
import { ready, require } from "esm-ui5/bundles/esm-ui5-bootstrap.js";

await ready;
const [Button] = await require(["sap/m/Button"]);
```

Optional UI5 configuration (what the `data-sap-ui-*` attributes did) goes in a script before
the bootstrap:

```html
<script>window["sap-ui-config"] = { theme: "sap_horizon", language: "en" };</script>
```

## Demo

[demo/](demo/) contains a small Todo app (Component, manifest, i18n, XML view, controller),
written twice:

- [demo/esm/](demo/esm/) — imports UI5 modules by path from `esm/`
  ([index.html](demo/esm/index.html) is the best starting point)
- [demo/bundles/](demo/bundles/) — the same app on the `bundles/` tree

The built demo is also included in the npm package under `dist/demo/`. To run it from this
repository, see [Contributing](#contributing).

## Writing UI5 code for esmUi5

### Native classes

The UI5 modules use native JavaScript classes and `extends`/`super`. `Class.extend()` and
`Metadata.createClass()` are **not available**; this is a breaking change for code that defines
classes with those APIs. Define a class with native syntax and register its UI5 metadata through
the base class's `defineClass()` method. `Renderer.extend()` is unchanged.

### Class-style controllers

Export a native class from a `*.controller.js` module. esmUi5 derives the controller name from
the module path and adapts its methods when UI5 loads it by name:

```js
export default class {
	onInit() {
		this.model = this.getOwnerComponent().getModel();
	}
}
```

No class name, `extends`, `super()`, or controller factory call is needed. Initialize controller
state in lifecycle methods rather than a constructor or instance fields.

## Limitations

- Apps must use ES modules and choose either `esm/` or `bundles/` per page.
- Targets OpenUI5 1.x; `sap.ui.requireSync` only works for modules already loaded.
- SAPUI5-only libraries are not included.

## Contributing

Building the package yourself requires Node.js 24 or newer.

```sh
npm ci
npm run build              # convert OpenUI5 into dist/
npm test
npm run check
npm run check:build-report # compare conversion warnings and unresolved imports to the reviewed baseline
npm run serve              # demo at http://localhost:8080/ (also /esm/ and /bundles/)
```

