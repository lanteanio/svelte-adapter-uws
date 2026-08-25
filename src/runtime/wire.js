/**
 * Binary wire primitives for the `0x03` topic-PAYLOAD frame.
 *
 * The leading-byte demux on a WebSocket connection is:
 *   - `0x01` upload chunk  (svelte-realtime layer, client -> server, never inbound here)
 *   - `0x02` upload cancel (svelte-realtime layer, client -> server)
 *   - `0x03` binary topic frame (this module, server -> client)
 *
 * The `0x03` frame envelope, owned by the framework (not the plugin codec):
 *
 *   [0x03][schemaVersion:u8][topicId:varint][seq:varint][codec payload...]
 *
 * `topicId` is the per-connection short id assigned by the server and
 * advertised to the client out-of-band (see the `wire-id` control frame).
 * `seq` is the per-topic monotonic sequence (0 means "no seq", matching the
 * seq-less single-target send path). The codec payload is opaque to the
 * framework - a plugin's `wire.encode` produced it and that plugin's
 * `wire.decode` consumes it.
 *
 * Integers use unsigned LEB128 varints. Division/multiplication (not bit
 * shifts) carry values past 2^31 so a long-lived per-topic `seq` never wraps
 * or corrupts. Floats use big-endian IEEE-754 single precision, matching the
 * big-endian convention of the upload frame builders.
 *
 * @module svelte-adapter-uws/src/runtime/wire
 */

/** Leading byte of a binary topic-PAYLOAD frame. */
export const WIRE_BINARY_TAG = 0x03;

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const FRAME_IO = Object.freeze({
	allocate: (length) => new Uint8Array(length),
	copy: (target, source, offset) => target.set(source, offset)
});

let activeFrameIO = FRAME_IO;

/**
 * Replace the default binary-frame allocation boundary in a controlled test or
 * simulation. Calls that pass an explicit `io` object remain unaffected. The
 * production runtime keeps the frozen native boundary and refuses replacement.
 *
 * @param {{ allocate: (length: number) => Uint8Array, copy: (target: Uint8Array, source: Uint8Array, offset: number) => void }} io
 */
export function setBinaryFrameIO(io) {
	if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
		throw new Error('wire: setBinaryFrameIO refused in production');
	}
	if (!io || typeof io.allocate !== 'function' || typeof io.copy !== 'function') {
		throw new TypeError('wire: binary frame I/O requires allocate and copy functions');
	}
	activeFrameIO = io;
}

/** Restore the native binary-frame allocation boundary. */
export function resetBinaryFrameIO() {
	activeFrameIO = FRAME_IO;
}

/**
 * Growable byte buffer with varint / float32 / length-prefixed-string writers.
 * Backed by an ArrayBuffer that doubles on demand; `take()` returns an
 * exact-length copy safe to retain, share, or hand to `ws.send`.
 */
export class ByteWriter {
	constructor(initial = 64) {
		this._ab = new ArrayBuffer(initial);
		this._buf = new Uint8Array(this._ab);
		this._view = new DataView(this._ab);
		this.len = 0;
	}

	/** @param {number} need - additional bytes required */
	_ensure(need) {
		const want = this.len + need;
		if (want <= this._buf.length) return;
		let cap = this._buf.length * 2;
		while (cap < want) cap *= 2;
		const ab = new ArrayBuffer(cap);
		const buf = new Uint8Array(ab);
		buf.set(this._buf.subarray(0, this.len));
		this._ab = ab;
		this._buf = buf;
		this._view = new DataView(ab);
	}

	/** Write one byte. @param {number} n */
	u8(n) {
		this._ensure(1);
		this._buf[this.len++] = n & 0xff;
	}

	/** Write an unsigned LEB128 varint. @param {number} value - non-negative, < 2^53 */
	varint(value) {
		// Math (not >>>) so values above 2^31 stay correct - `seq` can exceed
		// 32 bits on a long-lived high-throughput topic.
		while (value > 0x7f) {
			this.u8((value & 0x7f) | 0x80);
			value = Math.floor(value / 128);
		}
		this.u8(value & 0x7f);
	}

	/** Write a big-endian float32. @param {number} n */
	f32(n) {
		this._ensure(4);
		this._view.setFloat32(this.len, n, false);
		this.len += 4;
	}

	/** Write a big-endian float64. @param {number} n */
	f64(n) {
		this._ensure(8);
		this._view.setFloat64(this.len, n, false);
		this.len += 8;
	}

