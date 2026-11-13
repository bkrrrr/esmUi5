// The esmUi5 bootstrap of the esm tree (dist/esm/; dist/bundles/ gets its own from the bundle
// step). It replaces sap-ui-core.js and ui5loader. Apps import it first:
//
//   import { ready } from "<dist>/esm/esm-ui5-bootstrap.js";
//   import Button from ...;                                      // UI5 modules, statically
//   await ready;
//
// ES modules evaluate their imports in order, depth first, so esm-ui5-setup.js runs before any
// UI5 module and the Core is loaded before the app's other imports (libraries check that the
// Core module is loaded).
import fs from "node:fs";
import path from "node:path";

export const BOOTSTRAP = "esm-ui5-bootstrap.js";
export const SETUP = "esm-ui5-setup.js";

const coreImport = {
	esm: `import Core from "./sap/ui/core/Core.js";`,
};

/** The bootstrap files of one tree. */
export function bootstrapFiles(mode) {
	if (!coreImport[mode]) throw new Error(`unknown mode ${mode}`);
	const setup = `// esmUi5 setup (dist/${mode}/): runs before any UI5 module, imported by ${BOOTSTRAP}.
import { init } from "../runtime/esm-ui5-runtime.js";

// 1. name resolution for dynamic loading (view/controller/component names, lazy libraries)
init({ mode: "${mode}" });

// 2. configuration: what the data-sap-ui-* attributes of the old bootstrap tag did. Pages can
//    set window["sap-ui-config"] in a classic <script> before their module scripts.
globalThis["sap-ui-config"] = {
	theme: "sap_horizon",
	compatVersion: "edge", // complex binding syntax etc., as modern bootstrap tags set it
	async: true,
	...globalThis["sap-ui-config"],
};
`;
	const bootstrap = `// esmUi5 bootstrap (dist/${mode}/): replaces sap-ui-core.js and ui5loader. Import it first.
import "./${SETUP}";
${coreImport[mode]}

// sap-ui-core.js ended with require("sap/ui/core/Core").boot(): load the configured
// libraries and the theme
if (typeof Core.boot === "function") Core.boot();

/** Resolves with the Core when it is ready (DOM ready, libraries loaded, theme applied). */
export const ready = Core.ready().then(() => Core);
export default Core;
export { require, toUrl, preload } from "../runtime/esm-ui5-runtime.js";
`;
	return { [SETUP]: setup, [BOOTSTRAP]: bootstrap };
}

/** Write the bootstrap files into a tree folder. */
export function writeBootstrap(dir, mode) {
	for (const [file, content] of Object.entries(bootstrapFiles(mode))) fs.writeFileSync(path.join(dir, file), content);
	return Object.keys(bootstrapFiles(mode));
}
