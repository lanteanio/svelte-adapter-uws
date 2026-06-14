/**
 * Binary wire codec for the CRDT document plugin.
 *
 * Produces / consumes the `codec payload` that rides inside the framework's
 * `0x03` topic frame (see files/wire.js for the frame envelope). The payload is
 * `[op:u8][bytes...]`, one op per CRDT wire event, where `bytes` is the rest of
 * the payload verbatim:
 *
 *   UPDATE        [op][update bytes...]    - a steady-state document delta
 *   SNAPSHOT      [op][full-state bytes...] - the whole document state in one blob
 *   SYNC_REQUEST  [op][state-vector bytes...] - what the sender already has
 *
 * The op byte is codec-internal: it lives INSIDE the `0x03` PAYLOAD, one byte
 * past the framework header, so it shares no namespace with the adapter's
 * leading-byte demux (`0x01` upload chunk / `0x02` upload cancel / `0x03` binary
 * topic frame) nor with the cursor / presence opcode spaces (each codec owns its
 * own payload byte 0). The three op values 1/2/3 are this codec's alone.
 *
 * OPAQUE BY DESIGN
 * This codec carries the CRDT update `bytes` verbatim and never interprets them.
 * It knows nothing about any specific CRDT library: encode frames `{ op, bytes }`
 * onto the wire and decode hands the same `{ op, bytes }` back. The document
 * replica that produces and applies those bytes is a separate concern that rides
 * on top of this frame - the codec is purely the transport shape, so a future
 * replica can swap its byte format without touching the wire.
 *
 * APPLY-IN-PLACE (sink)
 * The client registers this codec with `sink: true`: decode applies / forwards
 * the bytes in place (into the local replica) and the framework dispatches no
 * store event. A sink codec recovers its own resume position (a CRDT resyncs via
 * a state-vector SYNC_REQUEST, not seq replay), so the framework does not track
 * `lastSeenSeqs` for its topic. The codec definition here returns the decoded
 * `{ op, bytes }` so the same definition is testable end to end and so a
 * non-sink consumer (a test, a relay) can read it; the sink flag is applied at
 * the client registration site, not baked into the codec.
 *
 * JSON FALLBACK
 * `encode` returns `null` for any frame it cannot represent (a `data` that is
 * not `{ op, bytes }` with a known op and byte-array bytes), which tells the
 * framework to send JSON for that one frame. A client without
 * `crdt.protocol:1` receives the JSON envelope `platform.publish` would have
 * sent - `{ op, bytes: number[] }` - and reads the identical shape, so a
 * non-capable client is never sent a frame it would mis-decode and no update is
 * silently lost. `bytes` travels as a plain `number[]` in the JSON form so it
 * round-trips losslessly without a base64 step.
 *
 * @module svelte-adapter-uws/plugins/crdt/codec
 */

import { ByteWriter, ByteReader } from '../../files/wire.js';
import { WS_CAPS } from '../../files/utils.js';

/** Negotiated capability for the CRDT binary wire. Bumped only for an incompatible schema. */
export const CRDT_CAPABILITY = 'crdt.protocol:1';

/**
 * The reserved topic-name prefix CRDT frames ride on. One definition for both
 * sides: the client registers its sink codec on it, the server publishes its
 * document topics under it (reserved-prefix topics never ride the client's
 * own subscribe frames; membership is server-side `platform.subscribe`).
 */
export const CRDT_TOPIC_PREFIX = '__crdt:';

/** 1-byte in-frame schema version for the CRDT wire. */
export const CRDT_SCHEMA_VERSION = 1;

const OP_UPDATE = 1;
const OP_SNAPSHOT = 2;
const OP_SYNC_REQUEST = 3;

/**
 * Map the public op name <-> the on-wire op byte. The names are the stable
 * surface (`data.op`); the bytes are this codec's internal namespace.
 */
const OP_TO_BYTE = Object.freeze({ update: OP_UPDATE, snapshot: OP_SNAPSHOT, 'sync-request': OP_SYNC_REQUEST });
const BYTE_TO_OP = Object.freeze({ [OP_UPDATE]: 'update', [OP_SNAPSHOT]: 'snapshot', [OP_SYNC_REQUEST]: 'sync-request' });

/**
 * Normalize the `bytes` field of a wire event to a Uint8Array, accepting either
 * a Uint8Array (the replica's native output) or a plain `number[]` of 0..255
 * (the JSON-transported form). Returns null for anything else - a non-array, or
 * an array carrying a non-byte value - so an unrepresentable frame falls back to
 * JSON rather than emitting corrupt bytes.
 * @param {any} bytes
 * @returns {Uint8Array | null}
 */
