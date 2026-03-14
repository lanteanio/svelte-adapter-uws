/**
 * Presence plugin for svelte-adapter-uws.
 *
 * Tracks which users are connected to which topics and provides live
 * presence lists. Handles multi-tab dedup (same user, multiple connections
 * = one presence entry) via a configurable key field.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * uses ws.subscribe(), platform.publish(), and platform.send().
 *
 * @module svelte-adapter-uws/plugins/presence
 */

/**
 * @typedef {Object} PresenceOptions
 * @property {string} [key='id'] - Field in the selected data that uniquely identifies a user.
 *   Used for multi-tab dedup: if two connections share the same key value, they count as one
 *   presence entry. If the field is missing from the data, each connection is tracked separately.
 * @property {(userData: any) => Record<string, any>} [select] - Function to extract the public
 *   presence data from the connection's userData (whatever your `upgrade` handler returned).
 *   Only the selected fields are broadcast to other clients. Defaults to the full userData.
 *   Use this to avoid leaking private fields like session tokens.
 */

/**
 * @typedef {Object} PresenceTracker
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} join -
 *   Add a connection to a topic's presence. Call this from your `subscribe` hook.
 *   Automatically ignores `__`-prefixed internal topics. Idempotent.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} leave -
 *   Remove a connection from all topics. Call this from your `close` hook.
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} sync -
 *   Send the current presence list to a single connection without joining.
 *   Use this for admin dashboards or observers who want to see presence
 *   without being present themselves.
 * @property {(topic: string) => Record<string, any>[]} list -
 *   Get the current presence list for a topic. Use in load() functions or API routes.
 * @property {(topic: string) => number} count -
 *   Get the number of unique users present on a topic.
 * @property {() => void} clear -
 *   Clear all presence tracking state.
 * @property {{ subscribe: (ws: any, topic: string, ctx: { platform: import('../../index.js').Platform }) => void, close: (ws: any, ctx: { platform: import('../../index.js').Platform }) => void }} hooks -
 *   Ready-made WebSocket hooks. Handles join for regular topics, sync for
 *   __presence:* topics, and leave on close. Spread into hooks.ws.js for
 *   zero-config presence.
 */

/**
 * Create a presence tracker.
 *
 * @param {PresenceOptions} [options]
 * @returns {PresenceTracker}
 *
 * @example
 * ```js
 * // src/lib/server/presence.js
 * import { createPresence } from 'svelte-adapter-uws/plugins/presence';
 *
 * export const presence = createPresence({
 *   key: 'id',
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - zero-config (just spread hooks)
 * import { presence } from '$lib/server/presence';
 *
 * export const { subscribe, close } = presence.hooks;
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - with custom logic
 * import { presence } from '$lib/server/presence';
 *
 * export function subscribe(ws, topic, ctx) {
 *   if (topic === 'vip' && !ws.getUserData().isVip) return false;
 *   presence.hooks.subscribe(ws, topic, ctx);
 * }
 *
 * export const close = presence.hooks.close;
 * ```
 *
 * @example
 * ```js
 * // +page.server.js - server-side presence for SSR
 * import { presence } from '$lib/server/presence';
 *
 * export async function load() {
 *   return { users: presence.list('room'), online: presence.count('room') };
 * }
 * ```
 */
