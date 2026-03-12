import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface PresenceOptions<UserData = unknown, Selected extends Record<string, any> = Record<string, any>> {
	/**
	 * Field in the selected data that uniquely identifies a user.
	 * Used for multi-tab dedup: if two connections share the same key value,
	 * they count as one presence entry. The second tab bumps a ref count
	 * instead of adding a duplicate.
	 *
	 * If the field is missing from the data, each connection is tracked separately.
	 *
	 * @default 'id'
	 */
	key?: keyof Selected & string;

	/**
	 * Extract the public presence data from a connection's userData.
	 * Only the returned fields are broadcast to other clients.
	 *
	 * Use this to avoid leaking private fields (session tokens, internal IDs, etc.).
	 * Defaults to the full userData object.
	 *
	 * @example
	 * ```js
	 * select: (userData) => ({ id: userData.id, name: userData.name, avatar: userData.avatar })
	 * ```
	 */
	select?: (userData: UserData) => Selected;
}

export interface PresenceTracker<Selected extends Record<string, any> = Record<string, any>> {
	/**
	 * Add a connection to a topic's presence list.
	 *
	 * Call this from your `subscribe` hook. Automatically ignores `__`-prefixed
	 * internal topics (prevents recursion). Idempotent - calling twice for the
	 * same ws + topic is a no-op.
	 *
	 * What happens:
	 * 1. Adds the user to the topic's presence map
	 * 2. Broadcasts a `join` event to others already present
	 * 3. Subscribes this ws to the presence channel
	 * 4. Sends the full current list to this ws
	 *
	 * @example
	 * ```js
	 * export function subscribe(ws, topic, { platform }) {
	 *   presence.join(ws, topic, platform);
	 * }
	 * ```
	 */
	join(ws: WebSocket<any>, topic: string, platform: Platform): void;

	/**
	 * Remove a connection from all topics.
	 *
	 * Call this from your `close` hook. Handles multi-tab correctly:
	 * if the user has other connections still open, they stay present.
	 * Only broadcasts a `leave` event when the last connection closes.
	 *
	 * @example
	 * ```js
	 * export function close(ws, { platform }) {
	 *   presence.leave(ws, platform);
	 * }
	 * ```
	 */
	leave(ws: WebSocket<any>, platform: Platform): void;

	/**
	 * Send the current presence list to a connection without joining.
	 *
	 * Use this for observers (admin dashboards, spectators) who want to
	 * see who's present without being counted as present themselves.
	 *
	 * @example
	 * ```js
	 * export function message(ws, { data, platform }) {
	 *   const msg = JSON.parse(Buffer.from(data).toString());
	 *   if (msg.type === 'observe-presence') {
	 *     presence.sync(ws, msg.topic, platform);
	 *   }
	 * }
	 * ```
	 */
	sync(ws: WebSocket<any>, topic: string, platform: Platform): void;

	/**
	 * Get the current presence list for a topic.
	 * Returns an array of the selected data objects.
	 *
	 * Use in `load()` functions or API routes for SSR.
	 *
	 * @example
	 * ```js
	 * export async function load() {
	 *   return { users: presence.list('room') };
	 * }
	 * ```
	 */
	list(topic: string): Selected[];

	/**
	 * Get the number of unique users present on a topic.
	 *
	 * @example
	 * ```js
	 * export async function GET({ platform }) {
	 *   return json({ online: presence.count('room') });
	 * }
	 * ```
	 */
	count(topic: string): number;

	/** Clear all presence tracking state. */
	clear(): void;
}

/**
 * Create a presence tracker for real-time "who's online" features.
 *
 * @example
 * ```js
 * import { createPresence } from 'svelte-adapter-uws/plugins/presence';
 *
 * export const presence = createPresence({
 *   key: 'id',
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 */
export function createPresence<UserData = unknown, Selected extends Record<string, any> = Record<string, any>>(
	options?: PresenceOptions<UserData, Selected>
): PresenceTracker<Selected>;
