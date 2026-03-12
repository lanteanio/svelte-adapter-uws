/**
 * Replay plugin for svelte-adapter-uws.
 *
 * Bridges the gap between SSR data loading and WebSocket client connect.
 * Messages published through the replay buffer are stored with a sequence
 * number so clients connecting after SSR can request a replay of anything
 * they missed.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * wraps the existing platform.publish() and platform.send() APIs.
 *
 * @module svelte-adapter-uws/plugins/replay
 */

/**
 * @typedef {Object} ReplayOptions
 * @property {number} [size=1000] - Max messages per topic in the ring buffer
 * @property {number} [maxTopics=100] - Max number of topics to track (oldest evicted on overflow)
 */

/**
 * @typedef {Object} BufferedMessage
 * @property {number} seq - Sequence number
 * @property {string} topic - Topic name
 * @property {string} event - Event name
 * @property {unknown} data - Event payload
 */

/**
 * @typedef {Object} ReplayBuffer
 * @property {(platform: import('../../index.js').Platform, topic: string, event: string, data?: unknown) => boolean} publish -
 *   Publish a message through the buffer. Stores it with a sequence number, then
 *   calls platform.publish() as normal. Returns the result of platform.publish().
 * @property {(topic: string) => number} seq -
 *   Get the current sequence number for a topic. Returns 0 if no messages have
 *   been published to this topic. Use this in your load() function to pass the
 *   current position to the client.
 * @property {(topic: string, since: number) => BufferedMessage[]} since -
 *   Get all buffered messages for a topic after a given sequence number.
 *   Returns an empty array if the sequence is current or the topic has no buffer.
 * @property {(ws: any, topic: string, sinceSeq: number, platform: import('../../index.js').Platform) => void} replay -
 *   Send buffered messages to a single connection. Call this when a client
 *   subscribes with a sequence number to fill the gap. Sends each missed
 *   message to `__replay:{topic}` with the sequence number embedded, then
 *   an end marker. The client uses these to reconstruct missed state.
 * @property {() => void} clear -
 *   Clear all buffers and reset all sequence numbers.
 * @property {(topic: string) => void} clearTopic -
 *   Clear the buffer and reset the sequence number for a single topic.
 */

/**
 * Create a replay buffer.
 *
 * @param {ReplayOptions} [options]
 * @returns {ReplayBuffer}
 *
 * @example
 * ```js
 * // src/lib/server/replay.js - shared instance
 * import { createReplay } from 'svelte-adapter-uws/plugins/replay';
 * export const replay = createReplay({ size: 500 });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js
 * import { replay } from '$lib/server/replay';
 *
 * export function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *
 *   // Client requests replay after SSR
 *   if (msg.type === 'replay') {
 *     replay.replay(ws, msg.topic, msg.since, platform);
 *     return;
 *   }
 * }
 * ```
 *
 * @example
 * ```js
 * // +page.server.js
 * import { replay } from '$lib/server/replay';
 *
 * export async function load({ platform }) {
 *   const messages = await db.getRecentMessages();
 *   return { messages, seq: replay.seq('chat') };
 * }
 * ```
 *
 * @example
 * ```js
 * // +page.server.js (form action that publishes)
 * import { replay } from '$lib/server/replay';
 *
 * export const actions = {
 *   send: async ({ request, platform }) => {
 *     const data = Object.fromEntries(await request.formData());
 *     const msg = await db.createMessage(data);
 *     replay.publish(platform, 'chat', 'created', msg);
 *   }
 * };
 * ```
 */
export function createReplay(options = {}) {
	if (options.size !== undefined) {
		if (typeof options.size !== 'number' || options.size < 1 || !Number.isInteger(options.size)) {
			throw new Error(`replay: size must be a positive integer, got ${options.size}`);
		}
	}
	if (options.maxTopics !== undefined) {
		if (typeof options.maxTopics !== 'number' || options.maxTopics < 1 || !Number.isInteger(options.maxTopics)) {
			throw new Error(`replay: maxTopics must be a positive integer, got ${options.maxTopics}`);
		}
	}

	const maxSize = options.size || 1000;
	const maxTopics = options.maxTopics || 100;

	/**
	 * Per-topic state: sequence counter + ring buffer.
	 * @type {Map<string, { seq: number, buf: BufferedMessage[], start: number, len: number }>}
	 */
	const topics = new Map();

	/** @type {string[]} - Topic insertion order for LRU eviction */
	const topicOrder = [];

	/**
	 * Get or create topic state.
	 * @param {string} topic
	 */
	function getTopic(topic) {
		let state = topics.get(topic);
		if (!state) {
			// Evict oldest topic if at capacity
			if (topics.size >= maxTopics) {
				const oldest = topicOrder.shift();
				if (oldest) topics.delete(oldest);
			}
			state = { seq: 0, buf: new Array(maxSize), start: 0, len: 0 };
			topics.set(topic, state);
			topicOrder.push(topic);
		}
		return state;
	}

	/**
	 * Push a message into the ring buffer.
	 * @param {{ seq: number, buf: BufferedMessage[], start: number, len: number }} state
	 * @param {BufferedMessage} msg
	 */
	function pushMessage(state, msg) {
		const idx = (state.start + state.len) % maxSize;
		state.buf[idx] = msg;
		if (state.len < maxSize) {
			state.len++;
		} else {
			// Buffer full - overwrite oldest, advance start
			state.start = (state.start + 1) % maxSize;
		}
	}

	/**
	 * Read messages from the buffer after a given sequence number.
	 * @param {{ seq: number, buf: BufferedMessage[], start: number, len: number }} state
	 * @param {number} since
	 * @returns {BufferedMessage[]}
	 */
	function readSince(state, since) {
		if (state.len === 0 || since >= state.seq) return [];

		const result = [];
		for (let i = 0; i < state.len; i++) {
			const entry = state.buf[(state.start + i) % maxSize];
			if (entry.seq > since) {
				result.push(entry);
			}
		}
		return result;
	}

	return {
		publish(platform, topic, event, data) {
			const state = getTopic(topic);
			state.seq++;
			pushMessage(state, { seq: state.seq, topic, event, data });
			return platform.publish(topic, event, data);
		},

		seq(topic) {
			const state = topics.get(topic);
			return state ? state.seq : 0;
		},

		since(topic, since) {
			const state = topics.get(topic);
			if (!state) return [];
			return readSince(state, since);
		},

		replay(ws, topic, sinceSeq, platform) {
			const state = topics.get(topic);
			if (!state) {
				// No buffer for this topic - just send end marker
				platform.send(ws, '__replay:' + topic, 'end', null);
				return;
			}
			const missed = readSince(state, sinceSeq);
			const replayTopic = '__replay:' + topic;
			for (let i = 0; i < missed.length; i++) {
				const msg = missed[i];
				platform.send(ws, replayTopic, 'msg', {
					seq: msg.seq,
					event: msg.event,
					data: msg.data
				});
			}
			platform.send(ws, replayTopic, 'end', null);
		},

		clear() {
			topics.clear();
			topicOrder.length = 0;
		},

		clearTopic(topic) {
			topics.delete(topic);
			const idx = topicOrder.indexOf(topic);
			if (idx !== -1) topicOrder.splice(idx, 1);
		}
	};
}
