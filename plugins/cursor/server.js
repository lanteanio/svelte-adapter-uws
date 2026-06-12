/**
 * Cursor / ephemeral state plugin for svelte-adapter-uws.
 *
 * Lightweight fire-and-forget broadcasting for transient state like
 * mouse cursors, text selections, drag positions, or drawing strokes.
 * Built-in throttle with trailing edge ensures the final position is
 * always delivered. Auto-cleanup on disconnect.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * uses platform.publish() and platform.send().
 *
 * Wire shape (channel `__cursor:{topic}`):
 *   - `catalog`  [{key, user}, ...]  - sent on snapshot() to a single
 *                                      newly-attaching subscriber.
 *   - `join`     {key, user}         - emitted once per (ws, topic) the
 *                                      first time that ws updates on the
 *                                      topic. Broadcast to all subscribers.
 *   - `update`   {key, data}         - single-mover position update.
 *   - `bulk`     [{key, data}, ...]  - per-topic coalesced positions when
 *                                      `topicThrottle` is enabled and >1
 *                                      mover is pending in the window.
 *   - `remove`   {key}               - user is gone from the topic.
 *
 * User metadata (the `select()`ed userData) lives on the catalog channel
 * (catalog + join), not on every position frame. This matches the
 * cluster-aware Redis-backed variant in the extensions package so a
 * single browser bundle (`plugins/cursor/client`) works against either
 * backend.
 *
 * MULTI-TENANT NOTE
 * Cursor state is keyed by the topic name verbatim. Apps running
 * multiple tenants in one process must namespace topic names with
 * tenant scope to avoid cross-tenant cursor leakage. Same
 * recommendation for the `presence`, `groups`, and `replay` plugins.
 *
 * @module svelte-adapter-uws/plugins/cursor
 */

import { encodeCursor, CURSOR_CAPABILITY, CURSOR_SCHEMA_VERSION, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME, CursorEncodeDict, CursorTimeEncodeDict } from './codec.js';
import { WS_CAPS, trackedSubscribe } from '../../files/utils.js';
import { monotonicNow, wallEpoch, setTimer, clearTimer } from '../../files/runtime.js';

const TOPIC_PREFIX = '__cursor:';

/** Wire-protocol event names. */
const EVENTS = Object.freeze({
	CATALOG: 'catalog',
	JOIN: 'join',
	UPDATE: 'update',
	BULK: 'bulk',
	REMOVE: 'remove',
	TIME: 'time'
});

/**
 * Mover count past which a flush builds the transient spatial index instead of
 * scanning every entry per subscriber. Below it, a flat bounds test over every
 * mover is cheaper: a cell probe is a Map lookup (several times the cost of an
 * inline bounds compare) and a viewport always walks a fixed cell span, so the
 * index only repays its per-cell probes once the per-subscriber mover scan it
 * replaces is large. The bench/30 sweep puts the crossover near here for the
 * default cell/padding; the index then earns a multiple-x CPU win at the
 * thousands-of-simultaneous-movers tail.
 */
const INDEX_CROSSOVER = 512;

/**
 * Pack a grid cell coordinate pair into one numeric key. Covers +-32k cells per
 * axis (at the default 256-unit cell, +-8.3M board units); a board beyond that
 * range sets a larger `cell`. A key collision can only over-deliver - every
 * pulled entry is re-tested against the exact bounds - never blank a region.
 * @param {number} cx
 * @param {number} cy
 */
