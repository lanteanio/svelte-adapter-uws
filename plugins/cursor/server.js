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
 * Wire shape (channel `__cursor:{topic}`):
 *   - `catalog`  [{key, user}, ...]  - sent on snapshot() to a single
 *                                      newly-attaching subscriber.
 *   - `join`     {key, user}         - emitted once per (ws, topic) the
 *                                      first time that ws updates on the
 *                                      topic. Broadcast to all subscribers.
 *   - `update`   {key, data}         - single-mover position update.
 *   - `bulk`     [{key, data}, ...]  - per-topic coalesced positions when
 *                                      `topicThrottle` is enabled and >1
 *                                      mover is pending in the window.
 *   - `remove`   {key}               - user is gone from the topic.
 *
 * User metadata (the `select()`ed userData) lives on the catalog channel
 * (catalog + join), not on every position frame. This matches the
 * cluster-aware Redis-backed variant in the extensions package so a
 * single browser bundle (`plugins/cursor/client`) works against either
 * backend.
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

/** Wire-protocol event names. */
const EVENTS = Object.freeze({
	CATALOG: 'catalog',
	JOIN: 'join',
	UPDATE: 'update',
	BULK: 'bulk',
	REMOVE: 'remove'
});

/**
 * @typedef {Object} CursorOptions
 * @property {number} [throttle=16] - Minimum milliseconds between broadcasts
 *   per user per topic. A trailing-edge timer fires to ensure the final
 *   position is always sent. Default 16 (~60 Hz) suits collaborative
 *   apps; lower (e.g. 8 for 120 Hz) for high-refresh demos, higher to
 *   conserve bandwidth.
 * @property {number} [topicThrottle=16] - World-state tick rate, in ms.
 *   Per-topic aggregate cap on broadcasts: each topic emits at most one
 *   frame per window, carrying the latest position for every cursor that
 *   moved (a single `update` when one mover is dirty, a `bulk` array
 *   otherwise). Bandwidth per peer scales with active-mover count, not
 *   with mover-count times per-mover rate. Default 16 (~60 Hz) suits
 *   small-to-medium rooms; raise to 33 (~30 Hz) for high-density rooms
 *   where wire bytes dominate. 0 disables the tick; per-cursor `throttle`
 *   then governs broadcast rate.
 * @property {(userData: any) => any} [select] - Extract user-identifying data
 *   from the connection's userData. This is announced on the `catalog` /
 *   `join` channel when a user first appears on a topic. Defaults to the
 *   full userData. Should return JSON-serializable data (plain objects,
 *   arrays, strings, numbers, booleans, null). The same applies to the
 *   `data` argument passed to `update()`.
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
 *   Broadcast a cursor position update. Throttled per user per topic and
 *   optionally coalesced per topic. Call this from your `message` hook
 *   when you receive cursor data.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} remove -
 *   Remove a connection's cursor state from all topics and broadcast removal.
 *   Call this from your `close` hook.
 * @property {(topic: string) => CursorEntry[]} list -
 *   Get current cursor positions for a topic. Use in load() functions for SSR.
 *   Returns deep copies (via structuredClone) when data is JSON-serializable.
 *   Falls back to shared references for non-cloneable data.
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} snapshot -
 *   Send current cursor positions for a topic to a single connection as
 *   a `catalog` + `bulk` pair (roster, then positions). Call from your
 *   `message` handler when the client sends `{type: 'cursor-snapshot',
 *   topic}`. The `cursor()` client store sends this automatically on
 *   subscribe so late joiners see existing cursors immediately.
 * @property {() => void} clear -
 *   Clear all cursor tracking state and pending timers.
 * @property {() => { flushes: number, driftMeanMs: number, driftMaxMs: number, dirtyTopicsCurrent: number, activeTopicsTotal: number }} stats -
 *   Snapshot of scheduler health. `flushes` is the total tick-driven
 *   flushes; `driftMeanMs` / `driftMaxMs` measure the gap between the
 *   target deadline and the actual fire time (`> topicThrottle` indicates
 *   sustained event-loop saturation); `dirtyTopicsCurrent` is topics with
 *   pending coalesced entries (should hover near zero); `activeTopicsTotal`
 *   is topics with at least one local cursor.
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
 *   throttle: 16,        // 60 Hz per-cursor rate (default)
 *   topicThrottle: 16,   // 60 Hz per-topic coalescing (default)
 *   select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
 * });
 * ```
 *
 * @example
 * ```js
 * // 120 Hz demo: halve both intervals
 * createCursor({ throttle: 8, topicThrottle: 8 });
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
	const throttleMs = options.throttle ?? 16;
	const topicThrottleMs = options.topicThrottle ?? 16;
	const select = options.select || ((userData) => userData);
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;
	const maxTopicLength = options.maxTopicLength ?? 256;
	const maxDataBytes = options.maxDataBytes ?? 8192;

	if (typeof throttleMs !== 'number' || !Number.isFinite(throttleMs) || throttleMs < 0) {
		throw new Error('cursor: throttle must be a non-negative number');
	}
	if (typeof topicThrottleMs !== 'number' || !Number.isFinite(topicThrottleMs) || topicThrottleMs < 0) {
		throw new Error('cursor: topicThrottle must be a non-negative number');
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
	if (!Number.isInteger(maxTopicLength) || maxTopicLength < 1) {
		throw new Error('cursor: maxTopicLength must be a positive integer');
	}
	if (!Number.isInteger(maxDataBytes) || maxDataBytes < 1) {
		throw new Error('cursor: maxDataBytes must be a positive integer');
	}

	/** Auto-incrementing connection key. */
	let connCounter = 0;

	/**
	 * Per-ws state: connection key, selected user data, and which topics
	 * this ws has already announced (the `topics` set doubles as the
	 * already-joined set - presence in the set means a `join` has fired).
	 * Capped at `maxConnections` - oldest insertion-order entry evicted
	 * on new insert at cap. Eviction is rare in practice because user
	 * code is expected to call `remove(ws)` on disconnect.
	 * @type {Map<any, { key: string, user: any, topics: Set<string> }>}
	 */
	const wsState = new Map();

	/**
	 * Per-topic local cursor state. Drives the per-(ws, topic) throttle
	 * and the post-disconnect cleanup. Capped at `maxTopics` - oldest
	 * insertion-order topic evicted on new insert at cap. Each evicted
	 * topic's pending throttle and coalesce timers are cleared first.
	 * @type {Map<string, Map<string, { user: any, data: any, lastBroadcast: number, timer: any }>>}
	 */
	const topics = new Map();

	/**
	 * Per-topic aggregate flush state.
	 *
	 * - `dirty`: cursors awaiting coalesced flush. Keyed by connection key;
	 *   latest-wins. When the coalesce window elapses, `dirty.size === 1`
	 *   sends a single `update`; any other count sends one `bulk` array.
	 * - `lastFlush`: target-anchored timestamp of the most recent flush.
	 *   Advanced by `topicThrottleMs` per cycle (not to actual fire time)
	 *   so a single late tick does not compound drift on subsequent cycles.
	 *
	 * @type {Map<string, { dirty: Map<string, { data: any, platform: any }>, lastFlush: number }>}
	 */
	const topicFlush = new Map();

	/**
	 * Topics with at least one pending dirty entry. Bounded by mover count,
	 * not active-topic count, so the scheduler walks only dirty topics on
	 * each tick instead of every active one.
	 * @type {Set<string>}
	 */
	const dirtyTopics = new Set();

	/**
	 * Single tracker-wide timer. Always points at the next earliest topic
	 * deadline (or null when idle). Replaces the previous per-topic
	 * setTimeout pattern: N pending timers -> 1 pending timer regardless
	 * of topic count. Scheduling cost is O(dirty topics), not O(active
	 * topics).
	 * @type {ReturnType<typeof setTimeout> | null}
	 */
	let tickTimer = null;

	/**
	 * Drift accounting for `stats()` observability. Mean (target - actual)
	 * and max over tick-driven flushes. Leading-edge synchronous flushes
	 * are NOT counted (they fire on the caller's thread, not via the
	 * scheduler; their drift is structurally zero).
	 */
	let driftSum = 0;
	let driftCount = 0;
	let driftMax = 0;
	let flushCount = 0;

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
			let userData = {};
			if (typeof ws.getUserData === 'function') {
				// Closed-WS race: caller may reach here after an `await`
				// that outlasted the socket; getUserData throws on a
				// freed handle. Fall back to an empty userData rather
				// than crashing the worker.
				try { userData = ws.getUserData(); } catch { userData = {}; }
			}
			state = {
				key: String(++connCounter),
				user: select(userData),
				topics: new Set()
			};
			wsState.set(ws, state);
		}
		return state;
	}

	/**
	 * Drop the topic's coalesce state. The single tracker-wide tickTimer is
	 * left alone (it self-cancels on the next tick when `dirtyTopics` is
	 * empty); we just remove this topic from both the flush map and the
	 * dirty set so the next tick skips it.
	 * @param {string} topic
	 */
	function clearTopicFlush(topic) {
		topicFlush.delete(topic);
		dirtyTopics.delete(topic);
	}

	/**
	 * Emit `join` for a (ws, topic) pair the first time the ws moves on
	 * the topic. Broadcast (not single-target) so existing subscribers
	 * pick up the new user before any position frames arrive.
	 */
	function emitJoin(topic, key, user, platform) {
		platform.publish(TOPIC_PREFIX + topic, EVENTS.JOIN, { key, user });
	}

	/**
	 * Publish a single-mover position update.
	 * @param {string} topic
	 * @param {string} key
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function doBroadcast(topic, key, data, platform) {
		platform.publish(TOPIC_PREFIX + topic, EVENTS.UPDATE, { key, data });
	}

	/**
	 * Flush all coalesced entries for a topic. One entry -> `update`,
	 * many entries -> single `bulk` array.
	 * @param {string} topic
	 * @param {Map<string, { data: any, platform: any }>} dirty
	 */
	function flushDirty(topic, dirty) {
		if (dirty.size === 0) return;
		flushCount++;
		if (dirty.size === 1) {
			const [k, v] = dirty.entries().next().value;
			doBroadcast(topic, k, v.data, v.platform);
			return;
		}
		const entries = [];
		let flushPlatform = null;
		for (const [k, v] of dirty) {
			entries.push({ key: k, data: v.data });
			flushPlatform = v.platform;
		}
		if (flushPlatform) {
			flushPlatform.publish(TOPIC_PREFIX + topic, EVENTS.BULK, entries);
		}
	}

	/**
	 * Scheduler tick. Walks `dirtyTopics`, flushes any topic whose deadline
	 * (`lastFlush + topicThrottleMs`) has passed, and re-arms `tickTimer`
	 * for the next earliest pending deadline. Topics whose deadline has
	 * not yet passed stay in `dirtyTopics` for the next tick.
	 *
	 * Target-anchored advance: on flush, `lastFlush` is set to the deadline
	 * (not the actual fire time) so a single late tick does not compound
	 * drift on subsequent cycles. If we fell behind by more than one cycle
	 * (event loop saturation > `topicThrottleMs`), `lastFlush` resets to
	 * `now` to avoid queueing phantom catch-up fires.
	 */
	function tick() {
		tickTimer = null;
		const now = Date.now();
		let nextDeadline = Infinity;

		for (const topic of dirtyTopics) {
			const state = topicFlush.get(topic);
			if (!state) { dirtyTopics.delete(topic); continue; }
			if (state.dirty.size === 0) {
				dirtyTopics.delete(topic);
				continue;
			}
			const deadline = state.lastFlush + topicThrottleMs;
			if (deadline <= now) {
				const drift = now - deadline;
				driftSum += drift;
				driftCount++;
				if (drift > driftMax) driftMax = drift;

				flushDirty(topic, state.dirty);  // increments flushCount internally
				state.dirty.clear();
				dirtyTopics.delete(topic);

				state.lastFlush = drift < topicThrottleMs ? deadline : now;
			} else if (deadline < nextDeadline) {
				nextDeadline = deadline;
			}
		}

		if (nextDeadline !== Infinity) {
			tickTimer = setTimeout(tick, Math.max(0, nextDeadline - Date.now()));
		}
		// else: scheduler idle until next `broadcast()` call.
	}

	function armTick(delay) {
		if (tickTimer !== null) return;
		tickTimer = setTimeout(tick, delay);
	}

	/**
	 * Route a broadcast through the per-topic coalesce window when
	 * `topicThrottle` is enabled, or directly publish when disabled.
	 *
	 * Leading-edge claims the cadence slot synchronously (lastFlush =
	 * now) but defers the actual flush by one microtask so co-arriving
	 * broadcasts in the same JS pass batch into a single bulk frame.
	 * Without the microtask defer, an event-loop pause > topicThrottleMs
	 * caused the post-pause first cursor to fire alone (single-cursor
	 * UPDATE) while every other cursor in the same burst queued to the
	 * trailing tick: under sustained pressure (30K RPCs/sec/worker) this
	 * fragmented 86% of cursor frames into single-cursor UPDATEs.
	 * Microtasks run after the current synchronous code completes but
	 * before the next I/O / setTimeout / event-loop tick, so any
	 * subsequent broadcast() in the same handler batch adds itself to
	 * `dirty` before the flush runs.
	 *
	 * Trailing-edge fires via the single tracker-wide `tickTimer` for
	 * broadcasts that land mid-window.
	 */
	function broadcast(topic, key, data, platform) {
		if (topicThrottleMs <= 0) {
			doBroadcast(topic, key, data, platform);
			return;
		}

		let state = topicFlush.get(topic);
		if (!state) {
			state = { dirty: new Map(), lastFlush: 0, pendingMicroflush: false };
			topicFlush.set(topic, state);
		}
		state.dirty.set(key, { data, platform });

		const now = Date.now();
		if (now - state.lastFlush >= topicThrottleMs) {
			state.lastFlush = now;
			dirtyTopics.delete(topic);
			// Schedule once per cycle slot; subsequent broadcasts inside
			// the same microtask boundary just append to `state.dirty`.
			if (!state.pendingMicroflush) {
				state.pendingMicroflush = true;
				queueMicrotask(() => {
					state.pendingMicroflush = false;
					if (state.dirty.size === 0) return;
					flushDirty(topic, state.dirty);
					state.dirty.clear();
				});
			}
			return;
		}

		dirtyTopics.add(topic);
		armTick(Math.max(0, topicThrottleMs - (now - state.lastFlush)));
	}

	/** @type {CursorTracker} */
	const tracker = {
		update(ws, topic, data, platform) {
			// Reject malformed topic or oversized payload silently. Cursor
			// is best-effort fire-and-forget; a misbehaving client (or a
			// bug producing a giant `data` blob) gets its frame dropped
			// rather than throwing into the message hook. Legitimate
			// cursor moves are small ({x, y}-shaped, ~30 bytes) so the
			// 256/8192 caps are never reached in practice.
			if (typeof topic !== 'string' || topic.length === 0 || topic.length > maxTopicLength) return;
			if (data !== undefined && data !== null) {
				let dataBytes;
				try {
					dataBytes = Buffer.byteLength(JSON.stringify(data));
				} catch {
					return;
				}
				if (dataBytes > maxDataBytes) return;
			}
			const state = getWsState(ws);
			const isFirstOnTopic = !state.topics.has(topic);
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
						clearTopicFlush(oldest);
					}
				}
				topicMap = new Map();
				topics.set(topic, topicMap);
			}

			if (isFirstOnTopic) {
				emitJoin(topic, state.key, state.user, platform);
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
				broadcast(topic, state.key, data, platform);
				return;
			}

			// Trailing edge: schedule a broadcast for the end of the window
			if (!entry.timer) {
				const key = state.key;
				entry.timer = setTimeout(() => {
					const e = topicMap.get(key);
					if (e) {
						e.lastBroadcast = Date.now();
						e.timer = null;
						broadcast(topic, key, e.data, platform);
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
						clearTopicFlush(topic);
					} else {
						const flushState = topicFlush.get(topic);
						if (flushState) flushState.dirty.delete(state.key);
					}
					platform.publish(TOPIC_PREFIX + topic, EVENTS.REMOVE, { key: state.key });
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
			const catalog = [];
			const positions = [];
			if (topicMap) {
				for (const [key, entry] of topicMap) {
					catalog.push({ key, user: entry.user });
					positions.push({ key, data: entry.data });
				}
			}
			platform.send(ws, TOPIC_PREFIX + topic, EVENTS.CATALOG, catalog);
			platform.send(ws, TOPIC_PREFIX + topic, EVENTS.BULK, positions);
		},

		clear() {
			for (const [, topicMap] of topics) {
				for (const [, entry] of topicMap) {
					if (entry.timer) clearTimeout(entry.timer);
				}
			}
			if (tickTimer !== null) { clearTimeout(tickTimer); tickTimer = null; }
			dirtyTopics.clear();
			topics.clear();
			topicFlush.clear();
			wsState.clear();
			connCounter = 0;
		},

		/**
		 * Snapshot of scheduler health. Always available, near-zero cost.
		 *
		 * - `flushes`: total tick-driven flushes since tracker creation.
		 * - `driftMeanMs`: mean (target_deadline - actual_fire_time) across
		 *   all tick-driven flushes. 0 means perfect cadence; values >
		 *   `topicThrottle` indicate sustained event-loop saturation or
		 *   CPU contention.
		 * - `driftMaxMs`: largest single observed late fire. Useful for
		 *   spotting one-off GC pauses vs. sustained drift.
		 * - `dirtyTopicsCurrent`: topics with pending coalesced entries
		 *   right now. Should hover near zero in healthy operation.
		 * - `activeTopicsTotal`: topics with at least one local cursor.
		 *
		 * Leading-edge synchronous flushes (first call on an idle topic)
		 * are not counted in drift stats - they fire on the call thread,
		 * not via the scheduler.
		 */
		stats() {
			return {
				flushes: flushCount,
				driftMeanMs: driftCount > 0 ? driftSum / driftCount : 0,
				driftMaxMs: driftMax,
				dirtyTopicsCurrent: dirtyTopics.size,
				activeTopicsTotal: topics.size
			};
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
