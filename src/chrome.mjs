// Minimal headless Chrome driver over the DevTools protocol (no dependency; Node >= 22 for the
// global WebSocket). Used by the app build (trace), demo:check and the benchmark.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Chrome/Chromium/Edge: CHROME_BIN, the usual install locations, or the PATH. */
export function findBrowser() {
	const candidates = [
		process.env.CHROME_BIN,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge"]) {
		const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split("\n")[0];
	}
	return null;
}

/** Start headless Chrome; returns { send, listeners, newPage, close }. */
export async function startChrome(browser, extraArgs = []) {
	if (typeof WebSocket === "undefined") throw new Error("needs Node >= 22 (global WebSocket)");
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5next-chrome-"));
	const child = spawn(browser, [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--window-size=1200,800", ...extraArgs, "about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	const wsUrl = await new Promise((resolve, reject) => {
		let buf = "";
		child.stderr.on("data", (d) => {
			buf += d;
			const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) resolve(m[1]);
		});
		child.on("exit", (c) => reject(new Error(`chrome exited (${c})`)));
		setTimeout(() => reject(new Error("chrome did not start")), 20000);
	});
	const ws = new WebSocket(wsUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	let id = 0;
	const pending = new Map();
	const listeners = new Set();
	ws.addEventListener("message", (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
		} else for (const l of listeners) l(msg);
	});
	const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
		const i = ++id;
		pending.set(i, { resolve, reject });
		ws.send(JSON.stringify({ id: i, method, params, sessionId }));
	});
	/** A page in a fresh browser context: { s(method, params), evaluate(expr), close() } */
	async function newPage() {
		const { browserContextId } = await send("Target.createBrowserContext");
		const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
		const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
		const s = (m, p) => send(m, p, sessionId);
		return {
			sessionId,
			s,
			evaluate: async (expression) => (await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value,
			close: async () => {
				await send("Target.closeTarget", { targetId });
				await send("Target.disposeBrowserContext", { browserContextId });
			},
		};
	}
	return {
		send, listeners, newPage,
		close: async () => {
			ws.close();
			child.kill();
			await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
			try {
				fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
			} catch {
				/* temp dir */
			}
		},
	};
}
