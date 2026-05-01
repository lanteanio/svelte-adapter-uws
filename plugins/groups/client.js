/**
 * Client-side group helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__group:{name}` channel. The server-side
 * hooks helper intercepts this to call join(), gating access. Exposes
 * two reactive stores: one for messages and one for the member list.
 * The server handles membership, roles, and lifecycle; this module
 * keeps the client-side state in sync.
 *
 * @module svelte-adapter-uws/plugins/groups/client
 */

import { on } from '../../client.js';
import { writable } from 'svelte/store';

const TOPIC_PREFIX = '__group:';

/** @type {Map<string, ReturnType<typeof group>>} */
const groupStores = new Map();

/**
 * Get a reactive group store.
 *
 * Returns an object with a `subscribe` method (latest event) and a
 * `members` sub-store (current member list).
 *
 * @param {string} name - Group name
 * @returns {{ subscribe: (fn: Function) => (() => void), members: import('svelte/store').Readable<Array<{ role: string }>> }}
 *
 * @example
 * ```svelte
 * <script>
 *   import { group } from 'svelte-adapter-uws/plugins/groups/client';
 *
 *   const lobby = group('lobby');
 *   const members = lobby.members;
 * </script>
 *
 * <p>{$members.length} members</p>
 *
 * {#each $members as m}
 *   <span>{m.role}</span>
 * {/each}
 * ```
 */
export function group(name) {
	const cached = groupStores.get(name);
	if (cached) return cached;

	const groupTopic = TOPIC_PREFIX + name;

	const membersStore = writable(/** @type {Array<{ role: string }>} */ ([]));
	const messagesStore = writable(/** @type {any} */ (null));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let refCount = 0;

	function startListening() {
		// Call on() fresh each time. When all subscribers unsubscribe, the
		// client store deletes the underlying writable for that topic. A cached
		// reference would be stale and stop receiving events on resubscribe.
		const source = on(groupTopic);
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'members' && Array.isArray(event.data)) {
				membersStore.set(event.data);
				return;
			}

			if (event.event === 'join' && event.data && event.data.role) {
				membersStore.update((list) => [...list, { role: event.data.role }]);
				messagesStore.set(event);
				return;
			}

			if (event.event === 'leave' && event.data && event.data.role) {
				membersStore.update((list) => {
					const idx = list.findIndex((m) => m.role === event.data.role);
					if (idx === -1) return list;
					const next = list.slice();
					next.splice(idx, 1);
					return next;
				});
				messagesStore.set(event);
				return;
			}

			if (event.event === 'close') {
				membersStore.set([]);
				messagesStore.set(event);
				return;
			}

			// All other events (user messages) go to messages
			messagesStore.set(event);
		});
	}

	function stopListening() {
		if (sourceUnsub) {
			sourceUnsub();
			sourceUnsub = null;
		}
		// Clear stores so a new subscriber doesn't see stale data from the
		// previous subscription cycle before the server sends fresh events.
		membersStore.set([]);
		messagesStore.set(null);
	}

	const store = {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = messagesStore.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) {
					stopListening();
					groupStores.delete(name);
				}
			};
		},

		members: {
			subscribe(fn) {
				if (refCount++ === 0) startListening();
				const unsub = membersStore.subscribe(fn);
				return () => {
					unsub();
					if (--refCount === 0) {
						stopListening();
						groupStores.delete(name);
					}
				};
			}
		}
	};

	groupStores.set(name, store);

	// If nothing subscribes before the next microtask, remove the cache entry.
	// This bounds memory use when code creates group stores for many distinct
	// names and then drops them without ever subscribing.
	queueMicrotask(() => {
		if (refCount === 0) groupStores.delete(name);
	});

	return store;
}
