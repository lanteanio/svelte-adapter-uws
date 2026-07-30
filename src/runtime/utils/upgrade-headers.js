// Response-splitting guard for headers written onto the 101 handshake.
//
// uWS writes these headers VERBATIM into the handshake response, so a CR, LF or
// NUL in a value - or a name outside the RFC 7230 token alphabet - splits the
// response and lets an app that composes untrusted data into a header inject
// arbitrary response lines.
//
// This module is the SINGLE definition, imported by every surface that can write
// a handshake header: the production runtime, the upgradeResponse() helper (which
// validates at construction so the failure surfaces inside the app's own hook),
// and the in-process test server. Those three previously carried their own
// copies kept in step by a comment asking a human to remember, which is how the
// test server ended up without the check at all - an app could verify its
// handshake against the test server, see a clean pass, and ship a splittable
// header to production. A shared predicate makes that class of divergence
// impossible rather than merely discouraged.

/** RFC 7230 token: the only shape a header NAME may take. */
export const UPGRADE_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

/**
 * Bytes a header value may not carry.
 *
 * This is Node's own `checkInvalidHeaderChar` class: everything except TAB,
 * printable ASCII and the high range. CR, LF and NUL are the ones that actually
 * split or truncate the response, but the class is deliberately wider. An
 * earlier version listed only those three, which let VT (0x0B), FF (0x0C) and
 * DEL (0x7F) through to the wire verbatim - so a value this module accepted was
 * one `cookies.set()` in the same package would refuse, and a header round-trip
 * through any Node-based proxy would throw where the adapter had passed it.
 * TAB stays legal because it is valid header whitespace, and the high range
 * stays legal because uWS writes bytes and a latin-1 value is not a splitting
 * risk.
 */
export const UPGRADE_HEADER_VALUE_RE = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * First reason these headers cannot be written safely, or null when clean.
 *
 * Requires a non-null object: callers guard, because "no headers at all" is a
 * legitimate state that has nothing to validate rather than a violation to
 * report.
 *
 * @param {Record<string, string | string[]>} responseHeaders
 * @returns {string | null}
 */
export function findUnsafeUpgradeHeader(responseHeaders) {
	for (const [name, value] of Object.entries(responseHeaders)) {
		if (!UPGRADE_HEADER_NAME_RE.test(name)) {
			return `header name ${JSON.stringify(name)} is not a valid RFC 7230 token`;
		}
		const arrayValue = Array.isArray(value);
		const length = arrayValue ? value.length : 1;
		for (let i = 0; i < length; i++) {
			// Index the array directly. `for...of` runs an app-controlled
			// Symbol.iterator, which can yield clean bytes during validation and
			// splitting bytes when the runtime iterates again to write.
			const v = arrayValue ? value[i] : value;
			// Strings only. uWS rejects a non-string at writeHeader time, which is
			// inside the cork AFTER the 101 status line has already gone out - so
			// the handshake is half-written and the client is left with a broken
			// connection rather than a clean refusal. (The throw itself is caught
			// and logged on both the direct and the deferred-admission path; the
			// damage is the truncated handshake, not an unhandled error.)
			// `RegExp.test` alone would coerce a non-string and pass it.
			if (typeof v !== 'string') {
				return `header ${JSON.stringify(name)} value must be a string, got ${v === null ? 'null' : typeof v}`;
			}
			if (UPGRADE_HEADER_VALUE_RE.test(v)) {
				return `header ${JSON.stringify(name)} value contains a CR, LF, or NUL byte, or another control character`;
			}
		}
	}
	return null;
}

/**
 * Assert that a value is a header bag whose names and values are safe to write.
 *
 * `null` / `undefined` mean no response headers and are accepted. Every other
 * value must be a non-array object. In particular, `Object.entries('abc')` and
 * `Object.entries(['abc'])` produce numeric keys, so merely feeding an unknown
 * value to {@link findUnsafeUpgradeHeader} invents valid-looking headers rather
 * than rejecting the misshaped upgrade result.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 * @returns {void}
 */