export function createPresence(options = {}) {
	const keyField = options.key || 'id';
	const select = options.select || ((userData) => userData);

	// Auto-generated ID counter for connections without a key field
	let connCounter = 0;

	/**
	 * Per-connection state: which topics they've joined and their key on each.
	 * @type {Map<any, Map<string, { key: string, data: Record<string, any> }>>}
	 */
	const wsTopics = new Map();

	/**
	 * Per-topic presence: Map<key, { data, count }>.
	 * count > 1 means multiple connections share the same key (multi-tab).
	 * @type {Map<string, Map<string, { data: Record<string, any>, count: number }>>}
	 */
	const topicPresence = new Map();

	/**
	 * Resolve the dedup key from selected data.
	 * Falls back to a unique connection ID if the key field is missing.
	 * @param {Record<string, any>} data
	 * @returns {string}
	 */
	function resolveKey(data) {
		if (data && keyField in data && data[keyField] != null) {
			return String(data[keyField]);
		}
		return '__conn:' + (++connCounter);
	}

	/** @type {PresenceTracker} */
	const tracker = {
		join(ws, topic, platform) {
			// Skip internal topics to prevent recursion when the subscribe
			// hook fires for __presence:* subscriptions
			if (topic.startsWith('__')) return;

			// Idempotent: skip if this ws is already on this topic
			let connTopics = wsTopics.get(ws);
			if (connTopics && connTopics.has(topic)) return;

			const data = select(ws.getUserData());
			const key = resolveKey(data);

			// Track per-connection
			if (!connTopics) {
				connTopics = new Map();
				wsTopics.set(ws, connTopics);
			}
			connTopics.set(topic, { key, data });

			// Track per-topic
			let users = topicPresence.get(topic);
			if (!users) {
				users = new Map();
				topicPresence.set(topic, users);
			}

			const presenceTopic = '__presence:' + topic;
			const existing = users.get(key);
			if (existing) {
				// Same user, additional connection (another tab) - just bump count
				existing.count++;
				existing.data = data;
			} else {
				// New user on this topic
				users.set(key, { data, count: 1 });
				// Publish join BEFORE subscribing ws - the joining client
				// doesn't need to see their own join event (they get the
				// full list below). Other clients see the join.
				platform.publish(presenceTopic, 'join', { key, data });
			}

			// Subscribe this ws to the presence channel (server-side, idempotent)
			ws.subscribe(presenceTopic);

			// Send the full current list to this connection
			const list = [];
			for (const [k, entry] of users) {
				list.push({ key: k, data: entry.data });
			}
			platform.send(ws, presenceTopic, 'list', list);
		},

		leave(ws, platform) {
			const connTopics = wsTopics.get(ws);
			if (!connTopics) return;

			for (const [topic, { key }] of connTopics) {
				const users = topicPresence.get(topic);
				if (!users) continue;

				const existing = users.get(key);
				if (!existing) continue;

				existing.count--;
				if (existing.count <= 0) {
					const data = existing.data;
					users.delete(key);
					if (users.size === 0) {
						topicPresence.delete(topic);
					}
					// Last connection for this user left - broadcast departure
					platform.publish('__presence:' + topic, 'leave', { key, data });
				}
			}

			wsTopics.delete(ws);
		},

		sync(ws, topic, platform) {
			const users = topicPresence.get(topic);
			const presenceTopic = '__presence:' + topic;
			const list = [];
			if (users) {
				for (const [k, entry] of users) {
					list.push({ key: k, data: entry.data });
				}
			}
			ws.subscribe(presenceTopic);
			platform.send(ws, presenceTopic, 'list', list);
		},

		list(topic) {
			const users = topicPresence.get(topic);
			if (!users) return [];
			const result = [];
			for (const [, entry] of users) {
				result.push(entry.data);
			}
			return result;
		},

		count(topic) {
			const users = topicPresence.get(topic);
			return users ? users.size : 0;
		},

		clear() {
			wsTopics.clear();
			topicPresence.clear();
			connCounter = 0;
		},

		hooks: {
			subscribe(ws, topic, { platform }) {
				if (topic.startsWith('__presence:')) {
					// Observer subscribing to presence channel directly --
					// send current list so the client isn't left empty
					const realTopic = topic.slice('__presence:'.length);
					const users = topicPresence.get(realTopic);
					const list = [];
					if (users) {
						for (const [k, entry] of users) {
							list.push({ key: k, data: entry.data });
						}
					}
					ws.subscribe(topic);
					platform.send(ws, topic, 'list', list);
					return;
				}
				// Regular topic -- join presence
				tracker.join(ws, topic, platform);
			},
			close(ws, { platform }) {
				tracker.leave(ws, platform);
			}
		}
	};

	return tracker;
}
