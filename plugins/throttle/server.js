/**
 * Throttle/debounce plugin for svelte-adapter-uws.
 *
 * Per-topic publish rate limiting for single-publisher streams. Wraps
 * platform.publish() to coalesce rapid-fire updates (e.g. server-aggregated
 * metrics, live counters, world-state snapshots, job-progress feeds). Sends
 * the latest value at most once per interval. Prevents flooding without the
 * user having to implement timers.
 *
 * Not suitable for multi-publisher streams that share a topic (many clients
 * emitting cursor moves, drawing strokes, or presence pings into one
 * topic) - the single shared pending slot lets fast publishers overwrite
 * slow publishers' updates. Aggregate server-side first, then throttle the
 * aggregate.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * wraps platform.publish() with timer-based rate limiting.
 *
 * @module svelte-adapter-uws/plugins/throttle
 */

/**
 * Send pending data for a topic and clean up its timer.
 * @param {Map<string, any>} topics
 * @param {string} topic
 */
function flushOne(topics, topic) {
	const state = topics.get(topic);
	if (!state) return;
	if (state.timer) clearTimeout(state.timer);
	if (state.pending) {
		const p = state.pending;
		p.platform.publish(topic, p.event, p.data);
	}
	topics.delete(topic);
}

/**
 * Send all pending data and clean up all timers.
 * @param {Map<string, any>} topics
 */
function flushAll(topics) {
	for (const [t, state] of topics) {
		if (state.timer) clearTimeout(state.timer);
		if (state.pending) {
			const p = state.pending;
			p.platform.publish(t, p.event, p.data);
		}
	}
	topics.clear();
}

/**
 * Discard pending data for a topic and clean up its timer.
 * @param {Map<string, any>} topics
 * @param {string} topic
 */
function cancelOne(topics, topic) {
	const state = topics.get(topic);
	if (!state) return;
	if (state.timer) clearTimeout(state.timer);
	topics.delete(topic);
}

/**
 * Discard all pending data and clean up all timers.
 * @param {Map<string, any>} topics
 */
function cancelAll(topics) {
	for (const [, state] of topics) {
		if (state.timer) clearTimeout(state.timer);
	}
	topics.clear();
}

/**
 * Validate interval parameter.
 * @param {any} interval
 * @param {string} name
 */
function validateInterval(interval, name) {
	if (typeof interval !== 'number' || interval < 0 || !Number.isFinite(interval)) {
		throw new Error(`${name}: interval must be a non-negative finite number`);
	}
}

/**
 * Resolve `maxTopics` from a possibly-omitted options bag and validate.
 * Default cap is 1_000_000 - far above any realistic per-process active
 * topic count, but still bounded to catch unbounded-cardinality leaks
 * (e.g. throttling on a per-user topic for many distinct users).
 *
 * @param {{ maxTopics?: number } | undefined} options
 * @param {string} name
 * @returns {number}
 */
