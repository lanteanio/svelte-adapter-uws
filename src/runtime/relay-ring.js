// @ts-check
// SPSC shared-memory byte ring for the cross-worker relay hot path.
//
// The cluster relay is a star through the primary: a publishing worker hands
// its per-microtask batch to the primary, and the primary re-sends every
// message to every other worker. Over `postMessage` each hop structured-clones
// the message - the primary pays one clone per message per receiving worker,
// so a hot topic on an N-worker box costs O(N) clones per publish plus the
// per-message queue machinery.
//
// This module replaces that hop with one SharedArrayBuffer ring per direction
// per worker (worker -> primary, primary -> worker). Each ring is a
// single-producer / single-consumer BYTE STREAM: the producer appends framed
// bytes, the consumer drains them, and `Atomics.waitAsync` wakes each side
// with no polling. Byte-stream semantics (not slot semantics) are what make
// the hard cases fall out for free:
//
//   - ORDER: one stream per direction, so relay order is exactly preserved -
//     there is never a second path a frame can race ahead on.
//   - BACKPRESSURE: a full ring spills into the producer's pending queue and
//     flushes as the consumer frees space (the consumer's readPos advance IS
//     the wake-up signal) - the same unbounded-queue-while-consumer-lags
//     semantics postMessage had, minus its per-message allocation.
//   - OVERSIZED FRAMES: a frame larger than the ring streams through in
//     pieces; the reader's accumulator reassembles it. No fallback path, no
//     reordering window.
//
// The relay envelope is JSON-serializable by construction (the envelope field
// IS a pre-serialized JSON string), so a message is encoded to bytes ONCE by
// the publisher; the primary forwards the framed bytes VERBATIM (memcpy, zero
// parse, zero clone) and only the receiving worker decodes.
//
// The wire format is process-internal (both ends are always the same build in
// the same process), so it carries no version negotiation.

import { clearTimer, microtask, monotonicNow, setTimer } from './runtime.js';

