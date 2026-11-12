#!/usr/bin/env node
import { parseArgs } from "node:util";
import { build, DEFAULT_THEMES } from "../src/build.mjs";

const usage = `Usage: ui5-next [--from <dir>] [--out <dir>] [--scopes openui5,sapui5] [--themes <list>|all|none] [--clean] [--force]

  --from    directory containing node_modules (default ".")
  --out     output directory (default "dist")
  --scopes  comma separated npm scopes to read (default "openui5,sapui5")
  --themes  themes to compile from LESS (default "${DEFAULT_THEMES.join(",")}"; "all" or "none")
  --force   allow a non-empty output directory (overwrite, never delete)
  --clean   remove the output directory first
  --help    show this help`;

let args;
try {
	({ values: args } = parseArgs({
		options: {
			from: { type: "string", default: "." },
			out: { type: "string", default: "dist" },
			scopes: { type: "string", default: "openui5,sapui5" },
			themes: { type: "string" },
			clean: { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	}));
} catch (err) {
	console.error(err.message + "\n\n" + usage);
	process.exit(2);
}
if (args.help) {
	console.log(usage);
	process.exit(0);
}

const themes = args.themes === undefined ? undefined
	: args.themes === "all" ? "all"
	: args.themes === "none" ? []
	: args.themes.split(",").map((t) => t.trim()).filter(Boolean);
try {
	await build({
		from: args.from,
		out: args.out,
		scopes: args.scopes.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean),
		clean: args.clean,
		force: args.force,
		themes,
	});
} catch (err) {
	console.error(`ui5-next: ${err.message}`);
	process.exit(1);
}
