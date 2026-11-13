// Node module hooks: imports of UI5 Next modules (".../esm/sap/..." or ".../bundles/sap/...")
// resolve to test/fixtures/ui5/sap/... instead. Registered with module.register() by a test.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtures = new URL("./fixtures/ui5/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
	const m = /\/(?:esm|bundles)\/(sap\/.+\.js)$/.exec(specifier);
	if (m) {
		const url = new URL(m[1], fixtures);
		if (!existsSync(fileURLToPath(url))) throw new Error(`no UI5 fixture for ${m[1]} (add test/fixtures/ui5/${m[1]})`);
		return { url: url.href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

