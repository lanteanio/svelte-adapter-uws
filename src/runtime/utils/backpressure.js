import { setTimer, clearTimer } from '../runtime.js';

/**
 * Write a chunk to a uWS HttpResponse inside a cork and, if backpressure
 * builds, return a Promise that resolves when the socket drains or the
 * timeout elapses. Returns `true` synchronously when no drain is needed.
 *
 * All uWS response mutations (write + onWritable registration) happen
 * inside the cork callback, which uWS invokes synchronously, so the
 * boolean return value of `res.write()` is captured correctly.
 *
 * @param {{ cork: (fn: () => void) => void, write: (value: any) => boolean, onWritable: (fn: () => boolean) => void }} res
 * @param {any} value
 * @param {number} [timeoutMs]
 * @returns {true | Promise<boolean>} true if the write succeeded without drain; otherwise a promise that resolves true on drain or false on timeout.
 */
export function writeChunkWithBackpressure(res, value, timeoutMs = 30000) {
	let ok = false;
	/** @type {Promise<boolean> | null} */
	let drainPromise = null;
	res.cork(() => {
		ok = res.write(value);
		if (!ok) {
			drainPromise = new Promise((resolve) => {
				const timer = setTimer(() => resolve(false), timeoutMs);
				res.onWritable(() => {
					clearTimer(timer);
					resolve(true);
					return true;
				});
			});
		}
	});
	return ok ? true : /** @type {Promise<boolean>} */ (drainPromise);
}

/**
 * Drain a coalesce-by-key buffer.
 *
 * Iterates entries in insertion order and calls `send` for each, using the
 * uWS send-status contract (see platform.js): 1 = sent clean, 0 = enqueued
 * behind backpressure (accepted and delivered in order, but the socket is
 * now under pressure), 2 = dropped past maxBackpressure. A sent (1) or
 * enqueued (0) entry is removed from the map; a dropped (2) entry is retained
 * for a later flush. The drain continues while sends land clean and STOPS the
 * moment the socket signals pressure - the first enqueued-behind-backpressure
 * (0) or dropped (2) result - so a backpressured socket is never pushed
 * harder and a healthy one drains all of its pending keys in one pass.
 *
 * Pure: no I/O of its own, no timers, no globals. The caller supplies
 * `send`, which is the only side-effecting boundary, so this is unit-
 * testable with a mock send fn.
 *
 * Map insertion order is preserved across overwrites: setting an existing
 * key replaces the value but keeps the original slot. Latest value wins,
 * order is stable.
 *
 * @template T
 * @param {Map<string, T>} pending
 * @param {(value: T) => number} send  uWS send status: 1 sent clean, 0 enqueued-under-backpressure, 2 dropped
 */
export function drainCoalesced(pending, send) {
	for (const [key, value] of pending) {
		const result = send(value);
		if (result === 2) return;
		pending.delete(key);
		if (result === 0) return;
	}
}

/**
 * Collapse events that share a `coalesceKey` so only the latest value
 * survives in the batch. Events without a `coalesceKey` pass through
 * unchanged. The latest occurrence's position is preserved (so the
 * order of non-collapsed events is stable, and the surviving entry
 * appears at the position the latest value arrived in).
 *
 * Use case: high-frequency `publishBatched` calls carrying many
 * cursor / presence / price-tick events, where intermediate values are
 * noise. Tagging each with a `coalesceKey` (e.g. `'cursor:' + userId`)
 * lets a single batch deliver only the latest position per user even
 * if the caller submitted hundreds.
 *
 * Pure helper: returns the input array untouched (same reference) when
 * no event carries a `coalesceKey`, so the common no-coalesce path
 * pays only one linear scan.
 *
 * @template {{ coalesceKey?: string }} T
 * @param {T[]} messages
 * @returns {T[]}
 */
export function collapseByCoalesceKey(messages) {
	let hasCoalesce = false;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].coalesceKey !== undefined) { hasCoalesce = true; break; }
	}
	if (!hasCoalesce) return messages;
	/** @type {Map<string, number>} */
	const lastByKey = new Map();
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key !== undefined) lastByKey.set(key, i);
	}
	const out = [];
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key === undefined || lastByKey.get(key) === i) {
			out.push(messages[i]);
		}
	}
	return out;
}

