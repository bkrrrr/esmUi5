// The "demo" step: copy ./demo (Todo app) to dist/demo and write dist/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT, freshDir } from "./build.mjs";

const DEMO_SRC = fileURLToPath(new URL("../demo/", import.meta.url));
const README_SRC = fileURLToPath(new URL("./dist-README.md", import.meta.url));

export function copyDemo({ out = "dist", log = (m) => console.log(m) } = {}) {
	const target = path.join(path.resolve(out), LAYOUT.demo);
	freshDir(target);
	fs.cpSync(DEMO_SRC, target, { recursive: true, filter: (src) => path.basename(src) !== ".DS_Store" });
	writeDistReadme(out);
	log(`demo -> ${target}`);
	return target;
}

export function writeDistReadme(out = "dist") {
	let version = "";
	try {
		version = JSON.parse(fs.readFileSync(path.join(path.resolve(out), LAYOUT.reports, "esm-ui5-report.json"), "utf8")).ui5Version;
	} catch {
		/* esm step not run */
	}
	fs.mkdirSync(path.resolve(out), { recursive: true });
	fs.writeFileSync(path.join(path.resolve(out), "README.md"), fs.readFileSync(README_SRC, "utf8").replace("__VERSION__", version || "?"));
}