function assertUpgradeHeaderContainer(responseHeaders) {
	if (responseHeaders == null) return;
	if (typeof responseHeaders !== 'object' || Array.isArray(responseHeaders)) {
		throw new TypeError(
			`upgradeResponse() headers must be an object of header names to values - ` +
			`got ${Array.isArray(responseHeaders) ? 'an array' : typeof responseHeaders}.`
		);
	}
}

export function assertSafeUpgradeHeaders(responseHeaders) {
	assertUpgradeHeaderContainer(responseHeaders);
	if (responseHeaders == null) return;
	const unsafe = findUnsafeUpgradeHeader(responseHeaders);
	if (unsafe) throw new TypeError(`upgradeResponse() rejected: ${unsafe}`);
}

/**
 * Snapshot and validate the headers a runtime surface is about to consume.
 *
 * This is deliberately one operation. The object belongs to the app and may be
 * shared across upgrades; validating it and reading it again later leaves a
 * validate/use window. Array values are copied as well as the bag, and the bag
 * has no prototype so an own enumerable `__proto__` key cannot disappear
 * through Object.prototype's setter. Every surface consumes this returned
 * snapshot rather than the caller's object.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 * @returns {Record<string, string | string[]> | null}
 */
export function snapshotUpgradeHeaders(responseHeaders) {
	if (responseHeaders == null) return null;
	// Check the CONTAINER before Object.entries can reinterpret a string/array as
	// a bag of numeric header names. Do not validate the LIVE values before the
	// snapshot: a later getter may mutate an earlier key during Object.entries,
	// and the safe contract is to write the earlier value already captured by
	// that one enumeration, not to re-read the app's now-poisoned object.
	assertUpgradeHeaderContainer(responseHeaders);
	/** @type {Record<string, string | string[]>} */
	const snapshot = Object.create(null);
	// Read and copy one value at a time. Object.entries first materializes ALL
	// values, so a getter on a later key can mutate an earlier array before the
	// copy loop begins. Object.keys fixes the key set, then this loop captures an
	// array at the same point its property is read.
	for (const name of Object.keys(responseHeaders)) {
		const value = responseHeaders[name];
		if (Array.isArray(value)) {
			// Do not call the app array's `.slice()` (or any iterator). Both are
			// executable hooks, and slice also honours Symbol.species. A hostile
			// result can yield safe bytes while the snapshot is validated, then
			// CRLF when the write loop iterates it a second time. Copy each index
			// once into a native array; validation and the sinks also use indices,
			// so no app-controlled iteration remains between check and use.
			const length = value.length;
			const copied = new Array(length);
			for (let i = 0; i < length; i++) copied[i] = value[i];
			snapshot[name] = copied;
		} else {
			snapshot[name] = value;
		}
	}
	assertSafeUpgradeHeaders(snapshot);
	return snapshot;
}

/**
 * One warning per worker, not per connection - a warning that repeats on every
 * connection is a warning people filter out. Clustering runs worker threads in
 * one process, each with its own module registry, so a clustered deployment
 * emits one per worker.
 */
let warnedSetCookieOnUpgrade = false;

/**
 * Warn once when a handshake carries Set-Cookie, which Cloudflare Tunnel and
 * some other strict edge proxies silently reject: the WebSocket opens and then
 * closes with 1006 before any frame is exchanged, which is near-impossible to
 * diagnose from the app side.
 *
 * Shared rather than reimplemented per surface, so an app that develops against
 * the in-process test server sees the same advisory production would give it.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 */
export function warnSetCookieOnUpgradeOnce(responseHeaders) {
	if (warnedSetCookieOnUpgrade || !responseHeaders) return;
	for (const k of Object.keys(responseHeaders)) {
		if (k.toLowerCase() === 'set-cookie') {
			warnedSetCookieOnUpgrade = true;
			console.warn(
				'[adapter-uws] Set-Cookie on the 101 upgrade response is rejected by ' +
				'Cloudflare Tunnel and some other edge proxies (WebSocket opens, then ' +
				'closes with 1006 TCP FIN). Migrate to the `authenticate` hook to ' +
				'refresh session cookies over a normal HTTP response: ' +
				'export function authenticate({ cookies }) { cookies.set(...); }\n' +
				'  See: https://svti.me/cf-cookies'
			);
			return;
		}
	}
}
