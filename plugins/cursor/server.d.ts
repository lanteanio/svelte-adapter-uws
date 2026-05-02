import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface CursorOptions<UserData = unknown, UserInfo = unknown> {
	/**
	 * Minimum milliseconds between broadcasts per user per topic.
	 * A trailing-edge timer ensures the final position is always sent.
	 *
	 * @default 50
	 */
	throttle?: number;

	/**
	 * Extract user-identifying data from a connection's userData.
	 * This is broadcast alongside the cursor data so other clients
	 * know who the cursor belongs to.
	 *
	 * Defaults to the full userData object.
	 *
	 * Should return JSON-serializable data (plain objects, arrays, strings,
	 * numbers, booleans, null). The same applies to the `data` argument
	 * passed to `update()`.
	 *
	 * @example
	 * ```js
	 * select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
	 * ```
	 */
	select?: (userData: UserData) => UserInfo;

	/**
	 * Hard cap on tracked connections. When the cap is reached, the
	 * oldest insertion-order connection state is dropped on the next
	 * `update()` for a new ws. In practice eviction is rare because
	 * user code is expected to call `remove(ws)` on disconnect.
	 *
	 * @default 1_000_000
	 */
	maxConnections?: number;

	/**
	 * Hard cap on the active topic registry. When the cap is reached,
	 * the oldest insertion-order topic is dropped on the next `update()`
	 * for a new topic; any pending throttle timers on the dropped topic
	 * are cleared first.
	 *
	 * @default 1_000_000
	 */
	maxTopics?: number;
}

export interface CursorEntry<UserInfo = unknown, Data = unknown> {
	/** Unique connection key. */
	key: string;
	/** Selected user data. */
	user: UserInfo;
	/** Latest cursor/position data. */
	data: Data;
}

export interface CursorTracker<UserInfo = unknown> {
	/**
	 * Broadcast a cursor position update. Throttled per user per topic.
	 *
	 * Call this from your `message` hook when you receive cursor data.
	 *
	 * @example
	 * ```js
	 * cursors.update(ws, 'canvas', { x: 120, y: 340 }, platform);
	 * ```
	 */
	update(ws: WebSocket<any>, topic: string, data: unknown, platform: Platform): void;

	/**
	 * Remove a connection's cursor state from all topics.
	 * Broadcasts a `remove` event for each topic.
	 *
	 * Call this from your `close` hook.
	 */
	remove(ws: WebSocket<any>, platform: Platform): void;

	/**
	 * Get current cursor positions for a topic.
	 * Use in `load()` functions for SSR.
	 *
	 * Returns deep copies when data is JSON-serializable.
	 * Falls back to shared references for non-cloneable data.
	 */
	list(topic: string): CursorEntry<UserInfo>[];

	/**
	 * Send current cursor positions for a topic to a single connection.
	 *
	 * Call this from your `message` handler when the client sends a
	 * `{ type: 'cursor-snapshot', topic }` request. The `cursor()` client
	 * store sends this automatically on subscribe, so late joiners see
	 * existing cursors immediately without waiting for the next move event.
	 *
	 * Does nothing if the topic has no active cursors.
	 *
	 * @example
	 * ```js
	 * if (msg.type === 'cursor-snapshot') {
	 *   cursors.snapshot(ws, msg.topic, platform);
	 * }
	 * ```
	 */
	snapshot(ws: WebSocket<any>, topic: string, platform: Platform): void;

	/** Clear all cursor tracking state and pending timers. */
	clear(): void;

	/**
	 * Ready-made WebSocket hooks for cursor tracking.
	 *
	 * `message` handles `cursor` and `cursor-snapshot` messages automatically.
	 * Returns `true` when the message was handled (use this to skip your own
	 * message handler). `close` calls `remove()`.
	 *
	 * The hooks verify that the sender is subscribed to `__cursor:{topic}`
	 * before processing. For private topics, gate access in your `subscribe`
	 * hook by blocking `__cursor:{topic}` subscriptions from unauthorized
	 * clients -- the message hook will then reject their cursor messages.
	 *
	 * @example
	 * ```js
	 * export function message(ws, ctx) {
	 *   if (cursors.hooks.message(ws, ctx)) return;
	 *   // handle other messages...
	 * }
	 * export const close = cursors.hooks.close;
	 * ```
	 */
	hooks: {
		message(ws: WebSocket<any>, ctx: { data: ArrayBuffer; isBinary?: boolean; platform: Platform }): boolean | void;
		close(ws: WebSocket<any>, ctx: { platform: Platform }): void;
	};
}

/**
 * Create a cursor tracker for ephemeral state like mouse positions,
 * selections, or drag handles.
 *
 * @example
 * ```js
 * import { createCursor } from 'svelte-adapter-uws/plugins/cursor';
 *
 * export const cursors = createCursor({
 *   throttle: 50,
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 */
export function createCursor<UserData = unknown, UserInfo = unknown>(
	options?: CursorOptions<UserData, UserInfo>
): CursorTracker<UserInfo>;
