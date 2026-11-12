# ui5Next

`ui5-next` is a build tool that takes the OpenUI5 npm packages (`@openui5/*`) and
produces **one file tree of native ES modules** ("UI5 Next"). The folder structure
follows the UI5 namespace (`sap/m/Button.js`, `sap/ui/core/Control.js`, ...). The tree runs
in a browser with **no UI5 loader, no import map and no bundler**. A static file server is enough.

```html
<script type="module">
  import { boot } from "./dist/ui5-next-boot.js";
  await boot({ theme: "sap_horizon" });

  const { default: Button } = await import("./dist/sap/m/Button.js");
  new Button({ text: "Hello UI5 Next" }).placeAt("content");
</script>
```

## Base version: OpenUI5 1.154.0 (not 2.x)

The tool was designed for OpenUI5 **2.x** (clean AMD, no globals, no sync loading). When this
project was scaffolded (2026-11-12), the npm registry had **no 2.x release** of
`@openui5/sap.ui.core`: `npm view @openui5/sap.ui.core versions --json` lists 752 versions,
all 1.x, and `latest` is 1.154.0. By decision of the project owner, it is built on the latest
release, **1.154.0**, and every `@openui5` package is pinned to that version.

Running 1.x without its loader needs more than the AMD → ESM conversion. 1.x relies on its
bootstrap (`sap-ui-core.js`, `ui5loader-autoconfig.js`), on classic thirdparty scripts
(jQuery 3.6, jQuery UI, URI.js, ace, ...) and on loader internals (`sap.ui.loader`). The build
replaces all of these, see [What the build does](#what-the-build-does). To switch to 2.x once
it is published, update the versions in `package.json` and `src/packages.json`, then run
`npm install && npm run build`.

### Packages

Discovered with `npm search --json --searchlimit=250 @openui5` (excluding `@openui5/types`),
each checked with `npm view <pkg>@1.154.0 version`. See `src/packages.json`.

Included (26): sap.f, sap.html, sap.m, sap.tnt, sap.ui.codeeditor, sap.ui.commons,
sap.ui.core, sap.ui.documentation, sap.ui.dt, sap.ui.fl, sap.ui.integration,
sap.ui.layout, sap.ui.mdc, sap.ui.rta, sap.ui.suite, sap.ui.support, sap.ui.table,
sap.ui.testrecorder, sap.ui.unified, sap.ui.ux3, sap.uxap, themelib_sap_belize,
themelib_sap_bluecrystal, themelib_sap_fiori_3, themelib_sap_horizon, ts-types.
`ts-types` has no `src`/`resources` folder, so the build lists it under `ignoredPackages`.

**Dropped** (no 1.154.0 release): `@openui5/sap.ui.demokit`, `@openui5/sap.ui.webc.common`,
`@openui5/sap.ui.webc.fiori`, `@openui5/sap.ui.webc.main`, `@openui5/ts-types-esm`.

## Usage

```sh
npm install && npm run build   # -> dist/  (about 1.5 min, 4 Horizon themes)
npm test                       # unit + integration tests (node:test)
npm run check                  # every dist/**/*.js parses as an ES module; Button/Control import check
npm run smoke                  # headless Chrome: demo/index.html + demo/xmlview.html (Node >= 22, Chrome)
npm run import-all             # headless Chrome: imports all 3273 runtime modules of dist/
npm run serve                  # http://localhost:8080/demo/ (any static server works)
```

CLI:

```
ui5-next [--from <dir>] [--out <dir>] [--scopes openui5,sapui5] [--themes <list>|all|none] [--clean] [--force]
  --from    directory containing node_modules (default ".")
  --out     output directory (default "dist")
  --themes  themes to compile from LESS (default sap_horizon,sap_horizon_dark,sap_horizon_hcb,sap_horizon_hcw)
  --force   allow a non-empty out dir (overwrite, never delete)
  --clean   remove the out dir first; refused if out is the cwd, contains the --from dir,
            or contains node_modules
```

### Writing an app

```js
import { boot } from "./dist/ui5-next-boot.js";

await boot({ theme: "sap_horizon", language: "en" });   // = window["sap-ui-config"]
sap.ui.loader.config({ paths: { "my/app": new URL("./app/", import.meta.url).href } }); // = resourceroots
await import("./app/main.js");                            // app code, after boot()
```

- `boot(config)` replaces the `sap-ui-core.js` script tag. It merges `config` over
  `window["sap-ui-config"]` and the defaults `{ compatVersion: "edge", async: true }`, then
  boots the Core and waits for `Core.ready()`. Load app modules **after** `boot()`: UI5
  throws "Library must not be used before the core is ready" otherwise.
- App modules are ES modules that import from `dist/` (`import Button from ".../sap/m/Button.js"`).
- XML views, fragments and controllers are found by name at runtime: register the app
  namespace with `sap.ui.loader.config({ paths })`. Controllers are ES modules with
  `export default Controller.extend("my.app.controller.Main", {...})`.
- Views need `displayBlock="true"` (or an App/Shell) to fill the page, as in any UI5 app.

`demo/xmlview.html` is a complete example. It has an XML view and an ES module controller
found by name, a JSON model with data binding, an i18n resource model, an Input with a live
binding, a DatePicker with CLDR formats whose popup lazy-loads `sap.ui.unified`, a Select,
a List with SAP icons, and a press handler that shows a MessageToast.

## What the build does

1. **Merge:** finds `node_modules/@<scope>/*`, uses `src/` (or `resources/`) as the source
   root, and merges everything into one tree. The first package wins on a collision
   (identical files are ignored, different ones are reported).
2. **Never copies** `*-dbg.js`, `*.min.js`, `*-preload.js`, `*-preload.json`, `*.js.map`,
   `.DS_Store`.
3. **Converts AMD to ESM** (`src/convert.mjs`):
   - `sap.ui.define([deps], function (A, B) { ... return X; })` becomes
     `import A from "./a.js"; ... export default X;` (a "flat" module)
   - factories that cannot be flattened (a `return` inside `if`/`try`, destructured or
     extra parameters, `exports`/`module` dependencies, name clashes) are **kept as a
     function**: `export default (function (A, B) {...}).call(globalThis, __ui5_dep0, __ui5_dep1)`
   - `sap.ui.define` that is not a top-level statement (UMD wrappers, `if (sap.ui.define)`,
     as in `sap/ui/Device.js`) is routed to a local function whose result is exported
   - `sap.ui.require([deps], cb, errCb)` becomes
     `Promise.all([import(...)]).then(([{ default: A }]) => ...).catch(errCb)`
   - sync probes `sap.ui.require("a/b")` and `sap.ui.requireSync("a/b")` stay runtime calls
     ("probe" mode). Hoisting them into static imports changed the semantics (eager
     loading) and created import cycles (TDZ errors in `Lib.js`). The converter still
     supports hoisting (`syncRequire: "hoist"`, its default).
   - `this` at factory/callback level becomes `globalThis`, which is what the UI5 loader passes
   - a `"require"` dependency becomes the runtime shim's `require`
   - dependency names become relative specifiers ending in `.js`. Loader map aliases (`jquery`)
     are applied, and `x.css` resolves to the module `x.css.js` when that exists.
4. **Registers modules:** every converted module imports `ui5-next-runtime.js` first and calls
   `__ui5_register("sap/m/Button", namespace)` at the end. Sync probes then see every
   loaded module, as with the UI5 loader.
5. **Wraps classic scripts:** scripts that are neither modules nor AMD (jQuery 3.6 with
   jQuery Migrate, jQuery UI, URI.js, hasher, ace, ...) are copied to `<name>.classic.js`.
   If a module imports them, or a loader `shim` config names them (from
   `ui5loader-autoconfig.js` and from `sap.ui.loader.config({shim})` calls in modules), they
   get an ES module wrapper that imports the shim `deps`, loads the original as a classic
   script (`await`, so sloppy mode, `this` and globals behave as before) and exports the shim
   `exports` global. The other 498 classic scripts (ace workers/modes, ...) are copied as is;
   their libraries load them by URL.
6. **Replaces the legacy bootstrap:**
   - the configuration modules that `ui5loader-autoconfig.js` defines inline become real
     files (with the provider registration of `_setupConfiguration()`)
   - `ui5-next-bootstrap.js` loads them; dependencies on `ui5loader-autoconfig` resolve to it,
     and on `ui5loader` to the runtime
   - `sap-ui-*.js` and `ui5loader*.js` are copied but obsolete
7. **Generates** what the UI5 tooling normally generates:
   - `sap-ui-version.json`
   - `<lib>/manifest.json` from `.library` (dependencies, i18n with supported locales)
   - **themes:** `library.source.less` → `library.css` + `library-parameters.json`, compiled
     with the LESS 1.6.3 that UI5 ships (`sap/ui/thirdparty/less.js`, run in `node:vm`, so no
     extra dependency). The inline theme parameters and theme metadata rules are appended.
8. **Writes** `dist/package.json`, `ui5-next-runtime.js`, `ui5-next-boot.js`,
   `ui5-next-report.json`.

## Runtime (`ui5-next-runtime.js`, `ui5-next-boot.js`)

`ui5-next-runtime.js` is a small, dependency-free ES module. It does **not** recreate namespace
globals (`sap.m.Button`).

- `require(["a/b", ...], cb, errCb)` imports root-relative modules (or modules under
  `sap.ui.loader.config({paths})`), calls `cb` with their default exports and returns a Promise
- `require("a/b")` returns the default export of a loaded module, else `undefined`
- `toUrl(name)` returns the URL of a resource
- relative names (`./x`) throw an error, because there is no calling-module context
- installs `sap.ui.require` (+ `.toUrl`), `sap.ui.requireSync` (loaded modules only, with a
  warning otherwise) and a `sap.ui.loader` compatibility layer: `config({paths})` and the
  `_` internals UI5 1.x calls (`getModuleState`, `loadJSResourceAsync`, `getResourcePath`, ...)

## The report (`dist/ui5-next-report.json`)

`packages`, `ignoredPackages`, `stats`, `collisions`, `skipped` (`{file, reason, line?}`),
`warnings` (per file), `obsoleteBootstrap`, `extracted`, `wrappedClassicScripts`,
`classicScripts`, `themes` (`compiled`, `errors`), `unresolvedImports`
(`{target, firstImportedBy}`), `externalSpecifiers` (specifier -> count), and `legacyReferences`
(occurrences and files of `jQuery.sap.`, `sap.ui.requireSync`, `sap.ui.getCore(`).

Numbers for 1.154.0:

| | |
|---|---|
| files in merged tree | 15393 |
| converted modules | 3902 (incl. 7 generated) |
| unchanged ES modules | 148 |
| classic scripts wrapped / copied as is | 61 / 498 |
| skipped | **0** |
| library themes compiled | 72 (18 libraries × 4 Horizon themes), 0 errors |
| warnings | 560 in 389 files (mostly informational, e.g. 256 "factory kept as a function" for CommonJS-style web component bundles) |
| unresolved import targets | 28, all in SAPUI5-only libraries (sap.suite, sap.viz, sap.ui.vk, sap.ushell, sap.ui.export, sap.ui.richtexteditor) |
| external specifiers | 2 (`test-resources/...`) |
| legacy refs | `jQuery.sap.` 655 (50 files), `sap.ui.requireSync` 74 (42 files), `sap.ui.getCore(` 237 (101 files) |
| browser: modules importable (`npm run import-all`) | 3272 of 3273 (the exception imports `test-resources/...`) |

## Known limitations

- **Load app code after `boot()`.** Classic-script wrappers use top-level `await`, so in a single
  static import graph, unrelated branches may run before the Core is ready.
- Each module has a single default export, just as an AMD module returned one value.
- The bootstrap configuration comes from `window["sap-ui-config"]`/`boot(config)`, URL
  parameters and `<meta>` tags; there is no `<script id="sap-ui-bootstrap" data-sap-ui-*>` tag.
- Sync loading (`sap.ui.requireSync`, sync `Lib.load`, sync views) only works for modules that
  are already loaded; 1.x deprecated APIs that depend on it fail. App code must be async, as
  in 2.x.
- App code written as AMD (`sap.ui.define`) is not loaded by the runtime; write ES modules,
  or run the converter on it.
- Relative names in `sap.ui.require` / module-local `require` are not supported at runtime.
- Only the Horizon themes are compiled by default (`--themes all` compiles all 15+ themes,
  slower). No RTL CSS (`library-RTL.css`) is generated, and no CSS variables mode.
- `thirdparty/*` classic scripts run as classic scripts (via the wrapper), they are not converted;
  jQuery is a global, as in 1.x.
- Circular dependencies behave differently in ES modules (live bindings, TDZ errors instead of
  `undefined`).
- One remaining skipped-type case: files with several `sap.ui.define` calls (none in 1.154.0).
- Dropped packages: sap.ui.demokit, sap.ui.webc.common, sap.ui.webc.fiori, sap.ui.webc.main,
  ts-types-esm.
- Obsolete bootstrap/loader files, copied but replaced by `ui5-next-boot.js`, the runtime and
  `ui5-next-bootstrap.js`: `sap-ui-boot.js`, `sap-ui-core.js`, `sap-ui-core-nojQuery.js`,
  `sap-ui-debug.js`, `sap-ui-integration.js`, `sap-ui-integration-editor.js`,
  `sap-ui-integration-card-editor.js`, `ui5loader.js`, `ui5loader-autoconfig.js`.

## Deviations from the original specification

- **Base version:** 1.154.0 instead of 2.x (there is no 2.x on npm).
- **Test script:** `"test"` is `node --test test/*.test.mjs`. Plain `node --test` also runs fixture
  files and `dist/**/test/**`.
- **Fallbacks instead of skipping:** nested returns, extra or destructured factory parameters,
  `exports`/`module` and non-top-level defines get the fallbacks described above. Only multiple
  defines in one file still throw.
- **Sync require in the build:** sync `sap.ui.require`/`requireSync` stay runtime calls in the
  build (probe mode); hoisting remains the converter's default.
- **Thirdparty files:** they are converted when they are AMD, and wrapped when they are classic
  scripts.
- **Runtime:** besides `require`/`toUrl`, it provides `sap.ui.loader`, `sap.ui.requireSync`, a
  module registry and a default export (the loader API).
- **Additional generated files:** `ui5-next-boot.js`, `ui5-next-bootstrap.js`,
  `sap-ui-version.json`, library manifests and themes.
