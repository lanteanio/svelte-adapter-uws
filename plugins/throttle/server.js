/**
 * Throttle/debounce plugin for svelte-adapter-uws.
 *
 * Per-topic publish rate limiting. Wraps platform.publish() to coalesce
 * rapid-fire updates (e.g. mouse position, typing indicators). Sends the
 * latest value at most once per interval. Prevents flooding without the
 * user having to implement timers.
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
 * Create a throttled publisher.
 *
 * Sends the first publish immediately (leading edge), then at most once
 * per interval after that (trailing edge). Within each interval, only
 * the latest value is kept -- earlier values are discarded.
 *
 * Rate limiting is per-topic: different topics have independent timers.
 *
 * @param {number} interval - Minimum time (ms) between publishes per topic
 * @returns {import('./server.js').Limiter}
 *
 * @example
 * ```js
 * import { throttle } from 'svelte-adapter-uws/plugins/throttle';
 *
 * const mouse = throttle(50); // at most once per 50ms per topic
 *
 * // In your WebSocket message handler:
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   if (msg.type === 'cursor') {
 *     mouse.publish(platform, 'cursors', 'move', { userId: ws.getUserData().id, ...msg.pos });
 *   }
 * }
 * ```
 */
export function throttle(interval) {
	validateInterval(interval, 'throttle');

	/** @type {Map<string, { timer: any, pending: { platform: any, event: string, data: any } | null }>} */
	const topics = new Map();

	return {
		interval,

		publish(platform, topic, event, data) {
			let state = topics.get(topic);
			if (!state) {
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
export function debounce(interval) {
	validateInterval(interval, 'debounce');

	/** @type {Map<string, { timer: any, pending: { platform: any, event: string, data: any } | null }>} */
	const topics = new Map();

	return {
		interval,

		publish(platform, topic, event, data) {
			let state = topics.get(topic);
			if (!state) {
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