	/** Write a length-prefixed (varint byte length) UTF-8 string. @param {string} s */
	str(s) {
		const bytes = ENC.encode(s);
		this.varint(bytes.length);
		this._ensure(bytes.length);
		this._buf.set(bytes, this.len);
		this.len += bytes.length;
	}

	/** Append raw bytes. @param {Uint8Array} bytes */
	bytes(bytes) {
		this._ensure(bytes.length);
		this._buf.set(bytes, this.len);
		this.len += bytes.length;
	}

	/** @returns {Uint8Array} exact-length copy of the written bytes */
	take() {
		return this._buf.slice(0, this.len);
	}
}

/**
 * Sequential reader over a byte payload (typically a zero-copy subarray of an
 * inbound frame). Symmetric to {@link ByteWriter}. A read past the end throws
 * a RangeError, which callers turn into a dropped frame.
 */
export class ByteReader {
	/** @param {Uint8Array} buf */
	constructor(buf) {
		this._buf = buf;
		this._view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		this.pos = 0;
	}

	get done() {
		return this.pos >= this._buf.length;
	}

	/** @returns {number} */
	u8() {
		if (this.pos >= this._buf.length) throw new RangeError('wire: read past end');
		return this._buf[this.pos++];
	}

	/** @returns {number} */
	varint() {
		// Fast path: single-byte varint (the common case for lengths/counts).
		const first = this._buf[this.pos];
		if (first === undefined) throw new RangeError('wire: read past end');
		if (first < 0x80) { this.pos++; return first; }
		let result = 0;
		let mul = 1;
		let b;
		do {
			b = this._buf[this.pos++];
			if (b === undefined) throw new RangeError('wire: read past end');
			result += (b & 0x7f) * mul;
			mul *= 128;
		} while (b & 0x80);
		return result;
	}

	/** @returns {number} big-endian float32 */
	f32() {
		if (this.pos + 4 > this._buf.length) throw new RangeError('wire: read past end');
		const v = this._view.getFloat32(this.pos, false);
		this.pos += 4;
		return v;
	}

	/** @returns {number} big-endian float64 */
	f64() {
		if (this.pos + 8 > this._buf.length) throw new RangeError('wire: read past end');
		const v = this._view.getFloat64(this.pos, false);
		this.pos += 8;
		return v;
	}

	/** @returns {string} length-prefixed UTF-8 string */
	str() {
		const len = this.varint();
		if (this.pos + len > this._buf.length) throw new RangeError('wire: read past end');
		const s = DEC.decode(this._buf.subarray(this.pos, this.pos + len));
		this.pos += len;
		return s;
	}

	/** @returns {Uint8Array} a zero-copy view of the bytes from the cursor to the
	 * end - a codec whose tail is a differently-framed region (e.g. a bit stream)
	 * reads the byte-aligned head, then hands the remainder off. */
	rest() {
		return this._buf.subarray(this.pos);
	}
}

/**
 * Build a complete `0x03` topic-PAYLOAD frame from a codec payload.
 *
 * @param {number} schemaVersion - 1-byte plugin codec schema version
 * @param {number} topicId - per-connection short topic id
 * @param {number} seq - per-topic monotonic seq, or 0 for "no seq"
 * @param {Uint8Array} payload - bytes returned by the plugin's `wire.encode`
 * @param {{ allocate: (length: number) => Uint8Array, copy: (target: Uint8Array, source: Uint8Array, offset: number) => void }} [io]
 *   Injectable counting boundary for deterministic I/O-budget tests. Production
 *   omits it and takes the monomorphic native allocation/copy implementation.
 * @returns {Uint8Array}
 */
export function buildBinaryFrame(schemaVersion, topicId, seq, payload, io = activeFrameIO) {
	// Exact sizing avoids ByteWriter's grow-buffer allocation plus take() copy.
	// One outbound frame is one allocation and one bulk copy of the codec payload;
	// the four small header fields are written directly into the destination.
	const lengthOfVarint = (value) => {
		let length = 1;
		while (value > 0x7f) {
			value = Math.floor(value / 128);
			length++;
		}
		return length;
	};
	const headerLength = 2 + lengthOfVarint(topicId) + lengthOfVarint(seq);
	const frame = io.allocate(headerLength + payload.length);
	let at = 0;
	frame[at++] = WIRE_BINARY_TAG;
	frame[at++] = schemaVersion & 0xff;
	const writeVarint = (value) => {
		while (value > 0x7f) {
			frame[at++] = (value & 0x7f) | 0x80;
			value = Math.floor(value / 128);
		}
		frame[at++] = value & 0x7f;
	};
	writeVarint(topicId);
	writeVarint(seq);
	io.copy(frame, payload, at);
	return frame;
}

