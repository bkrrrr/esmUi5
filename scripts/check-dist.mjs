#!/usr/bin/env node
// Checks that every .js file in the output tree parses as an ES module, and that
// sample modules import their dependencies only via relative paths ending in .js.
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const dist = path.resolve(process.argv[2] ?? "dist/esm");
const SAMPLES = ["sap/m/Button.js", "sap/ui/core/Control.js"];

function* jsFiles(dir, rel = "") {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) yield* jsFiles(path.join(dir, e.name), r);
		else if (e.name.endsWith(".js")) yield r;
	}
}

const parseModule = (src) => acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });

let total = 0;
const failures = [];
for (const rel of jsFiles(dist)) {
	total++;
	try {
		parseModule(fs.readFileSync(path.join(dist, rel), "utf8"));
	} catch (err) {
		failures.push({ file: rel, error: err.message });
	}
}
console.log(`${total} .js files, ${total - failures.length} parse as ES modules, ${failures.length} do not`);
for (const f of failures.slice(0, 50)) console.log(`  FAIL ${f.file}: ${f.error}`);
if (failures.length > 50) console.log(`  ... and ${failures.length - 50} more`);

let sampleErrors = 0;
for (const rel of SAMPLES) {
	const file = path.join(dist, rel);
	if (!fs.existsSync(file)) {
		console.log(`MISSING ${rel}`);
		sampleErrors++;
		continue;
	}
	const ast = parseModule(fs.readFileSync(file, "utf8"));
	const specs = [];
	for (const n of ast.body) {
		if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source) {
			specs.push(n.source.value);
		}
	}
	const bad = specs.filter((s) => !/^\.\.?\//.test(s) || !s.endsWith(".js"));
	const missing = specs.filter((s) => !fs.existsSync(path.resolve(path.dirname(file), s)));
	console.log(`${rel}: ${specs.length} imports, ${bad.length} not relative .js, ${missing.length} missing targets`);
	for (const s of bad) console.log(`  BAD ${s}`);
	for (const s of missing) console.log(`  MISSING ${s}`);
	sampleErrors += bad.length + missing.length;
}

process.exit(failures.length || sampleErrors ? 1 : 0);
