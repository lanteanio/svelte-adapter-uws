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

import { encodePresence, PRESENCE_CAPABILITY, PRESENCE_SCHEMA_VERSION } from './codec.js';
import { setTimer, clearTimer, setIntervalTimer, clearIntervalTimer } from '../../files/runtime.js';

/**
 * @typedef {Object} PresenceOptions
 * @property {string} [key='id'] - Field in the selected data that uniquely identifies a user.
 *   Used for multi-tab dedup: if two connections share the same key value, they count as one
 *   presence entry. If the field is missing from the data, each connection is tracked separately.
 * @property {(userData: any) => Record<string, any>} [select] - Function to extract the public
 *   presence data from the connection's userData (whatever your `upgrade` handler returned).
 *   Only the selected fields are broadcast to other clients. Defaults to a recursive
 *   denylist that drops `__`-prefixed, `constructor`, `prototype`, and any key matching
 *   `/token|secret|password|auth|session|cookie|jwt|credential/i`. Binary views (Buffer,
 *   TypedArray, DataView, ArrayBuffer) are substituted with `'[bytes: <len>]'` so raw
 *   bytes do not land in presence frames. Every other field passes through.
 *
 *   This matches the default behavior of the cluster-aware Redis presence plugin
 *   (`svelte-adapter-uws-extensions/redis/presence`), so the two surfaces broadcast
 *   the same wire shape from the same upgrade-hook userData.
 *
 *   To override:
 *   - tighter (allowlist): `select: (ud) => ({ id: ud.id, name: ud.name })`
 *   - looser (passthrough, pre-this-default behavior): `select: (ud) => ud`
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
 *   heartbeats entirely (apps that do not use the `maxAge` self-healing path).
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
 *   snapshot. No-op if no field actually changed.
 * @property {(topic: string) => Record<string, any>[]} list -
 *   Get the current presence list for a topic. Use in load() functions or API routes.
 *   Returns deep copies (via structuredClone) when data is JSON-serializable.
 *   Falls back to shared references for non-cloneable data.
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
 * Deep equality check for presence data.
 * Handles plain objects, arrays, Date, and primitives. Set and Map are
 * compared by membership/entries but only reliably for primitive members
 * and primitive keys (object members use identity via has()).
 * Cycle-safe via pair tracking: if the same (a, b) pair is encountered
 * again during recursion, it is assumed equal (co-inductive equality).
 * Shared subobjects are handled correctly - the same object appearing
 * in multiple fields does not trigger false positives.
 * @param {any} a
 * @param {any} b
 * @param {Map<any, Set<any>>} [seen]
 * @returns {boolean}
 */
function deepEqual(a, b, seen) {
	if (a === b) return true;
	if (a == null || b == null || typeof a !== typeof b) return false;
	if (typeof a !== 'object') return false;

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
			if (!b.has(k) || !deepEqual(b.get(k), v, seen)) return false;
		}
		return true;
	}
	if (b instanceof Map) return false;

	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i], seen)) return false;
		}
		return true;
	}
	if (Array.isArray(b)) return false;

	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const k of keysA) {
		if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], seen)) return false;
	}
	return true;
}

/**
 * Match userData keys that look like auth / session credentials. Used by the
 * default `select` to drop those keys before broadcast. Mirrors the regex
 * in svelte-adapter-uws-extensions/shared/sensitive.js so the in-memory and
 * Redis-backed presence plugins use the same default safety net.
 *
 * Intentionally excludes the bare substring "key" because legitimate id-like
 * fields often contain it (apiKey-id, primaryKey, etc.). For tighter control,
 * pass an explicit `select` function.
 */
const PRESENCE_SENSITIVE_RE = /token|secret|password|auth|session|cookie|jwt|credential/i;

/**
 * Default `select`: recursively drop internal-looking and credential-looking
 * keys, substitute binary views with a `'[bytes: <len>]'` placeholder, and
 * pass everything else through. Matches the denylist behavior of the Redis
 * presence plugin's default. Apps that want the old full-userData passthrough
 * back can restate it: `select: (ud) => ud`. Apps that want a tighter strict
 * allowlist pass their own: `select: (ud) => ({ id: ud.id })`.
 *
 * Cycle-safe via a per-call WeakSet so a userData object that holds a
 * back-reference to itself does not blow the stack.
 *
 * @param {unknown} obj
 * @param {WeakSet<object>} [ancestors]
 */
function defaultPresenceSelect(obj, ancestors) {
	if (!obj || typeof obj !== 'object') {
		// Primitive / null / undefined - wrap as empty plain object so the
		// downstream "must return a plain object" check passes. The plugin
		// then falls back to the auto-generated __conn:N key for dedup.
		return ancestors === undefined ? {} : obj;
	}
	if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
		const len = /** @type {{ byteLength: number }} */ (obj).byteLength;
		return '[bytes: ' + len + ']';
	}
	if (!ancestors) ancestors = new WeakSet();
	if (ancestors.has(obj)) return undefined;
	ancestors.add(obj);
	let result;
	if (Array.isArray(obj)) {
		result = obj.map((v) => defaultPresenceSelect(v, ancestors));
	} else {
		result = {};
		for (const k of Object.keys(obj)) {
			if (k.startsWith('__') || k === 'constructor' || k === 'prototype' || PRESENCE_SENSITIVE_RE.test(k)) continue;
			const v = obj[k];
			result[k] = (v && typeof v === 'object') ? defaultPresenceSelect(v, ancestors) : v;
		}
	}
	ancestors.delete(obj);
	return result;
}

