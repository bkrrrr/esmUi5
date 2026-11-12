// UI5 Next boot: the replacement for the sap-ui-core.js bootstrap.
// UI5 requires the Core to be booted before any library is used, so load app code after boot():
//   import { boot } from "./ui5-next-boot.js";
//   await boot({ theme: "sap_horizon" });
//   await import("./app.js");          // or: const { default: Button } = await import(".../sap/m/Button.js")
import "./ui5-next-runtime.js";

let booted;

// what a modern bootstrap tag usually sets (data-sap-ui-compat-version="edge" & co.)
const DEFAULTS = { compatVersion: "edge", async: true };

/**
 * Boots the UI5 Core once and resolves with it when it is ready.
 * @param {object} [config] UI5 configuration (as window["sap-ui-config"]); merged over an existing
 *   window["sap-ui-config"] and the defaults { compatVersion: "edge", async: true }
 */
export function boot(config) {
	if (!booted) {
		globalThis["sap-ui-config"] = { ...DEFAULTS, ...globalThis["sap-ui-config"], ...config };
		booted = import("./sap/ui/core/Core.js").then(async ({ default: Core }) => {
			if (typeof Core.boot === "function") Core.boot();
			await Core.ready();
			return Core;
		});
	}
	return booted;
}
