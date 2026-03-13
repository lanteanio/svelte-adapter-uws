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
	 * @example
	 * ```js
	 * select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
	 * ```
	 */
	select?: (userData: UserData) => UserInfo;
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
	 */
	list(topic: string): CursorEntry<UserInfo>[];

	/** Clear all cursor tracking state and pending timers. */
	clear(): void;
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
