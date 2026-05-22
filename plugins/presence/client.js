/**
 * Client-side presence helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__presence:{topic}` channel and maintains
 * a live list of who's connected. The server handles join/leave tracking;
 * this module just keeps the client-side state in sync.
 *
 * When `maxAge` is set, entries that haven't been refreshed (via `list`
 * or `join` events) within that window are automatically removed. This
 * makes clients self-healing when the server fails to broadcast a `leave`
 * event (e.g. mass disconnects overwhelming Redis cleanup).
 *
 * @module svelte-adapter-uws/plugins/presence/client
 */

const TOPIC_PREFIX = '__presence:';

import { on, connect, status } from '../../client.js';
import { writable } from 'svelte/store';

/** @type {Map<string, { subscribe: (fn: Function) => (() => void) }>} */
const presenceStores = new Map();

/**
 * Get a reactive store of users present on a topic.
 *
 * Returns a readable Svelte store containing an array of user data objects.
 * The array updates automatically when users join or leave.
 *
 * Memoized by topic + maxAge: calling `presence('room', { maxAge: 90000 })`
 * multiple times (e.g. from `$derived`) returns the same store instance,
 * preventing flickering.
 *
 * You must also subscribe to the topic itself (via `on()`, `crud()`, etc.)
 * for the server's `subscribe` hook to fire and register your presence.
 * If you only need to observe presence without joining, use `sync()` on
 * the server side instead.
 *
 * @template T
 * @param {string} topic - Topic to track presence on
 * @param {{ maxAge?: number }} [options] - Options
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
 *
 * @example
 * ```svelte
 * <script>
 *   // Self-healing: entries expire after 90s without a refresh
 *   const users = presence('room', { maxAge: 90_000 });
 * </script>
 * ```
 */
export function presence(topic, options) {
	const maxAge = options?.maxAge;
	const cacheKey = maxAge > 0 ? topic + '\0' + maxAge : topic;

	const cached = presenceStores.get(cacheKey);
	if (cached) return cached;

	const presenceTopic = TOPIC_PREFIX + topic;

	/** @type {Map<string, any>} */
	let userMap = new Map();
	/** @type {Map<string, number>} */
	const timestamps = new Map();
	const output = writable(/** @type {any[]} */ ([]));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let statusUnsub = /** @type {(() => void) | null} */ (null);
	/** @type {ReturnType<typeof setInterval> | null} */
	let sweepTimer = null;
	let refCount = 0;
	let cancelled = false;

	function flush() {
		output.set([...userMap.values()]);
	}

	function sweep() {
		if (!maxAge || maxAge <= 0) return;
		const cutoff = Date.now() - maxAge;
		let changed = false;
		for (const [key, ts] of timestamps) {
			if (ts < cutoff) {
				timestamps.delete(key);
				if (userMap.delete(key)) changed = true;
			}
		}
		if (changed) flush();
	}

	function startListening() {
		cancelled = false;
		// Fresh on() call each time - the underlying writable in client.js
		// is cleaned up on full unsubscribe, so a stale reference would
		// silently stop receiving events.
		const source = on(presenceTopic);
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'presence_state' && event.data && typeof event.data === 'object') {
				userMap = new Map();
				timestamps.clear();
				const now = Date.now();
				for (const [key, data] of Object.entries(event.data)) {
					userMap.set(key, data);
					timestamps.set(key, now);
				}
				flush();
				return;
			}

			if (event.event === 'presence_diff' && event.data && typeof event.data === 'object') {
				const { joins, leaves } = event.data;
				const now = Date.now();
				let changed = false;
				// Apply leaves first so a leave-then-rejoin in the same diff
				// (rare) ends with the user present.
				if (leaves && typeof leaves === 'object') {
					for (const key of Object.keys(leaves)) {
						timestamps.delete(key);
						if (userMap.delete(key)) changed = true;
					}
				}
				if (joins && typeof joins === 'object') {
					for (const [key, data] of Object.entries(joins)) {
						timestamps.set(key, now);
						const prev = userMap.get(key);
						if (prev !== data) {
							userMap.set(key, data);
							changed = true;
						}
					}
				}
				if (changed) flush();
				return;
			}

			if (event.event === 'heartbeat') {
				const now = Date.now();
				let changed = false;
				if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
					// New shape: `{userKey: data}` map. Refresh existing AND
					// re-add any entry that aged out between heartbeats. The
					// older "refresh existing only" branch (below) could not
					// recover entries the local sweep had already removed -
					// once an entry aged out, the next heartbeat couldn't
					// bring it back and the user stayed missing until a
					// presence_diff or presence_state arrived.
					for (const [key, data] of Object.entries(event.data)) {
						timestamps.set(key, now);
						const prev = userMap.get(key);
						if (prev !== data) {
							userMap.set(key, data);
							changed = true;
						}
					}
				} else if (Array.isArray(event.data)) {
					// Back-compat: keys-only heartbeat (older server). Refresh
					// existing entries; cannot recover aged-out ones from this
					// shape. The presence_diff / presence_state reconciliation
					// path still corrects missing entries on the next event.
					for (const key of event.data) {
						if (timestamps.has(key)) {
							timestamps.set(key, now);
						}
					}
				}
				if (changed) flush();
				return;
			}
		});

		if (maxAge > 0) {
			sweepTimer = setInterval(sweep, Math.max(maxAge / 2, 1000));
		}

		// Request a presence snapshot every time the socket opens (initial
		// connect AND reconnects). Without this, a reconnecting client
		// missed any presence_diff frames that fired during the disconnect
		// window and its in-memory map stayed at whatever it last knew.
		// Symmetric to the cursor plugin's `cursor-snapshot` send.
		statusUnsub = status.subscribe((s) => {
			if (s === 'open' && !cancelled) {
				connect().send({ type: 'presence-snapshot', topic });
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
		userMap = new Map();
		timestamps.clear();
		output.set([]);
	}

	const store = {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) {
					stopListening();
					presenceStores.delete(cacheKey);
				}
			};
		}
	};

	presenceStores.set(cacheKey, store);

	// If nothing subscribes before the next microtask, remove the cache entry.
	// This bounds memory use when code creates presence stores for many distinct
	// topics and then drops them without ever subscribing.
	queueMicrotask(() => {
		if (refCount === 0) presenceStores.delete(cacheKey);
	});

	return store;
}
