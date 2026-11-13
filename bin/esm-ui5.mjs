#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { build, themesStep, removeDir, DEFAULT_THEMES } from "../src/build.mjs";
import { bundle, MINIFIERS, DEFAULT_MINIFIER } from "../src/bundle.mjs";
import { copyDemo, writeDistReadme } from "../src/demo.mjs";
import { serve } from "../src/serve.mjs";

const usage = `Usage: esm-ui5 <command> [options]

Commands:
  esm      merge @openui5 packages, convert to ES modules, thirdparty wrappers, package
           manifest, themes            -> dist/esm, dist/runtime, dist/reports
  themes   (re)build themes inside dist/esm
  bundle   one minified file per package (Rolldown)  -> dist/bundles, dist/reports/bundle-report.json
  demo     copy the Todo demo           -> dist/demo, dist/README.md
  all      esm + bundle + demo (default)
  serve    static server for dist/ (port 8080)

Options:
  --from <dir>       directory containing node_modules (default ".")
  --out <dir>        dist folder (default "dist")
  --scopes <list>    npm scopes to read (default "openui5,sapui5")
  --themes <list>    themes to build, or "all" / "none" (default "${DEFAULT_THEMES.join(",")}")
  --minifier <name>  ${MINIFIERS.join(" | ")} (default "${DEFAULT_MINIFIER}")
  --sourcemap        write source maps for the bundles
  --clean            remove the output first (all: dist/, esm: dist/esm)
  --force            allow a non-empty dist/esm (overwrite, never delete)
  --port <n>         serve: port (default 8080)
  --help`;

let args;
let positionals;
try {
	({ values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			from: { type: "string", default: "." },
			out: { type: "string", default: "dist" },
			scopes: { type: "string", default: "openui5,sapui5" },
			themes: { type: "string" },
			minifier: { type: "string", default: DEFAULT_MINIFIER },
			sourcemap: { type: "boolean", default: false },
			clean: { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			port: { type: "string", default: "8080" },
			help: { type: "boolean", short: "h", default: false },
		},
	}));
} catch (err) {
	console.error(err.message + "\n\n" + usage);
	process.exit(2);
}
const command = positionals[0] ?? "all";
if (args.help || !["esm", "themes", "bundle", "demo", "all", "serve"].includes(command)) {
	console.log(usage);
	process.exit(args.help ? 0 : 2);
}

const themes = args.themes === undefined ? DEFAULT_THEMES
	: args.themes === "all" ? "all"
	: args.themes === "none" ? []
	: args.themes.split(",").map((t) => t.trim()).filter(Boolean);
const scopes = args.scopes.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
const { from, out } = args;

try {
	if (command === "all" && args.clean) removeDir(path.resolve(out), from);
	if (command === "esm" || command === "all") {
		await build({ from, out, scopes, themes, clean: command === "esm" && args.clean, force: args.force || command === "all" });
		writeDistReadme(out);
	}
	if (command === "themes") await themesStep({ out, themes });
	if (command === "bundle" || command === "all") await bundle({ out, minifier: args.minifier, sourcemap: args.sourcemap });
	if (command === "demo" || command === "all") copyDemo({ out });
	if (command === "serve") await serve({ root: out, port: Number(args.port) });
} catch (err) {
	console.error(`esm-ui5: ${err.message}`);
	process.exit(1);
}
