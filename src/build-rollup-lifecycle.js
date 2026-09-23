import path from 'node:path';

/**
 * Write a programmatic Rollup build and always close its handle afterwards.
 * `close()` is what runs plugin `closeBundle` hooks and releases resources;
 * Rollup does not implicitly close a build after a successful `write()`.
 *
 * @param {import('rollup').RollupBuild} bundle
 * @param {import('rollup').OutputOptions} output
 * @returns {Promise<import('rollup').RollupOutput>} what was written, so a caller can
 *   name the files Rollup actually produced
 */
export async function writeAndCloseRollupBundle(bundle, output) {
	try {
		return await bundle.write(output);
	} finally {
		await bundle.close();
	}
}

/**
 * The import lines that make each discovered `__` entry run at startup, by the
 * file Rollup actually wrote for it rather than by its entry name: Rollup
 * rewrites characters it will not put in a file name (a `#` or `%` becomes
 * `_`), and each specifier is JSON-quoted, so an apostrophe cannot end it.
 *
 * @param {import('rollup').RollupOutput} written
 * @param {string} sourceDir - where the entry files were read from
 * @param {string[]} names - the entry names, in load order
 * @returns {string}
 */
export function extraEntryImports(written, sourceDir, names) {
	return names
		.map((name) => {
			const source = path.resolve(sourceDir, `${name}.js`);
			const chunk = written.output.find((o) => o.type === 'chunk' && o.isEntry &&
				typeof o.facadeModuleId === 'string' && path.resolve(o.facadeModuleId) === source);
			return `import ${JSON.stringify('./server/' + (chunk ? chunk.fileName : `${name}.js`))};`;
		})
		.join('\n');
}
