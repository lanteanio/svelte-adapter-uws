/**
 * Dedicated render worker for the cursor plugin.
 *
 * Owns a second WebSocket subscribed only to one cursor topic, decodes the
 * frames off the main thread, and paints into an `OffscreenCanvas` the main
 * thread transferred at mount. The main thread reads NOTHING from the cursor
 * stream while this worker runs; the only traffic back is the low-rate
 * roster (user metadata, so display config can resolve) and the optional
 * thinned position feed.
 *
 * The socket here is a deliberately minimal protocol client, not a port of
 * client.js:
 *
 *   - `hello` advertises ONLY the cursor codec capabilities. Without 'batch'
 *     the server never sends batch envelopes here, and without 'lease' flow
 *     control never activates - this socket's egress is a throttled viewport
 *     rect, nothing worth windowing - so neither demux arm exists.
 *   - No subscribe frame: `__`-prefixed topics cannot be subscribed over the
 *     wire. Sending `{type:'cursor-snapshot'}` makes the server's cursor
 *     plugin subscribe this socket AND reply with the catalog, so the
 *     snapshot request IS the subscription handshake (same as the main-thread
 *     store).
 *   - No resume/session state: cursors are ephemeral presence. A reconnect
 *     re-requests the snapshot and rebuilds state from scratch.
 *   - Reconnect uses the shared backoff curve, and a 30s liveness check
 *     recycles the socket when nothing (data or control) arrived for 150s -
 *     mirroring the main connection's zombie detection so a half-dead cursor
 *     socket cannot stall silently.
 *   - Per-connection wire state (topic-id map, short-id decode dictionary)
 *     resets on every (re)connect, in lock-step with the server's fresh
 *     encoder dictionary.
 *
 * Identifies itself at upgrade with the cursor lane subprotocol so a
 * deployment running the admission gate's cursor lane can route and shed it
 * independently of main connections.
 *
 * Lifecycle: `transferControlToOffscreen()` can run exactly once per canvas
 * element, so this worker outlives any single mount. `init` starts (or
 * restarts, possibly on a different topic) the socket and loops against the
 * canvas received on the first init; `pause` stops everything and clears
 * cursor state but keeps the canvas and renderer so a later `init` resumes
 * on the same surface; `destroy` is terminal and precedes terminate().
 *
 * The render loop applies the same visibility rule as the main-thread
 * store's merge: a position whose user has not yet arrived via catalog/join
 * stays invisible, so worker and fallback paint identical sets for the same
 * frame sequence.
 *
 * In a real worker this module attaches itself to the global scope on
 * import. Tests import {@link attachCursorWorker} and drive a fake scope
 * directly - no Worker global required.
 *
 * @module svelte-adapter-uws/plugins/cursor/cursor-worker
 */

import { now, monotonicNow, setTimer, clearTimer, setIntervalTimer, clearIntervalTimer, nextReconnectDelay } from '../../client-runtime.js';
import { parseBinaryFrame } from '../../runtime/wire.js';
import { decodeCursor, CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME, CursorDecodeDict } from './codec.js';
import { applyEvent, sweepExpired } from './decode.js';
import { createSmoother, SAMPLE_EMPTY } from '../smooth/interpolate.js';
import { selectRenderer, hashColor } from './render/index.js';

/**
 * Subprotocol token marking this socket for the cursor admission lane. Must
 * byte-match the token the server's upgrade gate discriminates on
 * (`CURSOR_LANE_SUBPROTOCOL` in the adapter's admission module); the server
 * echoes it during the upgrade, so a mismatch would hard-fail the handshake
 * in every browser.
 */
export const CURSOR_SUBPROTOCOL = 'svelte-realtime-cursor';

const TOPIC_PREFIX = '__cursor:';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 300000;
const ZOMBIE_CHECK_MS = 30000;
const SERVER_TIMEOUT_MS = 150000;
const VIEWPORT_WIRE_MIN_INTERVAL_MS = 100;
const MAX_FRAME_BYTES = 1048576;