function toBytes(bytes) {
	if (bytes instanceof Uint8Array) return bytes;
	if (!Array.isArray(bytes)) return null;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return null;
		out[i] = b;
	}
	return out;
}

/**
 * Encode a CRDT wire event into a codec payload.
 *
 * @param {string} event - the framework event name; this codec dispatches on
 *   `data.op`, so `event` is carried for symmetry with the other codecs and is
 *   not read.
 * @param {{ op: string, bytes: Uint8Array | number[] }} data - the value
 *   `platform.publish`/`send` would carry: a known op and the opaque update bytes.
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodeCrdt(event, data) {
	try {
		if (data === null || typeof data !== 'object') return null;
		const opByte = OP_TO_BYTE[data.op];
		if (opByte === undefined) return null;
		const bytes = toBytes(data.bytes);
		if (bytes === null) return null;
		const w = new ByteWriter(1 + bytes.length);
		w.u8(opByte);
		w.bytes(bytes);
		return w.take();
	} catch {
		// Defensive: any unexpected shape falls back to JSON for this frame
		// rather than throwing into publish.
		return null;
	}
}

/**
 * Decode a CRDT codec payload back into the `{ event, data }` shape the JSON
 * path would have dispatched. The decoded `data` is `{ op, bytes }` with `bytes`
 * a zero-copy view of the rest of the payload. Returns null on an unknown
 * opcode, an unknown schema version, or a truncated / empty frame (the frame is
 * then dropped; a CRDT reconciles on the next update / snapshot / sync).
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {any} [state] - unused; the CRDT wire is stateless at the codec layer
 *   (the document replica that consumes the bytes holds the state). Accepted for
 *   the codec-contract signature `decode(payload, state, schemaVersion, seq)`.
 * @param {number} [schemaVersion] - the frame's 1-byte schema version.
 * @returns {{ event: string, data: { op: string, bytes: Uint8Array } } | null}
 */
export function decodeCrdt(payload, state, schemaVersion = CRDT_SCHEMA_VERSION) {
	if (schemaVersion !== CRDT_SCHEMA_VERSION) {
		return null; // unknown schema: drop rather than mis-decode
	}
	try {
		const r = new ByteReader(payload);
		const opByte = r.u8();
		const op = BYTE_TO_OP[opByte];
		if (op === undefined) return null;
		// The rest of the payload is the opaque update blob, handed back verbatim.
		const bytes = payload.subarray(r.pos);
		return { event: 'crdt', data: { op, bytes } };
	} catch {
		return null;
	}
}

/**
 * Build the CRDT binary wire codec (`crdt.protocol:1`). Exported so a
 * cluster-backed CRDT backend (e.g. `svelte-adapter-uws-extensions/redis/crdt`)
 * builds the IDENTICAL codec from one definition - the in-memory and cluster
 * CRDT backends never drift on the wire. Hand the result to
 * `platform.publishWire` / `platform.sendWire`.
 *
 * The codec is stateless at the wire layer (the document replica holds all
 * state), so there is no per-connection `state` factory: every capable
 * subscriber shares one encode and the framework fans the single frame out -
 * the encode-once-send-many path the high-fan-out document case wants.
 *
 * Returns `null` when `binary: false` (JSON for every client), mirroring the
 * cursor / presence codec factories so `binary` is one uniform knob across the
 * binary plugins.
 *
 * @param {{ binary?: boolean }} [options]
 * @returns {{ capability: string, schemaVersion: number, encode: typeof encodeCrdt } | null}
 */
export function createCrdtWireCodec(options = {}) {
	if (options.binary === false) return null;
	return {
		capability: CRDT_CAPABILITY,
		schemaVersion: CRDT_SCHEMA_VERSION,
		encode: encodeCrdt
	};
}

/**
 * Read the capabilities a connection advertised in its `hello` frame. Mirrors
 * the cursor codec's `onAttach` cap read so a future stateful CRDT wire (or a
 * server-side per-connection gate) can branch on `crdt.protocol:1` the same way.
 * Kept here so the cap-read site lives next to the token it reads.
 * @param {any} ws
 * @returns {boolean} true when the connection advertised {@link CRDT_CAPABILITY}
 */
export function connectionAcceptsCrdtBinary(ws) {
	let caps;
	try { caps = ws.getUserData()[WS_CAPS]; } catch { return false; }
	return !!(caps && caps.has(CRDT_CAPABILITY));
}
