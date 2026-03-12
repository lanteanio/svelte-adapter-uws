import type { Readable } from 'svelte/store';
import type { WSEvent, TopicStore } from '../../client.js';

export interface ClientChannel<T = unknown> {
	/** The topic this channel subscribes to. */
	readonly topic: string;

	/** The valid event names (if provided at creation), or null. */
	readonly events: string[] | null;

	/**
	 * Get a reactive store for all events on this channel's topic.
	 *
	 * Same as `on(topic)` from the client library.
	 */
	on(): TopicStore<WSEvent<T>>;

	/**
	 * Get a reactive store filtered to a specific event.
	 *
	 * Same as `on(topic, event)` from the client library.
	 * Throws if the event name was not in the `events` array
	 * passed to `channel()`.
	 */
	on<E extends string>(event: E): TopicStore<{ data: T }>;
}

/**
 * Create a client-side typed channel for a topic.
 *
 * Scopes event subscriptions into a single object and validates
 * event names at call time. If you pass an `events` array, calling
 * `.on(event)` with an unknown name throws immediately instead of
 * silently subscribing to a misspelled event that never fires.
 *
 * @param topic - Topic to subscribe to
 * @param events - Allowed event names (omit to skip validation)
 *
 * @example
 * ```svelte
 * <script>
 *   import { channel } from 'svelte-adapter-uws/plugins/channels/client';
 *
 *   const todos = channel('todos', ['created', 'updated', 'deleted']);
 *
 *   const all     = todos.on();          // all events
 *   const created = todos.on('created'); // just 'created' events
 * </script>
 *
 * {#each $created as todo}
 *   <p>New: {todo.data.text}</p>
 * {/each}
 * ```
 */
export function channel<T = unknown>(
	topic: string,
	events?: string[]
): ClientChannel<T>;
