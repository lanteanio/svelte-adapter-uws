/**
 * Presence plugin for svelte-adapter-uws.
 *
 * Tracks which users are connected to which topics and provides live
 * presence lists. Handles multi-tab dedup (same user, multiple connections
 * = one presence entry) via a configurable key field.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * uses ws.subscribe(), platform.publish(), and platform.send().
 *
 * MULTI-TENANT NOTE
 * In a single-process deployment running multiple tenants, the plugin's
 * `Map<topic, ...>` state is keyed by the topic name verbatim. Two
 * tenants whose UI happens to share a room name (`'lobby'`, `'support'`,
 * `'chat-1'`) will collide on the SAME map entry: tenant A's roster
 * includes tenant B's members and vice versa. The fix is at the call
 * site - prefix room/topic names with a tenant scope before passing
 * them to `presence.join` / `presence.list`:
 *
 *     presence.join(ws, 'org-' + ctx.user.tenantId + ':lobby', platform);
 *     presence.list('org-' + ctx.user.tenantId + ':lobby');
 *
 * Same recommendation for `groups`, `replay`, and `cursor` plugins.
 * Live.room consumers can lift this into their `topic: (ctx, room) =>
 * 'org-' + ctx.user.tenantId + ':' + room` factory once and forget it.
 *
 * @module svelte-adapter-uws/plugins/presence
 */

const TOPIC_PREFIX = '__presence:';

// The roster tap is a DERIVED subscription: it is deliberately kept alive
// across a participant leave (so a co-resident observer's roster does not
// freeze) and released only on socket close. Declaring the prefix is what makes
// `platform.unsubscribe(ws, topic)` release it too, so a kick, ban or lease
// expiry stops the roster and its live diffs instead of leaving the revoked
// client subscribed to the channel the revocation was about.
registerDerivedTopicPrefix(TOPIC_PREFIX);

import { encodePresence, PRESENCE_CAPABILITY, PRESENCE_SCHEMA_VERSION } from './codec.js';
import { setTimer, clearTimer, setIntervalTimer, clearIntervalTimer } from '../../runtime/runtime.js';
import { trackedSubscribe, trackedUnsubscribe, registerDerivedTopicPrefix, markSideEffectHooks, authorizeDerivedSubscribe } from '../../runtime/utils.js';
import { isSensitiveFieldName, isStructurallyUnsafeFieldName, MAX_PROJECTION_DEPTH, exceedsDepth, isUnsafeProjectionFieldName } from '../_shared/sensitive.js';

/**
 * @typedef {Object} PresenceOptions
 * @property {string} [key='id'] - Field in the selected data that uniquely identifies a user.
 *   Used for multi-tab dedup: if two connections share the same key value, they count as one
 *   presence entry. If the field is missing from the data, each connection is tracked separately.
 * @property {(userData: any) => Record<string, any>} [select] - Function to extract the public
 *   presence data from the connection's userData (whatever your `upgrade` handler returned).
 *   Only the selected fields are broadcast to other clients. By default the
 *   projection copies only the configured `key` field, and only when its name
 *   is structurally safe and its value is a string or finite number. Display
 *   names, profiles, transport metadata and every other field require an
 *   explicit `select` allowlist.
 *
 *   The sensitive-name guard applies to the `key` field too, with no exemption: the
 *   resolved dedup key is broadcast as the roster key in every frame, so a
 *   credential-shaped one must not survive. Nominating `key: 'sessionId'`
 *   logs a warning at construction and falls back to per-connection entries
 *   (no multi-tab dedup) rather than publishing the value - dedup on a
 *   non-secret identifier, or pass an explicit `select` if the field really
 *   is one.
 *
 *   Cursor follows the same fail-closed rule, with `id` as its sole default
 *   identity field.
 *   An explicit selector is an application-owned policy override and its
 *   return value is used as-is. Prefer an allowlist such as
 *   `select: (ud) => ({ id: ud.id, name: ud.name })`.
 *
 *   Should return JSON-serializable data (plain objects, arrays, strings, numbers,
 *   booleans, null) since the result is sent over WebSocket.
 * @property {number} [heartbeat=30000] - Interval in milliseconds between heartbeat broadcasts.
 *   The server periodically publishes a `heartbeat` event to all presence topics carrying a
 *   `{userKey: data}` map of every active user. This refreshes each entry's `maxAge` timer on
 *   the client AND re-adds any entry the client swept while the user was still present, so
 *   live users do not flicker out when a `diff` is missed (e.g. transient network
 *   blip, JS thread saturation). Set this to a value shorter than the client's `maxAge`
 *   (default client `maxAge` is 90 s, so 30 s gives a 3x safety margin). Pass `0` to disable
 *   heartbeats entirely - which is not only a traffic decision. Presence diffs carry no
 *   sequence, so nothing else re-establishes a roster mid-session: with `0`, a missed `join`
 *   or `leave` diverges silently until the client rejoins, and against a client still running
 *   the default `maxAge` sweep the roster empties on its own about 135 s after the last diff,
 *   with no dropped frame involved. The opt-out is only complete when clients also pass
 *   `maxAge: 0` to `presence()`; the constructor warns once when it sees `heartbeat: 0`.
 * @property {boolean} [binary=true] - When true (the default), presence frames go
 *   to binary-capable clients as compact `0x03` frames via the presence codec and
 *   to everyone else as the identical JSON frames; fully transparent. Set `false`
 *   to force JSON for every client (e.g. to compare wire sizes, or on a platform
 *   whose `publishWire`/`sendWire` you do not want exercised). The codec is
 *   stateless - a roster frame is encoded once and fanned out to all subscribers.
 * @property {string[]} [transient] - Dynamic field names (set via `update()`)
 *   that are broadcast live but NEVER included in the `state` snapshot or the
 *   heartbeat roster. A (re)joining or swept-then-readded client therefore never
 *   inherits a possibly-stale transient value - a disconnected typer leaves no
 *   stuck indicator. Typical: `['typing', 'selection']`. Identity fields (from
 *   `select`) and durable `update()` fields not listed here ride the snapshot
 *   normally. Default: none (every `update()` field is durable).
 * @property {number} [topicThrottle=16] - Minimum gap in milliseconds between
 *   two diff publishes for a topic. The byte caps bound how much state one user
 *   can retain; this bounds how often it is re-broadcast, which is the other
 *   half of the same amplification. The 16 ms default caps a topic at roughly
 *   60 diff publishes per second and matches the cursor plugin's option of the
 *   same name. Pass `0` to retain the old next-tick-only coalescing.
 * @property {number} [maxFieldsBytes=8192] - Maximum serialized size of one
 *   `update()` fields blob. An over-cap (or unserializable) update is silently
 *   dropped, mirroring the cursor plugin's `maxDataBytes`. Legitimate presence
 *   fields are small (a typing flag, a selection range), so the default is
 *   never reached in practice.
 * @property {number} [maxTotalFieldsBytes=65536] - Cumulative serialized-size
 *   budget for one user's durable `update()` fields on a topic. Durable fields
 *   ride every future `state` snapshot and heartbeat, so the per-frame cap
 *   alone would still let a client accumulate unbounded stored state one small
 *   frame at a time. An update that would exceed the budget is dropped whole
 *   (no partial merge).
 * @property {number} [maxTopicsPerConnection=100] - Maximum presence topics
 *   tracked for one connection. Together with `maxTotalFieldsBytes`, this caps
 *   one connection's retained dynamic-field footprint at about 6.25 MiB by
 *   default instead of allowing the global one-million-topic registry limit to
 *   multiply the per-entry budget. A join beyond the cap is a silent no-op.
 * @property {string[]} [clientUpdateFields] - Allowlist for field names accepted
 *   from wire `presence-update` frames. Unset (the default), client frames may
 *   not add any dynamic fields. Set it to accept only the listed names. Direct
 *   server calls to `update()` retain the reserved-name guard; when this option
 *   is set, the same allowlist also applies to direct calls.
 */

