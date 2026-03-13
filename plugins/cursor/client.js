/**
 * Client-side cursor helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__cursor:{topic}` channel and maintains
 * a live Map of cursor positions. The server handles throttling and
 * cleanup; this module keeps the client-side state in sync.
 *
 * @module svelte-adapter-uws/plugins/cursor/client
 */

import { on } from '../../client.js';
import { writable } from 'svelte/store';

/**
 * Get a reactive store of cursor positions on a topic.
 *
 * Returns a readable Svelte store containing a Map of connection keys
 * to `{ user, data }` objects. The Map updates automatically when
 * cursors move or disconnect.
 *
 * @template UserInfo, Data
 * @param {string} topic - Topic to track cursors on
 * @returns {import('svelte/store').Readable<Map<string, { user: UserInfo, data: Data }>>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   const cursors = cursor('canvas');
 * </script>
 *
 * {#each [...$cursors] as [key, { user, data }] (key)}
 *   <div style="left: {data.x}px; top: {data.y}px" class="cursor">
 *     {user.name}
 *   </div>
 * {/each}
 * ```
 */
export function cursor(topic) {
	const cursorTopic = '__cursor:' + topic;
	const source = on(cursorTopic);

	/** @type {Map<string, { user: any, data: any }>} */
	let cursorMap = new Map();
	const output = writable(/** @type {Map<string, any>} */ (new Map()));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let refCount = 0;

	function startListening() {
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'update' && event.data != null) {
				const { key, user, data } = event.data;
				cursorMap.set(key, { user, data });
				output.set(new Map(cursorMap));
				return;
			}

			if (event.event === 'remove' && event.data != null) {
				const { key } = event.data;
				if (cursorMap.delete(key)) {
					output.set(new Map(cursorMap));
				}
			}
		});
	}

	function stopListening() {
		if (sourceUnsub) {
			sourceUnsub();
			sourceUnsub = null;
		}
		cursorMap = new Map();
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
