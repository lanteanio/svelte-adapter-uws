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
 * @module svelte-adapter-uws/plugins/cursor
 */

/**
 * @typedef {Object} CursorOptions
 * @property {number} [throttle=50] - Minimum milliseconds between broadcasts per
 *   user per topic. A trailing-edge timer fires to ensure the final position is
 *   always sent even if the user stops moving.
 * @property {(userData: any) => any} [select] - Extract user-identifying data from
 *   the connection's userData. This is broadcast alongside the cursor data so other
 *   clients know who the cursor belongs to. Defaults to the full userData.
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
 * // src/hooks.ws.js
 * import { cursors } from '$lib/server/cursors';
 *
 * export function message(ws, data, { platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   if (msg.type === 'cursor') {
 *     cursors.update(ws, msg.topic, msg.position, platform);
 *   }
 * }
 *
 * export function close(ws, { platform }) {
 *   cursors.remove(ws, platform);
 * }
 * ```
 */
export function createCursor(options = {}) {
	const throttleMs = options.throttle ?? 50;
	const select = options.select || ((userData) => userData);

	if (typeof throttleMs !== 'number' || !Number.isFinite(throttleMs) || throttleMs < 0) {
		throw new Error('cursor: throttle must be a non-negative number');
	}
	if (typeof select !== 'function') {
		throw new Error('cursor: select must be a function');
	}

	/** Auto-incrementing connection key. */
	let connCounter = 0;

	/**
	 * Per-ws state: their key and which topics they have cursor state on.
	 * @type {Map<any, { key: string, user: any, topics: Set<string> }>}
	 */
	const wsState = new Map();

	/**
	 * Per-topic cursor positions.
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
		platform.publish('__cursor:' + topic, 'update', { key, user, data });
	}

	return {
		update(ws, topic, data, platform) {
			const state = getWsState(ws);
			state.topics.add(topic);

			let topicMap = topics.get(topic);
			if (!topicMap) {
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
					platform.publish('__cursor:' + topic, 'remove', { key: state.key });
				}
			}

			wsState.delete(ws);
		},

		list(topic) {
			const topicMap = topics.get(topic);
			if (!topicMap) return [];
			const result = [];
			for (const [key, entry] of topicMap) {
				result.push({ key, user: entry.user, data: entry.data });
			}
			return result;
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
		}
	};
}
