/**
 * Cursor / ephemeral state plugin for svelte-adapter-uws.
 *
 * Lightweight fire-and-forget broadcasting for transient state like
 * mouse cursors, text selections, drag positions, or drawing strokes.
 * Built-in throttle with trailing edge ensures the final position is
 * always delivered. Auto-cleanup on disconnect.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * uses platform.publish() and platform.send().
 *
 * MULTI-TENANT NOTE
 * Cursor state is keyed by the topic name verbatim. Apps running
 * multiple tenants in one process must namespace topic names with
 * tenant scope to avoid cross-tenant cursor leakage. Same
 * recommendation for the `presence`, `groups`, and `replay` plugins.
 *
 * @module svelte-adapter-uws/plugins/cursor
 */

const TOPIC_PREFIX = '__cursor:';

/**
 * @typedef {Object} CursorOptions
 * @property {number} [throttle=50] - Minimum milliseconds between broadcasts per
 *   user per topic. A trailing-edge timer fires to ensure the final position is
 *   always sent even if the user stops moving.
 * @property {(userData: any) => any} [select] - Extract user-identifying data from
 *   the connection's userData. This is broadcast alongside the cursor data so other
 *   clients know who the cursor belongs to. Defaults to the full userData.
 *   Should return JSON-serializable data (plain objects, arrays, strings, numbers,
 *   booleans, null). The same applies to the `data` argument passed to `update()`.
 */

/**
 * @typedef {Object} CursorEntry
 * @property {string} key - Unique connection key.
 * @property {any} user - Selected user data.
 * @property {any} data - Latest cursor/position data.
 */

/**
 * @typedef {Object} CursorTracker
 * @property {(ws: any, topic: string, data: any, platform: import('../../index.js').Platform) => void} update -
 *   Broadcast a cursor position update. Throttled per user per topic.
 *   Call this from your `message` hook when you receive cursor data.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} remove -
 *   Remove a connection's cursor state from all topics and broadcast removal.
 *   Call this from your `close` hook.
 * @property {(topic: string) => CursorEntry[]} list -
 *   Get current cursor positions for a topic. Use in load() functions for SSR.
 *   Returns deep copies (via structuredClone) when data is JSON-serializable.
 *   Falls back to shared references for non-cloneable data.
 * @property {() => void} clear -
 *   Clear all cursor tracking state and pending timers.
 */

/**
 * Create a cursor tracker.
 *
 * @param {CursorOptions} [options]
 * @returns {CursorTracker}
 *
 * @example
 * ```js
 * // src/lib/server/cursors.js
 * import { createCursor } from 'svelte-adapter-uws/plugins/cursor';
 *
 * export const cursors = createCursor({
 *   throttle: 50,
 *   select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - using hooks helper
 * import { cursors } from '$lib/server/cursors';
 *
 * export function message(ws, ctx) {
 *   if (cursors.hooks.message(ws, ctx)) return;
 *   // handle other messages...
 * }
 *
 * export const close = cursors.hooks.close;
 * ```
 */
