import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface ReplayOptions {
	/**
	 * Max messages per topic in the ring buffer.
	 * When full, oldest messages are overwritten.
	 * @default 1000
	 */
	size?: number;

	/**
	 * Max number of topics to track.
	 * Oldest topic is evicted when this limit is reached.
	 * @default 100
	 */
	maxTopics?: number;
}

export interface BufferedMessage {
	/** Sequence number (monotonically increasing per topic). */
	seq: number;
	/** Topic name. */
	topic: string;
	/** Event name. */
	event: string;
	/** Event payload. */
	data: unknown;
}

export interface ReplayBuffer {
	/**
	 * Publish a message through the buffer. Stores it with a sequence number,
	 * then calls `platform.publish()` as normal.
	 *
	 * Use this instead of `platform.publish()` for any topic you want
	 * replay support on.
	 *
	 * @returns The result of `platform.publish()`.
	 */
	publish(platform: Platform, topic: string, event: string, data?: unknown): boolean;

	/**
	 * Get the current sequence number for a topic.
	 * Returns `0` if no messages have been published to this topic.
	 *
	 * Pass this to the client via your `load()` function.
	 *
	 * @example
	 * ```js
	 * export async function load({ platform }) {
	 *   return { items: await db.getItems(), seq: replay.seq('items') };
	 * }
	 * ```
	 */
	seq(topic: string): number;

	/**
	 * Get all buffered messages for a topic after a given sequence number.
	 * Returns an empty array if the sequence is current or the topic has no buffer.
	 */
	since(topic: string, since: number): BufferedMessage[];

	/**
	 * Send buffered messages to a single connection to fill the SSR gap.
	 *
	 * Call this in your WebSocket `message` handler when the client sends
	 * a replay request. Messages are sent on `__replay:{topic}` with an
	 * end marker so the client knows when to switch to live mode.
	 *
	 * @example
	 * ```js
	 * export function message(ws, { data, platform }) {
	 *   const msg = JSON.parse(Buffer.from(data).toString());
	 *   if (msg.type === 'replay') {
	 *     replay.replay(ws, msg.topic, msg.since, platform);
	 *     return;
	 *   }
	 * }
	 * ```
	 */
	replay(ws: WebSocket<any>, topic: string, sinceSeq: number, platform: Platform): void;

	/** Clear all buffers and reset all sequence numbers. */
	clear(): void;

	/** Clear the buffer and reset the sequence number for a single topic. */
	clearTopic(topic: string): void;
}

/**
 * Create a replay buffer for bridging the SSR-to-WebSocket gap.
 *
 * @example
 * ```js
 * import { createReplay } from 'svelte-adapter-uws/plugins/replay';
 *
 * export const replay = createReplay({ size: 500 });
 * ```
 */
export function createReplay(options?: ReplayOptions): ReplayBuffer;
