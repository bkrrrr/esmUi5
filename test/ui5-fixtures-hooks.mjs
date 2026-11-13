// Node module hooks: imports of esmUi5 UI5 modules resolve to test/fixtures/ui5/sap/... instead.
// The generated bundle bootstrap resolves to the source runtime for controller tests.
// Registered with module.register() by a test.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtures = new URL("./fixtures/ui5/", import.meta.url);
const runtime = new URL("../src/runtime.js", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
	if (/\/bundles\/esm-ui5-bootstrap\.js$/.test(specifier)) {
		return { url: runtime.href, shortCircuit: true };
	}
	const m = /\/(?:esm|bundles)\/(sap\/.+\.js)$/.exec(specifier);
	if (m) {
		const url = new URL(m[1], fixtures);
		if (!existsSync(fileURLToPath(url))) throw new Error(`no UI5 fixture for ${m[1]} (add test/fixtures/ui5/${m[1]})`);
		return { url: url.href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

