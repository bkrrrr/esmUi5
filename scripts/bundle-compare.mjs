#!/usr/bin/env node
// bundle:compare — bundles dist/esm with each minifier (rolldown, oxc, none) into a temporary
// dist (esm/, runtime/, demo/ linked to the real ones), prints a size table and runs the demo
// check (both pages) against each variant. Recommends the smallest gzip result that passes.
// dist/ itself is not changed. Needs a prior `npm run build` (or build:esm + build:demo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundle, MINIFIERS, DEFAULT_MINIFIER } from "../src/bundle.mjs";
import { LAYOUT } from "../src/build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
for (const d of [LAYOUT.esm, LAYOUT.runtime, LAYOUT.demo, LAYOUT.reports]) {
	if (!fs.existsSync(path.join(dist, d))) {
		console.error(`bundle:compare: ${path.join(dist, d)} missing; run npm run build first`);
		process.exit(1);
	}
}

const kib = (n) => (n / 1024).toFixed(0).padStart(8) + " KiB";
const rows = [];
for (const minifier of MINIFIERS) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `esm-ui5-compare-${minifier}-`));
	for (const d of [LAYOUT.esm, LAYOUT.runtime, LAYOUT.demo]) fs.symlinkSync(path.join(dist, d), path.join(tmp, d), "dir");
	fs.cpSync(path.join(dist, LAYOUT.reports), path.join(tmp, LAYOUT.reports), { recursive: true });
	process.stdout.write(`${minifier}: bundling ... `);
	const report = await bundle({ out: tmp, minifier, log: () => {} });
	process.stdout.write(`${report.seconds.toFixed(1)} s, demo check ... `);
	const check = spawnSync(process.execPath, [path.join(root, "scripts/demo-check.mjs")], { env: { ...process.env, DIST: tmp }, encoding: "utf8" });
	const skipped = /skipped/.test(check.stdout);
	const demo = skipped ? "skipped" : check.status === 0 ? "ok" : "FAIL";
	console.log(demo);
	if (demo === "FAIL") console.log(check.stdout.split("\n").filter((l) => /FAIL|error/.test(l)).map((l) => "    " + l).join("\n"));
	rows.push({ minifier, seconds: report.seconds, demo, ...report.packageBundles, totals: report.totals });
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`\npackage bundles (${rows[0].count} files), sum over all files:`);
console.log(`  ${"minifier".padEnd(10)}${"raw".padStart(12)}${"min".padStart(12)}${"gzip".padStart(12)}${"brotli".padStart(12)}${"time".padStart(8)}  demo`);
for (const r of rows) {
	console.log(`  ${r.minifier.padEnd(10)}${kib(r.raw)}${kib(r.minified)}${kib(r.gzip)}${kib(r.brotli)}${(r.seconds.toFixed(1) + " s").padStart(8)}  ${r.demo}`);
}
const passing = rows.filter((r) => r.demo !== "FAIL" && r.minifier !== "none");
const best = passing.sort((a, b) => a.gzip - b.gzip)[0];
console.log(best
	? `\nsmallest gzip that passes the demo check: ${best.minifier} (current default: ${DEFAULT_MINIFIER})`
	: "\nno minified variant passed the demo check");
process.exit(rows.some((r) => r.demo === "FAIL") ? 1 : 0);
