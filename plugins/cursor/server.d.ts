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

	/**
	 * Backpressure-aware per-subscriber drop (opt-in). When enabled, a topic's
	 * flush switches from the shared-frame fan-out to a per-subscriber walk that
	 * skips any subscriber whose queued bytes exceed `maxBufferedBytes` for the
	 * current flush. Cursors are latest-value, so a skipped subscriber catches up
	 * on the next flush with the latest coalesced positions - it renders one
	 * cadence later, never accumulating a backlog, and a stalled consumer's write
	 * queue can never exceed the cap plus one flush of cursor bytes.
	 *
	 * The walk is `O(connections)` per flush, so enable it on high-fan-out topics
	 * rather than on every tracker. Independent of viewport culling: an app can
	 * enable backpressure alone. Disabled by default - the zero-config path keeps
	 * the shared-frame fan-out. `backpressure: true` is shorthand for
	 * `{ enabled: true }` with the default cap.
	 */
	backpressure?: boolean | {
		/** Engage the per-subscriber backpressure drop. Only literal `true` enables it. @default false */
		enabled?: boolean;
		/**
		 * Skip a subscriber for the current flush when its queued bytes exceed
		 * this. Cursor frames are tiny (~30 bytes), so the default is generous;
		 * lower it to shed a slow consumer's queue sooner.
		 * @default 1048576 (1 MiB)
		 */
		maxBufferedBytes?: number;
	};

	/**
	 * Read `{ x, y }` out of the app's cursor `data` for viewport culling. The
	 * default reads finite `data.x` / `data.y`; override it when your cursor
	 * payload nests coordinates elsewhere. Returning `null` (or throwing) opts a
	 * single frame out of culling - it is then delivered to every subscriber - so
	 * a coordinate-less or malformed frame is never culled to nothing.
	 *
	 * Cursor positions and reported viewport rects must share one coordinate
	 * space (the board's); mapping screen coordinates into board space is the
	 * app's responsibility.
	 */
	position?: (data: unknown) => { x: number; y: number } | null;

	/**
	 * Jitter filter (opt-in). Drop a cursor move at ingest when it has not moved
	 * at least this far (Chebyshev distance, in the units `position` returns) from
	 * the last broadcast position, so sub-threshold wobble around a point is never
	 * fanned out. When movement then stops, a debounced settle delivers the final
	 * resting position once - even if it is within `minMove` of the last broadcast -
	 * so a still cursor is never left stranded at a stale point (an exact repeat
	 * stays dropped: the settle sends nothing when the rest position is unchanged).
	 * A dropped move is still kept as the latest value, so `list()` / `snapshot()`
	 * see the true current position. `0` (default) disables it.
	 *
	 * For integer-pixel cursor data, `minMove: 1` drops exact-repeat frames at no
	 * visual cost; raise to `2`-`4` to suppress sub-pixel wobble from high-DPI
	 * input. The right value depends on your coordinate scale (1 board unit can be
	 * many on-screen pixels when zoomed in), which is why it is off by default.
	 *
	 * @default 0
	 */
	minMove?: number;

	/**
	 * Viewport culling (opt-in). When enabled, the per-subscriber walk sends each
	 * reporting subscriber only the moving cursors inside its last reported
	 * viewport rect (plus a padding overscan). A subscriber that never reports a
	 * rect (see {@link CursorTracker.viewport}) is treated as whole-board and is
	 * never culled - the per-subscriber opt-in that makes culling safe by
	 * construction.
	 *
	 * Like `backpressure`, the walk engages per topic only once a subscriber on
	 * that topic has reported a viewport, so enabling it costs nothing on topics
	 * whose clients have not reported. Disabled by default; the zero-config path
	 * keeps the shared-frame fan-out. `viewport: true` is shorthand for
	 * `{ enabled: true }` with default padding/cell.
	 */
	viewport?: boolean | {
		/** Engage viewport culling. Only literal `true` enables it. @default false */
		enabled?: boolean;
		/**
		 * Overscan, in board coordinate units, added around each reported rect so
		 * a cursor just off-screen is already present when the user pans toward it.
		 * Widened by `1 / zoom` when a subscriber is zoomed out, so the overscan
		 * stays roughly constant on screen.
		 * @default 256
		 */
		padding?: number;
		/**
		 * Spatial-grid cell size in board coordinate units. Larger cells are a
		 * cheaper index and coarser culling; smaller are finer culling over more
		 * cells. Choose so board coordinates stay within `+-(cell * 32768)`.
		 * @default 256
		 */
		cell?: number;
	};
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
	 * The first call for a (ws, topic) pair also sends the mover its own
	 * roster key as a single-target `you` event and then broadcasts a
	 * `join` event carrying the user's catalog entry; subsequent calls
	 * emit only positions (`update` or `bulk`).
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
	 * as a `time` + `you` + `catalog` + `bulk` sequence (server clock
	 * seed, the requester's own roster key, the roster, then positions).
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

	/**
	 * Record a subscriber's viewport rect for a topic, from the inbound
	 * `cursor-viewport` frame (handled automatically by `hooks.message`).
	 * The rect bounds which cursors the subscriber receives once viewport
	 * culling is enabled; a subscriber that never reports one is treated as
	 * whole-board and is never culled. A malformed rect (missing or
	 * non-finite `x`/`y`/`w`/`h`) is dropped silently; `zoom` defaults to 1.
	 */
	viewport(
		ws: WebSocket<any>,
		topic: string,
		rect: { x: number; y: number; w: number; h: number; zoom?: number }
	): void;

	/**
	 * The last viewport rect this subscriber reported for a topic, or `null`
	 * if it never reported one. The `null` return is the per-subscriber opt-in
	 * that makes culling safe by construction. Read by viewport culling.
	 */
	viewportFor(
		ws: WebSocket<any>,
		topic: string
	): { x: number; y: number; w: number; h: number; zoom: number } | null;

	/** Clear all cursor tracking state and pending timers. */
	clear(): void;

	/**
	 * Snapshot of scheduler and fan-out health. Near-zero cost.
	 *
	 * - `flushes`: total tick-driven flushes since tracker creation.
	 * - `driftMeanMs` / `driftMaxMs`: gap between a flush's target deadline and
	 *   its actual fire time; values above `topicThrottle` indicate sustained
	 *   event-loop saturation.
	 * - `dirtyTopicsCurrent`: topics with pending coalesced entries right now.
	 * - `activeTopicsTotal`: topics with at least one local cursor.
	 * - `viewportsReported`: subscribers that have reported a viewport rect.
	 * - `perSubscriberFlushes`: flushes that took the per-subscriber walk rather
	 *   than the shared frame (non-zero only when a per-subscriber reducer is on).
	 * - `bpSkips`: cumulative subscribers skipped by the backpressure cap.
	 * - `culledEntriesDropped`: cumulative entries withheld by viewport culling;
	 *   divided by `perSubscriberFlushes` it approximates entries saved per flush.
	 * - `jitterDropped`: cumulative moves the `minMove` jitter filter dropped at
	 *   ingest. Zero unless `minMove > 0`; confirms the filter is firing.
	 */
	stats(): {
		flushes: number;
		driftMeanMs: number;
		driftMaxMs: number;
		dirtyTopicsCurrent: number;
		activeTopicsTotal: number;
		viewportsReported: number;
		perSubscriberFlushes: number;
		bpSkips: number;
		culledEntriesDropped: number;
		jitterDropped: number;
	};

	/**
	 * Ready-made WebSocket hooks for cursor tracking.
	 *
	 * `message` handles `cursor`, `cursor-snapshot`, and `cursor-viewport`
	 * messages automatically.
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

/**
 * Build the cursor binary wire codec (`cursor.protocol:2` full-string /
 * `cursor.protocol:3` short-id dictionary) without creating a tracker.
 *
 * Exported so a cluster-backed cursor backend (e.g.
 * `svelte-adapter-uws-extensions/redis/cursor`) builds the IDENTICAL codec from
 * one definition - the in-memory and cluster cursor backends never drift on the
 * wire. Hand the result to `platform.publishWire` / `platform.sendWire`; the
 * per-connection short-id dictionary state lives in the framework, so the caller
 * does not manage it.
 *
 * Returns `null` when `binary: false` (JSON for every client). With
 * `dictionary: false` the codec is the stateless full-string form
 * (`schemaVersion` 1), encoded once and fanned out to all subscribers.
 *
 * @param options - Only `binary` and `dictionary` are read.
 */
export function createCursorWireCodec(
	options?: Pick<CursorOptions, 'binary' | 'dictionary'>
): {
	capability: string;
	schemaVersion: number;
	encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
	state?: {
		onAttach: (ws: any) => unknown;
		onDetach?: (ws: any, state: unknown) => void;
	};
} | null;
