/**
 * Client-side replay helper for svelte-adapter-uws.
 *
 * Wraps the existing client `on()` store to handle the SSR-to-WebSocket
 * handoff gap. Pass the sequence number from your load() function and
 * this module requests a replay of missed messages from the server.
 *
 * How it works:
 * 1. Subscribes to the real topic for live messages
 * 2. Sends a replay request to the server with the SSR sequence number
 * 3. Server sends missed messages on `__replay:{topic}`, then an end marker
 * 4. During replay, live messages on the real topic are dropped (the replay
 *    covers them - the replay function on the server is synchronous, so no
 *    messages can be published between the last replayed message and the end
 *    marker)
 * 5. After the end marker, the store switches to live mode
 *
 * @module svelte-adapter-uws/plugins/replay/client
 */

import { on, connect, ready } from '../../client.js';
import { writable } from 'svelte/store';

/**
 * Subscribe to a topic with replay support.
 *
 * Works exactly like `on(topic)` but also requests a replay of messages
 * the client missed between SSR and WebSocket connect. During the replay
 * window, live messages are held back. Once the server signals replay is
 * done, the store switches to live mode with no gaps.
 *
 * @param {string} topic - Topic to subscribe to
 * @param {{ since: number }} options - `since` is the sequence number from your load() function
 * @returns {import('../../client.js').TopicStore<import('../../client.js').WSEvent>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { onReplay } from 'svelte-adapter-uws/plugins/replay/client';
 *   let { data } = $props();
 *
 *   // data.seq comes from replay.seq('chat') in your load() function
 *   const chat = onReplay('chat', { since: data.seq });
 * </script>
 *
 * {#if $chat}
 *   <p>{$chat.event}: {JSON.stringify($chat.data)}</p>
 * {/if}
 * ```
 *
 * @example With .scan() for accumulating state:
 * ```svelte
 * <script>
 *   import { onReplay } from 'svelte-adapter-uws/plugins/replay/client';
 *   import { crud } from 'svelte-adapter-uws/client';
 *   let { data } = $props();
 *
 *   const messages = onReplay('chat', { since: data.seq }).scan(
 *     data.messages,
 *     (list, { event, data }) => {
 *       if (event === 'created') return [...list, data];
 *       return list;
 *     }
 *   );
 * </script>
 * ```
 */
export function onReplay(topic, options) {
	if (!options || typeof options.since !== 'number') {
		throw new Error('onReplay: options.since must be a number (the sequence from your load function)');
	}

	const since = options.since;

	// Output store - what the user subscribes to
	/** @type {import('svelte/store').Writable<import('../../client.js').WSEvent | null>} */
	const output = writable(null);

	let replayDone = false;
	let storeUnsub = /** @type {(() => void) | null} */ (null);
	let replayUnsub = /** @type {(() => void) | null} */ (null);
	let refCount = 0;

	function startListening() {
		const liveStore = on(topic);
		const replayStore = on('__replay:' + topic);

		// Subscribe to the live topic - messages are dropped until replay ends
		storeUnsub = liveStore.subscribe((event) => {
			if (event === null || !replayDone) return;
			output.set(event);
		});

		// Subscribe to the replay topic for missed messages + end marker
		replayUnsub = replayStore.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'end') {
				replayDone = true;
				// Clean up the replay subscription - no longer needed
				if (replayUnsub) {
					queueMicrotask(() => {
						replayUnsub?.();
						replayUnsub = null;
					});
				}
				return;
			}

			if (event.event === 'msg' && event.data != null) {
				output.set({
					topic,
					event: event.data.event,
					data: event.data.data
				});
			}
		});

		// Request replay once connected
		ready().then(() => {
			connect().send({ type: 'replay', topic, since });
		});
	}

	function stopListening() {
		if (storeUnsub) { storeUnsub(); storeUnsub = null; }
		if (replayUnsub) { replayUnsub(); replayUnsub = null; }
		replayDone = false;
	}

	/**
	 * Create a .scan() method bound to a source store.
	 * @param {{ subscribe: (fn: (value: any) => void) => () => void }} source
	 */
	function makeScan(source) {
		/**
		 * @template A
		 * @param {A} initial
		 * @param {(acc: A, value: any) => A} reducer
		 * @returns {import('svelte/store').Readable<A>}
		 */
		return function scan(initial, reducer) {
			let acc = initial;
			const accumulated = writable(initial);
			/** @type {(() => void) | null} */
			let sourceUnsub = null;
			let subCount = 0;

			return {
				subscribe(fn) {
					if (subCount === 0) {
						sourceUnsub = source.subscribe((value) => {
							if (value !== null) {
								acc = reducer(acc, value);
								accumulated.set(acc);
							}
						});
					}
					subCount++;
					const unsub = accumulated.subscribe(fn);
					return () => {
						unsub();
						subCount--;
						if (subCount === 0 && sourceUnsub) {
							sourceUnsub();
							sourceUnsub = null;
						}
					};
				}
			};
		};
	}

	const wrapped = {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) stopListening();
			};
		}
	};

	return { subscribe: wrapped.subscribe, scan: makeScan(wrapped) };
}
