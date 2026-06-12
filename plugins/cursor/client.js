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
import { selectRenderer, hashColor } from './render/index.js';

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
	// A canvas switches cursor() from "reactive data" to "rendered pixels":
	// the return value is a small handle (mount/viewport/configure/destroy),
	// not a store, and the ingest-decode-paint pipeline runs in a dedicated
	// worker when the browser allows it. The no-canvas path below is
	// byte-for-byte the store the plugin always returned.
	if (options && options.canvas) return cursorOnCanvas(topic, options);
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

/*
 * Canvas rendering.
 *
 * `cursor(topic, { canvas })` hands the entire ingest-decode-merge-paint
 * pipeline to a dedicated worker that owns its own WebSocket and an
 * `OffscreenCanvas` transferred from the element, so the main thread reads
 * nothing from the cursor stream. Where the browser cannot do that
 * (no Worker / no OffscreenCanvas / no transferControlToOffscreen, or the
 * app forces `rendering: 'main'`), the same call renders on the main thread
 * against the same renderer backends, fed by the unchanged store above - so
 * the visual result is identical and the API never branches in app code.
 *
 * One worker serves one canvas element for the element's whole lifetime:
 * `transferControlToOffscreen()` is once-per-element, so unmounting pauses
 * the worker (socket closed, loops stopped, state cleared) instead of
 * terminating it, and a remount - same or different topic - re-inits it on
 * the kept surface. A `FinalizationRegistry` reaps the worker when the
 * canvas element itself is garbage collected.
 */

/** Per-canvas worker host. @type {WeakMap<any, any> | null} */
const canvasHosts = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

/** Terminates a host's worker once its canvas element is unreachable. */
const workerReaper = typeof FinalizationRegistry !== 'undefined'
	? new FinalizationRegistry((worker) => { try { worker.terminate(); } catch { /* already gone */ } })
	: null;

/**
 * Pack a display-config color into 0xRRGGBBAA. Accepts a packed 32-bit
 * integer or a hex string ('#rgb', '#rrggbb', '#rrggbbaa'); anything else
 * returns null and the deterministic default palette applies. Hex-only on
 * purpose: resolving arbitrary CSS color names would need a DOM round-trip
 * the worker path cannot afford, and hex covers the data-driven case
 * (a team color stored on the user object) completely.
 * @param {any} v
 * @returns {number | null}
 */
function packColor(v) {
	if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
	if (typeof v !== 'string') return null;
	let s = v.trim();
	if (s.startsWith('#')) s = s.slice(1);
	if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
	if (s.length === 6) s += 'ff';
	if (s.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(s)) return null;
	return parseInt(s, 16) >>> 0;
}

/**
 * Resolve the app's display-config callbacks against a roster, with the
 * callbacks contained: a throwing `colorOf`/`hide` skips that user and
 * keeps the pipeline alive (an app bug must degrade colors, not cursors).
 * @param {Map<string, any>} roster key -> user
 * @param {{ colorOf?: (user: any) => any, hide?: (user: any) => boolean }} cfg
 * @returns {{ colors: Array<[string, number]>, hidden: string[] }}
 */
function resolveDisplayConfig(roster, cfg) {
	const colors = [];
	const hidden = [];
	for (const [key, user] of roster) {
		if (cfg.colorOf) {
			try {
				const packed = packColor(cfg.colorOf(user));
				if (packed !== null) colors.push([key, packed]);
			} catch { /* contained: default palette applies */ }
		}
		if (cfg.hide) {
			try {
				if (cfg.hide(user) === true) hidden.push(key);
			} catch { /* contained: stays visible */ }
		}
	}
	return { colors, hidden };
}

/**
 * The canvas-mode entry behind `cursor(topic, { canvas })`.
 * @param {string} topic
 * @param {any} options
 */