function packCell(cx, cy) {
	return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

/**
 * @typedef {Object} CursorOptions
 * @property {number} [throttle=16] - Minimum milliseconds between broadcasts
 *   per user per topic. A trailing-edge timer fires to ensure the final
 *   position is always sent. Default 16 (~60 Hz) suits collaborative
 *   apps; lower (e.g. 8 for 120 Hz) for high-refresh demos, higher to
 *   conserve bandwidth.
 * @property {number} [topicThrottle=16] - World-state tick rate, in ms.
 *   Per-topic aggregate cap on broadcasts: each topic emits at most one
 *   frame per window, carrying the latest position for every cursor that
 *   moved (a single `update` when one mover is dirty, a `bulk` array
 *   otherwise). Bandwidth per peer scales with active-mover count, not
 *   with mover-count times per-mover rate. Default 16 (~60 Hz) suits
 *   small-to-medium rooms; raise to 33 (~30 Hz) for high-density rooms
 *   where wire bytes dominate. 0 disables the tick; per-cursor `throttle`
 *   then governs broadcast rate.
 * @property {(userData: any) => any} [select] - Extract user-identifying data
 *   from the connection's userData. This is announced on the `catalog` /
 *   `join` channel when a user first appears on a topic. Defaults to the
 *   full userData. Should return JSON-serializable data (plain objects,
 *   arrays, strings, numbers, booleans, null). The same applies to the
 *   `data` argument passed to `update()`.
 */

/**
 * @typedef {Object} CursorEntry
 * @property {string} key - Unique connection key.
 * @property {any} user - Selected user data.
 * @property {any} data - Latest cursor/position data.
 */

/**
 * @typedef {Object} CursorTracker
 * @property {(ws: any, topic: string, data: any, platform: import('../../index.js').Platform) => void} update -
 *   Broadcast a cursor position update. Throttled per user per topic and
 *   optionally coalesced per topic. Call this from your `message` hook
 *   when you receive cursor data.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} remove -
 *   Remove a connection's cursor state from all topics and broadcast removal.
 *   Call this from your `close` hook.
 * @property {(topic: string) => CursorEntry[]} list -
 *   Get current cursor positions for a topic. Use in load() functions for SSR.
 *   Returns deep copies (via structuredClone) when data is JSON-serializable.
 *   Falls back to shared references for non-cloneable data.
 * @property {(ws: any, topic: string, platform: import('../../index.js').Platform) => void} snapshot -
 *   Send current cursor positions for a topic to a single connection as
 *   a `catalog` + `bulk` pair (roster, then positions). Call from your
 *   `message` handler when the client sends `{type: 'cursor-snapshot',
 *   topic}`. The `cursor()` client store sends this automatically on
 *   subscribe so late joiners see existing cursors immediately.
 * @property {() => void} clear -
 *   Clear all cursor tracking state and pending timers.
 * @property {() => { flushes: number, driftMeanMs: number, driftMaxMs: number, dirtyTopicsCurrent: number, activeTopicsTotal: number }} stats -
 *   Snapshot of scheduler health. `flushes` is the total tick-driven
 *   flushes; `driftMeanMs` / `driftMaxMs` measure the gap between the
 *   target deadline and the actual fire time (`> topicThrottle` indicates
 *   sustained event-loop saturation); `dirtyTopicsCurrent` is topics with
 *   pending coalesced entries (should hover near zero); `activeTopicsTotal`
 *   is topics with at least one local cursor.
 */

/**
 * Create a cursor tracker.
 *
 * @param {CursorOptions} [options]
 * @returns {CursorTracker}
 *
 * @example
 * ```js
 * // src/lib/server/cursors.js
 * import { createCursor } from 'svelte-adapter-uws/plugins/cursor';
 *
 * export const cursors = createCursor({
 *   throttle: 16,        // 60 Hz per-cursor rate (default)
 *   topicThrottle: 16,   // 60 Hz per-topic coalescing (default)
 *   select: (userData) => ({ id: userData.id, name: userData.name, color: userData.color })
 * });
 * ```
 *
 * @example
 * ```js
 * // 120 Hz demo: halve both intervals
 * createCursor({ throttle: 8, topicThrottle: 8 });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - using hooks helper
 * import { cursors } from '$lib/server/cursors';
 *
 * export function message(ws, ctx) {
 *   if (cursors.hooks.message(ws, ctx)) return;
 *   // handle other messages...
 * }
 *
 * export const close = cursors.hooks.close;
 * ```
 */
export function createCursor(options = {}) {
	const throttleMs = options.throttle ?? 16;
	const topicThrottleMs = options.topicThrottle ?? 16;
	const select = options.select || ((userData) => userData);
	const maxConnections = options.maxConnections ?? 1_000_000;
	const maxTopics = options.maxTopics ?? 1_000_000;
	const maxTopicLength = options.maxTopicLength ?? 256;
	const maxDataBytes = options.maxDataBytes ?? 8192;

	// Backpressure-aware per-subscriber drop (opt-in). When enabled, a topic's
	// flush switches from the shared-frame fan-out to a per-subscriber walk that
	// skips any subscriber whose queued bytes exceed `maxBufferedBytes` for the
	// current flush. Cursors are latest-value, so a skipped subscriber catches up
	// on the next flush with the latest coalesced positions - it renders one
	// cadence later, never accumulating a backlog. A stalled consumer's write
	// queue can therefore never exceed the cap plus one flush of cursor bytes.
	// Off by default: the zero-config path keeps the shared-frame fan-out and
	// pays nothing.
	// `viewport: true` / `backpressure: true` are shorthand for `{ enabled: true }`
	// with defaults, so the zero-knob path is one token. A bare object with tuning
	// keys but no `enabled` is almost certainly a forgotten `enabled: true`, so it
	// throws below rather than silently culling nothing.
	const bp = options.backpressure === true ? { enabled: true } : (options.backpressure || {});
	const vp = options.viewport === true ? { enabled: true } : (options.viewport || {});

	const bpEnabled = bp.enabled === true;
	const bpMaxBufferedBytes = bp.maxBufferedBytes ?? 1024 * 1024;

	// Viewport culling (opt-in). When enabled, the per-subscriber walk sends each
	// reporting subscriber only the moving cursors inside its last reported
	// viewport rect (plus a padding overscan). A subscriber that never reports a
	// rect is treated as whole-board and is never culled - the per-subscriber
	// opt-in that makes culling safe by construction. The reported rect is in the
	// board's own coordinate space (the client reports the visible board region),
	// so its width/height bound the visible area directly; only the overscan is
	// widened by 1/zoom when zoomed out so it stays roughly constant on screen.
	const viewportEnabled = vp.enabled === true;
	const viewportPadding = vp.padding ?? 256;
	const viewportCell = vp.cell ?? 256;

	// Read {x, y} out of the app's cursor `data` for culling. The default reads
	// finite `data.x` / `data.y`; an app whose payload nests coordinates
	// elsewhere overrides it. Returning null (or throwing) opts a single frame
	// out of culling - it is delivered to every subscriber - so a coordinate-less
	// or malformed frame is never silently culled to nothing.
	const position = typeof options.position === 'function'
		? options.position
		: (data) =>
				data && typeof data.x === 'number' && typeof data.y === 'number'
					&& Number.isFinite(data.x) && Number.isFinite(data.y)
					? { x: data.x, y: data.y }
					: null;

	// Extract a finite {x, y} for the jitter filter. Mirrors the finiteness guard
	// the cull path applies to a custom extractor (the default extractor already
	// guards finiteness); a non-finite or unextractable coordinate yields null,
	// which the jitter filter treats as "always deliver" rather than letting a NaN
	// comparison silently fail open. Only called when minMove > 0.
	const finitePosition = (data) => {
		let p = null;
		try { p = position(data); } catch { p = null; }
		if (p && (typeof p.x !== 'number' || typeof p.y !== 'number'
			|| !Number.isFinite(p.x) || !Number.isFinite(p.y))) p = null;
		return p;
	};

	// Jitter filter (opt-in). Drop a cursor move at ingest when it has not moved at
	// least `minMove` (Chebyshev distance) from the LAST BROADCAST position, so a
	// burst of sub-threshold wobble around a point is never fanned out. The distance
	// is in the units `position` returns and is measured against what the subscriber
	// last actually saw (not the last stored value), so a slow drift still delivers
	// every `minMove` units. When movement then stops, a debounced settle delivers
	// the final resting position once - even if it is within `minMove` of the last
	// broadcast - so a still cursor is never left stranded at a stale point; an exact
	// repeat stays dropped because the settle sends nothing when the rest position
	// equals the last broadcast. 0 (default) disables it. For integer-pixel cursor
	// data, `minMove: 1` drops exact-repeat frames at no visual cost; raise to 2-4 to
	// suppress sub-pixel wobble from high-DPI input. Off by default for parity with
	// viewport culling and backpressure and because the right threshold depends on the
	// app's coordinate scale (1 board unit can be many on-screen pixels when zoomed in).
	const minMove = options.minMove ?? 0;

	// Debounce delay before the jitter filter flushes a settled cursor's final
	// position. Tracks the per-cursor throttle cadence (the rate the app already
	// accepts); falls back to one ~60 Hz frame when throttling is off. Only used
	// when minMove > 0.
	const settleMs = throttleMs > 0 ? throttleMs : 16;

	// Single boolean the flush hot path branches on. When false, the flush takes
	// the unchanged shared-frame path; when true it takes the per-subscriber walk.
	const perSubscriberWalk = bpEnabled || viewportEnabled;

	// Binary wire codec (cursor.protocol:2 full-string / :3 short-id dict), built
	// by the shared createCursorWireCodec factory so the cluster-backed variant
	// (svelte-adapter-uws-extensions redis/cursor) builds the identical codec.
	// null when binary:false. Transparent fallback: binary-capable clients get
	// 0x03 frames, everyone else (and any platform without publishWire, e.g. the
	// unit-test mock) gets the identical JSON frames.
	const wireCodec = createCursorWireCodec(options);

	if (typeof throttleMs !== 'number' || !Number.isFinite(throttleMs) || throttleMs < 0) {
		throw new Error('cursor: throttle must be a non-negative number');
	}
	if (typeof topicThrottleMs !== 'number' || !Number.isFinite(topicThrottleMs) || topicThrottleMs < 0) {
		throw new Error('cursor: topicThrottle must be a non-negative number');
	}
	if (typeof select !== 'function') {
		throw new Error('cursor: select must be a function');
	}
	if (!Number.isInteger(maxConnections) || maxConnections < 1) {
		throw new Error('cursor: maxConnections must be a positive integer');
	}
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error('cursor: maxTopics must be a positive integer');
	}
	if (!Number.isInteger(maxTopicLength) || maxTopicLength < 1) {
		throw new Error('cursor: maxTopicLength must be a positive integer');
	}
	if (!Number.isInteger(maxDataBytes) || maxDataBytes < 1) {
		throw new Error('cursor: maxDataBytes must be a positive integer');
	}
	for (const name of ['viewport', 'backpressure']) {
		const val = options[name];
		if (val !== undefined && val !== null && typeof val !== 'boolean' && typeof val !== 'object') {
			throw new Error(`cursor: ${name} must be true or an options object`);
		}
	}
	if (bp.maxBufferedBytes !== undefined && bp.enabled === undefined) {
		throw new Error('cursor: backpressure.maxBufferedBytes is set but backpressure.enabled is not - did you mean { enabled: true }?');
	}
	if (
		bp.maxBufferedBytes !== undefined &&
		(!Number.isInteger(bpMaxBufferedBytes) || bpMaxBufferedBytes < 1)
	) {
		throw new Error('cursor: backpressure.maxBufferedBytes must be a positive integer');
	}
	if (options.position !== undefined && typeof options.position !== 'function') {
		throw new Error('cursor: position must be a function');
	}
	if (typeof minMove !== 'number' || !Number.isFinite(minMove) || minMove < 0) {
		throw new Error('cursor: minMove must be a non-negative number');
	}
	if ((vp.padding !== undefined || vp.cell !== undefined) && vp.enabled === undefined) {
		throw new Error('cursor: viewport.padding/cell is set but viewport.enabled is not - did you mean { enabled: true }?');
	}
	if (
		vp.padding !== undefined &&
		(typeof viewportPadding !== 'number' || !Number.isFinite(viewportPadding) || viewportPadding < 0)
	) {
		throw new Error('cursor: viewport.padding must be a non-negative number');
	}
	if (
		vp.cell !== undefined &&
		(typeof viewportCell !== 'number' || !Number.isFinite(viewportCell) || viewportCell <= 0)
	) {
		throw new Error('cursor: viewport.cell must be a positive number');
	}

	/** Auto-incrementing connection key. */
	let connCounter = 0;

	/**
	 * Per-ws state: connection key, selected user data, and which topics
	 * this ws has already announced (the `topics` set doubles as the
	 * already-joined set - presence in the set means a `join` has fired).
	 * Capped at `maxConnections` - oldest insertion-order entry evicted
	 * on new insert at cap. Eviction is rare in practice because user
	 * code is expected to call `remove(ws)` on disconnect.
	 * @type {Map<any, { key: string, user: any, topics: Set<string> }>}
	 */
	const wsState = new Map();

	/**
	 * Per-topic local cursor state. Drives the per-(ws, topic) throttle
	 * and the post-disconnect cleanup. Capped at `maxTopics` - oldest
	 * insertion-order topic evicted on new insert at cap. Each evicted
	 * topic's pending throttle and coalesce timers are cleared first.
	 * @type {Map<string, Map<string, { user: any, data: any, lastBroadcast: number, timer: any, lastSentPos?: { x: number, y: number }, settleTimer?: any }>>}
	 */
	const topics = new Map();

	/**
	 * Per-topic aggregate flush state.
	 *
	 * - `dirty`: cursors awaiting coalesced flush. Keyed by connection key;
	 *   latest-wins. When the coalesce window elapses, `dirty.size === 1`
	 *   sends a single `update`; any other count sends one `bulk` array.
	 * - `lastFlush`: target-anchored timestamp of the most recent flush.
	 *   Advanced by `topicThrottleMs` per cycle (not to actual fire time)
	 *   so a single late tick does not compound drift on subsequent cycles.
	 *
	 * @type {Map<string, { dirty: Map<string, { data: any, platform: any }>, lastFlush: number }>}
	 */
	const topicFlush = new Map();

	/**
	 * Topics with at least one pending dirty entry. Bounded by mover count,
	 * not active-topic count, so the scheduler walks only dirty topics on
	 * each tick instead of every active one.
	 * @type {Set<string>}
	 */
	const dirtyTopics = new Set();

	/**
	 * Per-(subscriber, topic) viewport rect, recorded from the inbound
	 * `cursor-viewport` frame. Outer key is the subscriber's `wsState` key;
	 * inner key is the topic. Read by per-subscriber viewport culling, which
	 * never culls a subscriber that has not reported a rect (a non-reporter is
	 * treated as whole-board). Torn down with the subscriber in `remove()` /
	 * `clear()`, exactly like the other per-subscriber state.
	 * @type {Map<string, Map<string, { x: number, y: number, w: number, h: number, zoom: number }>>}
	 */
	const subViewport = new Map();

	/**
	 * Count of distinct subscribers currently reporting a viewport per topic.
	 * Lets a viewport-enabled topic with zero reporters keep the shared-frame
	 * fan-out instead of paying the O(connections) per-subscriber walk for the
	 * same bytes - so enabling culling globally costs nothing on topics whose
	 * clients have not (or never) reported. Maintained alongside `subViewport`:
	 * incremented when a `(subscriber, topic)` rect is first recorded, decremented
	 * when the subscriber is removed or evicted, cleared in `clear()`.
	 * @type {Map<string, number>}
	 */
	const topicReporters = new Map();

	/** Record that a subscriber started reporting a viewport for a topic. */
	function addReporter(topic) {
		topicReporters.set(topic, (topicReporters.get(topic) || 0) + 1);
	}
	/** Record that a subscriber stopped reporting a viewport for a topic. */
	function dropReporter(topic) {
		const n = topicReporters.get(topic);
		if (n === undefined) return;
		if (n <= 1) topicReporters.delete(topic);
		else topicReporters.set(topic, n - 1);
	}
	/**
	 * Whether a flush for `topic` must take the per-subscriber walk: always when
	 * backpressure is on (it needs per-socket queue checks), and when culling is
	 * on only once at least one subscriber has reported a viewport for the topic.
	 * @param {string} topic
	 */
	function topicNeedsWalk(topic) {
		return bpEnabled || topicReporters.get(topic) > 0;
	}

	/**
	 * Single tracker-wide timer. Always points at the next earliest topic
	 * deadline (or null when idle). Replaces the previous per-topic
	 * setTimeout pattern: N pending timers -> 1 pending timer regardless
	 * of topic count. Scheduling cost is O(dirty topics), not O(active
	 * topics).
	 * @type {ReturnType<typeof setTimeout> | null}
	 */
	let tickTimer = null;

	/**
	 * Drift accounting for `stats()` observability. Mean (target - actual)
	 * and max over tick-driven flushes. Leading-edge synchronous flushes
	 * are NOT counted (they fire on the caller's thread, not via the
	 * scheduler; their drift is structurally zero).
	 */
	let driftSum = 0;
	let driftCount = 0;
	let driftMax = 0;
	let flushCount = 0;

	/**
	 * Per-subscriber-walk observability (lifetime counters, like `flushCount`).
	 * `perSubscriberFlushes` is how many flushes took the per-subscriber walk
	 * rather than the shared frame; `bpSkips` is how often the backpressure cap
	 * bit. Counts only - no topic names, keys, or coordinates.
	 */
	let perSubscriberFlushes = 0;
	let bpSkips = 0;
	let culledEntriesDropped = 0;
	// Lifetime count of moves the jitter filter dropped at ingest (minMove). Lets
	// an operator confirm the filter is firing, the way bpSkips/culledEntriesDropped
	// do for the fan-out reducers. Count only - no keys or coordinates.
	let jitterDropped = 0;

	/**
	 * Per-flush scratch, reused every flush so the per-subscriber walk allocates
	 * no new collections per flush. Factory-closure scoped (one set per tracker)
	 * so two trackers in one process never alias each other's scratch.
	 *
	 * - `flushItems`: the single materialization of a flush's dirty entries,
	 *   `[{ key, data }, ...]`, shared (read-only) across that flush's subscribers.
	 * - `immediateOne`: a one-entry view used by the `topicThrottle: 0` immediate
	 *   path so it can route through the same walk as the coalesced path.
	 * - `inDeliver`: re-entrancy guard. The in-memory send is synchronous and
	 *   never re-enters delivery, but a nested call would corrupt `flushItems`;
	 *   it degrades to the shared-frame path instead.
	 * @type {Array<{ key: string, data: any }>}
	 */
	const flushItems = [];
	/**
	 * Viewport-culling scratch, parallel to `flushItems` and reused every flush.
	 * `flushPos[i]` is item i's resolved `{ x, y }` (or null when the position
	 * extractor could not place it - such an item is always delivered).
	 * `alwaysVisible` holds the indices of those null-position items.
	 * `flushCells` is the transient spatial index (packed cell key -> item
	 * indices), built only past INDEX_CROSSOVER and emptied back into `cellPool`
	 * after the walk so a dense flush recycles its bucket arrays. `cullOut` is
	 * the per-subscriber slice handed to the wire.
	 * @type {Array<{ x: number, y: number } | null>}
	 */
	const flushPos = [];
	/** @type {number[]} */
	const alwaysVisible = [];
	/** @type {Map<number, number[]>} */
	const flushCells = new Map();
	/** @type {number[][]} */
	const cellPool = [];
	/** @type {Array<{ key: string, data: any }>} */
	const cullOut = [];
	/** Reused padded-bounds object so the per-subscriber cull allocates nothing. */
	const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	/** @type {Map<string, { data: any, platform: any }>} */
	const immediateOne = new Map();
	let inDeliver = false;

	/**
	 * Get or create ws state and return the connection key + user data.
	 * @param {any} ws
	 * @returns {{ key: string, user: any, topics: Set<string> }}
	 */
	function getWsState(ws) {
		let state = wsState.get(ws);
		if (!state) {
			if (wsState.size >= maxConnections) {
				const oldest = wsState.keys().next().value;
				if (oldest !== undefined) {
					// Tear down the evicted connection's viewport too, keyed by
					// its state key, so subViewport can never outgrow wsState.
					const evicted = wsState.get(oldest);
					if (evicted) {
						const byTopic = subViewport.get(evicted.key);
						if (byTopic) for (const t of byTopic.keys()) dropReporter(t);
						subViewport.delete(evicted.key);
					}
					wsState.delete(oldest);
				}
			}
			let userData = {};
			if (typeof ws.getUserData === 'function') {
				// Closed-WS race: caller may reach here after an `await`
				// that outlasted the socket; getUserData throws on a
				// freed handle. Fall back to an empty userData rather
				// than crashing the worker.
				try { userData = ws.getUserData(); } catch { userData = {}; }
			}
			state = {
				key: String(++connCounter),
				user: select(userData),
				topics: new Set()
			};
			wsState.set(ws, state);
		}
		return state;
	}

	/**
	 * Drop the topic's coalesce state. The single tracker-wide tickTimer is
	 * left alone (it self-cancels on the next tick when `dirtyTopics` is
	 * empty); we just remove this topic from both the flush map and the
	 * dirty set so the next tick skips it.
	 * @param {string} topic
	 */
	function clearTopicFlush(topic) {
		topicFlush.delete(topic);
		dirtyTopics.delete(topic);
	}

	/**
	 * Broadcast a cursor wire event. Routes through the binary `publishWire`
	 * path when a codec is configured AND the platform supports it (production /
	 * dev / test-server); otherwise falls back to the JSON `publish` - so the
	 * unit-test mock platform and `binary: false` both keep the exact JSON shape.
	 * @param {string} fullTopic - the channel name, already TOPIC_PREFIX-scoped
	 * @param {string} event
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function emit(fullTopic, event, data, platform) {
		if (wireCodec && typeof platform.publishWire === 'function') {
			platform.publishWire(fullTopic, event, data, wireCodec);
		} else {
			// `compress: false` keeps the 60 Hz cursor hot path uncompressed even on
			// the JSON fallback (binary: false, or a platform without publishWire) -
			// per-message deflate CPU scales per subscriber and would dominate here.
			platform.publish(fullTopic, event, data, { compress: false });
		}
	}

	/**
	 * Single-target variant of {@link emit} (snapshot catalog + positions).
	 * @param {any} ws
	 * @param {string} fullTopic
	 * @param {string} event
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function emitTo(ws, fullTopic, event, data, platform) {
		if (wireCodec && typeof platform.sendWire === 'function') {
			platform.sendWire(ws, fullTopic, event, data, wireCodec);
		} else {
			platform.send(ws, fullTopic, event, data, { compress: false });
		}
	}

	/**
	 * Emit `join` for a (ws, topic) pair the first time the ws moves on
	 * the topic. Broadcast (not single-target) so existing subscribers
	 * pick up the new user before any position frames arrive.
	 */
	function emitJoin(topic, key, user, platform) {
		emit(TOPIC_PREFIX + topic, EVENTS.JOIN, { key, user }, platform);
	}

	/**
	 * Publish a single-mover position update.
	 * @param {string} topic
	 * @param {string} key
	 * @param {any} data
	 * @param {import('../../index.js').Platform} platform
	 */
	function doBroadcast(topic, key, data, platform) {
		emit(TOPIC_PREFIX + topic, EVENTS.UPDATE, { key, data }, platform);
	}

	/**
	 * Flush all coalesced entries for a topic. One entry -> `update`,
	 * many entries -> single `bulk` array.
	 *
	 * When a per-subscriber reducer is enabled the flush switches to a walk
	 * over the topic's subscribers (see {@link deliverFlush}); otherwise it
	 * takes the unchanged shared-frame path so the zero-config deployment keeps
	 * the single fan-out and pays nothing.
	 * @param {string} topic
	 * @param {Map<string, { data: any, platform: any }>} dirty
	 */
	function flushDirty(topic, dirty) {
		if (dirty.size === 0) return;
		flushCount++;
		if (perSubscriberWalk && topicNeedsWalk(topic)) {
			let platform = null;
			for (const v of dirty.values()) { platform = v.platform; break; }
			if (!platform) return;
			if (typeof platform.forEachSubscriber === 'function') {
				deliverFlush(topic, dirty, platform);
			} else {
				// Minimal or older host without the per-subscriber primitive:
				// degrade to the shared frame rather than throw.
				legacyEmit(topic, dirty, platform);
			}
			return;
		}
		if (dirty.size === 1) {
			const [k, v] = dirty.entries().next().value;
			doBroadcast(topic, k, v.data, v.platform);
			return;
		}
		const entries = [];
		let flushPlatform = null;
		for (const [k, v] of dirty) {
			entries.push({ key: k, data: v.data });
			flushPlatform = v.platform;
		}
		if (flushPlatform) {
			emit(TOPIC_PREFIX + topic, EVENTS.BULK, entries, flushPlatform);
		}
	}

	/**
	 * Per-subscriber flush walk. Used when a per-subscriber reducer (backpressure)
	 * is enabled. Materializes the flush's entries once into shared scratch, then
	 * walks the topic's subscribers via `platform.forEachSubscriber`, skipping any
	 * whose queued bytes exceed the backpressure cap, and sends each survivor the
	 * frame via the per-target `emitTo` (which keeps the binary-wire / JSON split
	 * and swallows the closed-WS race). A single-entry frame is an `update`,
	 * multiple is a `bulk` - byte-identical to the shared-frame path, so an
	 * existing client merges a thinned stream exactly as it merges a normal one.
	 * @param {string} topic
	 * @param {Map<string, { data: any, platform: any }>} dirty
	 * @param {import('../../index.js').Platform} platform
	 */
	function deliverFlush(topic, dirty, platform) {
		// Re-entrancy guard: a nested delivery would corrupt the shared scratch.
		if (inDeliver) { legacyEmit(topic, dirty, platform); return; }
		inDeliver = true;
		try {
			flushItems.length = 0;
			if (viewportEnabled) { flushPos.length = 0; alwaysVisible.length = 0; }
			for (const [k, v] of dirty) {
				flushItems.push({ key: k, data: v.data });
				if (viewportEnabled) {
					let pos = null;
					// A buggy or slow app extractor must not crash the flush.
					try { pos = position(v.data); } catch { pos = null; }
					if (pos && (typeof pos.x !== 'number' || typeof pos.y !== 'number'
						|| !Number.isFinite(pos.x) || !Number.isFinite(pos.y))) {
						pos = null;
					}
					flushPos.push(pos);
					if (pos === null) alwaysVisible.push(flushItems.length - 1);
				}
			}
			const n = flushItems.length;
			if (n === 0) return;
			const fullTopic = TOPIC_PREFIX + topic;
			const indexed = viewportEnabled && n >= INDEX_CROSSOVER;
			if (indexed) buildFlushCells(n);
			platform.forEachSubscriber(fullTopic, (ws) => {
				if (bpEnabled && platform.bufferedAmount(ws) > bpMaxBufferedBytes) {
					bpSkips++;
					return;
				}
				let slice = flushItems;
				if (viewportEnabled) {
					const rect = lookupViewport(ws, topic);
					// A non-reporter (null rect) is whole-board and never culled.
					if (rect !== null) slice = indexed ? cullIndexed(rect) : cullDirect(rect);
				}
				const len = slice.length;
				// Count entries withheld by the cull, including when the whole
				// slice is culled away (an empty frame is not sent at all).
				if (slice !== flushItems) culledEntriesDropped += n - len;
				if (len === 0) return; // nothing visible to this subscriber this flush
				if (len === 1) {
					emitTo(ws, fullTopic, EVENTS.UPDATE, slice[0], platform);
				} else {
					emitTo(ws, fullTopic, EVENTS.BULK, slice, platform);
				}
			});
			perSubscriberFlushes++;
			if (indexed) releaseFlushCells();
		} finally {
			inDeliver = false;
		}
	}

	/**
	 * Read a subscriber's last reported viewport rect for a topic, or null if it
	 * never reported one. The null return is the per-subscriber opt-in that keeps
	 * culling safe by construction. Does not create `wsState`.
	 * @param {any} ws
	 * @param {string} topic
	 * @returns {{ x: number, y: number, w: number, h: number, zoom: number } | null}
	 */
	function lookupViewport(ws, topic) {
		const state = wsState.get(ws);
		if (!state) return null;
		const byTopic = subViewport.get(state.key);
		return byTopic ? (byTopic.get(topic) ?? null) : null;
	}

	/**
	 * Build the transient spatial index over this flush's positioned movers.
	 * Bucket arrays are drawn from `cellPool` and returned by
	 * {@link releaseFlushCells} after the walk, so a dense flush recycles them.
	 * @param {number} n - flushItems.length
	 */
	function buildFlushCells(n) {
		releaseFlushCells();
		for (let i = 0; i < n; i++) {
			const pos = flushPos[i];
			if (pos === null) continue; // null-pos delivered via alwaysVisible
			const ck = packCell(Math.floor(pos.x / viewportCell), Math.floor(pos.y / viewportCell));
			let bucket = flushCells.get(ck);
			if (!bucket) {
				bucket = cellPool.pop() || [];
				bucket.length = 0;
				flushCells.set(ck, bucket);
			}
			bucket.push(i);
		}
	}

	/** Return this flush's bucket arrays to the pool and empty the index. */
	function releaseFlushCells() {
		for (const bucket of flushCells.values()) cellPool.push(bucket);
		flushCells.clear();
	}

	/**
	 * Resolve a reported rect's padded board bounds. Width/height are board
	 * units already (the client reports the visible board region), so only the
	 * overscan is widened by 1/zoom when zoomed out, keeping it roughly constant
	 * on screen. Writes into the shared `bounds` object to avoid per-call alloc.
	 * @param {{ x: number, y: number, w: number, h: number, zoom: number }} rect
	 */
	function rectBounds(rect) {
		const pad = rect.zoom < 1 ? viewportPadding / rect.zoom : viewportPadding;
		bounds.minX = rect.x - pad;
		bounds.minY = rect.y - pad;
		bounds.maxX = rect.x + rect.w + pad;
		bounds.maxY = rect.y + rect.h + pad;
		return bounds;
	}

	/**
	 * Flat bounds test over every mover this flush. Used below INDEX_CROSSOVER,
	 * where the dirty set is small enough that building an index does not pay.
	 * @param {{ x: number, y: number, w: number, h: number, zoom: number }} rect
	 * @returns {Array<{ key: string, data: any }>}
	 */
	function cullDirect(rect) {
		const b = rectBounds(rect);
		cullOut.length = 0;
		for (let i = 0; i < flushItems.length; i++) {
			const pos = flushPos[i];
			if (pos === null) { cullOut.push(flushItems[i]); continue; }
			if (pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.y <= b.maxY) {
				cullOut.push(flushItems[i]);
			}
		}
		return cullOut;
	}

	/**
	 * Spatial-index cull: walk only the cells the viewport covers and bounds-test
	 * their movers. Per-subscriber cost is O(visible cells + movers in them), not
	 * O(all movers). A viewport spanning more cells than the flush has movers
	 * sees ~the whole board, so it delivers everything (the deliver-all clamp),
	 * bounding worst-case cost at O(movers).
	 * @param {{ x: number, y: number, w: number, h: number, zoom: number }} rect
	 * @returns {Array<{ key: string, data: any }>}
	 */
	function cullIndexed(rect) {
		const b = rectBounds(rect);
		const cx0 = Math.floor(b.minX / viewportCell);
		const cy0 = Math.floor(b.minY / viewportCell);
		const cx1 = Math.floor(b.maxX / viewportCell);
		const cy1 = Math.floor(b.maxY / viewportCell);
		if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > flushItems.length) return flushItems;
		cullOut.length = 0;
		for (let a = 0; a < alwaysVisible.length; a++) cullOut.push(flushItems[alwaysVisible[a]]);
		for (let cy = cy0; cy <= cy1; cy++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				const bucket = flushCells.get(packCell(cx, cy));
				if (!bucket) continue;
				for (let bi = 0; bi < bucket.length; bi++) {
					const i = bucket[bi];
					const pos = flushPos[i];
					if (pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.y <= b.maxY) {
						cullOut.push(flushItems[i]);
					}
				}
			}
		}
		return cullOut;
	}

	/**
	 * Shared-frame fallback used when a per-subscriber reducer is enabled but the
	 * platform does not expose `forEachSubscriber` (a minimal or older host, or
	 * the unit-test mock). Reproduces today's shared-frame shape so enabling an
	 * option on such a host degrades to no reduction rather than throwing.
	 * @param {string} topic
	 * @param {Map<string, { data: any, platform: any }>} dirty
	 * @param {import('../../index.js').Platform} platform
	 */
	function legacyEmit(topic, dirty, platform) {
		if (dirty.size === 1) {
			const [k, v] = dirty.entries().next().value;
			doBroadcast(topic, k, v.data, platform);
			return;
		}
		const entries = [];
		for (const [k, v] of dirty) entries.push({ key: k, data: v.data });
		emit(TOPIC_PREFIX + topic, EVENTS.BULK, entries, platform);
	}

	/**
	 * Scheduler tick. Walks `dirtyTopics`, flushes any topic whose deadline
	 * (`lastFlush + topicThrottleMs`) has passed, and re-arms `tickTimer`
	 * for the next earliest pending deadline. Topics whose deadline has
	 * not yet passed stay in `dirtyTopics` for the next tick.
	 *
	 * Target-anchored advance: on flush, `lastFlush` is set to the deadline
	 * (not the actual fire time) so a single late tick does not compound
	 * drift on subsequent cycles. If we fell behind by more than one cycle
	 * (event loop saturation > `topicThrottleMs`), `lastFlush` resets to
	 * `now` to avoid queueing phantom catch-up fires.
	 */
	function tick() {
		tickTimer = null;
		const now = monotonicNow();
		let nextDeadline = Infinity;

		for (const topic of dirtyTopics) {
			const state = topicFlush.get(topic);
			if (!state) { dirtyTopics.delete(topic); continue; }
			if (state.dirty.size === 0) {
				dirtyTopics.delete(topic);
				continue;
			}
			const deadline = state.lastFlush + topicThrottleMs;
			if (deadline <= now) {
				const drift = now - deadline;
				driftSum += drift;
				driftCount++;
				if (drift > driftMax) driftMax = drift;

				flushDirty(topic, state.dirty);  // increments flushCount internally
				state.dirty.clear();
				dirtyTopics.delete(topic);

				state.lastFlush = drift < topicThrottleMs ? deadline : now;
			} else if (deadline < nextDeadline) {
				nextDeadline = deadline;
			}
		}

		if (nextDeadline !== Infinity) {
			tickTimer = setTimer(tick, Math.max(0, nextDeadline - monotonicNow()));
		}
		// else: scheduler idle until next `broadcast()` call.
	}

	function armTick(delay) {
		if (tickTimer !== null) return;
		tickTimer = setTimer(tick, delay);
	}

	/**
	 * Route a broadcast through the per-topic coalesce window when
	 * `topicThrottle` is enabled, or publish immediately when disabled.
	 *
	 * Every broadcast appends to `dirty` and arms (or shares) the
	 * tracker-wide tick timer. When the cadence window has already
	 * elapsed since the last flush, the tick is armed at delay 0 so it
	 * fires on the next event-loop iteration; otherwise it is armed at
	 * the remaining window time. Either way, the actual fanout happens
	 * inside `tick()`, never synchronously.
	 *
	 * Why no synchronous leading-edge fire: uWS dispatches each WS
	 * message as its own JS task. Microtasks drain at the C++ <-> JS
	 * boundary between tasks, so a `queueMicrotask`-deferred flush
	 * (previous design) runs BEFORE the next socket's message handler -
	 * cross-socket coalescing window is zero, and every "first message
	 * of a new cadence slot" from any socket fires alone as a single-
	 * cursor UPDATE. Going through the tick timer instead schedules a
	 * macrotask, which is dequeued only after the poll phase processes
	 * every ready message on every socket. All messages dispatched in
	 * the same loop iteration end up in one flush.
	 *
	 * Latency cost: the first cursor on an idle topic waits up to
	 * `topicThrottleMs` (one cycle) before its frame leaves. At the
	 * default 16 ms / 60 Hz this is one frame-budget; at 8 ms / 125 Hz
	 * it is half a frame. Below the perceptual floor for cursor.
	 */
	function broadcast(topic, key, data, platform) {
		if (topicThrottleMs <= 0) {
			// The immediate path bypasses the coalesce window entirely, so the
			// per-subscriber walk must engage here too or backpressure/culling
			// silently no-op for `topicThrottle: 0` apps. Route a single mover
			// through the same walk via a one-entry view.
			if (perSubscriberWalk && topicNeedsWalk(topic) && typeof platform.forEachSubscriber === 'function') {
				immediateOne.clear();
				immediateOne.set(key, { data, platform });
				deliverFlush(topic, immediateOne, platform);
			} else {
				doBroadcast(topic, key, data, platform);
			}
			return;
		}

		let state = topicFlush.get(topic);
		if (!state) {
			// Anchor lastFlush one full cycle in the past so the first
			// broadcast on a fresh topic is treated as "cycle ready" and
			// schedules the tick at delay 0 with zero drift, rather than
			// inflating drift stats by a full clock value worth of "lateness".
			state = { dirty: new Map(), lastFlush: monotonicNow() - topicThrottleMs };
			topicFlush.set(topic, state);
		}
		state.dirty.set(key, { data, platform });
		dirtyTopics.add(topic);

		const elapsed = monotonicNow() - state.lastFlush;
		const delay = elapsed >= topicThrottleMs ? 0 : topicThrottleMs - elapsed;
		armTick(delay);
	}

	/** @type {CursorTracker} */
	const tracker = {
		update(ws, topic, data, platform) {
			// Reject malformed topic or oversized payload silently. Cursor
			// is best-effort fire-and-forget; a misbehaving client (or a
			// bug producing a giant `data` blob) gets its frame dropped
			// rather than throwing into the message hook. Legitimate
			// cursor moves are small ({x, y}-shaped, ~30 bytes) so the
			// 256/8192 caps are never reached in practice.
			if (typeof topic !== 'string' || topic.length === 0 || topic.length > maxTopicLength) return;
			if (data !== undefined && data !== null) {
				let dataBytes;
				try {
					dataBytes = Buffer.byteLength(JSON.stringify(data));
				} catch {
					return;
				}
				if (dataBytes > maxDataBytes) return;
			}
			const state = getWsState(ws);
			const isFirstOnTopic = !state.topics.has(topic);
			state.topics.add(topic);

			let topicMap = topics.get(topic);
			if (!topicMap) {
				if (topics.size >= maxTopics) {
					const oldest = topics.keys().next().value;
					if (oldest !== undefined) {
						const oldMap = topics.get(oldest);
						if (oldMap) {
							for (const e of oldMap.values()) {
								if (e.timer) clearTimer(e.timer);
								if (e.settleTimer) clearTimer(e.settleTimer);
							}
						}
						topics.delete(oldest);
						clearTopicFlush(oldest);
					}
				}
				topicMap = new Map();
				topics.set(topic, topicMap);
			}

			if (isFirstOnTopic) {
				emitJoin(topic, state.key, state.user, platform);
			}

			let entry = topicMap.get(state.key);
			const now = monotonicNow();

			if (!entry) {
				entry = { user: state.user, data, lastBroadcast: 0, timer: null };
				topicMap.set(state.key, entry);
			}

			// Jitter filter: drop a sub-threshold wobble before it reaches the
			// flush. Measured against the last BROADCAST position (`lastSentPos`,
			// set only on a real broadcast below) so repeated small moves never
			// accumulate into a delivered jump. A dropped move stays as entry.data
			// (so list()/snapshot() see the true position) and arms a debounced
			// settle timer so the final resting position is delivered once movement
			// stops - the cursor is never left stranded at a stale point. pos === null
			// (no usable coordinate) always passes through.
			let pos = null;
			if (minMove > 0) {
				// Re-arm point for the debounced settle: clear any pending timer; a
				// drop below re-arms it, a real broadcast leaves it cleared.
				if (entry.settleTimer) { clearTimer(entry.settleTimer); entry.settleTimer = null; }
				pos = finitePosition(data);
				if (
					pos && entry.lastSentPos &&
					Math.max(Math.abs(pos.x - entry.lastSentPos.x), Math.abs(pos.y - entry.lastSentPos.y)) < minMove
				) {
					entry.data = data; // keep latest for a real move later + snapshot
					jitterDropped++;
					// Deliver the settled position once movement quiesces (debounced:
					// each drop re-armed the timer above). Skipped while a trailing
					// throttle broadcast is pending - that already sends the latest
					// entry.data at the window end. On fire, send only if the rest
					// position differs from the last broadcast, so an exact repeat
					// (minMove: 1) stays dropped.
					if (!entry.timer) {
						const key = state.key;
						entry.settleTimer = setTimer(() => {
							const e = topicMap.get(key);
							if (!e) return;
							e.settleTimer = null;
							const p = finitePosition(e.data);
							if (p && (!e.lastSentPos || p.x !== e.lastSentPos.x || p.y !== e.lastSentPos.y)) {
								e.lastBroadcast = monotonicNow();
								e.lastSentPos = p;
								broadcast(topic, key, e.data, platform);
							}
						}, settleMs);
					}
					return;
				}
			}

			// Always store latest data
			entry.data = data;
			entry.user = state.user;

			// Leading edge: broadcast immediately if throttle window passed
			if (now - entry.lastBroadcast >= throttleMs) {
				if (entry.timer) {
					clearTimer(entry.timer);
					entry.timer = null;
				}
				entry.lastBroadcast = now;
				if (pos) entry.lastSentPos = pos;
				broadcast(topic, state.key, data, platform);
				return;
			}

			// Trailing edge: schedule a broadcast for the end of the window
			if (!entry.timer) {
				const key = state.key;
				entry.timer = setTimer(() => {
					const e = topicMap.get(key);
					if (e) {
						e.lastBroadcast = monotonicNow();
						e.timer = null;
						// Record the position actually broadcast (the latest stored
						// data, which may be newer than this call's), never a dropped one.
						if (minMove > 0) {
							const p = finitePosition(e.data);
							if (p) e.lastSentPos = p;
						}
						broadcast(topic, key, e.data, platform);
					}
				}, throttleMs - (now - entry.lastBroadcast));
			}
		},

		remove(ws, platform) {
			const state = wsState.get(ws);
			if (!state) return;

			for (const topic of state.topics) {
				const topicMap = topics.get(topic);
				if (!topicMap) continue;

				const entry = topicMap.get(state.key);
				if (entry) {
					if (entry.timer) clearTimer(entry.timer);
					if (entry.settleTimer) clearTimer(entry.settleTimer);
					topicMap.delete(state.key);
					if (topicMap.size === 0) {
						topics.delete(topic);
						clearTopicFlush(topic);
					} else {
						const flushState = topicFlush.get(topic);
						if (flushState) flushState.dirty.delete(state.key);
					}
					emit(TOPIC_PREFIX + topic, EVENTS.REMOVE, { key: state.key }, platform);
				}
			}

			const byTopic = subViewport.get(state.key);
			if (byTopic) for (const t of byTopic.keys()) dropReporter(t);
			subViewport.delete(state.key);
			wsState.delete(ws);
		},

		list(topic) {
			const topicMap = topics.get(topic);
			if (!topicMap) return [];
			const result = [];
			for (const [key, entry] of topicMap) {
				const item = { key, user: entry.user, data: entry.data };
				try { result.push(structuredClone(item)); } catch { result.push(item); }
			}
			return result;
		},

		async snapshot(ws, topic, platform) {
			// The snapshot handshake is the membership-establishing path for this
			// tap channel: the client never wire-subscribes a `__`-prefixed topic
			// (the wire gate blocks that), so the plugin subscribes the socket
			// server-side here. Gate that on the REAL topic's authorization first -
			// the same check a wire-subscribe to `topic` would run - so a client
			// cannot join `__cursor:{topic}` for a topic it is not allowed to
			// subscribe to (closing the message-triggered path around the wire-level
			// `__`-subscribe block). checkSubscribe is async and was added to the
			// platform later, so it is optional-chained; the handshake is
			// low-frequency (once per (re)connect) so the await is off the hot path.
			// Subsequent `cursor` / `cursor-viewport` frames require this established
			// membership via the isSubscribed gate in hooks.message.
			if (platform && typeof platform.checkSubscribe === 'function') {
				let denial;
				try { denial = await platform.checkSubscribe(ws, topic); } catch { return; }
				if (denial) return;
			}
			// Tracked: the native subscribe alone would deliver JSON publishes
			// (uWS fans those out itself) but silently miss every binary
			// publishWire frame, whose per-subscriber walk reads the
			// connection's subscription registry rather than asking uWS.
			if (!trackedSubscribe(ws, TOPIC_PREFIX + topic)) return;
			// Server time first, so the requester's clock estimator is seeded
			// before the first stamped position frame and the request/reply
			// round trip is measurable. Rides the codec's JSON fallback (the
			// codec declines the event), so it is an additive envelope an
			// older client's merge ignores as an unknown event.
			emitTo(ws, TOPIC_PREFIX + topic, EVENTS.TIME, { t: wallEpoch() }, platform);
			const topicMap = topics.get(topic);
			const catalog = [];
			const positions = [];
			if (topicMap) {
				for (const [key, entry] of topicMap) {
					catalog.push({ key, user: entry.user });
					positions.push({ key, data: entry.data });
				}
			}
			emitTo(ws, TOPIC_PREFIX + topic, EVENTS.CATALOG, catalog, platform);
			emitTo(ws, TOPIC_PREFIX + topic, EVENTS.BULK, positions, platform);
		},

		/**
		 * Record this subscriber's viewport rect for a topic, from the inbound
		 * `cursor-viewport` frame. The rect bounds which cursors the subscriber
		 * receives once viewport culling is enabled; a subscriber that never
		 * reports one is treated as whole-board and is never culled. Best-effort:
		 * a malformed rect (missing or non-finite `x`/`y`/`w`/`h`) is dropped
		 * silently, mirroring the oversized-data drop on the update path. `zoom`
		 * is optional and defaults to 1.
		 * @param {any} ws
		 * @param {string} topic
		 * @param {any} rect
		 */
		viewport(ws, topic, rect) {
			if (!rect || typeof rect !== 'object') return;
			const { x, y, w, h } = rect;
			const zoom = rect.zoom === undefined ? 1 : rect.zoom;
			if (![x, y, w, h, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
			// A viewport has positive dimensions; a zero/negative w/h/zoom (an
			// unmounted or collapsed element) is degenerate. Drop it so the
			// subscriber stays "whole-board" (never culled) rather than recording
			// a rect culling would later resolve to an empty slice. x/y may be
			// negative (board coordinates).
			if (w <= 0 || h <= 0 || zoom <= 0) return;
			const state = getWsState(ws);
			let byTopic = subViewport.get(state.key);
			if (!byTopic) { byTopic = new Map(); subViewport.set(state.key, byTopic); }
			// First rect this subscriber reports for the topic flips it onto the
			// per-subscriber walk; a re-report of an existing topic does not.
			if (!byTopic.has(topic)) addReporter(topic);
			byTopic.set(topic, { x, y, w, h, zoom });
		},

		/**
		 * The last viewport rect this subscriber reported for a topic, or `null`
		 * if it never reported one. The `null` return is the per-subscriber
		 * opt-in that makes culling safe by construction. Read by viewport
		 * culling; does not create `wsState`.
		 * @param {any} ws
		 * @param {string} topic
		 * @returns {{ x: number, y: number, w: number, h: number, zoom: number } | null}
		 */
		viewportFor(ws, topic) {
			return lookupViewport(ws, topic);
		},

		clear() {
			for (const [, topicMap] of topics) {
				for (const [, entry] of topicMap) {
					if (entry.timer) clearTimer(entry.timer);
					if (entry.settleTimer) clearTimer(entry.settleTimer);
				}
			}
			if (tickTimer !== null) { clearTimer(tickTimer); tickTimer = null; }
			dirtyTopics.clear();
			topics.clear();
			topicFlush.clear();
			subViewport.clear();
			topicReporters.clear();
			wsState.clear();
			connCounter = 0;
			// Release per-flush scratch so a reset reclaims the last flush's
			// references (the lifetime stats counters are intentionally left
			// alone, matching `flushCount`).
			flushItems.length = 0;
			flushPos.length = 0;
			alwaysVisible.length = 0;
			cullOut.length = 0;
			cellPool.length = 0;
			flushCells.clear();
			immediateOne.clear();
			inDeliver = false;
		},

		/**
		 * Snapshot of scheduler health. Always available, near-zero cost.
		 *
		 * - `flushes`: total tick-driven flushes since tracker creation.
		 * - `driftMeanMs`: mean (target_deadline - actual_fire_time) across
		 *   all tick-driven flushes. 0 means perfect cadence; values >
		 *   `topicThrottle` indicate sustained event-loop saturation or
		 *   CPU contention.
		 * - `driftMaxMs`: largest single observed late fire. Useful for
		 *   spotting one-off GC pauses vs. sustained drift.
		 * - `dirtyTopicsCurrent`: topics with pending coalesced entries
		 *   right now. Should hover near zero in healthy operation.
		 * - `activeTopicsTotal`: topics with at least one local cursor.
		 *
		 * Leading-edge synchronous flushes (first call on an idle topic)
		 * are not counted in drift stats - they fire on the call thread,
		 * not via the scheduler.
		 */
		stats() {
			return {
				flushes: flushCount,
				driftMeanMs: driftCount > 0 ? driftSum / driftCount : 0,
				driftMaxMs: driftMax,
				dirtyTopicsCurrent: dirtyTopics.size,
				activeTopicsTotal: topics.size,
				viewportsReported: subViewport.size,
				perSubscriberFlushes,
				bpSkips,
				culledEntriesDropped,
				jitterDropped
			};
		},

		hooks: {
			message(ws, { data, platform }) {
				let parsed;
				try { parsed = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
				if (parsed.type === 'cursor' && typeof parsed.topic === 'string') {
					if (typeof ws.isSubscribed === 'function' && !ws.isSubscribed(TOPIC_PREFIX + parsed.topic)) return true;
					tracker.update(ws, parsed.topic, parsed.data ?? parsed.position, platform);
					return true;
				}
				if (parsed.type === 'cursor-snapshot' && typeof parsed.topic === 'string') {
					// No isSubscribed gate here: the snapshot IS the authorized
					// membership-establishing handshake (it runs checkSubscribe and
					// subscribes the socket). It is async; run it fire-and-forget
					// (it self-contains its errors) so the message hook stays sync.
					tracker.snapshot(ws, parsed.topic, platform);
					return true;
				}
				if (parsed.type === 'cursor-viewport' && typeof parsed.topic === 'string') {
					if (typeof ws.isSubscribed === 'function' && !ws.isSubscribed(TOPIC_PREFIX + parsed.topic)) return true;
					tracker.viewport(ws, parsed.topic, parsed.rect);
					return true;
				}
			},
			close(ws, { platform }) {
				tracker.remove(ws, platform);
			}
		}
	};

	return tracker;
}

/**
 * Build the cursor binary wire codec (cursor.protocol:2 full-string / :3 short-id
 * dictionary). Exported so the cluster-backed variant (svelte-adapter-uws-
 * extensions redis/cursor) builds the IDENTICAL codec from one definition - no
 * drift. The per-connection dictionary state lives in the framework (publishWire
 * runs the per-subscriber encode against it), so the cluster variant just hands
 * this codec to publishWire and the adapter does the rest.
 *
 * Wire transport selection:
 *   - `binary: false` -> null (JSON for everyone).
 *   - `dictionary: false` -> stateless full-string binary (schemaVersion 1) for
 *     every binary-capable client, encoded once and fanned out to all. Use for a
 *     single process with very high per-topic fan-out, where the per-connection
 *     dictionary's per-subscriber encode would cost more CPU than the bandwidth.
 *   - default -> the short-id dictionary (schemaVersion 2) for clients that
 *     advertised it, full-string (schemaVersion 1) for older binary clients.
 * @param {{ binary?: boolean, dictionary?: boolean }} [options]
 */
export function createCursorWireCodec(options = {}) {
	const useDictionary = options.binary !== false && options.dictionary !== false;
	const baseCodec = {
		capability: CURSOR_CAPABILITY,
		schemaVersion: CURSOR_SCHEMA_VERSION,
		encode: encodeCursor
	};
	return options.binary === false
		? null
		: !useDictionary
			? baseCodec // stateless: full-string binary, encode-once-send-many
			: {
				...baseCodec,
				// Per-connection short-id dictionary state. `onAttach` reads the
				// connection's negotiated capabilities: a client that advertised
				// the time capability on top of the dictionary gets the stamped
				// dictionary (schemaVersion 3, position frames carry the server
				// wall clock for client-side interpolation); a dictionary-only
				// client gets the plain dictionary (schemaVersion 2); any other
				// binary-capable client returns null, which the framework treats
				// as the shared full-string encode (schemaVersion 1) - so an
				// older client keeps the single-encode fan-out and a
				// byte-for-byte compatible frame. The choice is fixed for the
				// life of the connection (reset on reconnect, not on re-hello).
				state: {
					onAttach(ws) {
						let caps;
						try { caps = ws.getUserData()[WS_CAPS]; } catch { return null; }
						if (!caps || !caps.has(CURSOR_CAPABILITY_DICT)) return null;
						return caps.has(CURSOR_CAPABILITY_TIME)
							? new CursorTimeEncodeDict(wallEpoch)
							: new CursorEncodeDict();
					},
					onDetach(ws, state) {
						if (state && state.byKey) state.byKey.clear();
					}
				}
			};
}
