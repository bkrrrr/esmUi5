// Theme build with less-openui5 (SAP's LESS build for UI5 themes, the same engine the UI5
// tooling uses): library.source.less -> library.css (with the inline theme parameters that
// UI5 reads at runtime), library-RTL.css, library-parameters.json, css_variables.css and
// library_skeleton.css, written next to the sources.
import fs from "node:fs";
import path from "node:path";
import lessOpenUI5 from "less-openui5";

export const DEFAULT_THEMES = ["sap_horizon"];

/**
 * Find library themes in a tree: <lib path>/themes/<theme>/library.source.less
 * @param {Iterable<string>} relPaths
 * @returns {{lib: string, theme: string, dir: string}[]}
 */
export function findThemes(relPaths) {
	const out = [];
	for (const rel of relPaths) {
		const m = /^(.+)\/themes\/([^/]+)\/library\.source\.less$/.exec(rel);
		if (m) out.push({ lib: m[1].replace(/\//g, "."), theme: m[2], dir: `${m[1]}/themes/${m[2]}` });
	}
	return out.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** The files written for one library theme, from a less-openui5 result. */
export function themeFiles(result) {
	return {
		"library.css": result.css,
		"library-RTL.css": result.cssRtl,
		"library-parameters.json": JSON.stringify(result.variables) + "\n",
		"css_variables.css": result.cssVariables,
		"css_variables.source.less": result.cssVariablesSource,
		"library_skeleton.css": result.cssSkeleton,
		"library_skeleton-RTL.css": result.cssSkeletonRtl,
	};
}

/**
 * Build themes inside an ES module tree (which contains the merged LESS sources).
 * @param {string} root absolute path of dist/esm
 * @param {{lib, theme, dir}[]} themes
 * @param {(msg: string) => void} log
 * @returns {Promise<{compiled: string[], themeFailures: {library, theme, reason}[], written: string[]}>}
 */
export async function buildThemes(root, themes, log = () => {}) {
	const builder = new lessOpenUI5.Builder();
	const compiled = [];
	const themeFailures = [];
	const written = [];
	let n = 0;
	for (const t of themes) {
		if (++n % 5 === 0) log(`  themes ${n}/${themes.length}`);
		try {
			const result = await builder.build({
				lessInputPath: `${t.dir}/library.source.less`,
				rootPaths: [root],
				library: { name: t.lib }, // inlines the parameters as data URI (read by sap/ui/core/theming/Parameters)
				cssVariables: true,
				compiler: { compress: true },
			});
			for (const [file, content] of Object.entries(themeFiles(result))) {
				if (content == null) continue;
				const rel = `${t.dir}/${file}`;
				fs.writeFileSync(path.join(root, ...rel.split("/")), content);
				written.push(rel);
			}
			compiled.push(`${t.lib}:${t.theme}`);
		} catch (err) {
			themeFailures.push({ library: t.lib, theme: t.theme, reason: String(err?.message ?? err).split("\n")[0] });
		}
		builder.clearCache();
	}
	return { compiled, themeFailures, written };
}
