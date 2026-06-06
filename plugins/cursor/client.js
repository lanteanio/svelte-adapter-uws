/**
 * Client-side cursor helper for svelte-adapter-uws.
 *
 * Subscribes to the internal `__cursor:{topic}` channel and maintains
 * a live Map of cursor positions. The server handles throttling and
 * cleanup; this module keeps the client-side state in sync.
 *
 * Wire shape (catalog / positions split):
 *   - `catalog`  [{key, user}]  - roster sent on snapshot to a fresh
 *                                  subscriber. Replaces local user map.
 *   - `join`     {key, user}    - new user announced on the topic.
 *   - `update`   {key, data}    - single-mover position frame.
 *   - `bulk`     [{key, data}]  - multi-mover coalesced position frame.
 *   - `remove`   {key}          - user gone (catalog + positions cleared).
 *
 * User metadata lives on the catalog channel (catalog + join), positions
 * live on the update/bulk channel. The merge happens here: the public
 * Readable yields `Map<key, {user, data}>`, skipping any position whose
 * user has not yet been seen via catalog/join.
 *
 * When `maxAge` is set, cursor entries that haven't received a position
 * update within that window are automatically removed. This makes
 * clients self-healing when the server fails to broadcast a `remove`
 * event (e.g. mass disconnects overwhelming Redis cleanup).
 *
 * @module svelte-adapter-uws/plugins/cursor/client
 */

const TOPIC_PREFIX = '__cursor:';

import { on, connect, status, registerWireCodec } from '../../client.js';
import { setTimer, setIntervalTimer, clearTimer, clearIntervalTimer, microtask } from '../../client-runtime.js';
import { writable } from 'svelte/store';
import { decodeCursor, CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CursorDecodeDict } from './codec.js';
import { applyEvent, mergeOutput, sweepExpired } from './decode.js';

// Opt this connection into binary cursor frames: advertise both the full-string
// and the short-id dictionary capabilities in the `hello` frame and route
// inbound `0x03` frames on `__cursor:` topics through the cursor decoder, which
// yields the identical { event, data } the JSON path produced - so the store
// merge logic below is untouched. Advertising both tokens lets a new server send
// the compact dictionary form while an older server still sends the full-string
// form this client also decodes. The decoder dispatches on the frame's
// schemaVersion; the per-connection `state` is the short-id dictionary (id ->
// key), reset on reconnect by the connection. Registered at module load so the
// first `hello` already carries both capabilities. Fully transparent: nothing in
// the cursor() store knows whether a frame was binary or which schema it used.
registerWireCodec(TOPIC_PREFIX, {
	capability: CURSOR_CAPABILITY,
	capabilities: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT],
	state: { onAttach: () => new CursorDecodeDict() },
	decode: decodeCursor
});

/** @type {Map<string, ReturnType<typeof cursor>>} */
const cursorStores = new Map();

/**
 * Get a reactive store of cursor positions on a topic.
 *
 * Returns a readable Svelte store containing a Map of connection keys
 * to `{ user, data }` objects. The Map updates automatically when
 * cursors move, join, or disconnect.
 *
 * @template UserInfo, Data
 * @param {string} topic - Topic to track cursors on
 * @param {{ maxAge?: number }} [options] - Options
 * @returns {import('svelte/store').Readable<Map<string, { user: UserInfo, data: Data }>>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   const cursors = cursor('canvas');
 *
 *   function onmousemove(e) {
 *     move('canvas', { x: e.clientX, y: e.clientY });
 *   }
 * </script>
 *
 * <div on:mousemove={onmousemove}>
 *   {#each [...$cursors] as [key, { user, data }] (key)}
 *     <div style="left: {data.x}px; top: {data.y}px" class="cursor">
 *       {user.name}
 *     </div>
 *   {/each}
 * </div>
 * ```
 *
 * @example
 * ```svelte
 * <script>
 *   // Self-healing: cursors expire after 30s without a position update.
 *   const cursors = cursor('canvas', { maxAge: 30_000 });
 * </script>
 * ```
 */