/**
 * @typedef {Object} PresenceTracker
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} join -
 *   Add a connection to a topic's presence. Call this from your `subscribe` hook.
 *   Automatically ignores `__`-prefixed internal topics. Idempotent.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} leave -
 *   Remove a connection from all topics. Call this from your `close` hook.
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} sync -
 *   Send the current presence list to a single connection without joining.
 *   Use this for admin dashboards or observers who want to see presence
 *   without being present themselves.
 * @property {(ws: any, topic: string, fields: Record<string, any>, platform: import('../../index.js').Platform) => void} update -
 *   Set dynamic fields on the present user (typing, selection, a lock map), as a
 *   field-level delta: only fields whose value changed are merged into the user
 *   and broadcast in the next `diff` under `updates[key]`. The update applies to
 *   the user (per dedup key), so any of a multi-tab user's connections may call
 *   it. A connection that is not present on the topic is a silent no-op. Fields
 *   named in the `transient` option are broadcast live but excluded from the
 *   snapshot. Server-reserved field names (identity / credential-shaped; see the
 *   `clientUpdateFields` option) are stripped, and the whole update is dropped
 *   when it exceeds `maxFieldsBytes` or the user's `maxTotalFieldsBytes` budget.
 *   No-op if no field actually changed.
 * @property {(topic: string) => Record<string, any>[]} list -
 *   Get the current presence list for a topic. Use in load() functions or API routes.
 *   Each entry is the same shape the `state` snapshot puts on the wire: the
 *   identity from `select` plus the durable `update()` fields, minus anything
 *   named in `transient` - so an SSR render and the client's first WebSocket
 *   snapshot agree. Returns deep copies (via structuredClone) when data is
 *   JSON-serializable. Falls back to shared references for non-cloneable data.
 * @property {(topic: string) => number} count -
 *   Get the number of unique users present on a topic.
 * @property {() => void} clear -
 *   Clear all presence tracking state.
 * @property {{ subscribe: Function, unsubscribe: Function, close: Function }} hooks -
 *   Ready-made WebSocket hooks. subscribe handles join, unsubscribe removes
 *   from a single topic, close removes from all topics.
 */

/**
 * Create a presence tracker.
 *
 * @param {PresenceOptions} [options]
 * @returns {PresenceTracker}
 *
 * @example
 * ```js
 * // src/lib/server/presence.js
 * import { createPresence } from 'svelte-adapter-uws/plugins/presence';
 *
 * export const presence = createPresence({
 *   key: 'id',
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - zero-config (just spread hooks)
 * import { presence } from '$lib/server/presence';
 *
 * export const { subscribe, unsubscribe, close } = presence.hooks;
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - with custom logic
 * import { presence } from '$lib/server/presence';
 *
 * export function subscribe(ws, topic, ctx) {
 *   if (topic === 'vip' && !ws.getUserData().isVip) return false;
 *   presence.hooks.subscribe(ws, topic, ctx);
 * }
 *
 * export const { unsubscribe, close } = presence.hooks;
 * ```
 *
 * @example
 * ```js
 * // +page.server.js - server-side presence for SSR
 * import { presence } from '$lib/server/presence';
 *
 * export async function load() {
 *   return { users: presence.list('room'), online: presence.count('room') };
 * }
 * ```
 */

/**
 * Recursion budget for deepEqual. A presence field nested thousands of
 * levels deep (a hostile `presence-update` frame - the plugin's own
 * JSON.parse path has no depth limit) would otherwise blow the stack with a
 * RangeError out of the message hook. A few hundred levels is generous for
 * presence data (a typing flag, a selection range, a lock map).
 */
const DEEP_EQUAL_MAX_DEPTH = 256;

/**
 * Per-field JSON framing charged against `maxTotalFieldsBytes` alongside the
 * name and value: the colon and the comma separating this field from the next.
 * Without it the budget bounds the values but not the serialized entry, which
 * is what actually rides every snapshot and heartbeat.
 *
 * Two rather than four because the name is charged as `JSON.stringify(name)`,
 * which already includes the surrounding quotes - and, more importantly, the
 * ESCAPING. Charging the raw name under-counted by up to six times: a control
 * character is one byte raw and six once serialized (U+0001 becomes a six-byte
 * escape), and the serialized form is what lands in every frame. A name made
 * of them bought roughly six times the documented budget in retained state.
 */
const JSON_FIELD_OVERHEAD_BYTES = 2;

/**
 * Set once the `heartbeat: 0` pairing warning has been printed. Process-wide
 * rather than per-instance: an app that turns the heartbeat off usually does it
 * for every presence instance it builds, and the message is the same each time.
 */
let heartbeatOptOutWarned = false;

/**
 * Deep equality check for presence data.
 * Handles plain objects, arrays, Date, and primitives. Set and Map are
 * compared by membership/entries but only reliably for primitive members
 * and primitive keys (object members use identity via has()).
 * Cycle-safe via pair tracking: if the same (a, b) pair is encountered
 * again during recursion, it is assumed equal (co-inductive equality).
 * Shared subobjects are handled correctly - the same object appearing
 * in multiple fields does not trigger false positives.
 * Depth-capped (DEEP_EQUAL_MAX_DEPTH): past the cap the check stops
 * recursing and reports UNEQUAL rather than throwing - the safe direction,
 * since "changed" just stores and broadcasts the new value.
 * @param {any} a
 * @param {any} b
 * @param {Map<any, Set<any>>} [seen]
 * @param {number} [depth]
 * @returns {boolean}
 */
function deepEqual(a, b, seen, depth) {
	if (a === b) return true;
	if (a == null || b == null || typeof a !== typeof b) return false;
	if (typeof a !== 'object') return false;

	depth = (depth || 0) + 1;
	if (depth > DEEP_EQUAL_MAX_DEPTH) {
		// Past the cap, fall back to a serialized comparison rather than
		// reporting UNEQUAL. Reporting unequal looks like the safe direction
		// but is not: an unchanged deep value would then re-broadcast on every
		// frame at zero byte-budget cost (the delta is 0), handing a client an
		// O(subscribers) fan-out it can repeat forever with an identical
		// payload - exactly the amplification the field-level delta prevents.
		// Anything deep enough to blow the stack here was already rejected by
		// the JSON.stringify size check update() runs before change detection.
		try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
	}

	if (!seen) seen = new Map();
	const seenB = seen.get(a);
	if (seenB && seenB.has(b)) return true;
	if (!seenB) seen.set(a, new Set([b]));
	else seenB.add(b);

	if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
	if (b instanceof Date) return false;

	if (a instanceof Set) {
		if (!(b instanceof Set) || a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	}
	if (b instanceof Set) return false;

	if (a instanceof Map) {
		if (!(b instanceof Map) || a.size !== b.size) return false;
		for (const [k, v] of a) {
			if (!b.has(k) || !deepEqual(b.get(k), v, seen, depth)) return false;
		}
		return true;
	}
	if (b instanceof Map) return false;

	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i], seen, depth)) return false;
		}
		return true;
	}
	if (Array.isArray(b)) return false;

	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const k of keysA) {
		if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], seen, depth)) return false;
	}
	return true;
}

