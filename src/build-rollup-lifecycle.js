/**
 * Write a programmatic Rollup build and always close its handle afterwards.
 * `close()` is what runs plugin `closeBundle` hooks and releases resources;
 * Rollup does not implicitly close a build after a successful `write()`.
 *
 * @param {import('rollup').RollupBuild} bundle
 * @param {import('rollup').OutputOptions} output
 * @returns {Promise<void>}
 */
export async function writeAndCloseRollupBundle(bundle, output) {
	try {
		await bundle.write(output);
	} finally {
		await bundle.close();
	}
}
