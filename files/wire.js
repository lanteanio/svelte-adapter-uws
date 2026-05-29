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
 * @module svelte-adapter-uws/files/wire
 */

/** Leading byte of a binary topic-PAYLOAD frame. */
export const WIRE_BINARY_TAG = 0x03;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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

	/** @returns {string} length-prefixed UTF-8 string */
	str() {
		const len = this.varint();
		if (this.pos + len > this._buf.length) throw new RangeError('wire: read past end');
		const s = DEC.decode(this._buf.subarray(this.pos, this.pos + len));
		this.pos += len;
		return s;
	}
}

/**
 * Build a complete `0x03` topic-PAYLOAD frame from a codec payload.
 *
 * @param {number} schemaVersion - 1-byte plugin codec schema version
 * @param {number} topicId - per-connection short topic id
 * @param {number} seq - per-topic monotonic seq, or 0 for "no seq"
 * @param {Uint8Array} payload - bytes returned by the plugin's `wire.encode`
 * @returns {Uint8Array}
 */
export function buildBinaryFrame(schemaVersion, topicId, seq, payload) {
	const w = new ByteWriter(8 + payload.length);
	w.u8(WIRE_BINARY_TAG);
	w.u8(schemaVersion & 0xff);
	w.varint(topicId);
	w.varint(seq);
	w.bytes(payload);
	return w.take();
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
