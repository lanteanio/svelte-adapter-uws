// The trusted attribution contract: one server-side resolver, one frozen
// per-connection result, one accessor every limiter surface reads.
//
// The handler module may export `attribution(user)` - the same module that
// exports upgrade/open/message/close - returning
// `{ tenantId?, principalId?, entitlement? }` or null/undefined for an
// unattributed connection. `user` is `ws.getUserData()`, the server-trusted
// identity the upgrade hook established; nothing here ever reads the wire.
// The runtime resolves it exactly once per connection at open, before the
// app's open hook, so open/message hooks and the bundled plugins all read
// one settled answer for the connection's whole life.
//
// The id rule is shared with the svelte-realtime tenant resolver on purpose:
// `[a-zA-Z0-9_-]`, 1..64 chars. That charset excludes the NUL byte, so every
// downstream `id + '\0' + key` bucket key stays unambiguous, and it excludes
// `/`, so a tenant-namespaced topic prefix can never be spoofed from inside
// an id. An id outside the rule, a misshaped result, or a throwing resolver
// is FAIL-CLOSED: the caller refuses the connection rather than admitting it
// unattributed, because a silently-dropped attribution would disable every
// tenant-scoped limit downstream without a word - the exact silent
// degradation the config guards refuse everywhere else.

import { WS_ATTRIBUTION } from './ws-symbols.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ATTRIBUTION_FIELDS = Object.freeze(['tenantId', 'principalId', 'entitlement']);
const FIELD_SET = new Set(ATTRIBUTION_FIELDS);

/**
 * A loggable preview of a refused value. Strings are quoted and truncated so
 * an oversized or binary-ish value cannot flood the log line; everything else
 * is described by type only, since a non-string carries no id to show.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
	if (typeof value === 'string') {
		const shown = value.length > 64 ? value.slice(0, 64) + '...' : value;
		return JSON.stringify(shown) + (value.length > 64 ? ` (${value.length} chars)` : '');
	}
	if (value === null) return 'null';
	const type = typeof value;
	return (type === 'object' ? 'an ' : 'a ') + type;
}

/**
 * Resolve a connection's attribution through the handler module's
 * `attribution` export.
 *
 * Returns the frozen attribution object, or `null` for an unattributed
 * connection (no resolver, a null/undefined result, or a result with every
 * field absent). THROWS on anything else - a throwing resolver propagates,
 * and a misshaped result raises a TypeError naming the field and the rule -
 * so the caller's catch is the single fail-closed refusal point.
 *
 * A thenable result throws too: the open callback is synchronous, so an
 * async resolver could only ever be resolved after the hooks that need the
 * answer already ran. Refusing it loudly beats racing it.
 *
 * @param {unknown} hook - the handler module's `attribution` export
 * @param {any} user - the connection's userData (`ws.getUserData()`)
 * @returns {Readonly<{ tenantId?: string, principalId?: string, entitlement?: string }> | null}
 */
export function resolveAttribution(hook, user) {
	if (hook === undefined || hook === null) return null;
	// A DEFINED non-function export refuses instead of reading as "no
	// resolver": `export const attribution = { tenantId: 'acme' }` - the
	// object where the resolver belongs - would otherwise leave every
	// connection silently unattributed and stand down every tenant-scoped
	// limit downstream without a word.
	if (typeof hook !== 'function') {
		throw new TypeError(
			`the attribution export must be a function (user) => { tenantId?, principalId?, entitlement? }; got ${describeValue(hook)}`
		);
	}
	const result = hook(user);
	if (result === null || result === undefined) return null;
	if (typeof result !== 'object' || Array.isArray(result)) {
		throw new TypeError(
			`attribution must return { tenantId?, principalId?, entitlement? } or null; got ${describeValue(result)}`
		);
	}
	if (typeof (/** @type {any} */ (result).then) === 'function') {
		throw new TypeError(
			'attribution must be synchronous: it is resolved inside the open callback, ' +
			'before the open hook and every limiter can read it. Resolve identity in the ' +
			'(async-capable) upgrade hook and derive the attribution from userData here.'
		);
	}
	// An unknown key is refused rather than skipped: `tenantid` silently
	// meaning "unattributed" is the degradation this contract exists to end.
	for (const key of Object.keys(result)) {
		if (!FIELD_SET.has(key)) {
			throw new TypeError(
				`attribution returned unknown field "${key}"; the contract is { tenantId?, principalId?, entitlement? }`
			);
		}
	}
	/** @type {{ tenantId?: string, principalId?: string, entitlement?: string }} */
	const out = {};
	let present = false;
	for (const field of ATTRIBUTION_FIELDS) {
		const value = /** @type {any} */ (result)[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== 'string' || !VALID_ID.test(value)) {
			throw new TypeError(
				`attribution.${field} must be a string of [a-zA-Z0-9_-], 1-64 chars; got ${describeValue(value)}`
			);
		}
		out[field] = value;
		present = true;
	}
	if (!present) return null;
	return Object.freeze(out);
}

/**
 * Resolve and stamp a connection's attribution onto its userData slot.
 * Returns what was stamped (`null` leaves the slot absent, so the common
 * unattributed connection never grows a property). Throws exactly when
 * {@link resolveAttribution} does; the surface catches, reports, and closes.
 *
 * @param {unknown} hook - the handler module's `attribution` export
 * @param {any} userData - the connection's userData object
 * @returns {Readonly<{ tenantId?: string, principalId?: string, entitlement?: string }> | null}
 */
export function installAttribution(hook, userData) {
	const resolved = resolveAttribution(hook, userData);
	if (resolved !== null) userData[WS_ATTRIBUTION] = resolved;
	return resolved;
}

/**
 * Read a live connection's server-resolved attribution.
 *
 * Returns the frozen `{ tenantId?, principalId?, entitlement? }` object the
 * runtime resolved at open, or `null` for an unattributed connection or a
 * handle whose native side already closed. This is the one supported read:
 * app server code and plugins take the settled per-connection answer here
 * instead of re-running a resolver per call.
 *
 * @param {{ getUserData(): unknown }} ws
 * @returns {Readonly<{ tenantId?: string, principalId?: string, entitlement?: string }> | null}
 */
export function attribution(ws) {
	try {
		return /** @type {any} */ (ws.getUserData())?.[WS_ATTRIBUTION] ?? null;
	} catch {
		return null;
	}
}