const HEADER_BYTES = 64;
const WRITE_IDX = 0; // Int32Array index of the write position (own cache line)
const READ_IDX = 8; // Int32Array index of the read position (own cache line)

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Round up to a power of two (ring math masks positions). */
function powerOfTwo(n) {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

/**
 * Allocate the SharedArrayBuffer for one ring direction.
 * @param {number} dataBytes requested capacity; rounded up to a power of two
 */
export function createRelayRingBuffer(dataBytes) {
	return new SharedArrayBuffer(HEADER_BYTES + powerOfTwo(Math.max(1024, dataBytes)));
}

/**
 * The producing side of one ring. Exactly one writer may exist per buffer.
 */
export class RingWriter {
	/**
	 * @param {SharedArrayBuffer} sab
	 * @param {{
	 *   maxPendingBytes?: number,
	 *   maxPendingAgeMs?: number,
	 *   now?: () => number,
	 *   setTimer?: (callback: () => void, delayMs: number) => any,
	 *   clearTimer?: (handle: any) => void,
	 *   onOverflow?: (event: { reason: 'bytes' | 'age', droppedBytes: number, pendingAgeMs: number, maxPendingBytes: number, maxPendingAgeMs: number }) => void
	 * }} [options]
	 */
	constructor(sab, options = {}) {
		this.i32 = new Int32Array(sab, 0, 16);
		this.data = new Uint8Array(sab, HEADER_BYTES);
		this.cap = this.data.length;
		this.mask = this.cap - 1;
		/** Bytes accepted but not yet in the ring (consumer lagging). @type {Array<Uint8Array | undefined>} */
		this.pending = [];
		// Deque head: completed entries are cleared and advanced in O(1), then the
		// array is reset when empty. Array.shift() made a long spill drain O(n^2).
		this.pendingHead = 0;
		this.pendingOffset = 0; // consumed prefix of pending[0]
		this.pendingBytes = 0;
		this.pendingSince = 0;
		this.maxPendingBytes = options.maxPendingBytes ?? Infinity;
		this.maxPendingAgeMs = options.maxPendingAgeMs ?? Infinity;
		this._now = options.now ?? monotonicNow;
		this._setTimer = options.setTimer ?? setTimer;
		this._clearTimer = options.clearTimer ?? clearTimer;
		this.onOverflow = options.onOverflow ?? null;
		this.ageTimer = null;
		this.flushArmed = false;
		this.closed = false;
		/**
		 * The raw READ_IDX observed by the last _push that could not fit all
		 * its bytes. The flush wait MUST register against this observation:
		 * waiting on a fresher load would miss a consumer advance (and its
		 * one notify) landing between the failed push and the registration,
		 * leaving the flush parked forever while bytes queue behind it.
		 */
		this.readSnapshot = 0;
	}

	/**
	 * Append framed bytes to the stream. Never blocks and never reorders:
	 * whatever does not fit right now is queued and flushed as the consumer
	 * frees space. Call `notify()` after a batch of writes to wake the reader.
	 * @param {Uint8Array} bytes
	 */
	write(bytes) {
		if (this.closed) return false;
		if (this.pendingBytes > 0) {
			if (this._pendingAge() >= this.maxPendingAgeMs) {
				return this._overflow('age', bytes.length);
			}
			if (this.pendingBytes + bytes.length > this.maxPendingBytes) {
				return this._overflow('bytes', bytes.length);
			}
			// Something is already queued: append behind it (order).
			this.pending.push(bytes);
			this.pendingBytes += bytes.length;
			this._armFlush();
			return true;
		}
		const n = this._push(bytes, 0);
		if (n < bytes.length) {
			const remaining = bytes.length - n;
			if (remaining > this.maxPendingBytes) {
				return this._overflow('bytes', remaining);
			}
			this.pending.push(bytes);
			this.pendingOffset = n;
			this.pendingBytes = remaining;
			this.pendingSince = this._now();
			this._armAgeLimit();
			this._armFlush();
		}
		return true;
	}

	/** Wake the reader. One notify covers every write since the last one. */
	notify() {
		Atomics.notify(this.i32, WRITE_IDX);
	}

	/** Unblock any pending flush wait and refuse further writes. */
	close() {
		this.closed = true;
		this.pending.length = 0;
		this.pendingHead = 0;
		this.pendingOffset = 0;
		this.pendingBytes = 0;
		this.pendingSince = 0;
		if (this.ageTimer !== null) {
			this._clearTimer(this.ageTimer);
			this.ageTimer = null;
		}
		// Wake our own read-position wait so the armed flush observes `closed`.
		Atomics.notify(this.i32, READ_IDX);
	}

	_pendingAge() {
		return this.pendingBytes > 0 ? Math.max(0, this._now() - this.pendingSince) : 0;
	}

	_overflow(reason, incomingBytes) {
		const event = {
			reason,
			droppedBytes: this.pendingBytes + incomingBytes,
			pendingAgeMs: this._pendingAge(),
			maxPendingBytes: this.maxPendingBytes,
			maxPendingAgeMs: this.maxPendingAgeMs
		};
		this.close();
		try { this.onOverflow?.(event); } catch {}
		return false;
	}

	_armAgeLimit() {
		if (this.ageTimer !== null || this.closed || this.pendingBytes === 0 || !Number.isFinite(this.maxPendingAgeMs)) return;
		const remaining = Math.max(0, this.maxPendingAgeMs - this._pendingAge());
		this.ageTimer = this._setTimer(() => {
			this.ageTimer = null;
			if (this.closed || this.pendingBytes === 0) return;
			if (this._pendingAge() >= this.maxPendingAgeMs) this._overflow('age', 0);
			else this._armAgeLimit();
		}, remaining);
		if (this.ageTimer?.unref) this.ageTimer.unref();
	}

	/**
	 * Copy as much of `bytes` (from `offset`) into the ring as fits.
	 * @returns {number} how many bytes were consumed from `offset`
	 */
	_push(bytes, offset) {
		const write = Atomics.load(this.i32, WRITE_IDX) >>> 0;
		const readRaw = Atomics.load(this.i32, READ_IDX);
		const read = readRaw >>> 0;
		const free = this.cap - ((write - read) >>> 0);
		const remaining = bytes.length - offset;
		const n = Math.min(free, remaining);
		// Ring can't take everything: snapshot the read position this verdict
		// was computed from, for the flush wait to register against.
		if (n < remaining) this.readSnapshot = readRaw;
		if (n === 0) return 0;
		const at = write & this.mask;
		const firstPart = Math.min(n, this.cap - at);
		this.data.set(bytes.subarray(offset, offset + firstPart), at);
		if (n > firstPart) {
			this.data.set(bytes.subarray(offset + firstPart, offset + n), 0);
		}
		Atomics.store(this.i32, WRITE_IDX, (write + n) | 0);
		return n;
	}

	_flushPending() {
		if (this._pendingAge() >= this.maxPendingAgeMs) {
			this._overflow('age', 0);
			return;
		}
		while (this.pendingBytes > 0) {
			const head = this.pending[this.pendingHead];
			if (head === undefined) break;
			const n = this._push(head, this.pendingOffset);
			if (n === 0) break;
			this.pendingOffset += n;
			this.pendingBytes -= n;
			if (this.pendingOffset >= head.length) {
				this.pending[this.pendingHead] = undefined;
				this.pendingHead++;
				this.pendingOffset = 0;
			}
		}
		if (this.pendingBytes === 0) {
			this.pending.length = 0;
			this.pendingHead = 0;
			this.pendingSince = 0;
			if (this.ageTimer !== null) {
				this._clearTimer(this.ageTimer);
				this.ageTimer = null;
			}
		}
		this.notify();
		if (this.pendingBytes > 0) this._armFlush();
	}

	_armFlush() {
		if (this.flushArmed || this.closed) return;
		this.flushArmed = true;
		// Wait for the consumer to advance the read position PAST the value
		// the failed push observed. waitAsync's atomic compare is the
		// predicate re-check: if the consumer already advanced (and sent its
		// only notify) between the failed push and this registration, the
		// compare fails ('not-equal') and the microtask retry below flushes
		// immediately. Re-loading the index here instead would register
		// against the post-advance value and sleep through a wake-up that
		// already happened.
		const res = Atomics.waitAsync(this.i32, READ_IDX, this.readSnapshot);
		const resume = () => {
			this.flushArmed = false;
			if (this.closed) return;
			this._flushPending();
		};
		if (res.async) res.value.then(resume);
		else microtask(resume);
	}
}

/**
 * The consuming side of one ring. Exactly one reader may exist per buffer.
 * Emits each complete frame (INCLUDING its 4-byte length prefix, so a
 * forwarder can re-write it verbatim) to `onFrame` in stream order.
 */
export class RingReader {
	/**
	 * @param {SharedArrayBuffer} sab
	 * @param {(frame: Uint8Array) => void} onFrame
	 */
	constructor(sab, onFrame) {
		this.i32 = new Int32Array(sab, 0, 16);
		this.data = new Uint8Array(sab, HEADER_BYTES);
		this.cap = this.data.length;
		this.mask = this.cap - 1;
		this.onFrame = onFrame;
		/** Carry-over of a frame straddling drains. @type {Uint8Array | null} */
		this.acc = null;
		this.closed = false;
		this.waiting = false;
	}

	/** Begin draining; returns immediately, wakes on producer notify. */
	start() {
		this._drain();
	}

	/** Unblock the pending wait and stop. */
	close() {
		this.closed = true;
		this.acc = null;
		Atomics.notify(this.i32, WRITE_IDX);
	}

	_drain() {
		if (this.closed) return;
		let writeRaw = 0;
		for (;;) {
			writeRaw = Atomics.load(this.i32, WRITE_IDX);
			const write = writeRaw >>> 0;
			const read = Atomics.load(this.i32, READ_IDX) >>> 0;
			const avail = (write - read) >>> 0;
			if (avail === 0) break;
			// Copy everything out and free the ring space immediately (the
			// producer's flush wait wakes on this advance), then parse frames
			// from the private copy - framing never holds ring space hostage.
			const carried = this.acc === null ? 0 : this.acc.length;
			const buf = new Uint8Array(carried + avail);
			if (carried > 0) buf.set(this.acc, 0);
			const at = read & this.mask;
			const firstPart = Math.min(avail, this.cap - at);
			buf.set(this.data.subarray(at, at + firstPart), carried);
			if (avail > firstPart) {
				buf.set(this.data.subarray(0, avail - firstPart), carried + firstPart);
			}
			Atomics.store(this.i32, READ_IDX, (read + avail) | 0);
			Atomics.notify(this.i32, READ_IDX);
			this.acc = buf;
			this._parse();
			if (this.closed) return;
		}
		this._armWait(writeRaw);
	}

	_parse() {
		let buf = /** @type {Uint8Array} */ (this.acc);
		let offset = 0;
		while (buf.length - offset >= 4) {
			const len =
				buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | ((buf[offset + 3] << 24) >>> 0);
			if (buf.length - offset - 4 < len) break;
			const frame = buf.subarray(offset, offset + 4 + len);
			offset += 4 + len;
			try {
				this.onFrame(frame);
			} catch {
				// A throwing consumer must not wedge the stream; the frame
				// boundary is intact, continue with the next frame.
			}
			if (this.closed) return;
			buf = /** @type {Uint8Array} */ (this.acc);
		}
		this.acc = offset === 0 ? buf : (buf.length - offset > 0 ? buf.slice(offset) : null);
		if (this.acc !== null && this.acc.length === 0) this.acc = null;
	}

	/**
	 * Park until the producer advances the write position past the value the
	 * empty verdict was computed from. As in the writer's flush wait, the
	 * carried value is load-bearing: a producer advance (and its one notify)
	 * landing between the empty check and this registration fails the
	 * waitAsync compare and retries via microtask, instead of sleeping on the
	 * post-advance value with bytes already in the ring.
	 * @param {number} expectedWrite raw WRITE_IDX observed when avail hit 0
	 */
	_armWait(expectedWrite) {
		if (this.waiting || this.closed) return;
		this.waiting = true;
		const res = Atomics.waitAsync(this.i32, WRITE_IDX, expectedWrite);
		const resume = () => {
			this.waiting = false;
			if (this.closed) return;
			this._drain();
		};
		if (res.async) res.value.then(resume);
		else microtask(resume);
	}
}

// --- Relay frame codec -------------------------------------------------------
//
// [u32le frameLen][u8 kind][body]; frameLen counts kind + body.
// kind 1 (publish):        [u8 flags][u16le topicLen][topic]
//                          [u32le envelopeLen][envelope]
//                          [f64le seq]?[u16le capLen][capability]?
//                          [u16le eventLen][event]?[u32le dataLen][dataJson]?
//                          [u32le origin][f64le ord][f64le birth]?
//   flags: bit0 compress, bit1 has seq, bit2 has capability, bit3 has event,
//          bit4 has data, bit5 has origin+ord+birth (one flag: the three are
//          stamped together by the sending worker or not at all).
//   ord/birth are f64 rather than u32: a long-lived high-rate topic can relay
//   past 2^32 frames, and birth is a fractional-ms clock reading.
// kind 2 (publish-batched): [u8 flags(bit0 compress)][u32le len][eventsJson]
//   (its per-event origin/ord/birth ride inside the JSON)

const KIND_PUBLISH = 1;
const KIND_PUBLISH_BATCHED = 2;

/**
 * Encode one relayed publish. Field semantics identical to the postMessage
 * form batchRelay ships. `data` must be JSON-serializable (it is by
 * construction: the envelope carrying the same value is already a JSON
 * string); a value that cannot stringify makes this THROW, and the caller
 * falls back to the structured-clone path for that message.
 */
export function encodePublishFrame(topic, envelope, compress, seq, capability, event, data, origin, ord, birth) {
	const topicB = textEncoder.encode(topic);
	const envB = textEncoder.encode(envelope);
	const hasSeq = typeof seq === 'number';
	const capB = capability !== undefined ? textEncoder.encode(capability) : null;
	const eventB = event !== undefined ? textEncoder.encode(event) : null;
	const dataB = data !== undefined ? textEncoder.encode(JSON.stringify(data)) : null;
	const hasOrigin = typeof origin === 'number' && typeof ord === 'number' && typeof birth === 'number';
	let len = 1 + 1 + 2 + topicB.length + 4 + envB.length;
	if (hasSeq) len += 8;
	if (capB !== null) len += 2 + capB.length;
	if (eventB !== null) len += 2 + eventB.length;
	if (dataB !== null) len += 4 + dataB.length;
	if (hasOrigin) len += 4 + 8 + 8;
	const out = new Uint8Array(4 + len);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, len, true);
	out[4] = KIND_PUBLISH;
	out[5] =
		(compress ? 1 : 0) |
		(hasSeq ? 2 : 0) |
		(capB !== null ? 4 : 0) |
		(eventB !== null ? 8 : 0) |
		(dataB !== null ? 16 : 0) |
		(hasOrigin ? 32 : 0);
	let o = 6;
	dv.setUint16(o, topicB.length, true); o += 2;
	out.set(topicB, o); o += topicB.length;
	dv.setUint32(o, envB.length, true); o += 4;
	out.set(envB, o); o += envB.length;
	if (hasSeq) { dv.setFloat64(o, /** @type {number} */ (seq), true); o += 8; }
	if (capB !== null) { dv.setUint16(o, capB.length, true); o += 2; out.set(capB, o); o += capB.length; }
	if (eventB !== null) { dv.setUint16(o, eventB.length, true); o += 2; out.set(eventB, o); o += eventB.length; }
	if (dataB !== null) { dv.setUint32(o, dataB.length, true); o += 4; out.set(dataB, o); o += dataB.length; }
	if (hasOrigin) {
		dv.setUint32(o, /** @type {number} */ (origin), true); o += 4;
		dv.setFloat64(o, /** @type {number} */ (ord), true); o += 8;
		dv.setFloat64(o, /** @type {number} */ (birth), true); o += 8;
	}
	return out;
}