/**
 * Build the fail-closed default selector for one tracker. Only the configured
 * dedup key is copied, and only when the field name is safe and its value is a
 * stable JSON scalar (string or finite number). Every display/profile field
 * requires an explicit application allowlist.
 *
 * @param {string} keyField
 * @returns {(obj: unknown) => Record<string, string | number>}
 */
function makeDefaultPresenceSelect(keyField) {
	return function defaultPresenceSelect(obj) {
		const selected = {};
		if (
			!obj ||
			typeof obj !== 'object' ||
			isSensitiveFieldName(keyField) ||
			isStructurallyUnsafeFieldName(keyField)
		) return selected;

		let value;
		try {
			if (!Object.prototype.hasOwnProperty.call(obj, keyField)) return selected;
			value = obj[keyField];
		} catch {
			return selected;
		}
		if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
			return selected;
		}
		Object.defineProperty(selected, keyField, {
			value,
			enumerable: true,
			configurable: true,
			writable: true
		});
		return selected;
	};
}

export function createPresence(options = {}) {
	const keyField = options.key || 'id';
	const select = options.select || makeDefaultPresenceSelect(keyField);

	// A credential-shaped dedup key cannot work with the default projection,
	// and must not be made to: the resolved key becomes the roster map key in
	// every wire frame, so honouring `key: 'sessionId'` would broadcast the
	// session token to every peer. The field is dropped, dedup falls back to
	// the per-connection key, and the app is TOLD - silently losing multi-tab
	// dedup is what made this hard to diagnose before.
	if (!options.select && (isSensitiveFieldName(keyField) || isStructurallyUnsafeFieldName(keyField))) {
		console.warn(
			`[svelte-adapter-uws] presence: key field '${keyField}' is credential-shaped, so the default select() drops it ` +
			'and each connection gets its own presence entry (no multi-tab dedup). The dedup key is ' +
			'broadcast as the roster key, so it must not be a secret: dedup on a non-secret identifier ' +
			`(e.g. a user id), or pass an explicit select() that returns '${keyField}' if it really is one.`
		);
	}
	// Default 30 s heartbeat keeps the client's `maxAge` sweep self-healing:
	// a still-present user re-appears on the next heartbeat after their
	// entry ages out of the local map. Apps that want zero heartbeat
	// traffic (no `maxAge` consumers, or out-of-band liveness) pass
	// `heartbeat: 0` explicitly to opt out.
	const heartbeatMs = options.heartbeat ?? 30000;
	if (typeof heartbeatMs !== 'number' || !Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
		throw new Error('presence: heartbeat must be a non-negative number');
	}
	// `heartbeat: 0` is only half a decision, and the other half lives on the
	// client where this constructor cannot see it. Diffs carry no sequence, so
	// the heartbeat is both the refresh that holds an entry inside the client's
	// `maxAge` window and the only thing that re-adds one the sweep removed.
	// Turned off against a default client, a room where nobody joins, leaves or
	// updates empties itself within one sweep past the window - no dropped frame
	// required - and nothing restores it until that client reconnects. Paired
	// with `maxAge: 0` it is sound: nothing decays, and a dropped diff is simply
	// permanent. Warn once per process rather than per instance, and say which
	// client option completes the pair.
	if (heartbeatMs === 0 && !heartbeatOptOutWarned) {
		heartbeatOptOutWarned = true;
		console.warn(
			'[svelte-adapter-uws] presence: heartbeat: 0 removes the periodic full-roster broadcast, which is the ' +
			"only thing that refreshes a client's maxAge window and the only thing that re-adds an entry its sweep " +
			'removed. Clients on the default 90 s maxAge will empty their rosters roughly 135 s after the last diff. ' +
			'Pass maxAge: 0 to presence() on the client to complete the opt-out, or keep a heartbeat shorter than ' +
			'a third of the client maxAge.'
		);
	}
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;
	const maxTopicsPerConnection = options.maxTopicsPerConnection ?? 100;

	if (!Number.isInteger(maxConnections) || maxConnections < 1) {
		throw new Error('presence: maxConnections must be a positive integer');
	}
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error('presence: maxTopics must be a positive integer');
	}
	if (!Number.isInteger(maxTopicsPerConnection) || maxTopicsPerConnection < 1) {
		throw new Error('presence: maxTopicsPerConnection must be a positive integer');
	}

	// update() ingress bounds. The per-frame byte cap mirrors the cursor
	// plugin's maxDataBytes (same default, same drop-don't-throw behavior):
	// legitimate presence fields are small (a typing flag, a selection range),
	// so 8 KB is never reached in practice. The cumulative per-entry budget
	// bounds what one user can ACCUMULATE across many under-cap frames -
	// durable fields ride every future state snapshot and heartbeat, so the
	// per-frame cap alone would still allow unbounded stored state (and
	// unbounded snapshot fan-out) one small frame at a time. 64 KB gives
	// headroom for several distinct fields (8x the per-frame cap) while
	// keeping the snapshot bloat a single entry can cause tightly bounded.
	const maxFieldsBytes = options.maxFieldsBytes ?? 8192;
	const maxTotalFieldsBytes = options.maxTotalFieldsBytes ?? 65536;
	// Lower bound on the gap between two diff publishes for a topic. The byte
	// caps above bound how much state one user can retain; this bounds how OFTEN
	// that state is re-broadcast, which is the other half of the same
	// amplification - a client sending tick-separated updates otherwise produces
	// one topic-wide publish each, times every subscriber. Passing 0 keeps the
	// long-standing behaviour exactly (coalesce within one event-loop iteration
	// and publish on the next). The secure default matches cursor: roughly one
	// topic-wide publish per display frame. Apps that need the former next-tick
	// latency can opt out explicitly with 0.
	const topicThrottle = options.topicThrottle ?? 16;

	if (!Number.isInteger(maxFieldsBytes) || maxFieldsBytes < 1) {
		throw new Error('presence: maxFieldsBytes must be a positive integer');
	}
	if (!Number.isInteger(maxTotalFieldsBytes) || maxTotalFieldsBytes < 1) {
		throw new Error('presence: maxTotalFieldsBytes must be a positive integer');
	}
	if (typeof topicThrottle !== 'number' || !Number.isFinite(topicThrottle) || topicThrottle < 0) {
		throw new Error('presence: topicThrottle must be a non-negative number');
	}

	// Wire presence-update frames are fail closed: without an explicit
	// allowlist they cannot add durable or transient fields. Direct server calls
	// retain the reserved-name guard for compatibility. When configured, the
	// allowlist applies to both paths and is the deliberate escape hatch for an
	// app that accepts a client-owned display field such as `role`.
	if (options.clientUpdateFields !== undefined && !Array.isArray(options.clientUpdateFields)) {
		// A bare string is the obvious typo. Silently treating it as the omitted
		// fail-closed default would make the requested client update disappear,
		// so this stays loud like every other malformed option here.
		throw new Error('presence: clientUpdateFields must be an array of field names');
	}
	const clientUpdateFields = Array.isArray(options.clientUpdateFields)
		? new Set(options.clientUpdateFields.filter((f) => typeof f === 'string'))
		: null;
	// The allowlist is an escape hatch for identity-ish names an app really
	// does let clients write (a display `role`). It is NOT a way to opt into
	// the prototype gadgets: those must never become properties of a wire
	// object, whatever the app asked for.
	if (clientUpdateFields) {
		for (const gadget of ['__proto__', 'constructor', 'prototype']) {
			clientUpdateFields.delete(gadget);
		}
	}

	// A trusted direct `presence.update(ws, topic, { role })` is still subject
	// to the historical reserved-name guard. Say so once per finite reserved
	// name outside production, so an intentional server-owned field is easy to
	// diagnose and opt into.
	//
	// Deliberately limited to the FINITE reserved names. The credential-shaped
	// and `__`-prefixed rules match an unbounded name space, so warning on
	// those would let a hostile client mint `aaaToken`, `bbbToken`, ... and
	// drive both an unbounded log and an unbounded dedup set from the wire.
	// They are also the names a server would never set on purpose, so a
	// warning there has no DX value to trade for that risk.
	// Compared on the FOLDED name, matching how isReservedField refuses. The
	// refusal case-folds and de-punctuates; this set did not, so exactly the
	// spellings the fold was widened to catch - `ID`, `Role`, `userId`,
	// `user_id`, `roles` - were refused in silence. The newly-refused names were
	// the only ones an app could not already see coming.
	const foldName = /** @param {string} k */ (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, '');
	const WARNABLE_RESERVED = new Set(
		[keyField, 'id', 'userId', 'role', 'roles', 'userRole', 'constructor', 'prototype'].map(foldName)
	);
	const warnedReservedFields = new Set();
	const warnOnReservedField = process.env.NODE_ENV === 'production'
		? null
		: /** @param {string} k */ (k) => {
			if (!WARNABLE_RESERVED.has(foldName(k)) || warnedReservedFields.has(k)) return;
			warnedReservedFields.add(k);
			console.warn(
				`[svelte-adapter-uws] presence.update(): field '${k}' is reserved and was dropped. ` +
				'Reserved names are the dedup key field, id, role, __-prefixed, ' +
				'constructor/prototype and credential-shaped names, so a client ' +
				'cannot overwrite the identity its peers see. If this call is ' +
				`server-owned and intentional, pass clientUpdateFields: ['${k}', ...] ` +
				'to replace the guard with an explicit allowlist.'
			);
		};

	/**
	 * Field names a direct update() may not write by default:
	 * the identity the server's own `select` produced (the dedup key field,
	 * `id`, `role` - a client-written value would impersonate it to peers),
	 * anything the default denylist treats as credential-shaped, and the
	 * `__`-prefixed / prototype-gadget names that must never become
	 * wire-object properties. A configured `clientUpdateFields` allowlist
	 * replaces this guard for direct calls and independently gates wire calls.
	 * @param {string} k
	 */
	function isReservedField(k) {
		// No keyField exemption here, unlike the default `select`: the select
		// projects what the SERVER already established, while update() writes
		// what a client asked for - the dedup key is precisely the field a
		// client must not be able to rewrite.
		//
		// Compared with separators removed and case folded, which the transport
		// half of the denylist already does and this half did not. The exact
		// comparison refused `id` and `role` while admitting `ID`, `Id`, `Role`,
		// `ROLE`, `userId` and `user_id` - so a client could not overwrite the
		// identity its peers see, but could plant a confusable one BESIDE it,
		// which spoofs any client rendering `entry.userId ?? entry.id`.
		const folded = k.toLowerCase().replace(/[^a-z0-9]+/g, '');
		return (
			folded === keyField.toLowerCase().replace(/[^a-z0-9]+/g, '') ||
			folded === 'id' ||
			folded === 'userid' ||
			folded === 'role' ||
			folded === 'roles' ||
			folded === 'userrole' ||
			// MEMOISED in the shared predicate: direct update paths may reuse the
			// same dynamic field names at high frequency.
			isUnsafeProjectionFieldName(k)
		);
	}

	// Binary wire is on by default and fully transparent: a binary-capable client
	// receives compact `0x03` presence frames, everyone else (and any platform
	// without the publishWire/sendWire methods, e.g. the unit-test mock) receives
	// the identical JSON frames. `binary: false` forces JSON for everyone. The
	// codec is stateless: a roster frame is encoded once and fanned out to all
	// subscribers (the foundation's encode-once-send-many), the right trade for
	// presence's infrequent-but-full-roster broadcasts.
	const wireCodec = createPresenceWireCodec(options);

	// The platform reaches this plugin only per call (emit/emitTo receive it), never
	// at construction, so the codec is registered with the platform's wire-codec
	// registry lazily on first wire use. That lets the cross-worker relay re-derive
	// the codec and re-encode presence binary for subscribers on other workers,
	// instead of degrading them to JSON. One registration per platform; a no-op on a
	// platform without the registry (the unit-test mock) or when binary is off.
	let wireCodecRegistered = false;
	function registerWireCodecOnce(platform) {
		if (wireCodecRegistered || !wireCodec) return;
		if (typeof platform.registerWireCodec === 'function') {
			platform.registerWireCodec(wireCodec);
			wireCodecRegistered = true;
		}
	}

	// Fields tagged transient are broadcast live (in `update` diffs to the
	// subscribers connected at the moment they change) but are EXCLUDED from the
	// `state` snapshot and the heartbeat roster, so a (re)joining or
	// swept-then-readded client never inherits a possibly-stale transient value -
	// a disconnected typer leaves no stuck indicator. Identity fields (from
	// `select`) are unaffected. Dynamic fields set via `update()` that are NOT
	// tagged transient are durable and ride the snapshot like identity fields.
	const transientFields = new Set(
		Array.isArray(options.transient)
			? options.transient.filter((f) => typeof f === 'string')
			: []
	);

	/**
	 * The public presence value for a user: the identity `data` (from `select`)
	 * merged with the user's durable dynamic `fields` (from `update()`), with
	 * transient fields stripped. Used by every snapshot-shaped path (`state`,
	 * heartbeat, the `join` roster at flush) so a (re)joiner never sees a
	 * transient value. The no-`fields` user (the overwhelming common case)
	 * returns `entry.data` with zero copy.
	 * @param {{ data: Record<string, any>, fields: Record<string, any> | null }} entry
	 * @returns {Record<string, any>}
	 */
	function publicData(entry) {
		if (!entry.fields) return entry.data;
		const out = { ...entry.data };
		for (const k of Object.keys(entry.fields)) {
			if (transientFields.has(k)) continue;
			// Defence in depth: the field names reaching here are already
			// gadget-free (update() refuses them and the clientUpdateFields
			// allowlist cannot re-admit them), but this object becomes a wire
			// frame, and a plain assignment of a '__proto__' key would hit the
			// inherited setter - swapping the frame's prototype and dropping
			// the field instead of sending it. Same treatment the roster
			// accumulators get.
			if (k === '__proto__') {
				Object.defineProperty(out, k, { value: entry.fields[k], enumerable: true, writable: true, configurable: true });
			} else {
				out[k] = entry.fields[k];
			}
		}
		return out;
	}

	/**
	 * Broadcast a presence wire event. Routes through the binary `publishWire`
	 * path when a codec is configured AND the platform supports it (production /
	 * dev / test-server); otherwise falls back to the JSON `publish` - so the
	 * unit-test mock platform and `binary: false` both keep the exact JSON shape.
	 * @param {string} fullTopic - the channel name, already TOPIC_PREFIX-scoped
	 * @param {string} event
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function emit(fullTopic, event, data, platform) {
		// `seq: false` declares this lane's ordering contract to the cluster
		// sequence guard: presence broadcasts are roster snapshots and diffs
		// whose consistency is re-established by the state snapshot on join,
		// so they make no monotonic promise and must not consume per-worker
		// topic counters that would fork across a multi-worker relay.
		if (wireCodec && typeof platform.publishWire === 'function') {
			registerWireCodecOnce(platform);
			// Presence frames are low-frequency (a diff on join/leave; one heartbeat
			// per interval), so opting into permessage-deflate is a cheap bandwidth
			// win - the opposite of the 60 Hz cursor hot path, which stays
			// uncompressed. No-op unless a compressor is configured.
			platform.publishWire(fullTopic, event, data, wireCodec, { compress: true, seq: false });
		} else {
			platform.publish(fullTopic, event, data, { seq: false });
		}
	}

	/**
	 * Single-target variant of {@link emit} (the `state` snapshot).
	 * @param {any} ws
	 * @param {string} fullTopic
	 * @param {string} event
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function emitTo(ws, fullTopic, event, data, platform) {
		if (wireCodec && typeof platform.sendWire === 'function') {
			registerWireCodecOnce(platform);
			platform.sendWire(ws, fullTopic, event, data, wireCodec, { compress: true });
		} else {
			platform.send(ws, fullTopic, event, data);
		}
	}

	// Auto-generated ID counter for connections without a key field
	let connCounter = 0;

	/**
	 * Platform reference, captured on first use of join/leave/sync.
	 * Needed by the heartbeat timer to publish without a hook context.
	 * @type {import('../../index.js').Platform | null}
	 */
	let _platform = null;

	/** @type {ReturnType<typeof setInterval> | null} */
	let heartbeatTimer = null;

	/**
	 * Per-connection state: which topics they've joined and their key on each.
	 * @type {Map<any, Map<string, { key: string, data: Record<string, any> }>>}
	 */
	const wsTopics = new Map();

	/**
	 * Per-topic presence: Map<key, { data, fields, fieldsBytes, count }>.
	 * count > 1 means multiple connections share the same key (multi-tab).
	 * `data` is the identity (from `select`); `fields` (lazily allocated, `null`
	 * until the first `update()`) holds the dynamic fields set via `update()`
	 * (typing, selection, locks). `publicData()` merges the two minus transient.
	 * `fieldsBytes` is the running serialized size of `fields`, enforced against
	 * the `maxTotalFieldsBytes` budget by `update()` (meaningful only once
	 * `fields` is allocated).
	 * @type {Map<string, Map<string, { data: Record<string, any>, fields: Record<string, any> | null, fieldsBytes: number, count: number }>>}
	 */
	const topicPresence = new Map();

	/**
	 * Sync-observer interest: Map<ws, Set<topic>>. A socket becomes an observer
	 * of a topic via the presence-snapshot handshake (`sync`), independently of
	 * any participant role (`join`). Tracked so a participant leaving a topic does
	 * not tear down the wire subscription a co-resident observer still needs; the
	 * observer is released on socket close. Mirrors the Redis presence variant.
	 * @type {Map<any, Set<string>>}
	 */
	const syncObservers = new Map();

	/**
	 * Per-topic pending diff buffer: latest op per key wins. Joins and leaves
	 * happening on the same key in one event-loop iteration collapse so the
	 * wire only sees the net change. Flushed once per iteration via
	 * `setTimeout(() => flushDiffs(platform), 0)` armed when the first dirty
	 * entry lands.
	 *
	 * Why `setTimeout(0)` and not `queueMicrotask`: uWS dispatches each WS
	 * message as its own JS task, and N-API drains microtasks at the C++/JS
	 * boundary between tasks. A microtask-deferred flush fires BEFORE the
	 * next socket's handler runs, so cross-socket coalescing is impossible
	 * at the microtask level - a mass-join into a populated topic produces
	 * O(N) one-entry diffs instead of one batched diff. `setTimeout(0)`
	 * lands in libuv's timers phase, which fires only after the poll phase
	 * has dispatched every ready socket message in the current iteration -
	 * so all joins arriving together end up in one flush regardless of how
	 * many task boundaries separate them. Same structural choice the
	 * 0.5.6 cursor always-tick rewrite locked in.
	 *
	 * Per-key entry shape by op (latest net change per key per flush):
	 *   join   -> { op: 'join' }            - flush reads the live `publicData`
	 *   leave  -> { op: 'leave', data }     - entry is gone by flush, so the
	 *                                          leave roster value is snapshotted
	 *   update -> { op: 'update', changed } - accumulated changed dynamic fields
	 * @type {Map<string, Map<string, { op: 'join' | 'leave' | 'update', data?: Record<string, any>, changed?: Record<string, any> }>>}
	 */
	const pendingDiffs = new Map();
	/** @type {ReturnType<typeof setTimeout> | null} */
	let diffFlushTimer = null;

	/** @param {import('../../index.js').Platform} platform */
	function armDiffTimer(platform) {
		if (diffFlushTimer === null) {
			diffFlushTimer = setTimer(() => flushDiffs(platform), topicThrottle);
			if (diffFlushTimer.unref) diffFlushTimer.unref();
		}
	}

	/**
	 * Buffer a join/leave for the next flush. Latest op wins per key, so a
	 * join-then-leave (or leave-then-join) in one flush collapses to the net op.
	 * @param {string} topic
	 * @param {'join' | 'leave'} op
	 * @param {string} key
	 * @param {Record<string, any>} data - the leave roster snapshot (ignored for join, which reads live at flush)
	 * @param {import('../../index.js').Platform} platform
	 */
	function bufferDiff(topic, op, key, data, platform) {
		let entries = pendingDiffs.get(topic);
		if (!entries) {
			entries = new Map();
			pendingDiffs.set(topic, entries);
		}
		entries.set(key, op === 'leave' ? { op: 'leave', data } : { op: 'join' });
		armDiffTimer(platform);
	}

	/**
	 * Buffer a field-level update for the next flush, collapsing against any
	 * op already pending for the key:
	 *   - pending leave  -> drop (the user left this flush; the update is moot)
	 *   - pending join   -> drop (the join roster already carries the durable
	 *     fields via `publicData`; a transient change is correctly excluded)
	 *   - pending update -> accumulate the changed fields
	 * @param {string} topic
	 * @param {string} key
	 * @param {Record<string, any>} changed
	 * @param {import('../../index.js').Platform} platform
	 */
	function bufferUpdate(topic, key, changed, platform) {
		let entries = pendingDiffs.get(topic);
		if (!entries) {
			entries = new Map();
			pendingDiffs.set(topic, entries);
		}
		const prev = entries.get(key);
		if (prev) {
			if (prev.op === 'leave' || prev.op === 'join') return;
			Object.assign(prev.changed, changed);
			armDiffTimer(platform);
			return;
		}
		entries.set(key, { op: 'update', changed: { ...changed } });
		armDiffTimer(platform);
	}

	/** @param {import('../../index.js').Platform} platform */
	function flushDiffs(platform) {
		if (diffFlushTimer !== null) {
			clearTimer(diffFlushTimer);
			diffFlushTimer = null;
		}
		for (const [topic, entries] of pendingDiffs) {
			// Null-prototype roster objects: the keys are resolved dedup keys
			// (attacker-controlled strings) and this object becomes a wire
			// frame verbatim, so no key may ever reach an inherited
			// `__proto__` setter (which would silently turn the entry into
			// the object's prototype instead of an own, serializable key).
			/** @type {Record<string, Record<string, any>>} */
			const joins = Object.create(null);
			/** @type {Record<string, Record<string, any>>} */
			const leaves = Object.create(null);
			/** @type {Record<string, Record<string, any>> | null} */
			let updates = null;
			const users = topicPresence.get(topic);
			for (const [key, e] of entries) {
				if (e.op === 'join') {
					// Read the live entry so the join roster carries the latest
					// durable fields; the user is still present (a leave would have
					// superseded the join).
					const live = users && users.get(key);
					if (live) joins[key] = publicData(live);
				} else if (e.op === 'leave') {
					leaves[key] = /** @type {Record<string, any>} */ (e.data);
				} else {
					if (!updates) updates = Object.create(null);
					updates[key] = /** @type {Record<string, any>} */ (e.changed);
				}
			}
			// Keep the common diff shape `{ joins, leaves }` byte-identical when
			// no field-level update is pending, so a deployment that never calls
			// update() sees an unchanged wire (and the binary codec encodes it as
			// before). `updates` is additive: an old client ignores it.
			const diff = updates ? { joins, leaves, updates } : { joins, leaves };
			emit(TOPIC_PREFIX + topic, 'diff', diff, platform);
		}
		pendingDiffs.clear();
	}

	/**
	 * Build a state snapshot for a topic: {[key]: data}.
	 * @param {Map<string, { data: Record<string, any>, count: number }> | undefined} users
	 * @returns {Record<string, Record<string, any>>}
	 */
	function snapshotState(users) {
		/** @type {Record<string, Record<string, any>>} */
		const state = Object.create(null); // attacker-controlled keys - see flushDiffs
		if (!users) return state;
		for (const [k, entry] of users) state[k] = publicData(entry);
		return state;
	}

	/**
	 * Resolve the dedup key from selected data.
	 * Falls back to a unique connection ID if the key field is missing.
	 * @param {Record<string, any>} data
	 * @returns {string}
	 */
	function resolveKey(data) {
		if (data && keyField in data && data[keyField] != null) {
			const key = String(data[keyField]);
			// The resolved key is attacker-controlled (it stringifies whatever
			// the select produced for the key field) and lands as a property
			// name in every roster-shaped wire frame. Refuse the
			// prototype-gadget names outright - on any plain-object consumer
			// (the JSON-decoding client, an app's own merge) `__proto__` hits
			// the inherited setter instead of creating a key, which made the
			// user an invisible full participant. The connection still joins,
			// but under the per-connection fallback key: visible in every
			// roster, just not deduped with its other tabs (same as a missing
			// key field).
			if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
				return '__conn:' + (++connCounter);
			}
			return key;
		}
		return '__conn:' + (++connCounter);
	}

	/**
	 * Capture the platform reference and start the heartbeat if configured.
	 * Called lazily on first join/leave/sync - the platform object isn't
	 * available at createPresence() time.
	 * @param {import('../../index.js').Platform} platform
	 */
	function capturePlatform(platform) {
		if (_platform) return;
		_platform = platform;
		if (heartbeatMs > 0) {
			heartbeatTimer = setIntervalTimer(() => {
				for (const [topic, users] of topicPresence) {
					// Publish a `{userKey: data}` map (rather than a keys-only
					// array) so a client whose entry aged out of its local
					// `maxAge` sweep between heartbeats can re-add it from the
					// heartbeat alone, without waiting for a diff /
					// state to reconcile. Matches the Redis-backed
					// variant in svelte-adapter-uws-extensions.
					/** @type {Record<string, any>} */
					const dataMap = Object.create(null); // attacker-controlled keys - see flushDiffs
					for (const [userKey, entry] of users) dataMap[userKey] = publicData(entry);
					emit(TOPIC_PREFIX + topic, 'heartbeat', dataMap, _platform);
				}
			}, heartbeatMs);
		}
	}

	/**
	 * Remove a connection from a single topic's presence.
	 * @param {any} ws
	 * @param {string} topic
	 * @param {Map<string, { key: string, data: Record<string, any> }>} connTopics
	 * @param {import('../../index.js').Platform} platform
	 */
	function leaveTopic(ws, topic, connTopics, platform) {
		const entry = connTopics.get(topic);
		if (!entry) return;
		connTopics.delete(topic);
		if (connTopics.size === 0) wsTopics.delete(ws);

		const users = topicPresence.get(topic);
		if (!users) return;

		const existing = users.get(entry.key);
		if (!existing) return;

		existing.count--;
		if (existing.count <= 0) {
			const data = publicData(existing);
			users.delete(entry.key);
			if (users.size === 0) {
				topicPresence.delete(topic);
			}
			bufferDiff(topic, 'leave', entry.key, data, platform);
		}
		// Release the wire subscription only if this socket is not ALSO a
		// sync-observer of the topic: a participant leaving must not evict a
		// co-resident observer role (whose roster would then freeze). The observer
		// is released on socket close (see leave()).
		if (!syncObservers.get(ws)?.has(topic)) {
			trackedUnsubscribe(ws, TOPIC_PREFIX + topic);
		}
	}

	/** @type {PresenceTracker} */
	const tracker = {
		join(ws, topic, platform) {
			capturePlatform(platform);

			// Skip internal topics to prevent recursion when the subscribe
			// hook fires for __presence:* subscriptions
			if (topic.startsWith('__')) return;

			// Idempotent: skip if this ws is already on this topic
			let connTopics = wsTopics.get(ws);
			if (connTopics && connTopics.has(topic)) return;
			// A per-entry byte budget is not an aggregate bound while one socket
			// may join up to the global million-topic registry limit. Cap the
			// multiplier before select(), topic state, or a wire subscription is
			// touched. This also avoids ambiguous byte ownership for multi-tab
			// entries, whose fields are deliberately shared by every connection
			// with the same key.
			if (connTopics && connTopics.size >= maxTopicsPerConnection) return;

			// Callers typically reach here after an `await` in their own
			// join flow (auth, loader, RPC handshake). If the socket
			// closed mid-await `getUserData()` throws; presence is a
			// best-effort layer, so silently no-op rather than crash.
			let userData;
			try { userData = ws.getUserData(); } catch { return; }
			const data = select(userData);
			if (!data || typeof data !== 'object') {
				throw new TypeError(
					`presence select() must return a plain object, got ${data === null ? 'null' : typeof data}`
				);
			}
			const key = resolveKey(data);

			// Track per-connection
			if (!connTopics) {
				if (wsTopics.size >= maxConnections) {
					const oldest = wsTopics.keys().next().value;
					if (oldest !== undefined) {
						const oldestTopics = wsTopics.get(oldest);
						// Eviction must remove the topic entries too. Deleting only
						// wsTopics orphaned the selected data and durable fields in
						// topicPresence, so they kept riding every heartbeat forever
						// and could never be released by close().
						if (oldestTopics) {
							for (const oldTopic of [...oldestTopics.keys()]) {
								leaveTopic(oldest, oldTopic, oldestTopics, platform);
							}
						}
						wsTopics.delete(oldest);
					}
				}
				connTopics = new Map();
				wsTopics.set(ws, connTopics);
			}
			connTopics.set(topic, { key, data });

			// Track per-topic
			let users = topicPresence.get(topic);
			if (!users) {
				if (topicPresence.size >= maxTopics) {
					const oldest = topicPresence.keys().next().value;
					if (oldest !== undefined) topicPresence.delete(oldest);
				}
				users = new Map();
				topicPresence.set(topic, users);
			}

			const presenceTopic = TOPIC_PREFIX + topic;
			const existing = users.get(key);
			if (existing) {
				// Same user, additional connection (another tab) - bump count.
				// A data change (e.g. avatar updated in another session) becomes
				// a `join` entry in the next diff: client overwrites
				// the existing key with the new data.
				existing.count++;
				if (!deepEqual(existing.data, data)) {
					existing.data = data;
					bufferDiff(topic, 'join', key, data, platform);
				}
			} else {
				// New user on this topic - record the join in the next diff so
				// other subscribers see them appear. `fields` is lazily allocated
				// on the first update(), so a presence deployment that never calls
				// update() pays no per-user allocation.
				users.set(key, { data, fields: null, fieldsBytes: 0, count: 1 });
				bufferDiff(topic, 'join', key, data, platform);
			}

			// Subscribe this ws to the presence channel (server-side, idempotent,
			// registry-tracked so the binary publishWire walk delivers to it).
			// `platform.send` is closed-ws-safe on the adapter side; the direct
			// socket access is not - trackedSubscribe guards it.
			//
			// On failure (closed socket, or the connection is at its
			// subscription cap) roll the join back rather than returning
			// half-done: the roster entry and the join diff are already
			// staged above, so bailing here would leave the user visible to
			// every peer on a channel they will never receive.
			if (!trackedSubscribe(ws, presenceTopic)) {
				leaveTopic(ws, topic, connTopics, platform);
				return;
			}

			// Send the full current snapshot to this connection. The joining
			// user sees the complete state (including themselves) immediately;
			// any pending diff fan-out reaches them too but is idempotent on
			// the client (joins[key] = data is a no-op if already set).
			emitTo(ws, presenceTopic, 'state', snapshotState(users), platform);
		},

		leave(ws, platform) {
			capturePlatform(platform);
			const connTopics = wsTopics.get(ws);
			if (connTopics) {
				for (const [topic] of connTopics) {
					leaveTopic(ws, topic, connTopics, platform);
				}
				wsTopics.delete(ws);
			}

			// Release any sync-observer subscriptions held by this socket. leave()
			// runs on socket close, so the unsubscribe is belt-and-suspenders (uWS
			// drops a closing socket from every topic); the map entry must be
			// cleared to avoid a leak. An observer-only socket (no participant
			// topics) is handled here too.
			const observed = syncObservers.get(ws);
			if (observed) {
				for (const topic of observed) {
					trackedUnsubscribe(ws, TOPIC_PREFIX + topic);
				}
				syncObservers.delete(ws);
			}
		},

		async sync(ws, topic, platform) {
			capturePlatform(platform);
			// Client snapshot topics are application topics. Never let an
			// internal tap minted by this plugin self-authorize a second,
			// doubly-prefixed tap.
			if (typeof topic !== 'string' || topic.startsWith('__')) return;
			// Authorize against the REAL topic before granting tap-channel
			// membership: the presence-snapshot message is otherwise an
			// un-authorized path to subscribe to __presence:{topic} and read its
			// roster, around the wire-level `__`-subscribe block. Gate it on the
			// same check a wire-subscribe to `topic` would run. A Platform without
			// that method cannot prove access, so fail closed; the snapshot is
			// low-frequency (once per (re)connect) so the await is off the hot path.
			// Run under the revocation guard: a `platform.unsubscribe` landing
			// while this await is parked must cancel the tap, not be undone by it.
			if (!platform || typeof platform.checkSubscribe !== 'function') return;
			const allowed = await authorizeDerivedSubscribe(ws, topic, () =>
				platform.checkSubscribe(ws, topic, { requireGrant: true })
			);
			if (!allowed) return;
			const users = topicPresence.get(topic);
			const presenceTopic = TOPIC_PREFIX + topic;
			// Record the observer interest BEFORE subscribing so leaveTopic knows
			// the socket still wants the channel even after its participant role
			// (if any) leaves.
			let observed = syncObservers.get(ws);
			if (!observed) { observed = new Set(); syncObservers.set(ws, observed); }
			observed.add(topic);
			if (!trackedSubscribe(ws, presenceTopic)) {
				observed.delete(topic);
				if (observed.size === 0) syncObservers.delete(ws);
				return;
			}
			emitTo(ws, presenceTopic, 'state', snapshotState(users), platform);
		},

		update(ws, topic, fields, platform, fromClient = false) {
			capturePlatform(platform);
			if (topic.startsWith('__')) return;
			if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return;
			// Filter client-owned names before JSON serialization or depth walking.
			// With no allowlist this returns without touching nested values at all;
			// with one, unlisted getters and toJSON hooks remain unreachable.
			let effectiveFields = fields;
			if (fromClient) {
				if (!clientUpdateFields) return;
				effectiveFields = Object.create(null);
				let accepted = false;
				for (const k of Object.keys(fields)) {
					if (!clientUpdateFields.has(k)) continue;
					effectiveFields[k] = fields[k];
					accepted = true;
				}
				if (!accepted) return;
			}
			// Resolve the user this connection represents on the topic. A
			// connection that is not present (never joined, or the socket closed
			// mid-await) is a silent no-op - presence is best-effort. The update
			// applies to the user (per dedup key), so any of a multi-tab user's
			// connections can set the field and every observer sees one change.
			const connTopics = wsTopics.get(ws);
			const connEntry = connTopics && connTopics.get(topic);
			if (!connEntry) return;
			const users = topicPresence.get(topic);
			const entry = users && users.get(connEntry.key);
			if (!entry) return;
			// Reject an oversized or unserializable fields blob silently,
			// before any filtering or change detection. Presence is best-effort
			// fire-and-forget like cursor (whose update() caps `data` the same
			// way): a misbehaving client gets its frame dropped rather than
			// throwing into the message hook, and the byte cap keeps one
			// frame's O(subscribers) fan-out bounded.
			let fieldsBytes;
			try {
				fieldsBytes = Buffer.byteLength(JSON.stringify(effectiveFields));
			} catch {
				return;
			}
			if (fieldsBytes > maxFieldsBytes) return;
			// Depth as well as size. A nested value can sit far under the byte cap
			// and still terminate the worker on the cluster relay, whose
			// structuredClone serializer overflows about four times shallower than
			// 8 KB admits - and a worker exit is a much worse outcome than a
			// dropped frame. Rejected silently, like every other malformed update.
			if (exceedsDepth(effectiveFields, MAX_PROJECTION_DEPTH)) return;
			if (!entry.fields) {
				entry.fields = Object.create(null); // client-controlled field names - see flushDiffs
				entry.fieldsBytes = 0;
			}
			// Per-field change detection: only fields whose value actually changed
			// are merged and broadcast (the field-level delta). deepEqual so an
			// object field (a selection range) set to an equal value does not
			// spuriously re-broadcast.
			/** @type {Record<string, any>} */
			const changed = Object.create(null);
			let any = false;
			// Running serialized-size delta of this update against the per-entry
			// cumulative budget (durable fields ride every future snapshot and
			// heartbeat, so the per-frame cap alone is not enough).
			let deltaBytes = 0;
			for (const k of Object.keys(effectiveFields)) {
				// Wire updates accept nothing until the application names the
				// writable fields. Trusted direct calls keep the historical reserved
				// field guard; a configured allowlist narrows both paths.
				const refused = fromClient
					? (!clientUpdateFields || !clientUpdateFields.has(k))
					: (clientUpdateFields ? !clientUpdateFields.has(k) : isReservedField(k));
				if (refused) {
					if (warnOnReservedField) warnOnReservedField(k);
					continue;
				}
				const v = effectiveFields[k];
				if (deepEqual(entry.fields[k], v)) continue;
				let valueBytes;
				let oldBytes = 0;
				const isNewField = !Object.prototype.hasOwnProperty.call(entry.fields, k);
				try {
					valueBytes = Buffer.byteLength(JSON.stringify(v) ?? '');
					if (!isNewField) {
						oldBytes = Buffer.byteLength(JSON.stringify(entry.fields[k]) ?? '');
					}
				} catch {
					continue; // unserializable value - skip the field, keep the rest
				}
				changed[k] = v;
				// Charge the field NAME and its JSON framing ("":, plus a comma)
				// too, once, when the field first appears. Values alone are not
				// what the budget is for: a client sending long names with
				// 1-byte values stored megabytes under a 64 KB budget, and every
				// byte of that rides each future state snapshot and heartbeat -
				// the exact fan-out the cap exists to bound. Charging the framing
				// is what keeps the budget an upper bound on the SERIALIZED
				// entry rather than on the values alone.
				// The name is charged SERIALIZED, not raw: JSON.stringify escapes it,
				// and the escaped form is what is stored and re-broadcast. A raw
				// count reads a control character as one byte where the wire carries
				// six.
				deltaBytes += valueBytes - oldBytes + (isNewField ? Buffer.byteLength(JSON.stringify(k)) + JSON_FIELD_OVERHEAD_BYTES : 0);
				any = true;
			}
			if (!any) return;
			// Over the cumulative budget the WHOLE update is dropped (no
			// partial merge), so a client cannot sneak state in field-by-field
			// and the stored fields never exceed the budget.
			if (entry.fieldsBytes + deltaBytes > maxTotalFieldsBytes) return;
			for (const k of Object.keys(changed)) entry.fields[k] = changed[k];
			entry.fieldsBytes += deltaBytes;
			bufferUpdate(topic, connEntry.key, changed, platform);
		},

		list(topic) {
			const users = topicPresence.get(topic);
			if (!users) return [];
			const result = [];
			for (const [, entry] of users) {
				// publicData(), not entry.data: identity PLUS the durable
				// update() fields, minus transient - byte-identical to what
				// the `state` snapshot and the heartbeat put on the wire. A
				// load() that rendered entry.data alone produced a roster
				// without typing / selection / lock state, which the client
				// then gained the instant its WebSocket snapshot arrived.
				const data = publicData(entry);
				try { result.push(structuredClone(data)); } catch { result.push(data); }
			}
			return result;
		},

		count(topic) {
			const users = topicPresence.get(topic);
			return users ? users.size : 0;
		},

		clear() {
			if (heartbeatTimer) {
				clearIntervalTimer(heartbeatTimer);
				heartbeatTimer = null;
			}
			_platform = null;
			wsTopics.clear();
			topicPresence.clear();
			pendingDiffs.clear();
			if (diffFlushTimer !== null) {
				clearTimer(diffFlushTimer);
				diffFlushTimer = null;
			}
			connCounter = 0;
		},

		/**
		 * Drain any buffered diff publishes synchronously. Tests use this
		 * to assert on the wire output without awaiting the next-tick
		 * setTimeout flush. Production code generally does not need to call
		 * it - the tick flush happens automatically. Useful when a caller
		 * needs presence state visible to other workers before its own
		 * synchronous block returns (e.g. before responding to an HTTP
		 * request that just triggered a leave).
		 */
		flushDiffs() {
			if (diffFlushTimer === null || !_platform) return;
			flushDiffs(_platform);
		},

		// This subscribe hook is a SIDE EFFECT, never a decision: it joins the
		// roster and returns undefined on every path. Marked as such (see
		// markSideEffectHooks) because the server-grant gate steps aside whenever
		// the app exports a subscribe hook, and the documented wiring re-exports
		// this one - so arming `authorizeWireSubscribe` and following this
		// plugin's README used to disarm the gate the observer lane depends on,
		// leaving any client able to name any topic and receive its roster. The
		// hook still runs exactly as before. An app that WRAPS it in its own
		// function is not marked, and the gate steps aside as documented, because
		// that wrapper is app code which may decide.
		hooks: markSideEffectHooks({
			subscribe(ws, topic, { platform }) {
				if (topic.startsWith(TOPIC_PREFIX)) {
					tracker.sync(ws, topic.slice(TOPIC_PREFIX.length), platform);
					return;
				}
				tracker.join(ws, topic, platform);
			},
			unsubscribe(ws, topic, { platform }) {
				if (topic.startsWith('__')) return;
				const connTopics = wsTopics.get(ws);
				if (connTopics) leaveTopic(ws, topic, connTopics, platform);
			},
			message(ws, { data, msg, platform }) {
				// Client-initiated reconnect snapshot. The presence client sends
				// `{type:'presence-snapshot', topic}` on every status==='open'
				// (initial connect + reconnect); re-emit the current `state` to the
				// requesting connection via `sync` - the same path a fresh subscribe
				// takes. Without this, board-scoped presence stayed stale across a
				// reconnect: the client missed any `diff` during the disconnect
				// window and its local map kept whatever it last knew.
				//
				// The envelope reaches this hook in one of three shapes; resolve
				// all three so the snapshot fires under every wiring: the adapter's
				// direct message hook passes the parsed envelope as `msg` (raw bytes
				// in `data`); an app routing through `onUnhandled` / `onJsonMessage`
				// passes the already-parsed object as `data`; a caller may also pass
				// the raw frame bytes as `data`. Returns true when it owns the frame
				// so an app can chain it with the cursor hook through one message
				// handler. (The Redis-backed presence variant does the same
				// `sync`-on-snapshot but reads only a pre-parsed object; this hook is
				// the superset and is not drop-in identical to it.)
				let env = (msg && typeof msg === 'object') ? msg : null;
				if (!env && data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
					env = data;
				}
				if (!env) {
					try { env = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
				}
				if (env && env.type === 'presence-snapshot' && typeof env.topic === 'string') {
					tracker.sync(ws, env.topic, platform);
					return true;
				}
				if (env && env.type === 'presence-update' && typeof env.topic === 'string' && env.fields && typeof env.fields === 'object') {
					// Client-pushed field update for this connection's user on the
					// topic (a typing flag, a selection, a status). `update` self-gates
					// on membership (a connection that has not joined the topic is a
					// silent no-op) and on field shape, so an unsubscribed socket
					// cannot inject fields.
					/** @type {any} */ (tracker).update(ws, env.topic, env.fields, platform, true);
					return true;
				}
			},
			close(ws, { platform }) {
				tracker.leave(ws, platform);
			}
		}, ['subscribe'])
	};

	return tracker;
}

/**
 * Build the presence binary wire codec (`presence.protocol:1`, stateless).
 * Exported so the cluster-backed variant (`svelte-adapter-uws-extensions`
 * `redis/presence`) builds the IDENTICAL codec from one definition - no drift.
 * `null` when `binary: false` (JSON for everyone). Stateless: one encode is fanned
 * out to all subscribers (encode-once-send-many).
 * @param {{ binary?: boolean }} [options]
 */
export function createPresenceWireCodec(options = {}) {
	return options.binary === false
		? null
		: { capability: PRESENCE_CAPABILITY, schemaVersion: PRESENCE_SCHEMA_VERSION, encode: encodePresence };
}