// requestAnimationFrame resolved at call time (worker scopes expose it when
// an OffscreenCanvas is in play; a test harness substitutes it; otherwise a
// 16ms timer approximates the cadence through the runtime seam).
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
 * Wire the cursor worker onto a worker-like scope. Returns the controller so
 * a test can drive messages and inspect state without a real Worker.
 *
 * @param {{ postMessage: (msg: any, transfer?: any[]) => void, onmessage: ((ev: { data: any }) => void) | null }} scope
 */
export function attachCursorWorker(scope) {
	/** @type {import('./decode.js').CursorState} */
	const state = { positionMap: new Map(), userMap: new Map(), timestamps: new Map() };

	/** @type {'idle' | 'running' | 'paused' | 'destroyed'} */
	let phase = 'idle';
	let topic = '';
	let cursorTopic = '';
	let url = '';
	let canvas = null;
	let renderOpts = { gpu: 'auto', gpuThreshold: 500, devicePixelRatio: 1 };
	let maxAge = 0;
	let feedRate = 0;
	/** @type {{ delayMs: 'auto' | number, extrapolateMs: number, snapGapMs: number } | null} */
	let smoothCfg = null;
	/** @type {ReturnType<typeof createSmoother> | null} */
	let smoother = null;
	// Monotonic send time of the last snapshot request, pairing the server's
	// time reply into a measurable round trip for the clock estimator.
	let snapshotSentMono = -1;
	// Caller-owned scratch the interpolator samples into - per-frame
	// allocation-free by construction.
	const samplePoint = { x: 0, y: 0 };

	/** @type {any} */
	let renderer = null;
	/** @type {{ x: number, y: number, w: number, h: number, zoom: number } | null} */
	let rect = null;
	let dirty = false;
	let lastVisibleCount = 0;
	let frameHandle = null;

	/** @type {Map<string, number>} app color overrides (key -> packed RGBA) */
	const configColors = new Map();
	/** @type {Set<string>} keys hidden from render AND feed */
	const configHidden = new Set();
	// Exclude the viewer's own cursor from render and feed. Both pieces come
	// from the main thread: the flag rides init, the key rides config
	// messages. This socket's own `you` event is deliberately never adopted -
	// the worker's second connection has its own roster key, distinct from
	// the main connection that sends the user's moves.
	let hideSelf = false;
	/** @type {string | null} */
	let selfKey = null;

	// - socket state -
	/** @type {WebSocket | null} */
	let ws = null;
	let attempt = 0;
	let reconnectTimer = null;
	let zombieTimer = null;
	let sweepTimer = null;
	let feedTimer = null;
	let lastServerMessage = 0;
	/** @type {Map<number, string>} per-connection topic-id assignments */
	const wireIdMap = new Map();
	/** @type {CursorDecodeDict | null} per-connection short-id dictionary */
	let decodeDict = null;
	// Wire-frame viewport throttle: change-gated AND time-gated.
	let viewportWireSig = '';
	let viewportWireAt = 0;
	let viewportWireTimer = null;

	function markDirty() { dirty = true; }

	function applyDecoded(decoded) {
		if (!decoded) return;
		if (smoother) {
			// The time reply is paired with the snapshot request that provoked
			// it (a measurable round trip); every other event is a one-way
			// ingest that appends ring samples and clock samples.
			smoother.ingest(decoded, monotonicNow(), decoded.event === 'time' && snapshotSentMono >= 0 ? snapshotSentMono : undefined);
		}
		if (applyEvent(state, decoded)) markDirty();
		// Roster deltas always flow to the main thread: they are low-rate
		// (catalog on snapshot, join/remove per user) and the main thread
		// needs user metadata both for the optional feed join and to resolve
		// display-config callbacks against real users.
		if (decoded.event === 'catalog' || decoded.event === 'join' || decoded.event === 'remove') {
			postRoster();
		}
	}

	function postRoster() {
		const users = [];
		for (const [key, user] of state.userMap) users.push([key, user]);
		scope.postMessage({ type: 'roster', users });
	}

	function handleWireMessage(raw) {
		lastServerMessage = now();
		if (raw instanceof ArrayBuffer) {
			if (raw.byteLength > MAX_FRAME_BYTES) return;
			const parsed = parseBinaryFrame(new Uint8Array(raw));
			if (!parsed) return;
			const name = wireIdMap.get(parsed.topicId);
			if (name !== cursorTopic) return;
			applyDecoded(decodeCursor(parsed.payload, decodeDict, parsed.schemaVersion, parsed.seq));
			return;
		}
		if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES) return;
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		if (msg === null || typeof msg !== 'object') return;
		if (msg.topic === cursorTopic && typeof msg.event === 'string') {
			applyDecoded({ event: msg.event, data: msg.data });
			return;
		}
		if (msg.type === 'wire-id' && typeof msg.topic === 'string' && typeof msg.id === 'number') {
			wireIdMap.set(msg.id, msg.topic);
		}
		// Everything else (welcome, subscribed, unknown control frames) is
		// irrelevant to this socket and ignored silently.
	}

	function clearReconnect() {
		if (reconnectTimer !== null) { clearTimer(reconnectTimer); reconnectTimer = null; }
	}

	function scheduleReconnect() {
		if (phase !== 'running' || reconnectTimer !== null) return;
		const delay = nextReconnectDelay(RECONNECT_BASE_MS, RECONNECT_MAX_MS, attempt++);
		reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, delay);
	}

	function connect() {
		if (phase !== 'running') return;
		// Fresh per-connection wire state, in lock-step with the server's new
		// encoder dictionary and topic-id space. The smoother resets with it:
		// a reconnect may land on a different machine with a different wall
		// clock, so neither the offset estimate nor ring samples on the old
		// axis may survive (the snapshot reply repopulates positions).
		wireIdMap.clear();
		decodeDict = new CursorDecodeDict();
		if (smoother) smoother.reset();
		let sock;
		try {
			sock = new WebSocket(url, [CURSOR_SUBPROTOCOL]);
		} catch {
			scheduleReconnect();
			return;
		}
		ws = sock;
		sock.binaryType = 'arraybuffer';
		sock.onopen = () => {
			if (phase !== 'running' || ws !== sock) return;
			attempt = 0;
			lastServerMessage = now();
			// The time capability is advertised only when this pipeline smooths:
			// it buys stamped position frames (one extra byte steady-state) that
			// a non-smoothing canvas would pay for and never read.
			sock.send(JSON.stringify({
				type: 'hello',
				caps: smoother
					? [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME]
					: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]
			}));
			// The snapshot request doubles as the subscription handshake; the
			// reply rebuilds the roster, so local state never goes stale across
			// a reconnect. Its send time anchors the server's time reply into a
			// round trip the clock estimator can bound from both sides.
			snapshotSentMono = monotonicNow();
			sock.send(JSON.stringify({ type: 'cursor-snapshot', topic }));
			// Re-establish the viewport so a reconnecting worker is not culled
			// to a stale slice (or whole-board fanout) until the next pan.
			viewportWireSig = '';
			viewportWireAt = 0;
			sendViewportWire();
		};
		sock.onmessage = (ev) => { if (ws === sock) handleWireMessage(ev.data); };
		sock.onclose = () => {
			if (ws !== sock) return;
			ws = null;
			scheduleReconnect();
		};
		sock.onerror = () => { /* onclose follows and owns recovery */ };
	}

	function closeSocket() {
		const sock = ws;
		ws = null;
		if (sock) {
			sock.onopen = null;
			sock.onmessage = null;
			sock.onclose = null;
			try { sock.close(); } catch { /* already closed */ }
		}
	}

	function sendViewportWire() {
		if (!rect || !ws || ws.readyState !== 1) return;
		const sig = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ',' + rect.zoom;
		if (sig === viewportWireSig) return;
		const wait = viewportWireAt + VIEWPORT_WIRE_MIN_INTERVAL_MS - now();
		if (wait > 0) {
			// Trailing edge: one timer carries the latest rect once the gate opens.
			if (viewportWireTimer === null) {
				viewportWireTimer = setTimer(() => { viewportWireTimer = null; sendViewportWire(); }, wait);
			}
			return;
		}
		viewportWireSig = sig;
		viewportWireAt = now();
		try { ws.send(JSON.stringify({ type: 'cursor-viewport', topic, rect })); } catch { /* socket raced shut; reconnect resends */ }
	}

	// - render loop -

	/** Reused frame-to-frame: object pool + visible list, so the per-frame
	 * cull/transform allocates nothing once the pool is warm. Slots carry the
	 * view-space x/y for the renderer plus the board-space bx/by so the feed
	 * can ship the same coordinates the classic store exposes. */
	const pool = [];
	const visible = [];

	/**
	 * Rebuild the visible slot list from the position map. With `sampled`
	 * true (the smoothing render path) each position is resolved through the
	 * interpolator at the frame's render time; the raw path (`sampled` false:
	 * non-smoothing pipelines, and the feed, which ships wire positions by
	 * contract) reads the merged positions directly. Culling always runs on
	 * the coordinates that will be painted.
	 * @param {boolean} sampled
	 */
	function buildVisible(sampled) {
		visible.length = 0;
		if (!rect) return;
		const renderTime = sampled ? smoother.beginFrame(monotonicNow()) : 0;
		const zoom = rect.zoom || 1;
		// Pad by one dot radius in board units so a cursor sliding off the
		// edge disappears at its rim, not its center.
		const pad = 8 / zoom;
		const minX = rect.x - pad, maxX = rect.x + rect.w + pad;
		const minY = rect.y - pad, maxY = rect.y + rect.h + pad;
		let n = 0;
		for (const [key, data] of state.positionMap) {
			// Same rule as the store merge: no roster entry, not visible yet.
			if (!state.userMap.has(key)) continue;
			if (configHidden.has(key)) continue;
			if (hideSelf && key === selfKey) continue;
			if (data === null || typeof data !== 'object') continue;
			let x = data.x, y = data.y;
			if (typeof x !== 'number' || typeof y !== 'number') continue;
			if (sampled && smoother.sampleInto(key, renderTime, samplePoint) !== SAMPLE_EMPTY) {
				x = samplePoint.x;
				y = samplePoint.y;
			}
			if (x < minX || x > maxX || y < minY || y > maxY) continue;
			let slot = pool[n];
			if (slot === undefined) { slot = { x: 0, y: 0, bx: 0, by: 0, colorRGBA: 0, hidden: false, key: '' }; pool[n] = slot; }
			slot.x = (x - rect.x) * zoom;
			slot.y = (y - rect.y) * zoom;
			slot.bx = x;
			slot.by = y;
			const override = configColors.get(key);
			slot.colorRGBA = override === undefined ? hashColor(key) : override;
			slot.hidden = false;
			slot.key = key;
			visible.push(slot);
			n++;
		}
	}

	function ensureRenderer() {
		if (!canvas || !rect) return null;
		renderer = selectRenderer(canvas, {
			gpu: renderOpts.gpu,
			gpuThreshold: renderOpts.gpuThreshold,
			devicePixelRatio: renderOpts.devicePixelRatio,
			lastCount: lastVisibleCount
		}, renderer);
		return renderer;
	}

	function frame() {
		frameHandle = scheduleFrame(frame);
		// The dirty gate keeps an idle board near-free. Smoothing widens it:
		// while any ring holds un-played motion (buffered samples ahead of the
		// render time, live extrapolation) the loop must keep painting frames
		// no new wire data produced - then the gate closes again once every
		// entity settles.
		if (!dirty && !(smoother !== null && smoother.motionPending)) return;
		const r = ensureRenderer();
		if (!r) return;
		dirty = false;
		buildVisible(smoother !== null);
		lastVisibleCount = visible.length;
		r.render(visible, visible.length);
	}

	// - feed -

	function postFeed() {
		// The feed ships raw wire positions by contract - smoothing changes
		// pixels, never the data surface - so this build never samples.
		buildVisible(false);
		const n = visible.length;
		const keys = new Array(n);
		const positions = new Float32Array(n * 2);
		const colors = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			const c = visible[i];
			keys[i] = c.key;
			positions[i * 2] = c.bx;
			positions[i * 2 + 1] = c.by;
			colors[i] = c.colorRGBA;
		}
		scope.postMessage(
			{ type: 'feed', keys, positions, colors },
			[positions.buffer, colors.buffer]
		);
	}

	// - lifecycle -

	function stopRuntime() {
		clearReconnect();
		if (zombieTimer !== null) { clearIntervalTimer(zombieTimer); zombieTimer = null; }
		if (sweepTimer !== null) { clearIntervalTimer(sweepTimer); sweepTimer = null; }
		if (feedTimer !== null) { clearIntervalTimer(feedTimer); feedTimer = null; }
		if (viewportWireTimer !== null) { clearTimer(viewportWireTimer); viewportWireTimer = null; }
		cancelFrame(frameHandle);
		frameHandle = null;
		closeSocket();
		attempt = 0;
		viewportWireSig = '';
		viewportWireAt = 0;
		wireIdMap.clear();
		decodeDict = null;
		state.positionMap.clear();
		state.userMap.clear();
		state.timestamps.clear();
		if (smoother) { smoother.reset(); smoother = null; }
		snapshotSentMono = -1;
		lastVisibleCount = 0;
		// Leave the surface blank rather than frozen on the last frame: a
		// paused overlay showing stale cursors reads as a live board.
		if (renderer) {
			visible.length = 0;
			renderer.render(visible, 0);
		}
		dirty = false;
	}

	function startRuntime() {
		phase = 'running';
		smoother = smoothCfg ? createSmoother(smoothCfg) : null;
		connect();
		zombieTimer = setIntervalTimer(() => {
			if (ws && ws.readyState === 1 && now() - lastServerMessage > SERVER_TIMEOUT_MS) {
				// Half-dead socket: close and let the reconnect path recycle it.
				try { ws.close(); } catch { /* already closing */ }
			}
		}, ZOMBIE_CHECK_MS);
		if (maxAge > 0) {
			sweepTimer = setIntervalTimer(() => {
				if (sweepExpired(state, maxAge)) {
					markDirty();
					// Expiry leaves no remove event behind; drop the swept
					// keys' sample history with the same cadence.
					if (smoother) smoother.compact(state.positionMap);
				}
			}, Math.max(maxAge / 2, 1000));
		}
		if (feedRate > 0) {
			feedTimer = setIntervalTimer(postFeed, 1000 / feedRate);
		}
		frameHandle = scheduleFrame(frame);
		markDirty();
	}

	// - control messages from the main thread -

	function handleMessage(msg) {
		if (msg === null || typeof msg !== 'object' || phase === 'destroyed') return;

		if (msg.type === 'init') {
			const nextTopic = String(msg.topic);
			if (phase === 'running') stopRuntime();
			if (msg.canvas) canvas = msg.canvas;
			if (nextTopic !== topic) {
				// Keys are per-topic; stale display config must not leak onto
				// a new board's key space. The main thread re-resolves config
				// once the new roster lands (the self filter key rides along).
				// The viewport rect is also per-board: keeping it would cull
				// and transform the new topic against the old board's
				// coordinates until the next report, so render nothing until
				// the pump's first rect for this board arrives.
				configColors.clear();
				configHidden.clear();
				selfKey = null;
				rect = null;
			}
			topic = nextTopic;
			cursorTopic = TOPIC_PREFIX + topic;
			url = String(msg.url);
			maxAge = typeof msg.maxAge === 'number' ? msg.maxAge : 0;
			feedRate = typeof msg.feedRate === 'number' && msg.feedRate > 0 ? msg.feedRate : 0;
			// The main thread validates and resolves the smoothing knobs; the
			// worker still defends each field so a malformed init degrades to
			// the tuned defaults instead of a broken interpolator.
			smoothCfg = (msg.smooth && typeof msg.smooth === 'object') ? {
				delayMs: msg.smooth.delayMs === 'auto' || typeof msg.smooth.delayMs === 'number' ? msg.smooth.delayMs : 'auto',
				extrapolateMs: typeof msg.smooth.extrapolateMs === 'number' ? msg.smooth.extrapolateMs : 250,
				snapGapMs: typeof msg.smooth.snapGapMs === 'number' ? msg.smooth.snapGapMs : 500
			} : null;
			hideSelf = msg.hideSelf === true;
			renderOpts = {
				gpu: msg.gpu === undefined ? 'auto' : msg.gpu,
				gpuThreshold: msg.gpuThreshold === undefined ? 500 : msg.gpuThreshold,
				devicePixelRatio: msg.devicePixelRatio || 1
			};
			startRuntime();
			return;
		}

		if (msg.type === 'viewport' && msg.rect && typeof msg.rect === 'object') {
			const r = msg.rect;
			if (![r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
			const zoom = r.zoom === undefined ? 1 : r.zoom;
			if (typeof zoom !== 'number' || !(zoom > 0) || r.w <= 0 || r.h <= 0) return;
			rect = { x: r.x, y: r.y, w: r.w, h: r.h, zoom };
			// The viewport message also carries the CURRENT device pixel ratio:
			// a monitor move or browser zoom changes it mid-session, and the
			// renderer must rescale rather than paint at the stale density.
			if (typeof msg.dpr === 'number' && msg.dpr > 0) renderOpts.devicePixelRatio = msg.dpr;
			const rend = ensureRenderer();
			if (rend) rend.resize(rect.w * zoom, rect.h * zoom, renderOpts.devicePixelRatio);
			markDirty();
			sendViewportWire();
			return;
		}

		if (msg.type === 'config') {
			if (Array.isArray(msg.colors)) {
				configColors.clear();
				for (const entry of msg.colors) {
					if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
						configColors.set(entry[0], entry[1] >>> 0);
					}
				}
			}
			if (Array.isArray(msg.hidden)) {
				configHidden.clear();
				for (const key of msg.hidden) {
					if (typeof key === 'string') configHidden.add(key);
				}
			}
			// The main connection's roster key for this user. An absent field
			// (an older main thread) leaves the current value alone; an
			// explicit null clears it.
			if (msg.selfKey === null || typeof msg.selfKey === 'string') selfKey = msg.selfKey;
			markDirty();
			return;
		}

		if (msg.type === 'pause') {
			if (phase === 'running') stopRuntime();
			phase = 'paused';
			return;
		}

		if (msg.type === 'destroy') {
			if (phase === 'running') stopRuntime();
			phase = 'destroyed';
			if (renderer) { renderer.dispose(); renderer = null; }
			canvas = null;
			rect = null;
		}
	}

	scope.onmessage = (ev) => handleMessage(ev.data);

	// Read-only diagnostic surface on the worker scope, for end-to-end tests
	// and production debugging via the devtools worker console. Numbers and
	// strings only - nothing here can mutate the pipeline.
	try {
		Object.defineProperty(scope, '__cursorWorkerDebug', {
			value: {
				get phase() { return phase; },
				get topic() { return topic; },
				get url() { return url; },
				get wsReadyState() { return ws ? ws.readyState : -1; },
				get reconnectAttempts() { return attempt; },
				get positions() { return state.positionMap.size; },
				get users() { return state.userMap.size; },
				get wireIds() { return wireIdMap.size; },
				get hasRect() { return rect !== null; },
				get lastVisible() { return lastVisibleCount; },
				get smoothing() { return smoother !== null; },
				get smoothRings() { return smoother === null ? 0 : smoother.size; },
				get smoothDelayMs() { return smoother === null ? 0 : smoother.delay; },
				get smoothMotionPending() { return smoother !== null && smoother.motionPending; },
				get clockOffsetMs() {
					if (smoother === null) return 0;
					const o = smoother.clock.offset();
					return o === null ? 0 : o;
				}
			},
			configurable: true
		});
	} catch { /* frozen scope: diagnostics unavailable */ }

	// Exposed for tests: drive messages synchronously and inspect internals.
	return {
		handleMessage,
		_state: state,
		_visible: visible,
		get _phase() { return phase; },
		get _wireIds() { return wireIdMap; },
		get _ws() { return ws; },
		get _renderer() { return renderer; },
		get _rect() { return rect; },
		get _smoother() { return smoother; }
	};
}

// Self-attach inside a real dedicated worker; inert under node and on the
// main thread, so tests and bundlers can import this module freely.
if (typeof DedicatedWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof DedicatedWorkerGlobalScope) {
	attachCursorWorker(self);
}
