// Build-time configuration helpers for the adapter. Pure and dependency-free
// (no SvelteKit builder, no filesystem, no placeholder imports) so they are
// unit-testable in isolation - the runtime build flow in index.js wires their
// output into the placeholder replace map.

import { RESERVED_STATIC_HEADER_KEYS } from './runtime/utils/static-headers.js';

/**
 * @typedef {Object} NormalizedStaticHeaders
 * @property {Record<string, string> | null} headers - lowercased, reserved keys
 *   removed; `null` when nothing usable remains (so the placeholder serializes
 *   to `null` and the runtime merge is a no-op).
 * @property {string[]} dropped - reserved keys that were removed, for a
 *   build-time warning.
 */

/**
 * Validate and normalize the top-level `staticHeaders` adapter option. Throws
 * on a misshaped value (so the misconfig fails the build loudly) and strips
 * reserved transfer/caching headers the static handler manages itself.
 *
 * @param {unknown} input - the raw `staticHeaders` option value
 * @returns {NormalizedStaticHeaders}
 */
export function normalizeStaticHeaders(input) {
	if (input == null) return { headers: null, dropped: [] };
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new Error(
			"adapter option `staticHeaders` must be an object of string header values, " +
			"e.g. { 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' }."
		);
	}
	/** @type {Record<string, string>} */
	const headers = {};
	/** @type {string[]} */
	const dropped = [];
	for (const rawKey of Object.keys(/** @type {Record<string, unknown>} */ (input))) {
		const value = /** @type {Record<string, unknown>} */ (input)[rawKey];
		if (typeof value !== 'string') {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` must be a string, got ${typeof value}.`
			);
		}
		const key = rawKey.toLowerCase();
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) {
			dropped.push(key);
			continue;
		}
		headers[key] = value;
	}
	return { headers: Object.keys(headers).length ? headers : null, dropped };
}
