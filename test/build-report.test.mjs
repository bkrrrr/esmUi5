import assert from "node:assert/strict";
import test from "node:test";
import { checkBuildReport } from "../scripts/check-build-report.mjs";

const baseline = {
	ui5Version: "1.154.0",
	warningLimits: { "known warning": 1 },
	unresolvedImports: [{ target: "sap/optional/X.js", firstImportedBy: "sap/a/A.js" }],
};

function report(overrides = {}) {
	return {
		ui5Version: "1.154.0",
		stats: { warnings: 1, differentCollisions: 0 },
		skipped: [],
		themeFailures: [],
		warnings: [{ file: "sap/a/A.js", warnings: ["line 4: known warning"] }],
		unresolvedImports: [{ target: "sap/optional/X.js", firstImportedBy: "sap/a/A.js" }],
		...overrides,
	};
}

test("accepts known warnings and unresolved imports", () => {
	assert.deepEqual(checkBuildReport(report(), baseline), []);
});

test("fails on skipped conversions, theme failures and conflicting copies", () => {
	const result = report({
		stats: { warnings: 1, differentCollisions: 1 },
		skipped: [{ file: "sap/a/Broken.js" }],
		themeFailures: [{ library: "sap.a" }],
	});
	assert.deepEqual(checkBuildReport(result, baseline), [
		"1 conversions were skipped",
		"1 themes failed to build",
		"1 files have conflicting package copies",
	]);
});

test("fails on new or increased warning categories", () => {
	const result = report({
		stats: { warnings: 3, differentCollisions: 0 },
		warnings: [{ file: "sap/a/A.js", warnings: ["known warning", "known warning", "new warning"] }],
	});
	assert.deepEqual(checkBuildReport(result, baseline), [
		"conversion warning increased: known warning (2, baseline 1)",
		"new conversion warning: new warning",
	]);
});

test("fails when unresolved import targets drift from the reviewed baseline", () => {
	const result = report({
		unresolvedImports: [{ target: "sap/missing/Y.js", firstImportedBy: "sap/a/A.js" }],
	});
	assert.deepEqual(checkBuildReport(result, baseline), [
		'new unresolved import: ["sap/missing/Y.js","sap/a/A.js"]',
		'known unresolved import changed; verify and update baseline: ["sap/optional/X.js","sap/a/A.js"]',
	]);
});
