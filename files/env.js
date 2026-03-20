import process from 'node:process';

/* global ENV_PREFIX */

const expected = new Set([
	'HOST',
	'PORT',
	'ORIGIN',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'SHUTDOWN_TIMEOUT',
	'SHUTDOWN_DELAY_MS',
	'SSL_CERT',
	'SSL_KEY',
	'CLUSTER_WORKERS',
	'CLUSTER_MODE',
	'WS_DEBUG'
]);

if (ENV_PREFIX) {
	for (const name in process.env) {
		if (name.startsWith(ENV_PREFIX)) {
			const unprefixed = name.slice(ENV_PREFIX.length);
			if (!expected.has(unprefixed)) {
				throw new Error(
					`You should change envPrefix (${ENV_PREFIX}) to avoid conflicts with existing environment variables - unexpectedly saw ${name}`
				);
			}
		}
	}
}

// IMPORTANT: process.env property access crosses the V8-to-OS boundary on every
// call (uv_os_getenv() behind a global mutex  - it is NOT a cached Map lookup).
// All env() calls must be at module level, never inside request handlers or
// per-message callbacks. One access per call; the `in` + property pattern
// would cost two OS round-trips.

/**
 * @param {string} name
 * @param {any} fallback
 */
export function env(name, fallback) {
	const prefixed = ENV_PREFIX + name;
	const value = process.env[prefixed];
	return value !== undefined ? value : fallback;
}
