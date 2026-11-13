#!/usr/bin/env node
// Browser smoke test: serves the project, opens a test page (default test/browser/button.html) in headless Chrome via the
// DevTools protocol (no extra dependencies, Node >= 22 for the global WebSocket), and checks
// the page's window.__smoke() checks. Writes a screenshot next to the page (<page>.png).
// Usage: node scripts/smoke.mjs [page] ; CHROME=/path/to/chrome to override the browser.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const page = process.argv[2] ?? "test/browser/button.html";
const CHROME = process.env.CHROME ?? [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => fs.existsSync(p));
if (!CHROME) {
	console.error("no Chrome found; set CHROME=/path/to/chrome");
	process.exit(2);
}
if (typeof WebSocket === "undefined") {
	console.error("needs Node >= 22 (global WebSocket)");
	process.exit(2);
}

// static server on a free port
const TYPES = { ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html", ".xml": "application/xml", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const requests = { ok: 0, notFound: [] };
const server = http.createServer((req, res) => {
	const file = path.join(projectRoot, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) {
			requests.notFound.push(req.url);
			return res.writeHead(404).end();
		}
		requests.ok++;
		res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
		res.end(data);
	});
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esm-ui5-chrome-"));
const chrome = spawn(CHROME, [
	"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--window-size=1000,700", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
	let buf = "";
	chrome.stderr.on("data", (d) => {
		buf += d;
		const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
		if (m) resolve(m[1]);
	});
	chrome.on("exit", (c) => reject(new Error(`chrome exited ${c}`)));
	setTimeout(() => reject(new Error("chrome did not start")), 15000);
});

const browserWs = new WebSocket(wsUrl);
await new Promise((r) => browserWs.addEventListener("open", r));
let id = 0;
const pending = new Map();
const listeners = [];
browserWs.addEventListener("message", (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	} else {
		for (const l of listeners) l(msg);
	}
});
const send = (method, params = {}, sessionId) =>
	new Promise((resolve, reject) => {
		const msgId = ++id;
		pending.set(msgId, { resolve, reject });
		browserWs.send(JSON.stringify({ id: msgId, method, params, sessionId }));
	});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const s = (method, params) => send(method, params, sessionId);

const logs = [];
listeners.push((msg) => {
	if (msg.sessionId !== sessionId) return;
	if (msg.method === "Runtime.consoleAPICalled") {
		const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
		logs.push(`console.${msg.params.type}: ${text}`);
	} else if (msg.method === "Runtime.exceptionThrown") {
		const d = msg.params.exceptionDetails;
		logs.push(`EXCEPTION: ${d.exception?.description ?? d.text} @ ${d.url ?? ""}:${d.lineNumber}`);
	} else if (msg.method === "Log.entryAdded") {
		logs.push(`log.${msg.params.entry.level}: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
	}
});
await s("Runtime.enable");
await s("Log.enable");
await s("Page.enable");
await s("Network.enable");
const failed = [];
listeners.push((msg) => {
	if (process.env.TRACE && msg.sessionId === sessionId && msg.method === "Network.responseReceived" && msg.params.response.url.includes(process.env.TRACE)) {
		console.log("TRACE response", msg.params.response.status, msg.params.response.url, msg.params.response.fromDiskCache, msg.params.response.headers?.["content-type"]);
	}
	if (msg.sessionId === sessionId && msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
		failed.push(`${msg.params.response.status} ${msg.params.response.url} (${msg.params.type})`);
	}
	if (process.env.TRACE && msg.sessionId === sessionId && msg.method === "Network.requestWillBeSent" && msg.params.request.url.includes(process.env.TRACE)) {
		console.log("TRACE", msg.params.request.url, msg.params.type, JSON.stringify(msg.params.initiator).slice(0, 1500));
	}
	if (msg.sessionId === sessionId && msg.method === "Network.loadingFailed") {
		failed.push(`FAILED ${msg.params.errorText} ${msg.params.type} ${msg.params.requestId}`);
	}
});
const started = Date.now();
await s("Page.navigate", { url: base + page });

const evaluate = async (expression) => (await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
let ready = false;
while (Date.now() - started < 30000) {
	ready = await evaluate(`document.body?.dataset.esmUi5 === "ready"`);
	if (ready) break;
	await new Promise((r) => setTimeout(r, 250));
}
const elapsed = Date.now() - started;
// the page may define window.__smoke() returning check results ({ ok, ... })
// the page may define window.__smoke(); a second CLI argument is an async expression run instead
const expr = process.argv[3] ? `(async () => { ${process.argv[3]} })()` : "window.__smoke ? window.__smoke() : { ok: true }";
const info = ready ? await evaluate(`Promise.resolve(${expr}).catch((e) => ({ ok: false, error: String(e && e.stack || e) }))`) : null;
await new Promise((r) => setTimeout(r, 500)); // let the theme settle for the screenshot
info && (info.globals = await evaluate(`({ jQuery: typeof window.jQuery, sapUiLoader: typeof window.sap?.ui?.loader })`));
const shot = await s("Page.captureScreenshot", { format: "png" });
const shotFile = path.join(projectRoot, page.replace(/\.html$/, "") + ".png");
fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));

console.log(`page: ${base + page}`);
console.log(`ready: ${ready} after ${elapsed} ms; requests: ${requests.ok} ok, ${requests.notFound.length} not found`);
for (const u of requests.notFound.slice(0, 20)) console.log(`  404 ${u}`);
for (const f of failed.filter((f) => !/favicon/.test(f)).slice(0, 20)) console.log(`  network: ${f}`);
console.log(JSON.stringify(info, null, 2));
const shown = logs.filter((l) => !/^console\.(debug|info|log):/.test(l) && !/favicon\.ico/.test(l));
console.log(`console (${shown.length} warnings/errors):`);
for (const l of shown.slice(0, 40)) console.log("  " + l.slice(0, 400));

browserWs.close();
chrome.kill();
server.close();
await new Promise((r) => chrome.once("exit", r));
try {
	fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
	/* Chrome may still be flushing its profile; it is in the OS temp dir */
}
console.log(`screenshot: ${path.relative(projectRoot, shotFile)}`);
process.exit(ready && info?.ok ? 0 : 1);