export function createCursor(options = {}) {
	const throttleMs = options.throttle ?? 50;
	const select = options.select || ((userData) => userData);
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;

	if (typeof throttleMs !== 'number' || !Number.isFinite(throttleMs) || throttleMs < 0) {
		throw new Error('cursor: throttle must be a non-negative number');
	}
	if (typeof select !== 'function') {
		throw new Error('cursor: select must be a function');
	}
	if (!Number.isInteger(maxConnections) || maxConnections < 1) {
		throw new Error('cursor: maxConnections must be a positive integer');
	}
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error('cursor: maxTopics must be a positive integer');
	}

	/** Auto-incrementing connection key. */
	let connCounter = 0;

	/**
	 * Per-ws state: their key and which topics they have cursor state on.
	 * Capped at `maxConnections` - oldest insertion-order entry evicted
	 * on new insert at cap. Eviction is rare in practice because user
	 * code is expected to call `remove(ws)` on disconnect.
	 * @type {Map<any, { key: string, user: any, topics: Set<string> }>}
	 */
	const wsState = new Map();

	/**
	 * Per-topic cursor positions. Capped at `maxTopics` - oldest
	 * insertion-order topic evicted on new insert at cap. Each evicted
	 * topic's pending timers are cleared first so no callback fires on
	 * a deleted entry.
	 * @type {Map<string, Map<string, { user: any, data: any, lastBroadcast: number, timer: any }>>}
	 */
	const topics = new Map();

	/**
	 * Get or create ws state and return the connection key + user data.
	 * @param {any} ws
	 * @returns {{ key: string, user: any, topics: Set<string> }}
	 */
	function getWsState(ws) {
		let state = wsState.get(ws);
		if (!state) {
			if (wsState.size >= maxConnections) {
				const oldest = wsState.keys().next().value;
				if (oldest !== undefined) wsState.delete(oldest);
			}
			state = {
				key: String(++connCounter),
				user: select(typeof ws.getUserData === 'function' ? ws.getUserData() : {}),
				topics: new Set()
			};
			wsState.set(ws, state);
		}
		return state;
	}

	/**
	 * Broadcast a cursor update for a specific entry.
	 * @param {string} topic
	 * @param {string} key
	 * @param {any} user
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function broadcast(topic, key, user, data, platform) {
		platform.publish(TOPIC_PREFIX + topic, 'update', { key, user, data });
	}

	/** @type {CursorTracker} */
	const tracker = {
		update(ws, topic, data, platform) {
			const state = getWsState(ws);
			state.topics.add(topic);

			let topicMap = topics.get(topic);
			if (!topicMap) {
				if (topics.size >= maxTopics) {
					const oldest = topics.keys().next().value;
					if (oldest !== undefined) {
						const oldMap = topics.get(oldest);
						if (oldMap) {
							for (const e of oldMap.values()) {
								if (e.timer) clearTimeout(e.timer);
							}
						}
						topics.delete(oldest);
					}
				}
				topicMap = new Map();
				topics.set(topic, topicMap);
			}

			let entry = topicMap.get(state.key);
			const now = Date.now();

			if (!entry) {
				entry = { user: state.user, data, lastBroadcast: 0, timer: null };
				topicMap.set(state.key, entry);
			}

			// Always store latest data
			entry.data = data;
			entry.user = state.user;

			// Leading edge: broadcast immediately if throttle window passed
			if (now - entry.lastBroadcast >= throttleMs) {
				if (entry.timer) {
					clearTimeout(entry.timer);
					entry.timer = null;
				}
				entry.lastBroadcast = now;
				broadcast(topic, state.key, state.user, data, platform);
				return;
			}

			// Trailing edge: schedule a broadcast for the end of the window
			if (!entry.timer) {
				const key = state.key;
				const user = state.user;
				entry.timer = setTimeout(() => {
					const e = topicMap.get(key);
					if (e) {
						e.lastBroadcast = Date.now();
						e.timer = null;
						broadcast(topic, key, user, e.data, platform);
					}
				}, throttleMs - (now - entry.lastBroadcast));
			}
		},

		remove(ws, platform) {
			const state = wsState.get(ws);
			if (!state) return;

			for (const topic of state.topics) {
				const topicMap = topics.get(topic);
				if (!topicMap) continue;

				const entry = topicMap.get(state.key);
				if (entry) {
					if (entry.timer) clearTimeout(entry.timer);
					topicMap.delete(state.key);
					if (topicMap.size === 0) {
						topics.delete(topic);
					}
					platform.publish(TOPIC_PREFIX + topic, 'remove', { key: state.key });
				}
			}

			wsState.delete(ws);
		},

		list(topic) {
			const topicMap = topics.get(topic);
			if (!topicMap) return [];
			const result = [];
			for (const [key, entry] of topicMap) {
				const item = { key, user: entry.user, data: entry.data };
			try { result.push(structuredClone(item)); } catch { result.push(item); }
			}
			return result;
		},

		snapshot(ws, topic, platform) {
			const topicMap = topics.get(topic);
			const entries = [];
			if (topicMap) {
				for (const [key, entry] of topicMap) {
					entries.push({ key, user: entry.user, data: entry.data });
				}
			}
			platform.send(ws, TOPIC_PREFIX + topic, 'snapshot', entries);
		},

		clear() {
			// Clear all timers
			for (const [, topicMap] of topics) {
				for (const [, entry] of topicMap) {
					if (entry.timer) clearTimeout(entry.timer);
				}
			}
			topics.clear();
			wsState.clear();
			connCounter = 0;
		},

		hooks: {
			message(ws, { data, platform }) {
				let parsed;
				try { parsed = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
				if (parsed.type === 'cursor' && typeof parsed.topic === 'string') {
					if (typeof ws.isSubscribed === 'function' && !ws.isSubscribed(TOPIC_PREFIX + parsed.topic)) return true;
					tracker.update(ws, parsed.topic, parsed.data ?? parsed.position, platform);
					return true;
				}
				if (parsed.type === 'cursor-snapshot' && typeof parsed.topic === 'string') {
					if (typeof ws.isSubscribed === 'function' && !ws.isSubscribed(TOPIC_PREFIX + parsed.topic)) return true;
					tracker.snapshot(ws, parsed.topic, platform);
					return true;
				}
			},
			close(ws, { platform }) {
				tracker.remove(ws, platform);
			}
		}
	};

	return tracker;
}
