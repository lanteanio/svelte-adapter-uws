import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The `npm install` argument for the adapter's pinned uWebSockets.js, derived
 * from its own optionalDependencies - a single source of truth, so a pin bump
 * can never leave an install hint pointing at a stale tag. Every user-facing
 * message that tells someone how to install the addon goes through here.
 *
 * @param {{ optionalDependencies?: Record<string, string> } | undefined} pkg
 *   the adapter's parsed package.json (or undefined if it could not be read)
 * @returns {string} e.g. `uNetworking/uWebSockets.js#v20.69.0`
 */
export function uwsInstallSpec(pkg) {
	const spec = pkg && pkg.optionalDependencies && pkg.optionalDependencies['uWebSockets.js'];
	// Strip the `github:` scheme for the classic `npm install <owner>/<repo>#<tag>` form.
	if (typeof spec === 'string' && spec) return spec.replace(/^github:/, '');
	return 'uNetworking/uWebSockets.js';
}

/**
 * Build the "uWebSockets.js failed to load" error message, naming the
 * real-world causes: the GitHub-hosted native addon needs `git` on PATH and,
 * as an OPTIONAL dependency, is skipped SILENTLY by npm when its fetch fails,
 * so nothing surfaces until adapt().
 *
 * @param {{ optionalDependencies?: Record<string, string> } | undefined} pkg
 *   the adapter's parsed package.json (or undefined if it could not be read)
 * @returns {string}
 */
export function uwsLoadErrorMessage(pkg) {
	const installHint = uwsInstallSpec(pkg);
	return (
		'Could not load uWebSockets.js. Make sure it is installed:\n' +
		'  npm install ' + installHint + '\n\n' +
		'It is a native addon fetched from GitHub (not npm), so it needs `git` on ' +
		'PATH and, as an optional dependency, is skipped SILENTLY when the fetch ' +
		'fails - nothing reports it until build time. Verify it installed with ' +
		'`npm ls uWebSockets.js`; see the uWebSockets.js README for platform ' +
		'build requirements.'
	);
}

/**
 * Best-effort read of the adapter's own package.json, for the install hint.
 * Returns undefined if it cannot be read or parsed.
 * @returns {{ optionalDependencies?: Record<string, string> } | undefined}
 */
export function readAdapterPackageJson() {
	try {
		return JSON.parse(
			readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
		);
	} catch {
		return undefined;
	}
}
