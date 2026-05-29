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
import { writable } from 'svelte/store';
import { decodeCursor, CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CursorDecodeDict } from './codec.js';

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
	if (cached) return cached;

	const cursorTopic = TOPIC_PREFIX + topic;

	/** @type {Map<string, any>} */
	let positionMap = new Map();
	/** @type {Map<string, any>} */
	let userMap = new Map();
	/** @type {Map<string, number>} */
	const timestamps = new Map();
	const output = writable(/** @type {Map<string, any>} */ (new Map()));

	let sourceUnsub = /** @type {(() => void) | null} */ (null);
	let statusUnsub = /** @type {(() => void) | null} */ (null);
	/** @type {ReturnType<typeof setInterval> | null} */
	let sweepTimer = null;
	let refCount = 0;
	let cancelled = false;

	function emitOutput() {
		const merged = new Map();
		for (const [key, data] of positionMap) {
			const user = userMap.get(key);
			if (user === undefined) continue;
			merged.set(key, { user, data });
		}
		output.set(merged);
	}

	function sweep() {
		if (!maxAge || maxAge <= 0) return;
		const cutoff = Date.now() - maxAge;
		let changed = false;
		for (const [key, ts] of timestamps) {
			if (ts < cutoff) {
				timestamps.delete(key);
				if (positionMap.delete(key)) changed = true;
				userMap.delete(key);
			}
		}
		if (changed) emitOutput();
	}

	function startListening() {
		cancelled = false;
		const source = on(cursorTopic);
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;

			if (event.event === 'catalog' && Array.isArray(event.data)) {
				userMap = new Map();
				for (const entry of event.data) {
					if (entry && typeof entry.key === 'string') {
						userMap.set(entry.key, entry.user);
					}
				}
				emitOutput();
				return;
			}

			if (event.event === 'join' && event.data != null) {
				const { key, user } = event.data;
				if (typeof key === 'string') {
					userMap.set(key, user);
					emitOutput();
				}
				return;
			}

			if (event.event === 'update' && event.data != null) {
				const { key, data } = event.data;
				if (typeof key === 'string') {
					positionMap.set(key, data);
					timestamps.set(key, Date.now());
					emitOutput();
				}
				return;
			}

			if (event.event === 'bulk' && Array.isArray(event.data)) {
				const now = Date.now();
				for (const entry of event.data) {
					if (entry && typeof entry.key === 'string') {
						positionMap.set(entry.key, entry.data);
						timestamps.set(entry.key, now);
					}
				}
				emitOutput();
				return;
			}

			if (event.event === 'remove' && event.data != null) {
				const { key } = event.data;
				if (typeof key !== 'string') return;
				timestamps.delete(key);
				const hadPosition = positionMap.delete(key);
				const hadUser = userMap.delete(key);
				if (hadPosition || hadUser) emitOutput();
			}
		});

		if (maxAge > 0) {
			sweepTimer = setInterval(sweep, Math.max(maxAge / 2, 1000));
		}

		// Request a snapshot of existing cursor positions every time the socket
		// opens (initial connect and reconnects). Without this, the store would
		// miss cursors that appeared while the client was offline.
		statusUnsub = status.subscribe((s) => {
			if (s === 'open' && !cancelled) {
				connect().send({ type: 'cursor-snapshot', topic });
			}
		});
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
			clearInterval(sweepTimer);
			sweepTimer = null;
		}
		positionMap = new Map();
		userMap = new Map();
		timestamps.clear();
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
		}
	};

	cursorStores.set(cacheKey, store);

	// If nothing subscribes before the next microtask, remove the cache entry.
	queueMicrotask(() => {
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
	return setTimeout(cb, 16);
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
