import { resumeBuffers, maxSeenSeq, counters } from './state.js';
import { WS_COMPRESSION_ON } from './config.js';
import { bumpOut } from './pressure-metrics.js';

// Live-frame buffering for the replay-to-live cutover. When a connection
// gap-fills a topic on subscribe (a recover offset), the server reads the
// backend, then subscribes the client to live. Between those two steps an ASYNC
// resume hook yields the event loop, so a publish landing in that window is past
// the backend read but not yet on the live membership - the client would never
// see it, a silent gap. The barrier here holds those live frames: a buffer is
// opened BEFORE the resume await, every fan-out site appends to it during the
// window, and once live membership is installed the held frames are flushed in
// order (deduped against what the resume already covered) before the ack.
//
// A synchronous (in-memory) resume never yields a macrotask, so nothing is
// captured and the flush is a no-op - identical to the pre-barrier behavior. The
// window only ever holds frames behind a network-backed resume.

/**
 * @typedef {{ topic: string, buffer: { frames: { seq: number | null, envelope: string, compress: boolean }[], overflow: boolean }, before: number }} ResumeCaptureEntry
 * @typedef {{ ws: any, entries: ResumeCaptureEntry[] }} ResumeCaptureHandle
 */

/**
 * Open a live-frame buffer for each topic about to be resumed, BEFORE the resume
 * await. Records each topic's current max-seen seq as the fallback dedup floor
 * (used when the resume hook does not report the watermark it covered).
 * @param {string[]} topics
 * @param {any} ws
 * @returns {ResumeCaptureHandle}
 */
export function beginResumeCapture(topics, ws) {
	/** @type {ResumeCaptureEntry[]} */
	const entries = [];
	for (const topic of topics) {
		const buffer = { frames: [], overflow: false };
		let set = resumeBuffers.get(topic);
		if (set === undefined) { set = new Set(); resumeBuffers.set(topic, set); }
		set.add(buffer);
		const before = maxSeenSeq.get(topic);
		entries.push({ topic, buffer, before: typeof before === 'number' ? before : 0 });
	}
	return { ws, entries };
}

/** @param {ResumeCaptureHandle} handle @param {ResumeCaptureEntry} entry */
function unregister(handle, entry) {
	const set = resumeBuffers.get(entry.topic);
	if (set === undefined) return;
	set.delete(entry.buffer);
	if (set.size === 0) resumeBuffers.delete(entry.topic);
}

/**
 * Close every buffer in the handle WITHOUT delivering anything. Used on the
 * early-return race path (a concurrent subscribe already installed the topic, so
 * the client is live and the buffered frames would be duplicates).
 * @param {ResumeCaptureHandle} handle
 */
export function discardResumeCapture(handle) {
	for (const entry of handle.entries) unregister(handle, entry);
}

/**
 * Flush the frames held for one topic to the connection, in capture (seq) order,
 * skipping any the resume already covered, then close the buffer. `coveredSeq` is
 * the highest seq the resume hook reported delivering for this topic; when it is
 * not a number the entry's pre-window max-seen seq is the conservative floor (a
 * cooperating backend reports the exact watermark so the boundary is exact; a
 * non-reporting one may re-deliver the small window between buffer-open and the
 * backend read, which the client tolerates far better than a gap).
 * @param {ResumeCaptureHandle} handle
 * @param {string} topic
 * @param {number | undefined} coveredSeq
 * @returns {void}
 */
export function flushResumeTopic(handle, topic, coveredSeq) {
	const entry = handle.entries.find((e) => e.topic === topic);
	if (entry === undefined) return;
	const ws = handle.ws;
	if (entry.buffer.overflow) {
		// The window overflowed the frame cap: the tail past the cap was never
		// captured, and the client has no gap detection, so trusting a partial flush
		// would leave a silent hole. Signal a truncation on the replay channel FIRST
		// - the same marker a replay backend emits for an uncoverable range - so this
		// critical resync signal is not itself lost behind the backpressure the
		// partial flush below would build. The client drops its stale per-topic
		// offset and cold-resyncs; the partial frames are then a best-effort extra.
		const marker = '{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}';
		try { ws.send(marker, false, false); bumpOut(ws, marker); }
		catch { counters.closedWsAborts++; }
	}
	const floor = typeof coveredSeq === 'number' ? coveredSeq : entry.before;
	for (const f of entry.buffer.frames) {
		if (f.seq !== null && f.seq <= floor) continue; // already covered by the resume
		const compress = WS_COMPRESSION_ON && f.compress;
		try { ws.send(f.envelope, false, compress); }
		catch { counters.closedWsAborts++; break; }
		bumpOut(ws, f.envelope);
	}
	unregister(handle, entry);
	// Drop the entry from the handle too, so a repeat flush for this topic is a
	// no-op and the batch final-sweep discard only touches un-flushed topics.
	const ei = handle.entries.indexOf(entry);
	if (ei !== -1) handle.entries.splice(ei, 1);
}

/**
 * True if the topic's buffer overflowed the frame cap during the window (the
 * caller should tell the client to cold-rehydrate rather than trust a partial
 * flush).
 * @param {ResumeCaptureHandle} handle @param {string} topic
 */
export function resumeTopicOverflowed(handle, topic) {
	const entry = handle.entries.find((e) => e.topic === topic);
	return entry !== undefined && entry.buffer.overflow;
}

/**
 * Normalize the value a `resume` hook returns into the highest seq it delivered
 * for `topic`, or `undefined` when it reported nothing (the flush then falls back
 * to the pre-window floor). Accepts a per-topic map `{ [topic]: seq }` or, for the
 * single-topic callers, a bare number.
 * @param {unknown} covered
 * @param {string} topic
 * @returns {number | undefined}
 */
export function coveredSeqFor(covered, topic) {
	if (covered == null) return undefined;
	if (typeof covered === 'number') return covered;
	if (typeof covered === 'object') {
		const v = /** @type {Record<string, unknown>} */ (covered)[topic];
		return typeof v === 'number' ? v : undefined;
	}
	return undefined;
}
