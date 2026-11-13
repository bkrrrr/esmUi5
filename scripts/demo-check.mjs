#!/usr/bin/env node
// demo:check — serves dist/ and loads both demo pages in headless Chrome/Chromium with
// --dump-dom and a virtual-time budget; asserts that the rendered DOM contains the app title
// and a rendered list item. No extra dependency. Without a browser: "skipped", exit 0 unless
// REQUIRE_BROWSER=1.
//   CHROME_BIN=/path/to/chrome   use this browser
//   DIST=<dir>                    serve another dist folder (bundle:compare uses this)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../src/serve.mjs";
import { findBrowser } from "../src/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.resolve(process.env.DIST ?? path.join(root, "dist"));
const PAGES = ["demo/esm/index.html", "demo/bundles/index.html"];
const TITLE = "UI5 Next Todo";
const BUDGET_MS = Number(process.env.VIRTUAL_TIME_BUDGET ?? 60000);

export { findBrowser };

/** Checks on a dumped DOM: title rendered by sap.m.Page, at least one rendered list item, no error. */
export function checkDom(dom) {
	const title = new RegExp(`class="[^"]*sapMTitle[^"]*"[^>]*>(?:<[^>]+>)*\\s*${TITLE}`).test(dom);
	const listItems = (dom.match(/<li[^>]*class="[^"]*sapMLIB[^"]*"/g) ?? []).length;
	const error = /<pre id="ui5-next-error">([\s\S]*?)<\/pre>/.exec(dom)?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	return { title, listItems, error: error ?? null, ok: title && listItems > 0 && !error };
}

function dumpDom(browser, url) {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-demo-check-"));
	return new Promise((resolve) => {
		const child = spawn(browser, [
			"--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
			`--user-data-dir=${profile}`, `--virtual-time-budget=${BUDGET_MS}`, "--dump-dom", url,
		], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET_MS + 60000);
		child.on("close", (code) => {
			clearTimeout(timer);
			try {
				fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
			} catch {
				/* temp dir */
			}
			resolve({ code, dom: out });
		});
	});
}

export async function main({ browser = findBrowser(), distDir = dist, required = process.env.REQUIRE_BROWSER === "1" } = {}) {
	if (!browser) {
		if (required) {
			console.error("demo:check requires Chrome/Chromium, but none was found");
			return 1;
		}
		console.log("demo:check skipped: no Chrome/Chromium found (set CHROME_BIN to a Chrome or Chromium binary)");
		return 0;
	}
	for (const p of PAGES) {
		if (!fs.existsSync(path.join(distDir, p))) {
			console.error(`demo:check: ${path.join(distDir, p)} missing; run npm run build first`);
			return 1;
		}
	}
	const server = createStaticServer(distDir);
	await new Promise((r) => server.listen(0, r));
	const base = `http://localhost:${server.address().port}/`;
	console.log(`demo:check with ${browser}`);
	let failed = 0;
	for (const p of PAGES) {
		const t0 = Date.now();
		const { code, dom } = await dumpDom(browser, base + p);
		const r = checkDom(dom);
		console.log(`  ${r.ok ? "ok  " : "FAIL"} ${p}: title ${r.title ? "rendered" : "missing"}, ${r.listItems} list items (${Date.now() - t0} ms)`);
		if (code !== 0) console.error(`       Chrome exited with status ${code}`);
		if (r.error) console.log(`       error: ${r.error.split("\n").slice(0, 4).join("\n              ")}`);
		if (!r.ok || code !== 0) failed++;
	}
	server.close();
	return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	process.exitCode = await main();
}
