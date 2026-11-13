// License files for dist/ (Apache-2.0 §4): the project's LICENSE and NOTICE, and the license
// files of the OpenUI5 packages (LICENSE.txt, THIRDPARTY.txt, LICENSES/*), copied once each
// (identical files from several packages are kept once; differing ones under licenses/<package>/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function* licenseFiles(pkgDir) {
	for (const f of ["LICENSE.txt", "THIRDPARTY.txt"]) if (fs.existsSync(path.join(pkgDir, f))) yield f;
	const dir = path.join(pkgDir, "LICENSES");
	if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) yield `LICENSES/${f}`;
}

/**
 * @param {string} distRoot
 * @param {{name: string, root: string}[]} packages  root = the package's src/ or resources/ folder
 * @returns {string[]} written files, relative to distRoot
 */
export function writeLicenses(distRoot, packages) {
	const written = [];
	const put = (rel, data) => {
		const f = path.join(distRoot, ...rel.split("/"));
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, data);
		written.push(rel);
	};
	put("LICENSE", fs.readFileSync(path.join(ROOT, "LICENSE")));
	put("NOTICE", fs.readFileSync(path.join(ROOT, "NOTICE")));
	const seen = new Map(); // relative license path -> content
	for (const pkg of packages) {
		const pkgDir = path.dirname(pkg.root);
		for (const rel of licenseFiles(pkgDir)) {
			const data = fs.readFileSync(path.join(pkgDir, rel));
			if (!seen.has(rel)) {
				seen.set(rel, data);
				put(`licenses/${rel}`, data);
			} else if (!seen.get(rel).equals(data)) {
				put(`licenses/${pkg.name.replace(/^@[^/]+\//, "")}/${rel}`, data);
			}
		}
	}
	return written;
}