export function cursor(topic, options) {
	const maxAge = options?.maxAge;
	const cacheKey = maxAge > 0 ? topic + '\0' + maxAge : topic;

	const cached = cursorStores.get(cacheKey);
	if (cached) {
		// A later caller can supply the viewport source the first did not (e.g. a
		// board-owner component mounting after a plain reader). Last writer wins.
		if (options?.viewport) cached._setViewportSource(options.viewport);
		return cached;
	}

	const cursorTopic = TOPIC_PREFIX + topic;

	// The catalog/join/update/bulk/remove merge, the output build, and the sweep
	// live in ./decode.js as pure functions over this `state`; the store here
	// owns subscription, the writable, and viewport reporting. Keeping the same
	// `state` object across a (re)subscribe cycle (clearing in place rather than
	// reassigning) keeps every closure below pointing at the live Maps.
	/** @type {import('./decode.js').CursorState} */
	const state = { positionMap: new Map(), userMap: new Map(), timestamps: new Map() };
	const output = writable(/** @type {Map<string, any>} */ (new Map()));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let statusUnsub = /** @type {(() => void) | null} */ (null);
	/** @type {ReturnType<typeof setIntervalTimer> | null} */
	let sweepTimer = null;
	let refCount = 0;
	let cancelled = false;

	// Optional viewport auto-reporting. When a `viewport` source is given, the
	// store polls it on each animation frame while subscribed and calls
	// `reportViewport` only when the resolved rect actually changes - so scroll /
	// resize / zoom / late mount are all covered with no per-app wiring and no
	// redundant sends. Plain `cursor(topic)` usage never starts the poll.
	let viewportSource = options?.viewport ?? null;
	/** @type {ReturnType<typeof scheduleFrame> | null} */
	let viewportRaf = null;
	let viewportLastSig = '';

	function startViewportPoll() {
		if (typeof window === 'undefined' || !viewportSource || viewportRaf !== null) return;
		const tick = () => {
			const rect = resolveViewportRect(viewportSource);
			if (rect) {
				const sig = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ',' + rect.zoom;
				if (sig !== viewportLastSig) {
					viewportLastSig = sig;
					// The poll IS the rAF cadence, so send the frame directly rather
					// than routing through reportViewport's own rAF-coalesce hop.
					try { connect().send({ type: 'cursor-viewport', topic, rect }); } catch { /* not connected yet */ }
				}
			}
			// Keep polling even when unresolved (a getter whose element is not yet
			// bound) so a late mount starts reporting automatically.
			viewportRaf = scheduleFrame(tick);
		};
		viewportRaf = scheduleFrame(tick);
	}

	function stopViewportPoll() {
		cancelFrame(viewportRaf);
		viewportRaf = null;
		viewportLastSig = '';
	}

	function emitOutput() {
		output.set(mergeOutput(state));
	}

	function sweep() {
		if (sweepExpired(state, maxAge)) emitOutput();
	}

	function startListening() {
		cancelled = false;
		const source = on(cursorTopic);
		sourceUnsub = source.subscribe((event) => {
			if (applyEvent(state, event)) emitOutput();
		});

		if (maxAge > 0) {
			sweepTimer = setIntervalTimer(sweep, Math.max(maxAge / 2, 1000));
		}

		// Request a snapshot of existing cursor positions every time the socket
		// opens (initial connect and reconnects). Without this, the store would
		// miss cursors that appeared while the client was offline.
		statusUnsub = status.subscribe((s) => {
			if (s === 'open' && !cancelled) {
				connect().send({ type: 'cursor-snapshot', topic });
				// Re-establish the viewport after a (re)connect so a reconnecting
				// tab is not culled to an empty slice before its next report.
				viewportLastSig = '';
			}
		});

		startViewportPoll();
	}

	function stopListening() {
		cancelled = true;
		if (sourceUnsub) {
			sourceUnsub();
			sourceUnsub = null;
		}
		if (statusUnsub) {
			statusUnsub();
			statusUnsub = null;
		}
		if (sweepTimer) {
			clearIntervalTimer(sweepTimer);
			sweepTimer = null;
		}
		stopViewportPoll();
		state.positionMap.clear();
		state.userMap.clear();
		state.timestamps.clear();
		// Push the cleared state to the output store so a new subscriber does
		// not see ghost cursors from the previous subscription cycle.
		output.set(new Map());
	}

	const store = {
		subscribe(fn) {
			if (refCount++ === 0) startListening();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--refCount === 0) {
					stopListening();
					cursorStores.delete(cacheKey);
				}
			};
		},
		/**
		 * @internal Adopt a viewport source supplied by a later `cursor()` call,
		 * starting the poll if the store is already subscribed.
		 */
		_setViewportSource(src) {
			viewportSource = src;
			viewportLastSig = '';
			if (refCount > 0) startViewportPoll();
		}
	};

	cursorStores.set(cacheKey, store);

	// If nothing subscribes before the next microtask, remove the cache entry.
	microtask(() => {
		if (refCount === 0) cursorStores.delete(cacheKey);
	});

	return store;
}

/**
 * Internal coalesce buffer for `move()`. One entry per topic; latest-
 * wins inside a single animation frame. Flushed on the next rAF tick.
 * @type {Map<string, any>}
 */
const movePending = new Map();
let moveScheduled = false;

// Resolve `requestAnimationFrame` at call time so a polyfill installed
// after this module imports (or a test harness substitution) is honored.
function scheduleFrame(cb) {
	if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
	return setTimer(cb, 16);
}

function cancelFrame(handle) {
	if (handle == null) return;
	if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(handle);
	else clearTimer(handle);
}

