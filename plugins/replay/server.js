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
 * MULTI-TENANT NOTE
 * The replay buffer is keyed by the topic name verbatim. In a single-
 * process multi-tenant deployment, two tenants publishing to the same
 * topic name share the SAME replay buffer; tenant A's reconnects can
 * pick up tenant B's messages. Apps must namespace topic names with
 * tenant scope. Same recommendation for the `presence`, `groups`, and
 * `cursor` plugins.
 *
 * @module svelte-adapter-uws/plugins/replay
 */

const TOPIC_PREFIX = '__replay:';

/**
 * @typedef {Object} ReplayOptions
 * @property {number} [size=1000] - Max messages per topic in the ring buffer
 * @property {number} [maxTopics=100] - Max number of topics to track (least recently used topic evicted on overflow)
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

	/** @type {Map<string, null>} - LRU order (first key = least recently used, last = most recently used) */
	const topicOrder = new Map();

	/**
	 * Touch a topic in the LRU order without creating it. Call this from read
	 * operations (seq, since, replay) so topics under active use are not evicted
	 * while cold topics with earlier creation times are still around.
	 * @param {string} topic
	 */
	function touchTopic(topic) {
		if (!topics.has(topic)) return;
		topicOrder.delete(topic);
		topicOrder.set(topic, null);
	}

	/**
	 * Get or create topic state. Touches the LRU order so recently accessed topics
	 * are not evicted before cold ones.
	 * @param {string} topic
	 */
	function getTopic(topic) {
		let state = topics.get(topic);
		if (!state) {
			// Evict least-recently-used topic if at capacity
			if (topics.size >= maxTopics) {
				const lru = topicOrder.keys().next().value;
				if (lru !== undefined) {
					topics.delete(lru);
					topicOrder.delete(lru);
				}
			}
			state = { seq: 0, buf: new Array(maxSize), start: 0, len: 0 };
			topics.set(topic, state);
			topicOrder.set(topic, null);
		} else {
			// Move to most-recently-used end so this topic is evicted last
			topicOrder.delete(topic);
			topicOrder.set(topic, null);
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
			let snapshot = data;
			if (data != null && typeof data === 'object') {
				try { snapshot = structuredClone(data); } catch { snapshot = JSON.parse(JSON.stringify(data)); }
			}
			pushMessage(state, { seq: state.seq, topic, event, data: snapshot });
			return platform.publish(topic, event, data);
		},

		seq(topic) {
			touchTopic(topic);
			const state = topics.get(topic);
			return state ? state.seq : 0;
		},

		since(topic, since) {
			touchTopic(topic);
			const state = topics.get(topic);
			if (!state) return [];
			return readSince(state, since);
		},

		replay(ws, topic, sinceSeq, platform, reqId) {
			touchTopic(topic);
			const state = topics.get(topic);
			if (!state) {
				// No buffer for this topic - just send end marker
				platform.send(ws, TOPIC_PREFIX + topic, 'end', reqId != null ? { reqId } : null);
				return;
			}
			const missed = readSince(state, sinceSeq);
			const replayTopic = TOPIC_PREFIX + topic;
			for (let i = 0; i < missed.length; i++) {
				const msg = missed[i];
				platform.send(ws, replayTopic, 'msg', reqId != null
					? { reqId, seq: msg.seq, event: msg.event, data: msg.data }
					: { seq: msg.seq, event: msg.event, data: msg.data }
				);
			}
			// Detect whether the buffer covers sinceSeq completely.
			// If the oldest retained message has seq > sinceSeq + 1, the buffer
			// was overwritten before the client connected and some messages are lost.
			// Signal this via the end payload so callers can show a "missed events"
			// warning or trigger a full data reload instead of silently continuing.
			const oldestSeq = state.len > 0 ? state.buf[state.start].seq : null;
			const truncated = oldestSeq !== null && oldestSeq > sinceSeq + 1;
			if (reqId != null) {
				platform.send(ws, replayTopic, 'end', truncated ? { reqId, truncated: true } : { reqId });
			} else {
				platform.send(ws, replayTopic, 'end', truncated ? { truncated: true } : null);
			}
		},

		clear() {
			topics.clear();
			topicOrder.clear();
		},

		clearTopic(topic) {
			topics.delete(topic);
			topicOrder.delete(topic);
		}
	};
}
