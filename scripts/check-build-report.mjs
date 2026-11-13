#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = path.join(root, "src/build-report-baseline.json");

function warningKey(warning) {
	return warning.replace(/^line \d+: /, "");
}

function importKey(entry) {
	return JSON.stringify([entry.target, entry.firstImportedBy]);
}

export function checkBuildReport(report, baseline) {
	const failures = [];
	if (report.ui5Version !== baseline.ui5Version) {
		failures.push(`UI5 version changed: expected ${baseline.ui5Version}, got ${report.ui5Version}`);
	}

	if (report.skipped?.length) failures.push(`${report.skipped.length} conversions were skipped`);
	if (report.themeFailures?.length) failures.push(`${report.themeFailures.length} themes failed to build`);
	if (report.stats?.differentCollisions) failures.push(`${report.stats.differentCollisions} files have conflicting package copies`);

	const warnings = new Map();
	for (const file of report.warnings ?? []) {
		for (const warning of file.warnings ?? []) {
			const key = warningKey(warning);
			warnings.set(key, (warnings.get(key) ?? 0) + 1);
		}
	}
	for (const [key, count] of warnings) {
		const limit = baseline.warningLimits[key];
		if (limit === undefined) failures.push(`new conversion warning: ${key}`);
		else if (count > limit) failures.push(`conversion warning increased: ${key} (${count}, baseline ${limit})`);
	}
	const warningCount = [...warnings.values()].reduce((sum, count) => sum + count, 0);
	if (report.stats?.warnings !== warningCount) {
		failures.push(`warning count mismatch: report says ${report.stats?.warnings}, entries contain ${warningCount}`);
	}

	const expectedImports = new Set(baseline.unresolvedImports.map(importKey));
	const actualImports = new Set((report.unresolvedImports ?? []).map(importKey));
	for (const key of actualImports) {
		if (!expectedImports.has(key)) failures.push(`new unresolved import: ${key}`);
	}
	for (const key of expectedImports) {
		if (!actualImports.has(key)) failures.push(`known unresolved import changed; verify and update baseline: ${key}`);
	}

	return failures;
}

function main() {
	const reportPath = path.resolve(process.argv[2] ?? path.join(root, "dist/reports/ui5-next-report.json"));
	const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
	const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	const failures = checkBuildReport(report, baseline);
	if (failures.length) {
		console.error(`Build report check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Build report matches OpenUI5 ${baseline.ui5Version} baseline (${report.stats.warnings} warnings; ${report.unresolvedImports.length} known unresolved imports).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