function resolveMaxTopics(options, name) {
	const value = options && options.maxTopics !== undefined ? options.maxTopics : 1_000_000;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name}: maxTopics must be a positive integer`);
	}
	return value;
}

/**
 * Insert a topic state, dropping the oldest insertion-order entry when
 * the map is at cap. The dropped entry's pending payload is published
 * synchronously so the value is not silently lost - the caller's
 * trailing-edge contract still holds for that topic, just earlier than
 * its scheduled fire time.
 *
 * @param {Map<string, { timer: any, pending: { platform: any, event: string, data: any } | null }>} topics
 * @param {number} maxTopics
 */
function evictOldestIfAtCap(topics, maxTopics) {
	if (topics.size < maxTopics) return;
	const oldestKey = topics.keys().next().value;
	if (oldestKey === undefined) return;
	const state = topics.get(oldestKey);
	if (state) {
		if (state.timer) clearTimeout(state.timer);
		if (state.pending) {
			const p = state.pending;
			try { p.platform.publish(oldestKey, p.event, p.data); } catch {}
		}
	}
	topics.delete(oldestKey);
}

/**
 * Create a throttled publisher.
 *
 * Sends the first publish immediately (leading edge), then at most once
 * per interval after that (trailing edge). Within each interval, only
 * the latest value is kept - earlier values are discarded.
 *
 * Rate limiting is per-topic: different topics have independent timers.
 *
 * Caveat: the pending slot is per-topic, so for multi-publisher streams
 * (many users emitting into one shared topic) fast publishers will
 * overwrite slow publishers' pending payloads - slow publishers' updates
 * almost never reach subscribers. The fix is to aggregate at the server
 * (e.g. world-state tick: maintain `Map<publisher, latest>` and publish
 * snapshots on a fixed cadence) rather than throttling per-move broadcasts
 * directly. See `bench/28-throttle-per-key-ab.mjs` in the repo for the
 * fairness measurement.
 *
 * @param {number} interval - Minimum time (ms) between publishes per topic
 * @param {{ maxTopics?: number }} [options] - `maxTopics` caps the active
 *   topic registry (default 1_000_000). When the cap is reached, the
 *   oldest insertion-order entry is flushed (its pending value publishes
 *   immediately) and dropped, then the new topic is inserted.
 * @returns {import('./server.js').Limiter}
 *
 * @example
 * ```js
 * import { throttle } from 'svelte-adapter-uws/plugins/throttle';
 *
 * const worldTick = throttle(16); // 60 Hz world-state cap per topic
 *
 * // Server maintains the latest cursor position per user and broadcasts
 * // a single world-state snapshot per tick. Per-topic throttle is safe
 * // here because only one source - this aggregator - publishes to the
 * // topic; the multi-publisher trap is sidestepped by aggregating first.
 * const positions = new Map(); // userId -> { x, y }
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   if (msg.type === 'cursor') {
 *     positions.set(ws.getUserData().id, msg.pos);
 *     worldTick.publish(platform, 'cursors:room42', 'world', Object.fromEntries(positions));
 *   }
 * }
 * ```
 */
export function throttle(interval, options) {
	validateInterval(interval, 'throttle');
	const maxTopics = resolveMaxTopics(options, 'throttle');

	/** @type {Map<string, { timer: any, pending: { platform: any, event: string, data: any } | null }>} */
	const topics = new Map();

	return {
		interval,

		publish(platform, topic, event, data) {
			let state = topics.get(topic);
			if (!state) {
				evictOldestIfAtCap(topics, maxTopics);
				state = { timer: null, pending: null };
				topics.set(topic, state);
			}

			if (!state.timer) {
				// Idle: send immediately (leading edge), start cooldown
				platform.publish(topic, event, data);
				state.pending = null;
				state.timer = setTimeout(function tick() {
					if (state.pending) {
						const p = state.pending;
						state.pending = null;
						p.platform.publish(topic, p.event, p.data);
						state.timer = setTimeout(tick, interval);
					} else {
						state.timer = null;
						topics.delete(topic);
					}
				}, interval);
			} else {
				// Cooling down: store latest value (overwrites previous)
				state.pending = { platform, event, data };
			}
		},

		flush(topic) {
			if (topic != null) return flushOne(topics, topic);
			flushAll(topics);
		},

		cancel(topic) {
			if (topic != null) return cancelOne(topics, topic);
			cancelAll(topics);
		}
	};
}

/**
 * Create a debounced publisher.
 *
 * Waits until no publishes have occurred for the full interval duration,
 * then sends the latest value. Each new publish resets the timer.
 *
 * Rate limiting is per-topic: different topics have independent timers.
 *
 * @param {number} interval - Quiet period (ms) before publishing
 * @param {{ maxTopics?: number }} [options] - `maxTopics` caps the active
 *   topic registry (default 1_000_000). When the cap is reached, the
 *   oldest insertion-order entry is flushed (its pending value publishes
 *   immediately) and dropped, then the new topic is inserted.
 * @returns {import('./server.js').Limiter}
 *
 * @example
 * ```js
 * import { debounce } from 'svelte-adapter-uws/plugins/throttle';
 *
 * const typing = debounce(300); // wait for 300ms of silence
 *
 * // In your WebSocket message handler:
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   if (msg.type === 'search') {
 *     typing.publish(platform, 'search-results', 'query', { q: msg.q, user: ws.getUserData().id });
 *   }
 * }
 * ```
 */
export function debounce(interval, options) {
	validateInterval(interval, 'debounce');
	const maxTopics = resolveMaxTopics(options, 'debounce');

	/** @type {Map<string, { timer: any, pending: { platform: any, event: string, data: any } | null }>} */
	const topics = new Map();

	return {
		interval,

		publish(platform, topic, event, data) {
			let state = topics.get(topic);
			if (!state) {
				evictOldestIfAtCap(topics, maxTopics);
				state = { timer: null, pending: null };
				topics.set(topic, state);
			}

			// Always overwrite pending and restart timer
			state.pending = { platform, event, data };
			if (state.timer) clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				const p = state.pending;
				if (p) {
					p.platform.publish(topic, p.event, p.data);
					state.pending = null;
				}
				state.timer = null;
				topics.delete(topic);
			}, interval);
		},

		flush(topic) {
			if (topic != null) return flushOne(topics, topic);
			flushAll(topics);
		},

		cancel(topic) {
			if (topic != null) return cancelOne(topics, topic);
			cancelAll(topics);
		}
	};
}
