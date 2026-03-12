import type { Platform } from '../../index.js';

export interface Limiter {
	/** The configured interval in milliseconds. */
	readonly interval: number;

	/**
	 * Publish an event, subject to rate limiting.
	 *
	 * For throttle: sends immediately on first call, then at most once
	 * per interval (latest value wins).
	 *
	 * For debounce: waits until no calls for the full interval, then
	 * sends the latest value.
	 *
	 * @param platform - The platform object from SvelteKit's event
	 * @param topic - Topic to publish to
	 * @param event - Event name
	 * @param data - Payload
	 */
	publish(platform: Platform, topic: string, event: string, data?: unknown): void;

	/**
	 * Send all pending data immediately and clear timers.
	 *
	 * Call with no arguments to flush all topics, or pass a topic
	 * string to flush just that one.
	 *
	 * @example
	 * ```js
	 * mouse.flush();          // flush everything
	 * mouse.flush('cursors'); // flush just 'cursors'
	 * ```
	 */
	flush(topic?: string): void;

	/**
	 * Discard all pending data and clear timers without sending.
	 *
	 * Call with no arguments to cancel all topics, or pass a topic
	 * string to cancel just that one.
	 *
	 * @example
	 * ```js
	 * mouse.cancel();          // cancel everything
	 * mouse.cancel('cursors'); // cancel just 'cursors'
	 * ```
	 */
	cancel(topic?: string): void;
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
 * @param interval - Minimum time (ms) between publishes per topic
 *
 * @example
 * ```js
 * import { throttle } from 'svelte-adapter-uws/plugins/throttle';
 *
 * const mouse = throttle(50);
 *
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   mouse.publish(platform, 'cursors', 'move', msg.pos);
 * }
 * ```
 */
export function throttle(interval: number): Limiter;

/**
 * Create a debounced publisher.
 *
 * Waits until no publishes have occurred for the full interval duration,
 * then sends the latest value. Each new publish resets the timer.
 *
 * Rate limiting is per-topic: different topics have independent timers.
 *
 * @param interval - Quiet period (ms) before publishing
 *
 * @example
 * ```js
 * import { debounce } from 'svelte-adapter-uws/plugins/throttle';
 *
 * const typing = debounce(300);
 *
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   typing.publish(platform, 'search', 'query', { q: msg.q });
 * }
 * ```
 */
export function debounce(interval: number): Limiter;
