// Zero-dependency static file server (node:http) for dist/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export const MIME = {
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".xml": "application/xml; charset=utf-8",
	".properties": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
	".less": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif",
	".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

/** @returns {http.Server} not yet listening */
export function createStaticServer(root) {
	const base = path.resolve(root);
	return http.createServer((req, res) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
		} catch {
			return res.writeHead(400).end();
		}
		let file = path.join(base, pathname);
		if (file !== base && !file.startsWith(base + path.sep)) return res.writeHead(403).end();
		if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
		fs.readFile(file, (err, data) => {
			if (err) return res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }).end("not found");
			res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
			res.end(req.method === "HEAD" ? undefined : data);
		});
	});
}

export function serve({ root = "dist", port = 8080 } = {}) {
	const server = createStaticServer(root);
	return new Promise((resolve) => server.listen(port, () => {
		const p = server.address().port;
		console.log(`serving ${path.resolve(root)} at http://localhost:${p}/`);
		resolve(server);
	}));
}
