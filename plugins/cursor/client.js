/**
 * Client-side cursor helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__cursor:{topic}` channel and maintains
 * a live Map of cursor positions. The server handles throttling and
 * cleanup; this module keeps the client-side state in sync.
 *
 * When `maxAge` is set, cursor entries that haven't received an update
 * within that window are automatically removed. This makes clients
 * self-healing when the server fails to broadcast a `remove` event
 * (e.g. mass disconnects overwhelming Redis cleanup).
 *
 * @module svelte-adapter-uws/plugins/cursor/client
 */

const TOPIC_PREFIX = '__cursor:';

import { on, connect, status } from '../../client.js';
import { writable } from 'svelte/store';

/** @type {Map<string, ReturnType<typeof cursor>>} */
const cursorStores = new Map();

/**
 * Get a reactive store of cursor positions on a topic.
 *
 * Returns a readable Svelte store containing a Map of connection keys
 * to `{ user, data }` objects. The Map updates automatically when
 * cursors move or disconnect.
 *
 * @template UserInfo, Data
 * @param {string} topic - Topic to track cursors on
 * @param {{ maxAge?: number }} [options] - Options
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
 *
 * @example
 * ```svelte
 * <script>
 *   // Self-healing: cursors expire after 30s without movement
 *   const cursors = cursor('canvas', { maxAge: 30_000 });
 * </script>
 * ```
 */
export function cursor(topic, options) {
	const maxAge = options?.maxAge;
	const cacheKey = maxAge > 0 ? topic + '\0' + maxAge : topic;

	const cached = cursorStores.get(cacheKey);
	if (cached) return cached;

	const cursorTopic = TOPIC_PREFIX + topic;

	/** @type {Map<string, { user: any, data: any }>} */
	let cursorMap = new Map();
	/** @type {Map<string, number>} */
	const timestamps = new Map();
	const output = writable(/** @type {Map<string, any>} */ (new Map()));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let statusUnsub = /** @type {(() => void) | null} */ (null);
	/** @type {ReturnType<typeof setInterval> | null} */
	let sweepTimer = null;
	let refCount = 0;
	let cancelled = false;

	function sweep() {
		if (!maxAge || maxAge <= 0) return;
		const cutoff = Date.now() - maxAge;
		let changed = false;
		for (const [key, ts] of timestamps) {
			if (ts < cutoff) {
				timestamps.delete(key);
				if (cursorMap.delete(key)) changed = true;
			}
		}
		if (changed) output.set(new Map(cursorMap));
	}

	function startListening() {
		cancelled = false;
		const source = on(cursorTopic);
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'update' && event.data != null) {
				const { key, user, data } = event.data;
				cursorMap.set(key, { user, data });
				timestamps.set(key, Date.now());
				output.set(new Map(cursorMap));
				return;
			}

			if (event.event === 'snapshot' && Array.isArray(event.data)) {
				cursorMap = new Map();
				timestamps.clear();
				const now = Date.now();
				for (const entry of event.data) {
					const { key, user, data } = entry;
					cursorMap.set(key, { user, data });
					timestamps.set(key, now);
				}
				output.set(new Map(cursorMap));
				return;
			}

			if (event.event === 'bulk' && Array.isArray(event.data)) {
				const now = Date.now();
				for (const entry of event.data) {
					const { key, user, data } = entry;
					cursorMap.set(key, { user, data });
					timestamps.set(key, now);
				}
				output.set(new Map(cursorMap));
				return;
			}

			if (event.event === 'remove' && event.data != null) {
				const { key } = event.data;
				timestamps.delete(key);
				if (cursorMap.delete(key)) {
					output.set(new Map(cursorMap));
				}
			}
		});

		if (maxAge > 0) {
			sweepTimer = setInterval(sweep, Math.max(maxAge / 2, 1000));
		}

		// Request a snapshot of existing cursor positions every time the socket
		// opens (initial connect and reconnects). Without this, the store would
		// miss cursors that appeared while the client was offline.
		statusUnsub = status.subscribe((s) => {
			if (s === 'open' && !cancelled) {
				connect().send({ type: 'cursor-snapshot', topic });
			}
		});
	}

	function stopListening() {
		cancelled = true;
		if (sourceUnsub) {
			sourceUnsub();
			sourceUnsub = null;
		}
		if (statusUnsub) {
			statusUnsub();
			statusUnsub = null;
		}
		if (sweepTimer) {
			clearInterval(sweepTimer);
			sweepTimer = null;
		}
		cursorMap = new Map();
		timestamps.clear();
		// Push the cleared state to the output store so a new subscriber does
		// not see ghost cursors from the previous subscription cycle.
		output.set(new Map());
	}

	const store = {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) {
					stopListening();
					cursorStores.delete(cacheKey);
				}
			};
		}
	};

	cursorStores.set(cacheKey, store);

	// If nothing subscribes before the next microtask, remove the cache entry.
	queueMicrotask(() => {
		if (refCount === 0) cursorStores.delete(cacheKey);
	});

	return store;
}
