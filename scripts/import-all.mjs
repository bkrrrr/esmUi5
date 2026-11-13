#!/usr/bin/env node
// Lists the runtime modules of dist/esm/ (no tests, QUnit, thirdparty, documentation app) into
// test/browser/import-all.json and imports all of them in headless Chrome via scripts/smoke.mjs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist", "esm");
const EXCLUDE = /(^|\/)(test|qunit|thirdparty|testrecorder|demokit)\/|^sap\/ui\/documentation\/|\.orig\.js$|^ui5-next-|^ui5loader|^sap-ui-|\.support\.js$|^jquery\.sap\./;
const report = JSON.parse(fs.readFileSync(path.join(root, "dist", "reports", "ui5-next-report.json"), "utf8"));
const classic = new Set(report.classicScripts ?? []); // not modules: loaded by their libraries as scripts
const list = [];
(function walk(dir, rel) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) walk(path.join(dir, e.name), r);
		else if (e.name.endsWith(".js") && r.includes("/") && !EXCLUDE.test(r) && !classic.has(r)) list.push(r);
	}
})(dist, "");
list.sort();
fs.writeFileSync(path.join(root, "test/browser/import-all.json"), JSON.stringify(list));
const res = spawnSync(process.execPath, [path.join(root, "scripts/smoke.mjs"), "test/browser/import-all.html"], { encoding: "utf8", maxBuffer: 64 << 20 });
const out = res.stdout + res.stderr;
const json = out.slice(out.indexOf("{"), out.lastIndexOf("}\nconsole") + 1);
let info;
try {
	info = JSON.parse(json);
} catch {
	console.log(out);
	process.exit(1);
}
console.log(`${info.total} modules: ${info.imported} imported, ${info.failed} failed`);
const groups = new Map();
for (const f of info.failures) {
	const key = f.error.replace(/https?:\/\/[^\s'"]+/g, "<url>").replace(/'[^']*'/g, "'…'").slice(0, 160);
	groups.set(key, [...(groups.get(key) ?? []), f.module]);
}
for (const [k, mods] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
	console.log(`${String(mods.length).padStart(5)}  ${k}\n         e.g. ${mods.slice(0, 3).join(", ")}`);
}
fs.writeFileSync(path.join(root, "test/browser/import-all-result.json"), JSON.stringify(info, null, 2));
process.exit(info.failed ? 1 : 0);