/**
 * Parse the framework header of a `0x03` frame and return the header fields
 * plus a zero-copy view of the codec payload.
 *
 * @param {Uint8Array} bytes - the full inbound binary frame
 * @returns {{ schemaVersion: number, topicId: number, seq: number, payload: Uint8Array } | null}
 *   null when the frame is not a `0x03` frame or is truncated.
 */
export function parseBinaryFrame(bytes) {
	if (bytes.length < 2 || bytes[0] !== WIRE_BINARY_TAG) return null;
	try {
		const r = new ByteReader(bytes);
		r.u8(); // tag, already checked
		const schemaVersion = r.u8();
		const topicId = r.varint();
		const seq = r.varint();
		return { schemaVersion, topicId, seq, payload: bytes.subarray(r.pos) };
	} catch {
		return null;
	}
}

/**
 * Allocate (or return the existing) per-connection binary topic-id for a
 * topic, managing the `WS_TOPIC_IDS` slot `{ byName, next }` on the userData
 * object. Shared across the prod / test / dev platform implementations so the
 * id space is identical in all three.
 *
 * @param {any} ud - ws.getUserData()
 * @param {symbol} slotKey - the WS_TOPIC_IDS symbol
 * @param {string} topic
 * @returns {{ id: number, isNew: boolean }} isNew is true on first allocation
 */
export function allocWireId(ud, slotKey, topic) {
	let slot = ud[slotKey];
	if (!slot) {
		slot = { byName: new Map(), next: 1 };
		ud[slotKey] = slot;
	}
	const existing = slot.byName.get(topic);
	if (existing !== undefined) return { id: existing, isNew: false };
	const id = slot.next++;
	slot.byName.set(topic, id);
	return { id, isNew: true };
}

/**
 * Build the `{type:'wire-id'}` control frame announcing which numeric topic-id
 * maps to which topic name, so an inbound `0x03` frame resolves to a topic.
 * @param {string} topic
 * @param {number} id
 * @returns {string}
 */
export function wireIdAnnounce(topic, id) {
	return '{"type":"wire-id","topic":' + JSON.stringify(topic) + ',"id":' + id + '}';
}

/**
 * Per-entry-point live capability accounting: how many connections have
 * advertised each capability token. Lets the binary publish path skip the
 * per-subscriber walk entirely when no connected client wants binary for a
 * codec (a JSON-only deployment pays nothing).
 *
 * @returns {{ has(cap: string): boolean, adjust(prev: Set<string>|null|undefined, next: Set<string>|null|undefined): void }}
 */
export function createCapCounts() {
	/** @type {Map<string, number>} */
	const counts = new Map();
	return {
		has(cap) {
			return (counts.get(cap) || 0) > 0;
		},
		adjust(prev, next) {
			if (prev) {
				for (const c of prev) {
					const n = (counts.get(c) || 0) - 1;
					if (n > 0) counts.set(c, n);
					else counts.delete(c);
				}
			}
			if (next) {
				for (const c of next) counts.set(c, (counts.get(c) || 0) + 1);
			}
		}
	};
}

// - Per-connection send-gate state machine ---------------------------------
//
// An internal adapter-to-adapter flow-control loop. A connection that opts in
// (by advertising the matching capability token) is handed a window: a count
// of permitted flow-controlled frames and an absolute deadline. The deadline
// is fixed at the moment the window is granted (the clock reading taken then,
// plus a duration), and is compared against the wall clock on every check - it
// is never a decremented countdown, so a stalled event loop can never silently
// extend a window. When the window is spent or expired, further requests queue
// up to a bound; past the bound they are refused. A re-grant resets the window
// and drains the queue in FIFO order.
//
// The neutral public method names keep the on-wire / app-facing vocabulary out
// of every call site; only a 0..1 scalar, booleans, and counts leave the
// object. The window's internal accounting never crosses to a hook or frame
// the app can read.

/**
 * Default zero-config window sizing. Internal tuning knob only; never user
 * exposed. Generous for a healthy single connection; narrowed by the server
 * as its admission posture tightens.
 * @type {{ requestCount: number, ttlMs: number }}
 */
export const DEFAULT_GRANT = { requestCount: 256, ttlMs: 10000 };

