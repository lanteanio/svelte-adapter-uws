/**
 * Client-side presence helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__presence:{topic}` channel and maintains
 * a live list of who's connected. The server handles join/leave tracking;
 * this module just keeps the client-side state in sync.
 *
 * @module svelte-adapter-uws/plugins/presence/client
 */

import { on } from '../../client.js';
import { writable } from 'svelte/store';

/**
 * Get a reactive store of users present on a topic.
 *
 * Returns a readable Svelte store containing an array of user data objects.
 * The array updates automatically when users join or leave.
 *
 * You must also subscribe to the topic itself (via `on()`, `crud()`, etc.)
 * for the server's `subscribe` hook to fire and register your presence.
 * If you only need to observe presence without joining, use `sync()` on
 * the server side instead.
 *
 * @template T
 * @param {string} topic - Topic to track presence on
 * @returns {import('svelte/store').Readable<T[]>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { on } from 'svelte-adapter-uws/client';
 *   import { presence } from 'svelte-adapter-uws/plugins/presence/client';
 *
 *   const messages = on('room');
 *   const users = presence('room');
 * </script>
 *
 * <aside>
 *   <h3>{$users.length} online</h3>
 *   {#each $users as user (user.id)}
 *     <span>{user.name}</span>
 *   {/each}
 * </aside>
 * ```
 */
export function presence(topic) {
	const presenceTopic = '__presence:' + topic;
	const source = on(presenceTopic);

	/** @type {Map<string, any>} */
	let userMap = new Map();
	const output = writable(/** @type {any[]} */ ([]));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let refCount = 0;

	function startListening() {
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'list' && Array.isArray(event.data)) {
				userMap = new Map();
				for (const entry of event.data) {
					userMap.set(entry.key, entry.data);
				}
				output.set([...userMap.values()]);
				return;
			}

			if (event.event === 'join' && event.data != null) {
				const { key, data } = event.data;
				if (!userMap.has(key)) {
					userMap.set(key, data);
					output.set([...userMap.values()]);
				}
				return;
			}

			if (event.event === 'leave' && event.data != null) {
				const { key } = event.data;
				if (userMap.delete(key)) {
					output.set([...userMap.values()]);
				}
			}
		});
	}

	function stopListening() {
		if (sourceUnsub) {
			sourceUnsub();
			sourceUnsub = null;
		}
		userMap = new Map();
	}

	return {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) stopListening();
			};
		}
	};
}