/**
 * Encode one wire-level batched relay (`platform.publishBatched`). Throws if
 * `events` cannot stringify; the caller falls back to structured clone.
 */
export function encodePublishBatchedFrame(events, compress) {
	const eventsB = textEncoder.encode(JSON.stringify(events));
	const len = 1 + 1 + 4 + eventsB.length;
	const out = new Uint8Array(4 + len);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, len, true);
	out[4] = KIND_PUBLISH_BATCHED;
	out[5] = compress ? 1 : 0;
	dv.setUint32(6, eventsB.length, true);
	out.set(eventsB, 10);
	return out;
}

/**
 * Decode a complete frame (as emitted by RingReader, length prefix included)
 * back into the exact message shape the postMessage relay path dispatches.
 * Returns null for an unrecognized kind (skip - the frame boundary is intact).
 */
export function decodeRelayFrame(frame) {
	const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const kind = frame[4];
	if (kind === KIND_PUBLISH) {
		const flags = frame[5];
		let o = 6;
		const topicLen = dv.getUint16(o, true); o += 2;
		const topic = textDecoder.decode(frame.subarray(o, o + topicLen)); o += topicLen;
		const envLen = dv.getUint32(o, true); o += 4;
		const envelope = textDecoder.decode(frame.subarray(o, o + envLen)); o += envLen;
		let seq;
		if (flags & 2) { seq = dv.getFloat64(o, true); o += 8; }
		let capability;
		if (flags & 4) {
			const n = dv.getUint16(o, true); o += 2;
			capability = textDecoder.decode(frame.subarray(o, o + n)); o += n;
		}
		let event;
		if (flags & 8) {
			const n = dv.getUint16(o, true); o += 2;
			event = textDecoder.decode(frame.subarray(o, o + n)); o += n;
		}
		let data;
		if (flags & 16) {
			const n = dv.getUint32(o, true); o += 4;
			data = JSON.parse(textDecoder.decode(frame.subarray(o, o + n))); o += n;
		}
		let origin;
		let ord;
		let birth;
		if (flags & 32) {
			origin = dv.getUint32(o, true); o += 4;
			ord = dv.getFloat64(o, true); o += 8;
			birth = dv.getFloat64(o, true); o += 8;
		}
		return {
			type: 'publish',
			topic,
			envelope,
			compress: (flags & 1) !== 0,
			seq: flags & 2 ? seq : null,
			capability,
			event,
			data,
			origin,
			ord,
			birth
		};
	}
	if (kind === KIND_PUBLISH_BATCHED) {
		const n = dv.getUint32(6, true);
		const events = JSON.parse(textDecoder.decode(frame.subarray(10, 10 + n)));
		return { type: 'publish-batched', events, compress: (frame[5] & 1) !== 0 };
	}
	return null;
}
