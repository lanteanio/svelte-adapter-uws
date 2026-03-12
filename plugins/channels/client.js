/**
 * Client-side typed channels for svelte-adapter-uws.
 *
 * Scopes a topic's event subscriptions into a single object and validates
 * event names at call time. The runtime behavior is identical to calling
 * `on()` directly -- this is a convenience wrapper that catches typos
 * early and keeps topic strings DRY.
 *
 * @module svelte-adapter-uws/plugins/channels/client
 */

import { on } from '../../client.js';

/**
 * Create a client-side typed channel for a topic.
 *
 * If you pass an `events` array, calling `.on(event)` with an unknown
 * event name throws immediately instead of silently subscribing to
 * a misspelled event that never fires.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {string[]} [events] - Allowed event names (omit to skip validation)
 * @returns {import('./client.js').ClientChannel<T>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { channel } from 'svelte-adapter-uws/plugins/channels/client';
 *
 *   const todos = channel('todos', ['created', 'updated', 'deleted']);
 *
 *   const all     = todos.on();          // all events (same as on('todos'))
 *   const created = todos.on('created'); // filtered  (same as on('todos', 'created'))
 *   const typo    = todos.on('craeted'); // throws Error immediately
 * </script>
 * ```
 */
export function channel(topic, events) {
	const eventSet = events ? new Set(events) : null;

	return {
		/** The topic this channel subscribes to. */
		topic,

		/** The valid event names (if provided at creation). */
		events: events || null,

		/**
		 * Get a reactive store for this channel's topic.
		 *
		 * @param {string} [event] - Filter to a specific event name
		 */
		on(event) {
			if (event != null && eventSet && !eventSet.has(event)) {
				throw new Error(
					`channel "${topic}": unknown event "${event}". Valid events: ${[...eventSet].join(', ')}`
				);
			}
			return event != null ? on(topic, event) : on(topic);
		}
	};
}
