// Build-time configuration helpers for the adapter. Pure and dependency-free
// (no SvelteKit builder, no filesystem, no placeholder imports) so they are
// unit-testable in isolation - the runtime build flow in index.js wires their
// output into the placeholder replace map.

import { RESERVED_STATIC_HEADER_KEYS } from './runtime/utils/static-headers.js';

// RFC 9110 field-name grammar: 1*tchar. The set is written out rather than
// approximated with \w, which would admit nothing legal that this misses and
// would still reject the punctuation the grammar allows.
const STATIC_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// The three bytes that terminate or truncate a header field on the wire.
const FORBIDDEN_HEADER_BYTES = /[\r\n\0]/;

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
		// A CR, LF or NUL reaching `res.writeHeader` is a response-splitting
		// primitive: the bytes are written into the header block verbatim, so a
		// value carrying CRLF ends the current header and starts whatever the
		// rest of the string says - including a second response. Refused at
		// BUILD time rather than sanitised at request time, because silently
		// rewriting an operator's configured value would hide the misconfig
		// while leaving them believing the header they wrote is being sent.
		//
		// The name is held to the RFC 9110 token grammar rather than only
		// scanned for the three bytes, because anything outside it - a space,
		// a colon, a quote - cannot appear in a legal field name anyway, and an
		// allowlist cannot be outflanked the way a denylist can.
		if (!STATIC_HEADER_NAME.test(key)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` has a header name that is not a valid HTTP field name. ` +
				'Names are RFC 9110 tokens: letters, digits and !#$%&\'*+-.^_`|~ only.'
			);
		}
		if (FORBIDDEN_HEADER_BYTES.test(value)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` contains a carriage return, line feed or NUL. ` +
				'Those bytes end a header field on the wire, so a value carrying them could inject headers ' +
				'or a whole second response. Remove them, or fold the value onto one line.'
			);
		}
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) {
			dropped.push(key);
			continue;
		}
		headers[key] = value;
	}
	return { headers: Object.keys(headers).length ? headers : null, dropped };
}

/**
 * Validate and normalize path-specific Cache-Control rules. A rule without a
 * trailing slash matches one exact asset path; a trailing slash matches that
 * directory tree. Patterns are relative to SvelteKit's configured base path.
 *
 * @param {unknown} input - the raw `staticCacheControl` option value
 * @returns {{ pattern: string, cacheControl: string }[] | null}
 */
export function normalizeStaticCacheControl(input) {
	if (input == null) return null;
	if (!Array.isArray(input)) {
		throw new Error(
			"adapter option `staticCacheControl` must be an array of { pattern, cacheControl } rules."
		);
	}

	/** @type {{ pattern: string, cacheControl: string }[]} */
	const rules = [];
	const seen = new Set();
	for (let index = 0; index < input.length; index++) {
		const rule = input[index];
		if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
			throw new Error(`adapter option \`staticCacheControl[${index}]\` must be an object.`);
		}

		const record = /** @type {Record<string, unknown>} */ (rule);
		const unknown = Object.keys(record).filter((key) => key !== 'pattern' && key !== 'cacheControl');
		if (unknown.length) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}]\` has unknown key(s): ${unknown.join(', ')}.`
			);
		}

		const pattern = record.pattern;
		if (typeof pattern !== 'string' || pattern[0] !== '/' ||
			/[\\?#*\u0000-\u001f\u007f]/.test(pattern) || /(^|\/)\.{1,2}(\/|$)/.test(pattern)) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}].pattern\` must be an absolute, ` +
				"literal, query-free asset path such as '/fonts/' or '/logo.v2.svg'."
			);
		}
		if (seen.has(pattern)) {
			throw new Error(`adapter option \`staticCacheControl\` contains duplicate pattern '${pattern}'.`);
		}

		const cacheControl = record.cacheControl;
		if (typeof cacheControl !== 'string' || !cacheControl.trim() || /[\u0000-\u001f\u007f]/.test(cacheControl)) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}].cacheControl\` must be a non-empty, single-line string.`
			);
		}

		seen.add(pattern);
		rules.push({ pattern, cacheControl: cacheControl.trim() });
	}

	// Resolve the most specific directory first regardless of declaration order.
	rules.sort((left, right) => right.pattern.length - left.pattern.length);
	return rules.length ? rules : null;
}