/**
 * Cap on the number of connections the 1 Hz pressure sampler reads
 * `getBufferedAmount()` for in a single tick. Each read is one C++ call, but a
 * worker holding tens of thousands of sockets would still pay a measurable
 * per-tick cost if it walked every one, so the walk is bounded: at or below the
 * cap the aggregate is exact; above it the reported figures are a bounded
 * sample of the connection set (documented on `PressureSnapshot`). This walk
 * is off the publish fast path entirely - it runs only on the sampler tick.
 */
export const BACKPRESSURE_SAMPLE_CAP = 1024;

/**
 * A sampled connection counts toward `backpressuredConnections` when it holds
 * more than this many bytes of un-flushed outbound at sample time. Set above
 * the transient in-flight bytes of a healthy flush so a normal high-throughput
 * consumer does not register, while a wedged slow consumer - whose queue climbs
 * toward `maxBackpressure` (1 MB default), where uWS begins dropping frames -
 * does.
 */
export const BACKPRESSURE_SAMPLE_THRESHOLD_BYTES = 64 * 1024;

/**
 * Record one exact uWS `dropped` callback into the current pressure window.
 * The callback's ArrayBuffer is valid only for that synchronous callback, so
 * retain only its byte length and never the buffer itself.
 *
 * @param {{ droppedFramesWindow: number, droppedBytesWindow: number }} target
 * @param {{ byteLength: number }} message
 */
export function recordBackpressureDrop(target, message) {
	target.droppedFramesWindow++;
	target.droppedBytesWindow += message.byteLength;
}

/**
 * Close and reset the exact drop window. Kept separate from the bounded queue
 * sampler: a drop that drains before the next tick, or occurs beyond the
 * sampler's 1,024-connection cap, must still be counted.
 *
 * @param {{ droppedFramesWindow: number, droppedBytesWindow: number }} target
 * @returns {{ droppedFrames: number, droppedBytes: number }}
 */
export function takeBackpressureDropWindow(target) {
	const droppedFrames = target.droppedFramesWindow;
	const droppedBytes = target.droppedBytesWindow;
	target.droppedFramesWindow = 0;
	target.droppedBytesWindow = 0;
	return { droppedFrames, droppedBytes };
}

/**
 * Walk up to `cap` connections, reading each one's outbound queue depth via
 * `getBufferedAmount()`, and fold the readings into two aggregate telemetry
 * figures: the worst queue depth seen, and the count of connections holding
 * more than `threshold` bytes at sample time. Zero-allocation apart from the
 * single result object - it folds inline over the connection iterable rather
 * than building an intermediate array, so the 1 Hz sampler pays a fixed,
 * bounded per-tick cost even on a worker holding tens of thousands of sockets.
 * A connection closing mid-walk throws from `getBufferedAmount()`; count it as
 * 0 (already gone). At or below the cap the figures are exact; above it they
 * are a bounded sample of the connection set.
 *
 * Pure with respect to everything but the supplied connections: the only
 * side-effecting boundary is `getBufferedAmount()`, so a unit test drives it
 * with mock connections and no real socket. Kept in this module (not inline in
 * the sampler) so the hot-path-sensitive bounded walk is unit-testable without
 * pulling the sampler's build-time-configured module graph.
 *
 * @param {Iterable<{ getBufferedAmount: () => number }>} connections
 * @param {number} cap  max connections to read this tick (bounds the cost)
 * @param {number} threshold  a reading strictly above this counts as backpressured
 * @returns {{ maxBufferedBytes: number, backpressuredConnections: number, sampled: number }}
 */
export function foldConnectionBackpressure(connections, cap, threshold) {
	let maxBufferedBytes = 0;
	let backpressuredConnections = 0;
	let sampled = 0;
	for (const ws of connections) {
		if (sampled >= cap) break;
		let amt;
		try { amt = ws.getBufferedAmount(); } catch { amt = 0; }
		if (amt > maxBufferedBytes) maxBufferedBytes = amt;
		if (amt > threshold) backpressuredConnections++;
		sampled++;
	}
	return { maxBufferedBytes, backpressuredConnections, sampled };
}
