// Build-time configuration helpers for the adapter. Pure and dependency-free
// (no SvelteKit builder, no filesystem, no placeholder imports) so they are
// unit-testable in isolation - the runtime build flow in index.js wires their
// output into the placeholder replace map.

import { RESERVED_STATIC_HEADER_KEYS } from './runtime/utils/static-headers.js';
// The SAME predicates the handshake lane uses, imported rather than restated.
// That module is the single definition on purpose, and its own history is the
// argument: a narrower class listing only CR, LF and NUL was tried there and
// reverted, because it let VT, FF and DEL through to the wire - values this
// package accepted while `cookies.set()` in the same package refused them, and
// which a Node-based proxy throws on when it re-emits the header.
import { UPGRADE_HEADER_NAME_RE, UPGRADE_HEADER_VALUE_RE } from './runtime/utils/upgrade-headers.js';

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
	/**
	 * Null-prototype, so a configured `__proto__` key becomes an own property
	 * instead of hitting `Object.prototype`'s setter and vanishing. On a plain
	 * object `headers['__proto__'] = 'x'` is a silent no-op for a string value,
	 * which would drop an operator's header with no throw and no warning - the
	 * exact quiet substitution this function refuses to make everywhere else.
	 * @type {Record<string, string>}
	 */
	const headers = Object.create(null);
	/** @type {string[]} */
	const dropped = [];
	for (const rawKey of Object.keys(/** @type {Record<string, unknown>} */ (input))) {
		const value = /** @type {Record<string, unknown>} */ (input)[rawKey];
		if (typeof value !== 'string') {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` must be a string, got ${typeof value}.`
			);
		}
		// Validated on the RAW key, before lowercasing. Some non-ASCII letters
		// case-fold INTO the token alphabet - the Kelvin sign lowercases to `k` -
		// so checking the folded form would ship a header under a name the
		// operator never wrote.
		if (!UPGRADE_HEADER_NAME_RE.test(rawKey)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` has a header name that is not a valid HTTP field name. ` +
				'Names are RFC 9110 tokens: letters, digits and !#$%&\'*+-.^_`|~ only.'
			);
		}
		// A value written into the header block verbatim can end the field and
		// start whatever follows - another header, or after a blank line a second
		// response. Refused at BUILD time rather than sanitised at request time,
		// because rewriting an operator's configured value would leave them
		// believing the header they wrote is the one being served.
		//
		// Both predicates are the handshake lane's, imported: see the note over
		// the import for why this file does not get its own spelling of them.
		if (UPGRADE_HEADER_VALUE_RE.test(value)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` contains a byte a header value may not carry ` +
				'(a control character such as CR, LF, NUL, VT, FF or DEL). Those bytes end or truncate a header ' +
				'field on the wire, so a value carrying them could inject headers or a whole second response. ' +
				'Remove them, or fold the value onto one line.'
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
