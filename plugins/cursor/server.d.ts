import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface CursorOptions<UserData = unknown, UserInfo = unknown> {
	/**
	 * Minimum milliseconds between broadcasts per user per topic.
	 * A trailing-edge timer ensures the final position is always sent.
	 *
	 * Lower for high-refresh demos (8 = 120 Hz), higher to conserve
	 * bandwidth (33 = 30 Hz). Set to 0 to disable.
	 *
	 * @default 16 (~60 Hz)
	 */
	throttle?: number;

	/**
	 * Per-topic aggregate coalesce window in ms. Each topic emits at
	 * most one frame per window, carrying the latest position for every
	 * cursor that moved (a single `update` when one mover is dirty, a
	 * `bulk` array otherwise). Bandwidth per peer scales with active-
	 * mover count, not with mover-count times per-mover rate.
	 *
	 * Raise (e.g. 33 = 30 Hz) for high-density rooms where wire bytes
	 * dominate. Lower (e.g. 8 = 120 Hz) for high-refresh demos. 0
	 * disables coalescing; per-cursor `throttle` then governs broadcast
	 * rate.
	 *
	 * @default 16 (~60 Hz)
	 */
	topicThrottle?: number;

	/**
	 * Extract user-identifying data from a connection's userData.
	 * This is announced on the `catalog` / `join` channel when a user
	 * first appears on a topic, not on every position frame.
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
	 * for a new topic; any pending throttle and coalesce timers on the
	 * dropped topic are cleared first.
	 *
	 * @default 1_000_000
	 */
	maxTopics?: number;

	/**
	 * Reject cursor `update()` calls whose `topic` string is longer than
	 * this many characters. Generous for typical cursor-topic shapes
	 * (`board:${boardId}:cursor`, etc.). The cap prevents an oversized
	 * topic from anchoring a large internal string in the per-topic
	 * cursor state map.
	 *
	 * @default 256
	 */
	maxTopicLength?: number;

	/**
	 * Reject cursor `update()` calls whose JSON-encoded `data` payload
	 * exceeds this many bytes. Cursor positions are by definition small
	 * ({x, y}-shaped, ~30 bytes); a payload above the cap is a sign of
	 * either misuse (cursor used as a general-purpose broadcast channel)
	 * or a misbehaving / hostile client. Rejection is silent so a single
	 * bad frame does not throw into the message hook.
	 *
	 * @default 8192 (8 KB)
	 */
	maxDataBytes?: number;

	/**
	 * Binary wire transport. When `true` (the default), cursor frames are sent
	 * as compact binary `0x03` frames to clients that negotiated the
	 * `cursor.protocol:2` capability, and as JSON to everyone else - fully
	 * transparent, no app-code change, and a large wire-size reduction on the
	 * position hot path. Set `false` to force JSON for every client (e.g. to
	 * keep DevTools' WS inspector readable). The wire format is the server's
	 * decision - clients never opt out via a URL parameter.
	 *
	 * Non-`{x, y}`-numeric cursor data (extra fields, non-numeric positions)
	 * transparently falls back to JSON per frame, so richer cursor payloads
	 * keep working regardless of this flag.
	 *
	 * @default true
	 */
	binary?: boolean;

	/**
	 * Short-id dictionary wire. When `true` (the default), a client that
	 * advertised the `cursor.protocol:3` capability receives the compact
	 * dictionary form: each cursor key is announced once, then referenced by a
	 * 1-2 byte per-connection id, so the key bytes leave the wire and decode no
	 * longer allocates a string per entry. Older binary clients keep the
	 * full-string form transparently.
	 *
	 * The dictionary is per-connection stateful, so each capable subscriber's
	 * frame is encoded independently - the foundation's encode-once-send-many no
	 * longer applies to those recipients. A warm dictionary encode is far cheaper
	 * than a full-string encode, so this is a net win (cheaper CPU and smaller
	 * frames) for typical per-process fan-out; only a single process with very
	 * high per-topic subscriber counts (hundreds-plus on one worker) pays more
	 * CPU than the bandwidth is worth. Set `false` there to keep the full-string
	 * binary wire with its single shared encode. Ignored when `binary` is `false`.
	 *
	 * @default true
	 */
	dictionary?: boolean;
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
	 * Broadcast a cursor position update. Throttled per user per topic
	 * and optionally coalesced per topic via `topicThrottle`.
	 *
	 * The first call for a (ws, topic) pair also emits a `join` event
	 * carrying the user's catalog entry; subsequent calls emit only
	 * positions (`update` or `bulk`).
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
	 * Send current cursor positions for a topic to a single connection
	 * as a `catalog` + `bulk` pair (roster, then positions).
	 *
	 * Call this from your `message` handler when the client sends a
	 * `{ type: 'cursor-snapshot', topic }` request. The `cursor()` client
	 * store sends this automatically on subscribe, so late joiners see
	 * existing cursors immediately without waiting for the next move event.
	 *
	 * Sends an empty `catalog` and `bulk` when the topic has no active
	 * cursors.
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
	 * clients - the message hook will then reject their cursor messages.
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
 *   throttle: 16,        // 60 Hz per-cursor rate (default)
 *   topicThrottle: 16,   // 60 Hz per-topic coalescing (default)
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 */
export function createCursor<UserData = unknown, UserInfo = unknown>(
	options?: CursorOptions<UserData, UserInfo>
): CursorTracker<UserInfo>;