function cursorOnCanvas(topic, options) {
	const canvas = options.canvas;
	const rendering = options.rendering === undefined ? 'auto' : options.rendering;
	if (rendering !== 'auto' && rendering !== 'main' && rendering !== 'worker') {
		throw new Error('cursor: unknown rendering mode ' + JSON.stringify(rendering));
	}
	const gpu = options.gpu === undefined ? 'auto' : options.gpu;
	if (gpu !== 'auto' && gpu !== 'canvas2d' && gpu !== 'webgl2' && gpu !== 'webgpu') {
		// Fail here on the main thread; deferring to the worker's first frame
		// would surface as an opaque worker error event.
		throw new Error('cursor: unknown gpu mode ' + JSON.stringify(gpu));
	}
	const gpuThreshold = options.gpuThreshold === undefined ? 500 : options.gpuThreshold;
	const maxAge = typeof options.maxAge === 'number' ? options.maxAge : 0;
	const feedRate = options.mainThreadFeed === true ? 10
		: (options.mainThreadFeed && typeof options.mainThreadFeed.rate === 'number' ? options.mainThreadFeed.rate : 0);

	// SSR: an inert handle so `$effect(() => cursor(t, { canvas }).mount())`
	// is safe in universal components (effects only run in the browser, but
	// a stray server call must not throw).
	if (typeof window === 'undefined' || !canvasHosts) {
		const inert = writable(new Map());
		return {
			mount: () => () => {},
			viewport: () => {},
			configure: () => {},
			destroy: () => {},
			...(feedRate > 0 ? { feed: { subscribe: inert.subscribe } } : {}),
			...(rendering === 'main' ? { store: { subscribe: inert.subscribe } } : {})
		};
	}

	let host = canvasHosts.get(canvas);
	if (!host) {
		host = { worker: null, off: null, canvasSent: false, activeTopic: null, activeSink: null, handles: new Map() };
		canvasHosts.set(canvas, host);
	}
	const cached = host.handles.get(topic);
	if (cached) {
		if (options.viewport) cached._setViewportSource(options.viewport);
		return cached;
	}

	// - per-handle state -
	let refCount = 0;
	let everMounted = false;
	let viewportSource = options.viewport ?? null;
	const cfg = { colorOf: null, hide: null };
	/** @type {Map<string, any>} latest roster (worker mode: pushed; fallback: derived) */
	let roster = new Map();
	const feedStore = feedRate > 0 ? writable(new Map()) : null;

	// Worker-mode internals.
	let initSent = false;
	let statusUnsub = null;
	let pumpHandle = null;
	let pumpSig = '';

	// Fallback internals.
	let fallback = null;

	function ensureWorker() {
		if (host.worker) return host.worker;
		// Throws InvalidStateError when the surface was already transferred
		// outside this plugin; surface the real constraint instead of a
		// generic DOM error message.
		let off;
		try {
			off = canvas.transferControlToOffscreen();
		} catch (err) {
			throw new Error('cursor: this canvas cannot start a render worker - its drawing surface was already transferred or claimed (' + (err && err.message) + ')');
		}
		const worker = new Worker(new URL('./cursor-worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (ev) => { if (host.activeSink) host.activeSink(ev.data); };
		if (workerReaper) workerReaper.register(canvas, worker, worker);
		host.worker = worker;
		host.off = off;
		host.canvasSent = false;
		return worker;
	}

	function pushConfig() {
		if (!cfg.colorOf && !cfg.hide) return;
		const resolved = resolveDisplayConfig(roster, cfg);
		if (host.worker && initSent) {
			host.worker.postMessage({ type: 'config', colors: resolved.colors, hidden: resolved.hidden });
		}
		if (fallback) {
			fallback.colors = new Map(resolved.colors);
			fallback.hidden = new Set(resolved.hidden);
			fallback.dirty = true;
		}
	}

	function workerSink(msg) {
		if (msg === null || typeof msg !== 'object') return;
		if (msg.type === 'roster' && Array.isArray(msg.users)) {
			roster = new Map(msg.users);
			pushConfig();
			return;
		}
		if (msg.type === 'feed' && feedStore && Array.isArray(msg.keys)) {
			const map = new Map();
			const { keys, positions, colors } = msg;
			// Shape guard: the buffers must cover every key or the join would
			// fabricate undefined coordinates.
			if (!positions || !colors || typeof positions.length !== 'number' || typeof colors.length !== 'number') return;
			if (positions.length < keys.length * 2 || colors.length < keys.length) return;
			for (let i = 0; i < keys.length; i++) {
				map.set(keys[i], {
					user: roster.get(keys[i]),
					data: { x: positions[i * 2], y: positions[i * 2 + 1] },
					colorRGBA: colors[i]
				});
			}
			feedStore.set(map);
		}
	}

	function sendInit() {
		if (initSent) return;
		const worker = ensureWorker();
		host.activeSink = workerSink;
		const init = {
			type: 'init',
			topic,
			url: connect()._url(),
			gpu,
			gpuThreshold,
			devicePixelRatio: window.devicePixelRatio || 1,
			maxAge,
			feedRate
		};
		if (!host.canvasSent) {
			init.canvas = host.off;
			host.canvasSent = true;
			worker.postMessage(init, [host.off]);
		} else {
			worker.postMessage(init);
		}
		initSent = true;
		pushConfig();
		startPump();
	}

	function startPump() {
		if (pumpHandle !== null) return;
		const tick = () => {
			const rect = resolveViewportRect(viewportSource ?? canvas);
			if (rect && host.worker && initSent) {
				const dpr = window.devicePixelRatio || 1;
				const sig = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ',' + rect.zoom + ',' + dpr;
				if (sig !== pumpSig) {
					pumpSig = sig;
					// dpr rides along so a monitor move / browser zoom rescales
					// the worker's renderer, not just this signature.
					host.worker.postMessage({ type: 'viewport', rect, dpr });
				}
			}
			pumpHandle = scheduleFrame(tick);
		};
		pumpHandle = scheduleFrame(tick);
	}

	function stopPump() {
		cancelFrame(pumpHandle);
		pumpHandle = null;
		pumpSig = '';
	}

	function mountWorker() {
		host.activeTopic = topic;
		host.activeSink = workerSink;
		connect();
		// Init waits for the main connection's first 'open': by then the auth
		// preflight has run (cookies are minted) and the endpoint is proven
		// reachable, so the worker socket can dial the same URL cold.
		statusUnsub = status.subscribe((s) => {
			if (s === 'open') sendInit();
		});
		return function teardown() {
			if (--refCount > 0) return;
			stopPump();
			if (statusUnsub) { statusUnsub(); statusUnsub = null; }
			if (host.worker && initSent) host.worker.postMessage({ type: 'pause' });
			initSent = false;
			host.activeTopic = null;
			host.activeSink = null;
		};
	}

	function mountFallback() {
		// The unchanged store above is the data source: same merge, same
		// self-healing sweep, and - when a viewport source exists - the same
		// main-connection culling report the store path always sent.
		const storeOpts = {};
		if (maxAge > 0) storeOpts.maxAge = maxAge;
		if (viewportSource) storeOpts.viewport = viewportSource;
		const source = handle.store || cursor(topic, storeOpts);
		const fb = {
			merged: new Map(),
			dirty: true,
			rectSig: '',
			colors: new Map(),
			hidden: new Set(),
			renderer: null,
			lastCount: 0,
			raf: null,
			feedTimer: null,
			unsub: null
		};
		fallback = fb;
		fb.unsub = source.subscribe((map) => {
			fb.merged = map;
			fb.dirty = true;
			// Re-resolve display config only when the user set changes; a
			// position-only frame keeps the same keys and must not pay an
			// O(users) callback sweep at wire rate.
			let sameKeys = map.size === roster.size;
			if (sameKeys) {
				for (const key of map.keys()) {
					if (!roster.has(key)) { sameKeys = false; break; }
				}
			}
			if (!sameKeys) {
				roster = new Map();
				for (const [key, entry] of map) roster.set(key, entry.user);
				pushConfig();
			}
		});

		const visible = [];
		const frame = () => {
			fb.raf = scheduleFrame(frame);
			const rect = resolveViewportRect(viewportSource ?? canvas);
			if (!rect) return;
			const zoom = rect.zoom || 1;
			// dpr is read every frame: monitor moves and browser zoom change it
			// mid-session, and the signature catches the change like any other
			// viewport delta.
			const dpr = window.devicePixelRatio || 1;
			const sig = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ',' + zoom + ',' + dpr;
			if (sig !== fb.rectSig) { fb.rectSig = sig; fb.dirty = true; }
			if (!fb.dirty) return;
			fb.dirty = false;
			fb.renderer = selectRenderer(canvas, { gpu, gpuThreshold, devicePixelRatio: dpr, lastCount: fb.lastCount }, fb.renderer);
			fb.renderer.resize(rect.w * zoom, rect.h * zoom, dpr);
			visible.length = 0;
			const pad = 8 / zoom;
			const minX = rect.x - pad, maxX = rect.x + rect.w + pad;
			const minY = rect.y - pad, maxY = rect.y + rect.h + pad;
			for (const [key, entry] of fb.merged) {
				if (fb.hidden.has(key)) continue;
				const data = entry.data;
				if (data === null || typeof data !== 'object') continue;
				const x = data.x, y = data.y;
				if (typeof x !== 'number' || typeof y !== 'number') continue;
				if (x < minX || x > maxX || y < minY || y > maxY) continue;
				const override = fb.colors.get(key);
				visible.push({
					x: (x - rect.x) * zoom,
					y: (y - rect.y) * zoom,
					colorRGBA: override === undefined ? hashColor(key) : override,
					hidden: false
				});
			}
			fb.lastCount = visible.length;
			fb.renderer.render(visible, visible.length);
		};
		fb.raf = scheduleFrame(frame);

		if (feedStore && feedRate > 0) {
			fb.feedTimer = setIntervalTimer(() => {
				const rect = resolveViewportRect(viewportSource ?? canvas);
				const map = new Map();
				if (rect) {
					const zoom = rect.zoom || 1;
					const pad = 8 / zoom;
					for (const [key, entry] of fb.merged) {
						if (fb.hidden.has(key)) continue;
						const data = entry.data;
						if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') continue;
						if (data.x < rect.x - pad || data.x > rect.x + rect.w + pad) continue;
						if (data.y < rect.y - pad || data.y > rect.y + rect.h + pad) continue;
						const override = fb.colors.get(key);
						map.set(key, {
							user: entry.user,
							data: { x: data.x, y: data.y },
							colorRGBA: override === undefined ? hashColor(key) : override
						});
					}
				}
				feedStore.set(map);
			}, 1000 / feedRate);
		}

		return function teardown() {
			if (--refCount > 0) return;
			if (fb.unsub) fb.unsub();
			cancelFrame(fb.raf);
			if (fb.feedTimer !== null) clearIntervalTimer(fb.feedTimer);
			if (fb.renderer) { fb.renderer.dispose(); fb.renderer = null; }
			fallback = null;
		};
	}

	/** @type {(() => void) | null} active teardown while mounted */
	let activeTeardown = null;
	let handleDestroyed = false;

	/** Per-caller idempotent wrapper: a teardown invoked twice (a defensive
	 * caller, an effect framework bug) must decrement the refCount exactly
	 * once or a sibling mount's pipeline would be torn down under it. */
	function teardownOnce() {
		let torn = false;
		return () => {
			if (torn) return;
			torn = true;
			if (activeTeardown) activeTeardown();
		};
	}

	const handle = {
		/**
		 * Start rendering. Returns a teardown function, so the natural Svelte
		 * binding is `$effect(() => cursor(topic, { canvas }).mount())`.
		 * Unmounting pauses the pipeline; the same canvas can mount again.
		 */
		mount() {
			if (handleDestroyed) {
				throw new Error('cursor: this handle was destroyed; its canvas surface is gone - bind a fresh <canvas> element and call cursor() again');
			}
			everMounted = true;
			if (refCount++ > 0) return teardownOnce();
			const workerViable =
				typeof Worker !== 'undefined' &&
				typeof OffscreenCanvas !== 'undefined' &&
				typeof canvas.transferControlToOffscreen === 'function';
			if (rendering === 'worker' && !workerViable) {
				refCount--;
				throw new Error('cursor: rendering "worker" requires Worker, OffscreenCanvas and transferControlToOffscreen; this browser lacks them - use rendering "auto" to fall back to main-thread rendering');
			}
			if (host.activeTopic !== null && host.activeTopic !== topic) {
				refCount--;
				throw new Error('cursor: canvas is already rendering topic ' + JSON.stringify(host.activeTopic) + '; one canvas renders one topic at a time');
			}
			const useWorker = workerViable && rendering !== 'main';
			activeTeardown = useWorker ? mountWorker() : mountFallback();
			return teardownOnce();
		},

		/**
		 * Push a viewport manually. Accepts the same sources as the
		 * `viewport` option (element, explicit rect, or getter); the value
		 * becomes the tracked source, so an explicit rect is re-sent only
		 * when replaced by the next call.
		 */
		viewport(source) {
			viewportSource = source;
			pumpSig = '';
			if (fallback) { fallback.rectSig = ''; fallback.dirty = true; }
		},

		/**
		 * Display config. Functions run on the main thread against the
		 * roster; only the resolved per-key results cross to the worker. The
		 * callbacks deliberately receive the user object, never the
		 * connection key of another viewer's session.
		 */
		configure(config) {
			cfg.colorOf = config && typeof config.colorOf === 'function' ? config.colorOf : null;
			cfg.hide = config && typeof config.hide === 'function' ? config.hide : null;
			pushConfig();
		},

		/**
		 * Terminal teardown: stops the pipeline AND disposes the worker. The
		 * canvas element cannot host cursors afterwards (its surface was
		 * transferred once and the worker that owned it is gone); normal
		 * component lifecycles should rely on the mount() teardown instead.
		 */
		destroy() {
			handleDestroyed = true;
			if (activeTeardown) { refCount = 1; activeTeardown(); activeTeardown = null; }
			if (host.worker) {
				host.worker.postMessage({ type: 'destroy' });
				host.worker.terminate();
				if (workerReaper) workerReaper.unregister(host.worker);
				host.worker = null;
				host.off = null;
				host.activeSink = null;
				host.activeTopic = null;
			}
			host.handles.delete(topic);
		},

		/** @internal Late viewport source adoption, mirroring the store path. */
		_setViewportSource(src) {
			viewportSource = src;
			pumpSig = '';
			if (fallback) { fallback.rectSig = ''; fallback.dirty = true; }
		}
	};

	if (feedStore) handle.feed = { subscribe: feedStore.subscribe };
	if (rendering === 'main') {
		const storeOpts = {};
		if (maxAge > 0) storeOpts.maxAge = maxAge;
		if (viewportSource) storeOpts.viewport = viewportSource;
		handle.store = cursor(topic, storeOpts);
	}

	host.handles.set(topic, handle);

	// Mirror the store path's cache hygiene: a handle nobody mounted by the
	// next microtask is forgotten.
	microtask(() => {
		if (!everMounted && refCount === 0) host.handles.delete(topic);
	});

	return handle;
}
