import type { TopicStore, WSEvent } from '../../client.js';

export interface OnReplayOptions {
	/**
	 * The sequence number from your `load()` function.
	 * This tells the server where to start replaying from.
	 *
	 * Get this value from `replay.seq('topic')` on the server side.
	 */
	since: number;
}

/**
 * Subscribe to a topic with replay support.
 *
 * Works exactly like `on(topic)` from `svelte-adapter-uws/client` but also
 * requests a replay of messages the client missed between SSR and WebSocket
 * connect. During the replay window, live messages are held back. Once the
 * server signals replay is done, the store switches to live mode with no gaps.
 *
 * @param topic - Topic to subscribe to
 * @param options - Must include `since` (the sequence number from your load function)
 *
 * @example
 * ```svelte
 * <script>
 *   import { onReplay } from 'svelte-adapter-uws/plugins/replay/client';
 *   let { data } = $props();
 *
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
export function onReplay<T = unknown>(
	topic: string,
	options: OnReplayOptions
): TopicStore<WSEvent<T>>;