export function createPresence(options = {}) {
	const keyField = options.key || 'id';
	const select = options.select || defaultPresenceSelect;
	// Default 30 s heartbeat keeps the client's `maxAge` sweep self-healing:
	// a still-present user re-appears on the next heartbeat after their
	// entry ages out of the local map. Apps that want zero heartbeat
	// traffic (no `maxAge` consumers, or out-of-band liveness) pass
	// `heartbeat: 0` explicitly to opt out.
	const heartbeatMs = options.heartbeat ?? 30000;
	if (typeof heartbeatMs !== 'number' || !Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
		throw new Error('presence: heartbeat must be a non-negative number');
	}
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;

	if (!Number.isInteger(maxConnections) || maxConnections < 1) {
		throw new Error('presence: maxConnections must be a positive integer');
	}
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error('presence: maxTopics must be a positive integer');
	}

	// Binary wire is on by default and fully transparent: a binary-capable client
	// receives compact `0x03` presence frames, everyone else (and any platform
	// without the publishWire/sendWire methods, e.g. the unit-test mock) receives
	// the identical JSON frames. `binary: false` forces JSON for everyone. The
	// codec is stateless: a roster frame is encoded once and fanned out to all
	// subscribers (the foundation's encode-once-send-many), the right trade for
	// presence's infrequent-but-full-roster broadcasts.
	const wireCodec = createPresenceWireCodec(options);

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
			if (!transientFields.has(k)) out[k] = entry.fields[k];
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
		if (wireCodec && typeof platform.publishWire === 'function') {
			// Presence frames are low-frequency (a diff on join/leave; one heartbeat
			// per interval), so opting into permessage-deflate is a cheap bandwidth
			// win - the opposite of the 60 Hz cursor hot path, which stays
			// uncompressed. No-op unless a compressor is configured.
			platform.publishWire(fullTopic, event, data, wireCodec, { compress: true });
		} else {
			platform.publish(fullTopic, event, data);
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
	 * Per-topic presence: Map<key, { data, fields, count }>.
	 * count > 1 means multiple connections share the same key (multi-tab).
	 * `data` is the identity (from `select`); `fields` (lazily allocated, `null`
	 * until the first `update()`) holds the dynamic fields set via `update()`
	 * (typing, selection, locks). `publicData()` merges the two minus transient.
	 * @type {Map<string, Map<string, { data: Record<string, any>, fields: Record<string, any> | null, count: number }>>}
	 */
	const topicPresence = new Map();

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
			diffFlushTimer = setTimer(() => flushDiffs(platform), 0);
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
			/** @type {Record<string, Record<string, any>>} */
			const joins = {};
			/** @type {Record<string, Record<string, any>>} */
			const leaves = {};
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
					if (!updates) updates = {};
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
		const state = {};
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
			return String(data[keyField]);
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
					const dataMap = {};
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
		try { ws.unsubscribe(TOPIC_PREFIX + topic); } catch { /* ws already closed */ }
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
					if (oldest !== undefined) wsTopics.delete(oldest);
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
				users.set(key, { data, fields: null, count: 1 });
				bufferDiff(topic, 'join', key, data, platform);
			}

			// Subscribe this ws to the presence channel (server-side, idempotent).
			// `platform.send` is closed-ws-safe on the adapter side; the
			// direct `ws.subscribe` is not - guard locally.
			try { ws.subscribe(presenceTopic); } catch { return; }

			// Send the full current snapshot to this connection. The joining
			// user sees the complete state (including themselves) immediately;
			// any pending diff fan-out reaches them too but is idempotent on
			// the client (joins[key] = data is a no-op if already set).
			emitTo(ws, presenceTopic, 'state', snapshotState(users), platform);
		},

		leave(ws, platform) {
			capturePlatform(platform);
			const connTopics = wsTopics.get(ws);
			if (!connTopics) return;

			for (const [topic] of connTopics) {
				leaveTopic(ws, topic, connTopics, platform);
			}

			wsTopics.delete(ws);
		},

		sync(ws, topic, platform) {
			capturePlatform(platform);
			const users = topicPresence.get(topic);
			const presenceTopic = TOPIC_PREFIX + topic;
			try { ws.subscribe(presenceTopic); } catch { return; }
			emitTo(ws, presenceTopic, 'state', snapshotState(users), platform);
		},

		update(ws, topic, fields, platform) {
			capturePlatform(platform);
			if (topic.startsWith('__')) return;
			if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return;
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
			if (!entry.fields) entry.fields = {};
			// Per-field change detection: only fields whose value actually changed
			// are merged and broadcast (the field-level delta). deepEqual so an
			// object field (a selection range) set to an equal value does not
			// spuriously re-broadcast.
			/** @type {Record<string, any>} */
			const changed = {};
			let any = false;
			for (const k of Object.keys(fields)) {
				const v = fields[k];
				if (!deepEqual(entry.fields[k], v)) {
					entry.fields[k] = v;
					changed[k] = v;
					any = true;
				}
			}
			if (!any) return;
			bufferUpdate(topic, connEntry.key, changed, platform);
		},

		list(topic) {
			const users = topicPresence.get(topic);
			if (!users) return [];
			const result = [];
			for (const [, entry] of users) {
				try { result.push(structuredClone(entry.data)); } catch { result.push(entry.data); }
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

		hooks: {
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
			},
			close(ws, { platform }) {
				tracker.leave(ws, platform);
			}
		}
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
