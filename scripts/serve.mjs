#!/usr/bin/env node
// Minimal static file server for trying UI5 Next: node scripts/serve.mjs [root] [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8080);
const TYPES = {
	".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
	".html": "text/html", ".xml": "application/xml", ".properties": "text/plain; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff",
	".ttf": "font/ttf", ".less": "text/plain",
};

http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	let file = path.join(root, decodeURIComponent(url.pathname));
	if (!file.startsWith(root)) return res.writeHead(403).end();
	if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
	fs.readFile(file, (err, data) => {
		if (err) return res.writeHead(404).end("not found");
		res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
		res.end(data);
	});
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}/`));