/** Hard ceiling on queued-but-not-yet-permitted requests before refusal. */
export const MAX_QUEUED_REQUESTS = 256;

/**
 * Build a per-connection send-gate state machine.
 *
 * @param {{ requestCount: number, ttlMs: number, maxQueue?: number, now?: () => number }} opts
 *   `requestCount` / `ttlMs` size the window applied by `grant()`; `maxQueue`
 *   bounds the queue depth (default {@link MAX_QUEUED_REQUESTS}); `now` is an
 *   injectable clock reader (default `Date.now`) so tests drive time.
 * @returns {{
 *   grant(count?: number, ttlMs?: number): void,
 *   live(): boolean,
 *   expiresAt(): number,
 *   tryAcquire(): boolean,
 *   available(): number,
 *   granted(): number,
 *   queued(): number,
 *   enqueue(item: any): boolean,
 *   requestN(count: number, ttlMs?: number): any[],
 *   pressureValue(): number
 * }}
 */
export function createLeaseState(opts) {
	const now = (opts && opts.now) || Date.now;
	const maxQueue = opts && typeof opts.maxQueue === 'number' ? opts.maxQueue : MAX_QUEUED_REQUESTS;
	const defaultCount = opts && typeof opts.requestCount === 'number' ? opts.requestCount : 0;
	const defaultTtl = opts && typeof opts.ttlMs === 'number' ? opts.ttlMs : 0;

	// Absolute deadline: the clock value read at grant time plus the duration.
	// Compared against now() on every check; never decremented.
	let _expiresAt = 0;
	// Remaining permits in the current window.
	let _available = 0;
	// Size of the current window, kept so the saturation scalar has a
	// denominator.
	let _granted = 0;
	/** @type {any[]} */
	const _queue = [];

	function fresh() {
		return _available > 0 && now() < _expiresAt;
	}

	return {
		// Apply a fresh window: fix the absolute deadline and reset the
		// permit counters. Defaults to the configured size when called with
		// no arguments. Does NOT drain the queue - drains happen via
		// requestN, which models the re-grant + drain on the inbound path.
		grant(count, ttlMs) {
			const c = typeof count === 'number' ? count : defaultCount;
			const t = typeof ttlMs === 'number' ? ttlMs : defaultTtl;
			_expiresAt = now() + t;
			_available = c;
			_granted = c;
		},

		// True while the current window is valid: permits remain and the
		// absolute deadline has not been reached.
		live() {
			return fresh();
		},

		// The current window's absolute deadline. 0 before the first grant.
		expiresAt() {
			return _expiresAt;
		},

		// Admission for one flow-controlled request. Consumes a permit and
		// returns true when the window is valid; returns false (without
		// consuming) when spent or expired.
		tryAcquire() {
			if (!fresh()) return false;
			_available--;
			return true;
		},

		// Remaining permits in the current window.
		available() {
			return _available;
		},

		// Size of the current window.
		granted() {
			return _granted;
		},

		// Number of items waiting for a future window.
		queued() {
			return _queue.length;
		},

		// Push one item onto the bounded queue. Returns false (and keeps the
		// queue unchanged) when the bound is reached, so the caller can turn
		// the refusal into a degraded signal rather than an unbounded buffer.
		enqueue(item) {
			if (_queue.length >= maxQueue) return false;
			_queue.push(item);
			return true;
		},

		// Apply a re-grant of `count` permits (and `ttlMs`, defaulting to the
		// configured duration) and drain as many queued items as the window
		// covers, in FIFO order. Returns the drained items so the caller can
		// run them after the window state is settled.
		requestN(count, ttlMs) {
			const t = typeof ttlMs === 'number' ? ttlMs : defaultTtl;
			_expiresAt = now() + t;
			_available = count;
			_granted = count;
			const drained = [];
			while (_available > 0 && _queue.length > 0) {
				drained.push(_queue.shift());
				_available--;
			}
			return drained;
		},

		// Saturation in 0..1. 0 == idle (full window unspent), 1 == exhausted
		// (no permits left or window dead). Higher means more saturated.
		pressureValue() {
			return leasePressureValue({ granted: _granted, available: fresh() ? _available : 0, fallback: 0 });
		}
	};
}

