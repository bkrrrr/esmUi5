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

## CI and releases

Pushes and pull requests to `main` run the build and tests on Node 26, with npm dependency caching.
Each successful run makes the generated `dist/` files available as a downloadable GitHub Actions
artifact.

Releasing does not rebuild. Bump the version in `package.json` and commit it to `main`; after its
**Build and test** run succeeds, manually run **Deploy existing build**. The workflow reads the
version from that build's `package.json`, downloads its artifact, publishes it to npm, and creates
a GitHub Release with the same package tarball attached. Ordinary commits never publish a new
version. The deploy workflow requires the repository's `NPM_TOKEN` secret.

## Output

- `dist/esm/` — one ES module per UI5 module
- `dist/bundles/` — shared, lazy-loaded library bundles, loaded by UI5 module name through the runtime
- `dist/runtime/` — runtime support for UI5's by-name module loading
- `dist/demo/` — the same Todo app using either output

## Native UI5 classes

The generated UI5 modules use native JavaScript classes and `extends`/`super`. The UI5 class
factory APIs `Class.extend()` and `Metadata.createClass()` are not available in the generated
tree; this is a breaking change for code that defines classes with those APIs. Define an app
class with native syntax and register its UI5 metadata through the base class's
`defineClass()` method. Renderer-specific `Renderer.extend()` composition is unchanged.

## Class-style controllers

Export a native class from a `*.controller.js` module. esmUi5 derives the UI5 controller name from
the module path and adapts its methods when UI5 loads it by name:

```js
export default class {
	onInit() {
		this.model = this.getOwnerComponent().getModel();
	}
}
```

No class name, `extends`, `super()`, or controller factory call is needed. The class supplies
prototype methods; UI5 still receives a metadata-aware controller constructor, not an instance.
Initialize controller state in lifecycle methods rather than a class constructor or instance
fields.

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
