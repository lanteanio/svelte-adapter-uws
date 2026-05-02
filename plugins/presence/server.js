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
 * @module svelte-adapter-uws/plugins/presence
 */

const TOPIC_PREFIX = '__presence:';

/**
 * @typedef {Object} PresenceOptions
 * @property {string} [key='id'] - Field in the selected data that uniquely identifies a user.
 *   Used for multi-tab dedup: if two connections share the same key value, they count as one
 *   presence entry. If the field is missing from the data, each connection is tracked separately.
 * @property {(userData: any) => Record<string, any>} [select] - Function to extract the public
 *   presence data from the connection's userData (whatever your `upgrade` handler returned).
 *   Only the selected fields are broadcast to other clients. Defaults to the full userData.
 *   Use this to avoid leaking private fields like session tokens.
 *   Should return JSON-serializable data (plain objects, arrays, strings, numbers,
 *   booleans, null) since the result is sent over WebSocket.
 * @property {number} [heartbeat=0] - Interval in milliseconds between heartbeat broadcasts.
 *   When set, the server periodically publishes a `heartbeat` event to all presence topics
 *   containing the list of active keys. This resets the `maxAge` timer on clients, preventing
 *   live users from being expired. Set this to a value shorter than the client's `maxAge`.
 *   Disabled by default (0 or omitted).
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
 * Shared subobjects are handled correctly -- the same object appearing
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

export function createPresence(options = {}) {
	const keyField = options.key || 'id';
	const select = options.select || ((userData) => userData);
	const heartbeatMs = options.heartbeat || 0;
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;

	if (!Number.isInteger(maxConnections) || maxConnections < 1) {
		throw new Error('presence: maxConnections must be a positive integer');
	}
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error('presence: maxTopics must be a positive integer');
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
	 * Per-topic presence: Map<key, { data, count }>.
	 * count > 1 means multiple connections share the same key (multi-tab).
	 * @type {Map<string, Map<string, { data: Record<string, any>, count: number }>>}
	 */
	const topicPresence = new Map();

	/**
	 * Per-topic pending diff buffer: latest op per key wins. Joins and leaves
	 * happening on the same key in a tick collapse so the wire only sees the
	 * net change. Flushed once per microtask via `scheduleDiffFlush`.
	 * @type {Map<string, Map<string, { op: 'join' | 'leave', data: Record<string, any> }>>}
	 */
	const pendingDiffs = new Map();
	let diffFlushScheduled = false;

	/**
	 * @param {string} topic
	 * @param {'join' | 'leave'} op
	 * @param {string} key
	 * @param {Record<string, any>} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function bufferDiff(topic, op, key, data, platform) {
		let entries = pendingDiffs.get(topic);
		if (!entries) {
			entries = new Map();
			pendingDiffs.set(topic, entries);
		}
		entries.set(key, { op, data });
		if (!diffFlushScheduled) {
			diffFlushScheduled = true;
			queueMicrotask(() => flushDiffs(platform));
		}
	}

	/** @param {import('../../index.js').Platform} platform */
	function flushDiffs(platform) {
		diffFlushScheduled = false;
		for (const [topic, entries] of pendingDiffs) {
			/** @type {Record<string, Record<string, any>>} */
			const joins = {};
			/** @type {Record<string, Record<string, any>>} */
			const leaves = {};
			for (const [key, { op, data }] of entries) {
				if (op === 'join') joins[key] = data;
				else leaves[key] = data;
			}
			platform.publish(TOPIC_PREFIX + topic, 'presence_diff', { joins, leaves });
		}
		pendingDiffs.clear();
	}

	/**
	 * Build a presence_state snapshot for a topic: {[key]: data}.
	 * @param {Map<string, { data: Record<string, any>, count: number }> | undefined} users
	 * @returns {Record<string, Record<string, any>>}
	 */
	function snapshotState(users) {
		/** @type {Record<string, Record<string, any>>} */
		const state = {};
		if (!users) return state;
		for (const [k, entry] of users) state[k] = entry.data;
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
	 * Called lazily on first join/leave/sync -- the platform object isn't
	 * available at createPresence() time.
	 * @param {import('../../index.js').Platform} platform
	 */
	function capturePlatform(platform) {
		if (_platform) return;
		_platform = platform;
		if (heartbeatMs > 0) {
			heartbeatTimer = setInterval(() => {
				for (const [topic, users] of topicPresence) {
					_platform.publish(
						TOPIC_PREFIX + topic,
						'heartbeat',
						[...users.keys()]
					);
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
			const data = existing.data;
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

			const data = select(ws.getUserData());
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
				// a `join` entry in the next presence_diff: client overwrites
				// the existing key with the new data.
				existing.count++;
				if (!deepEqual(existing.data, data)) {
					existing.data = data;
					bufferDiff(topic, 'join', key, data, platform);
				}
			} else {
				// New user on this topic - record the join in the next diff so
				// other subscribers see them appear.
				users.set(key, { data, count: 1 });
				bufferDiff(topic, 'join', key, data, platform);
			}

			// Subscribe this ws to the presence channel (server-side, idempotent)
			ws.subscribe(presenceTopic);

			// Send the full current snapshot to this connection. The joining
			// user sees the complete state (including themselves) immediately;
			// any pending diff fan-out reaches them too but is idempotent on
			// the client (joins[key] = data is a no-op if already set).
			platform.send(ws, presenceTopic, 'presence_state', snapshotState(users));
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
			ws.subscribe(presenceTopic);
			platform.send(ws, presenceTopic, 'presence_state', snapshotState(users));
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
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			_platform = null;
			wsTopics.clear();
			topicPresence.clear();
			pendingDiffs.clear();
			diffFlushScheduled = false;
			connCounter = 0;
		},

		/**
		 * Drain any buffered diff publishes synchronously. Tests use this
		 * to assert on the wire output without awaiting the microtask
		 * queue. Production code generally does not need to call it - the
		 * microtask flush happens automatically. Useful when a caller
		 * needs presence state visible to other workers before its own
		 * synchronous block returns (e.g. before responding to an HTTP
		 * request that just triggered a leave).
		 */
		flushDiffs() {
			if (!diffFlushScheduled || !_platform) return;
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
			close(ws, { platform }) {
				tracker.leave(ws, platform);
			}
		}
	};

	return tracker;
}
