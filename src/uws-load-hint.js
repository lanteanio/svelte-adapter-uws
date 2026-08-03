import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ERROR_IDS, adapterErrorMessage } from './runtime/error-registry.js';

/**
 * The `npm install` argument for the adapter's pinned uWebSockets.js, derived
 * from its own optionalDependencies - a single source of truth, so a pin bump
 * can never leave an install hint pointing at a stale tag. Every user-facing
 * message that tells someone how to install the addon goes through here.
 *
 * @param {{ optionalDependencies?: Record<string, string> } | undefined} pkg
 *   the adapter's parsed package.json (or undefined if it could not be read)
 * @returns {string | null} e.g. an exact GitHub HTTPS archive URL, or
 *   null when package metadata cannot supply an exact ref
 */
export function uwsInstallSpec(pkg) {
	const spec = pkg && pkg.optionalDependencies && pkg.optionalDependencies['uWebSockets.js'];
	if (typeof spec !== 'string' || !spec) return null;
	if (/^https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz$/.test(spec)) {
		return spec;
	}
	// Retain bounded support for metadata from older published adapter versions.
	if (/^(?:github:)?uNetworking\/uWebSockets\.js#v\d+\.\d+\.\d+$/.test(spec)) {
		const installSpec = spec.replace(/^github:/, '');
		return installSpec;
	}
	return null;
}

/**
 * Build the "uWebSockets.js failed to load" error message with the exact
 * recovery spec and the native loader's original diagnostic.
 *
 * @param {{ optionalDependencies?: Record<string, string> } | undefined} pkg
 *   the adapter's parsed package.json (or undefined if it could not be read)
 * @param {unknown} [cause]
 * @returns {string}
 */
export function uwsLoadErrorMessage(pkg, cause) {
	const installHint = uwsInstallSpec(pkg);
	const recovery = installHint === null
		? '  Reinstall svelte-adapter-uws so its package metadata is available, then use the exact native-addon command from Version compatibility.\n'
		: '  npm install ' + installHint + '\n';
	const detail = cause instanceof Error && cause.message
		? '\nNative loader cause: ' + cause.message
		: '';
	return (
		adapterErrorMessage(ADAPTER_ERROR_IDS.NATIVE_LOAD, ' Make sure it is installed:\n' +
		recovery + '\n' +
		'The prebuilt Linux addon requires glibc >= 2.38; musl-based distributions ' +
		'are unsupported. The installed addon must also include a binary for this ' +
		'Node ABI and CPU architecture. Verify it with `npm ls uWebSockets.js`.' +
		detail)
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