/**
 * Map a window's remaining/total permits to a 0..1 saturation scalar, the
 * same shape the worker pressure snapshot folds in. Direction: idle (full
 * window) reads near 0, exhausted (no permits or dead window) reads near 1, so
 * a higher value always means more saturation.
 *
 * A connection that never opted in has no window (`granted <= 0`); there is no
 * ratio to compute, so the supplied `fallback` (the worker's existing
 * threshold-derived scalar, 0 when healthy) is returned instead of dividing by
 * zero.
 *
 * @param {{ granted: number, available: number, fallback?: number }} w
 * @returns {number}
 */
export function leasePressureValue(w) {
	const granted = w.granted | 0;
	if (granted <= 0) {
		const fb = typeof w.fallback === 'number' ? w.fallback : 0;
		return fb < 0 ? 0 : fb > 1 ? 1 : fb;
	}
	const outstanding = granted - (w.available > 0 ? w.available : 0);
	const r = outstanding / granted;
	return r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * Normalize a client-reported permit-starved backlog (`request-n`'s optional
 * `queued` field) to the 0..1 saturation scalar the worker pressure fold
 * consumes. The server's own mirror of the gate never consumes a permit, so
 * this report is the only truthful saturation reading the replenish path has:
 * a healthy low-water replenish carries no backlog and reads 0, while a
 * connection whose previous window was spent with sends still waiting reads
 * the waiting fraction of the reference queue bound.
 *
 * The report is advisory input off the wire: the field is an integer by
 * schema, so everything non-numeric, non-integer, or non-positive collapses
 * to 0, and the scalar caps at 1 no matter what the peer claims. 0 is also
 * what an old client that never sends the field produces, so the pre-field
 * wire behaves exactly as before.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function leaseReportedSaturation(raw) {
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return 0;
	return raw >= MAX_QUEUED_REQUESTS ? 1 : raw / MAX_QUEUED_REQUESTS;
}

/**
 * Size the next send-gate window from the worker's current posture. Heap
 * headroom and subscriber load narrow the window so a tightening worker hands
 * out smaller windows; an idle worker hands out the full base size. Always
 * floors so a connection makes forward progress.
 *
 * Pure so the sizing direction (shrinks under load, floors) is testable without
 * reaching into process state. The caller supplies the live readings.
 *
 * @param {{ heapRatio: number, subscriberRatio: number, base?: number, floor?: number }} w
 *   `heapRatio` is heapUsed/heapTotal (0..1); `subscriberRatio` is total
 *   subscriptions per connection; `base` is the full window (default
 *   {@link DEFAULT_GRANT}.requestCount); `floor` is the smallest window handed
 *   out (default 8).
 * @returns {number}
 */
export function leaseGrantSize(w) {
	const base = typeof w.base === 'number' ? w.base : DEFAULT_GRANT.requestCount;
	const floor = typeof w.floor === 'number' ? w.floor : 8;
	const heapRatio = typeof w.heapRatio === 'number' && w.heapRatio > 0 ? w.heapRatio : 0;
	const subRatio = typeof w.subscriberRatio === 'number' && w.subscriberRatio > 0 ? w.subscriberRatio : 0;
	let scale = 1;
	if (heapRatio > 0.7) scale *= (1 - heapRatio);
	if (subRatio > 25) scale *= 25 / subRatio;
	if (scale < 0.05) scale = 0.05;
	else if (scale > 1) scale = 1;
	return Math.max(floor, Math.round(base * scale));
}

/**
 * Fold the worker's 0..1 saturation scalar from its raw readings. Each active
 * threshold contributes its sample's distance toward the threshold (worst-of),
 * clamped to 0..1; a fully healthy worker reads 0. The worst client-reported
 * send-gate backlog observed since the last sample is folded in worst-of too,
 * so a starved opted-in connection lifts the worker value even while the
 * global counters look calm.
 *
 * Pure so the value direction (rises under any breach, the gate peak lifts it,
 * idle reads 0) is testable without a live worker. The caller supplies the
 * readings, the configured thresholds, and the current gate peak.
 *
 * @param {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number, psiCpuSome10?: number, psiMemoryFull10?: number, psiIoFull10?: number, cpuThrottledRatio?: number }} sample
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, psiCpuSome?: number | false, psiMemoryFull?: number | false, psiIoFull?: number | false, cpuThrottledRatio?: number | false }} thresholds
 * @param {number} leaseSaturationPeak - worst gate reading since the last sample
 * @returns {number}
 */
export function samplePressureValue(sample, thresholds, leaseSaturationPeak) {
	let value = leaseSaturationPeak > 0 ? leaseSaturationPeak : 0;
	if (thresholds.memoryHeapUsedRatio !== false && thresholds.memoryHeapUsedRatio > 0) {
		const r = sample.heapUsedRatio / thresholds.memoryHeapUsedRatio;
		if (r > value) value = r;
	}
	if (thresholds.publishRatePerSec !== false && thresholds.publishRatePerSec > 0) {
		const r = sample.publishRate / thresholds.publishRatePerSec;
		if (r > value) value = r;
	}
	if (thresholds.subscriberRatio !== false && thresholds.subscriberRatio > 0) {
		const r = sample.subscriberRatio / thresholds.subscriberRatio;
		if (r > value) value = r;
	}
	// Kernel-sourced signals fold in worst-of like the process-local ones.
	// Their sample fields are simply absent on hosts without the source, so
	// the non-Linux path is byte-identical.
	if (thresholds.psiCpuSome !== undefined && thresholds.psiCpuSome !== false && thresholds.psiCpuSome > 0 && sample.psiCpuSome10 !== undefined) {
		const r = sample.psiCpuSome10 / thresholds.psiCpuSome;
		if (r > value) value = r;
	}
	if (thresholds.psiMemoryFull !== undefined && thresholds.psiMemoryFull !== false && thresholds.psiMemoryFull > 0 && sample.psiMemoryFull10 !== undefined) {
		const r = sample.psiMemoryFull10 / thresholds.psiMemoryFull;
		if (r > value) value = r;
	}
	if (thresholds.psiIoFull !== undefined && thresholds.psiIoFull !== false && thresholds.psiIoFull > 0 && sample.psiIoFull10 !== undefined) {
		const r = sample.psiIoFull10 / thresholds.psiIoFull;
		if (r > value) value = r;
	}
	if (thresholds.cpuThrottledRatio !== undefined && thresholds.cpuThrottledRatio !== false && thresholds.cpuThrottledRatio > 0 && sample.cpuThrottledRatio !== undefined) {
		const r = sample.cpuThrottledRatio / thresholds.cpuThrottledRatio;
		if (r > value) value = r;
	}
	if (value < 0) value = 0; else if (value > 1) value = 1;
	return value;
}

// - Send-gate control frames -----------------------------------------------
// JSON control frames carrying no data body, JSON transport
// only. Routed through the existing JSON-control demux (byte[3] === 'y') on
// both ends; no new demux branch. ASCII-safe numeric serialization.

/**
 * Build the server-to-client window-grant control frame.
 * @param {number} count
 * @param {number} ttlMs
 * @returns {string}
 */
export function leaseGrantFrame(count, ttlMs) {
	return '{"type":"lease","count":' + (count | 0) + ',"ttlMs":' + (ttlMs | 0) + '}';
}

/**
 * Build the client-to-server window-replenish control frame. `queued` is the
 * sender's permit-starved backlog at request time (the optional additive field
 * of PROTOCOL.md section 3.6); it is omitted at 0 so a client with no backlog
 * emits the historical byte shape.
 * @param {number} n
 * @param {number} [queued]
 * @returns {string}
 */
export function requestNFrame(n, queued) {
	const q = typeof queued === 'number' ? queued | 0 : 0;
	if (q > 0) return '{"type":"request-n","n":' + (n | 0) + ',"queued":' + q + '}';
	return '{"type":"request-n","n":' + (n | 0) + '}';
}

/**
 * The maximum byte length of a client-to-server control frame. A text frame at
 * or above this size is never parsed as a control frame (the demux stops at the
 * ceiling to keep the hot path from JSON-parsing large user payloads).
 * @type {number}
 */
export const CONTROL_FRAME_LIMIT = 8192;

/**
 * Build the server-to-client frame rejecting an oversized control-shaped
 * frame: a text frame that begins `{"type` (byte[3] = 'y') but is at or above
 * CONTROL_FRAME_LIMIT, so it can never be acted on as a control frame. The
 * server sends this instead of letting the frame fall through silently, so the
 * client learns its control frame overflowed. `limit` is the ceiling in
 * bytes; `size` is the offending frame's byte length - the frame was rejected
 * without being parsed, so no `ref` or `type` can be echoed, and the size is
 * what lets a developer identify which frame overflowed. Built per rejection;
 * the path is exceptional, never hot.
 * @param {number} size
 * @returns {string}
 */
export function controlFrameTooLargeFrame(size) {
	return '{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":' + CONTROL_FRAME_LIMIT +
		',"size":' + size + '}';
}
