# UI5 as native ES modules

*Draft*

**TL;DR:** ui5Next converts OpenUI5 1.154 npm packages into browser-native ES modules and builds
shared, lazy-loaded library bundles. The same Todo app ran 17% faster over 4G than the classic
optimized CDN build. This is a proof of concept, not a production replacement.

```js
import { ready } from "./dist/esm/ui5-next-bootstrap.js";
import Button from "./dist/esm/sap/m/Button.js";

await ready;
new Button({ text: "Hello" }).placeAt("content");
```

## Why try this?

Browsers, editors and build tools have supported ES modules for years, but OpenUI5 1.x still uses
`sap.ui.define`, `sap.ui.require` and `ui5loader.js`. UI5 2.x removes some synchronous APIs and
globals, but keeps AMD and its loader. I wanted to test the real npm sources in a real browser,
not just convert a small example.

The loader does more than fetch files:

- Views, controllers, components and manifest model classes are resolved by module name at runtime.
- The bootstrap defines configuration modules inline, and parts of the Core depend on them.
- Synchronous `sap.ui.require("name")` probes are common. Replacing them with static imports can
  eagerly load code and create cycles.
- Classic third-party scripts rely on globals, loader shim configuration, load order and sometimes
  sloppy-mode behavior.
- Package boundaries are not clean dependency boundaries; support code in the Core reaches into
  control libraries.
- The npm sources do not include generated themes and library metadata.

## What the build does

The build merges 25 OpenUI5 packages (15,393 files), converts AMD modules to ESM, generates a
bootstrap and a small runtime, wraps classic third-party scripts, and builds themes. It converted
3,902 modules; 37 third-party scripts get wrappers, and themes are built for 18 libraries.

The conversion preserves cases a mechanical rewrite would break:

- Factories that cannot be flattened stay functions called with their imports.
- Reassigned AMD factory parameters become mutable local variables; ESM import bindings are
  read-only.
- Top-level `this` becomes `globalThis`, as it does in the UI5 loader's factory context.
- Asynchronous `sap.ui.require` becomes dynamic imports; synchronous probes stay runtime calls.
- Inline bootstrap configuration becomes real modules.

The runtime registers loaded modules and resolves the remaining by-name requests. It also supplies
the loader APIs that UI5 still calls internally. The build generates the theme CSS and metadata that
are absent from the npm packages.

There are two outputs with the same module paths:

- **esm/**: one ES module per UI5 module; useful for development.
- **bundles/**: shared library bundles for pages or launchpads with many apps on one UI5.

The Todo demo uses each output in a separate page. Both pages statically import their component,
controller and manifest as well as the UI5 bootstrap and modules. This lets the browser discover
the app's dependency graph up front.

## Why the first bundles were slow

My first design made one bundle per npm package and had each package registry import every module.
Unlike UI5's `library-preload.js`, an ES module runs when imported. About 2,500 modules ran at
startup, including code from libraries the app did not use. That version took 911 ms locally versus
620 ms for classic UI5, made 43 requests and spent 486 ms in script execution.

Three issues explained the result:

1. **Preload files define; ESM imports execute.** Importing every module defeated UI5's lazy
   execution and triggered unnecessary CSS and text requests.
2. **Package boundaries are not dependency boundaries.** Core support tools import `sap.m`, while
   `sap.m` depends on the Core. Loading the Core pulled in eight package bundles, including six the
   Todo app did not need.
3. **The build had too much glue.** Registries, setup, runtime and module maps were separate
   requests.

The redesign keeps UI5's on-demand behavior:

- Each statically imported module gets a tiny facade at its ESM path. It runs that module and its
  dependencies, not every module in its bundle.
- Per-package lazy registries handle loads by name; the package bundle is fetched only when needed.
- Chunks follow declared library dependencies, with side bundles for dependencies that cross those
  boundaries. This removes circular imports between bundles.
- The Core is split into its boot path, code other libraries need, and a lazy remainder.
- The bootstrap imports the shared Core pieces in parallel. The app statically imports its own code.

The final build has 70 bundle files and 4,001 facades. A `Controller`, `Filter` and `FilterOperator`
import loads five files (1.9 MiB minified) and runs 102 modules, instead of the earlier 12 files
(9.0 MiB) and thousands of modules.

## Results

The same Todo app was tested in headless Chrome over seven runs with the cache disabled. “4G” uses
40 ms RTT and 20/5 Mbit/s. Values are medians.

| | Ready, local | Ready, 4G | Requests | Transferred | Script time |
|---|---:|---:|---:|---:|---:|
| **UI5 Next, bundles/** | **519 ms** | **1,375 ms** | 26 | **1.71 MiB** | 117 ms |
| UI5 Next, esm/ | 894 ms | 3,203 ms | 464 | 2.19 MiB | 166 ms |
| Classic UI5, optimized CDN build | 543 ms | 1,658 ms | 24 | 1.88 MiB | 121 ms |
| Classic UI5, unbuilt npm sources | 1,159 ms | 12,293 ms | 452 | 2.22 MiB | 686 ms |

The bundles are 17% faster over 4G and transfer 9% less than the optimized classic build. The ESM
tree needs one request per module, but still loads much faster over 4G than unbuilt classic sources,
which fetch synchronously one file at a time.

## What the conversion exposed

The conversion made several existing assumptions visible:

- `sap/ui/core/Lib.js` reassigns an AMD dependency parameter. As an ESM import that assignment is
  illegal, so the converter emits a mutable local copy.
- Core support tools import controls from `sap.m`, creating a cycle across Core and control
  libraries. UI5's loader hides the cycle; bundling along actual dependencies avoids it.
- Test tools, the old boot entry and deprecated aliases can run code as soon as they're imported.
  They are excluded from bundles, but remain available in the ESM tree.
- Some third-party dependencies exist only in comments or loader configuration. The build has to
  preserve their load order.
- jQuery Mobile expects top-level `this` to be `window`; in an ES module it is `undefined`. Its
  wrapper restores the browser-global behavior. Not every legacy script can be wrapped safely.

## Benefits and limits

- **App development:** serve the generated ESM with any static server; app code can use tools such
  as Vite or Rollup without a UI5 plugin.
- **Simpler npm dependencies:** install one `ui5-next` package containing the generated UI5 modules
  and themes, instead of managing many library and theme packages.
- **Editors:** native imports enable go-to-definition, find references, completion and diagnostics.
- **Static checks:** ESLint and TypeScript can follow regular ESM imports to catch issues before
  running the app.
- **AI coding tools:** explicit imports and file paths make dependencies easier to trace.
- **Browser tests:** Playwright, Cypress and WebdriverIO can test the app in a regular browser
  without a UI5-specific test runner. The shared bundles also cut the thousands of individual
  module files and requests that can make test servers and CI slow.
- **Unit tests:** Node's built-in `node:test` can test controller logic against fixtures without a
  browser, DOM or UI5 loader.

This is a proof of concept for OpenUI5 1.154, not a production replacement. The build reports 28
unresolved targets in SAPUI5-only libraries. They are all lazy imports, so they do not prevent an
ordinary page from starting. But using an affected feature—such as microcharts, analytics cards,
cloud-file upload, export, or rich-text/file preview—fails when its missing module is requested,
unless that library is supplied separately. This is a distribution gap in this OpenUI5-only build,
not by itself a bug in OpenUI5. AMD app code is also unsupported.

An official ESM distribution would be better. The experiment shows the main barriers are packaging
and loader history, not a fundamental incompatibility.

*Code and build: this repository (`npm ci && npm run build && npm run serve`).*