/**
 * Send a cursor move on a topic. Frames are coalesced via
 * `requestAnimationFrame` so calling `move()` at 1000 Hz (high-DPI
 * mouse) collapses to at most one send per repaint, matching the
 * server-side `topicThrottle` default. Multi-topic callers do not
 * clobber each other.
 *
 * No-op in non-browser environments.
 *
 * @param {string} topic
 * @param {any} data
 *
 * @example
 * ```svelte
 * <script>
 *   import { move } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   function onmousemove(e) {
 *     move('canvas', { x: e.clientX, y: e.clientY });
 *   }
 * </script>
 *
 * <div on:mousemove={onmousemove}> ... </div>
 * ```
 */
export function move(topic, data) {
	if (typeof window === 'undefined') return;
	movePending.set(topic, data);
	if (moveScheduled) return;
	moveScheduled = true;
	scheduleFrame(() => {
		moveScheduled = false;
		const conn = connect();
		for (const [t, d] of movePending) {
			conn.send({ type: 'cursor', topic: t, data: d });
		}
		movePending.clear();
	});
}

/**
 * Internal coalesce buffer for `reportViewport()`. One rect per topic;
 * latest-wins inside a single animation frame.
 * @type {Map<string, { x: number, y: number, w: number, h: number, zoom: number }>}
 */
const viewportPending = new Map();
let viewportScheduled = false;

/**
 * Resolve a viewport source to a `{ x, y, w, h, zoom }` rect in the board's
 * coordinate space. Accepts:
 *   - a scroll-container element: the visible content region is
 *     `{ x: scrollLeft, y: scrollTop, w: clientWidth, h: clientHeight, zoom: 1 }`.
 *   - an explicit rect object `{ x, y, w, h, zoom? }` (a virtualized canvas with
 *     its own transform computes this itself).
 *   - a getter returning either of the above.
 * Returns `null` for an unresolvable / malformed source.
 * @param {any} source
 */
function resolveViewportRect(source) {
	if (typeof source === 'function') source = source();
	if (!source || typeof source !== 'object') return null;
	if (typeof source.clientWidth === 'number' && typeof source.clientHeight === 'number') {
		const w = source.clientWidth;
		const h = source.clientHeight;
		// An unmounted / collapsed / pre-layout element reports 0x0; do not send
		// a degenerate viewport for it.
		if (w <= 0 || h <= 0) return null;
		return { x: source.scrollLeft || 0, y: source.scrollTop || 0, w, h, zoom: 1 };
	}
	const { x, y, w, h } = source;
	const zoom = source.zoom === undefined ? 1 : source.zoom;
	if (![x, y, w, h, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
	if (w <= 0 || h <= 0 || zoom <= 0) return null;
	return { x, y, w, h, zoom };
}

/**
 * Report this subscriber's viewport on a topic so the server can cull cursors
 * outside the visible region (once viewport culling is enabled server-side).
 * Reporting is per-subscriber and opt-in: a subscriber that never reports a
 * viewport is treated as whole-board and is never culled. Frames are coalesced
 * via `requestAnimationFrame` so a scroll burst collapses to one send per
 * repaint; multi-topic callers do not clobber each other.
 *
 * Most apps do not call this directly - pass `{ viewport }` to `cursor()` and
 * the store reports automatically. Use this for a source `cursor()` cannot
 * observe (e.g. a custom transform you recompute yourself).
 *
 * The reported rect and your `move()` data must share one coordinate space (the
 * board's): a scroll container reports `scrollLeft`/`scrollTop` board offsets,
 * so send board coordinates (`clientX + scrollLeft`), not raw screen `clientX`.
 *
 * No-op in non-browser environments and for an unresolvable source.
 *
 * @param {string} topic
 * @param {Element | { x: number, y: number, w: number, h: number, zoom?: number } | (() => any)} source
 *   a scroll-container element, an explicit `{ x, y, w, h, zoom? }` rect, or a
 *   getter returning either.
 *
 * @example
 * ```svelte
 * <script>
 *   import { reportViewport } from 'svelte-adapter-uws/plugins/cursor/client';
 *   // A virtualized canvas with its own pan/zoom transform:
 *   $effect(() => reportViewport('board', { x: panX, y: panY, w: viewW, h: viewH, zoom }));
 * </script>
 * ```
 */
export function reportViewport(topic, source) {
	if (typeof window === 'undefined') return;
	const rect = resolveViewportRect(source);
	if (!rect) return;
	viewportPending.set(topic, rect);
	if (viewportScheduled) return;
	viewportScheduled = true;
	scheduleFrame(() => {
		viewportScheduled = false;
		const conn = connect();
		for (const [t, r] of viewportPending) {
			conn.send({ type: 'cursor-viewport', topic: t, rect: r });
		}
		viewportPending.clear();
	});
}
