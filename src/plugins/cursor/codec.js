/**
 * Binary wire codec for the cursor plugin.
 *
 * Produces / consumes the `codec payload` that rides inside the framework's
 * `0x03` topic frame (see src/runtime/wire.js for the frame envelope). The payload
 * is `[op:u8][op-specific...]`, one op per cursor wire event:
 *
 *   UPDATE  [op][keyref][x:f32][y:f32]
 *   BULK    [op][count:varint]({keyref}{x:f32}{y:f32})*
 *   REMOVE  [op][keyref]
 *   JOIN    [op][keyref][userJson]
 *   CATALOG [op][count:varint]({keyref}{userJson})*
 *
 * where `userJson` is a length-prefixed UTF-8 string and `keyref` is the cursor
 * key. There are two on-wire key encodings, selected by the frame's
 * `schemaVersion` (the framework stamps it; the decoder dispatches on it):
 *
 *   - schemaVersion 1 (`cursor.protocol:2`): `keyref` is the full
 *     length-prefixed UTF-8 key string, every frame, no per-connection state.
 *   - schemaVersion 2 (`cursor.protocol:3`): `keyref` is a per-connection short
 *     id. The first time a key appears on a connection it is announced inline
 *     (the key string travels once); after that the frame carries a 1-2 byte id
 *     and the decoder resolves it from a cached id->key map - no per-entry
 *     string decode, and the key bytes leave the wire entirely.
 *   - schemaVersion 3 (`cursor.protocol:4`): the short-id wire plus a server
 *     wall-clock stamp on every position frame, written between the op byte
 *     and the first keyref:
 *
 *       UPDATE  [op][t:varint][keyref][x:f32][y:f32]
 *       BULK    [op][t:varint][count:varint]({keyref}{x:f32}{y:f32})*
 *
 *     The stamp is delta-coded against the connection's previous stamp (the
 *     first stamp after a (re)connect is the absolute epoch-ms value; every
 *     later one is the non-negative delta), so the steady-state cost is one
 *     byte per frame. Both dictionaries track `lastT` in lock-step - same
 *     per-connection, in-order, reset-on-reconnect, untouched-on-JSON-fallback
 *     discipline as the key dictionary. Roster ops (join/catalog/remove) carry
 *     no stamp. The stamp is what client-side interpolation reconstructs its
 *     server time axis from; a client that never smooths simply ignores it.
 *   - schemaVersion 4 (`cursor.protocol:5`): the stamped short-id wire with
 *     positions carried as a per-cursor temporal value stream
 *     (src/runtime/wire-stream.js) instead of raw float32 pairs:
 *
 *       UPDATE  [op][t:varint][keyref][positionBits]
 *       BULK    [op][t:varint][count:varint]({keyref})*[positionBits]
 *
 *     Each cursor's x and y are encoded against that cursor's PREVIOUS sample
 *     on the connection (delta-of-delta for integer positions, XOR for
 *     fractional ones), bit-packed in a trailing block - a whole-pixel cursor
 *     drift costs a few bits instead of eight bytes. The streamed value is the
 *     float32-narrowed position (`Math.fround`), so a client decodes exactly
 *     the value the float32 wire would have delivered: the precision contract
 *     is unchanged across versions, only the bytes drop. The per-cursor stream
 *     state lives on both dictionaries with the key-dictionary discipline
 *     (in-order, reset on reconnect, untouched on JSON fallback) and is
 *     cleared by that cursor's REMOVE on both ends, so a re-appearing cursor
 *     starts a fresh stream.
 *
 * The short-id keyref is a single varint `v`:
 *   - `v == 0` KEY-ASSIGN: followed by `varint(id)` then the key string. Binds
 *     `id -> key` for this connection, then this occurrence uses `id`.
 *   - `v == 1` INLINE: followed by the key string, with no id binding. The
 *     overflow fallback when the id space is exhausted within a single frame.
 *   - `v >= 2` REF: the id is `v - 2` (so id 0 maps to v 2; 0 and 1 are
 *     reserved for the two escapes above). No key bytes on the wire.
 *
 * Design notes (why the encoding is shaped this way, recorded so the choices
 * are legible):
 *
 *   - The key is a UTF-8 string (full at v1 / on first use at v2), NOT 16 raw
 *     UUID bytes. Cursor keys are server-assigned connection ids - `"42"`
 *     in-process, `"<instanceId>:42"` in the Redis-backed variant - never
 *     UUIDs, and the same client decoder serves both backends. A string is
 *     correct for any key shape; the short id then collapses it to 1-2 bytes
 *     for every frame after the first.
 *   - Positions are big-endian float32, NOT i16. Real cursor positions are
 *     fractional doubles (e.g. `clientX - getBoundingClientRect().left`), so an
 *     integer-only schema would fall back to JSON for essentially every frame.
 *     float32 precision (sub-0.01 px at screen scale) is imperceptible for an
 *     ephemeral cursor.
 *
 * The encoder returns `null` for any frame it cannot represent (data that is
 * not exactly `{x, y}`-numeric, a non-string key, or a `user` that will not
 * JSON-serialize). A `null` return tells the framework to send JSON for that
 * one frame, so apps that put richer data on the cursor channel keep working.
 * Critically, a `null` return must leave the encoder dictionary UNCHANGED:
 * the JSON-fallback frame never reaches the decoder, so any id assigned for it
 * would be one the decoder never learns, desyncing every later reference. The
 * dictionaried encoders below validate and pre-serialize everything that could
 * fail BEFORE the first key is interned.
 *
 * @module svelte-adapter-uws/plugins/cursor/codec
 */

import { ByteWriter, ByteReader } from '../../runtime/wire.js';
import { BitWriter, BitReader } from '../../runtime/wire-bits.js';
import { createStreamSlot, writeStreamValue, readStreamValue } from '../../runtime/wire-stream.js';
import {
	KeyEncodeDict,
	KeyDecodeDict,
	writeDeltaStamp,
	readDeltaStamp,
	DEFAULT_MAX_ENTRIES
} from '../../runtime/keydict.js';

/**
 * Negotiated capability for the full-string-key cursor wire (schemaVersion 1).
 * Bumped only for an incompatible v1 schema.
 */
export const CURSOR_CAPABILITY = 'cursor.protocol:2';

/** 1-byte in-frame schema version for the full-string-key wire. */
export const CURSOR_SCHEMA_VERSION = 1;

/**
 * Additive capability advertised alongside {@link CURSOR_CAPABILITY} by a
 * client that can also decode the short-id dictionary wire (schemaVersion 2).
 * The server sends the dictionaried form only to connections carrying this
 * token; a connection with `cursor.protocol:2` only keeps receiving the
 * full-string form, so an older client is never sent a frame it would
 * mis-decode.
 */
export const CURSOR_CAPABILITY_DICT = 'cursor.protocol:3';

/** 1-byte in-frame schema version for the short-id dictionary wire. */
export const CURSOR_SCHEMA_VERSION_DICT = 2;

/**
 * Additive capability advertised alongside the dictionary capability by a
 * client that can also decode the time-stamped wire (schemaVersion 3). The
 * server stamps position frames only for connections carrying this token AND
 * the dictionary token; everyone else keeps receiving their negotiated form,
 * so no client is ever sent a frame it would mis-decode.
 */
export const CURSOR_CAPABILITY_TIME = 'cursor.protocol:4';

/** 1-byte in-frame schema version for the time-stamped dictionary wire. */
export const CURSOR_SCHEMA_VERSION_TIME = 3;

/**
 * Additive capability advertised alongside the time capability by a client
 * that can also decode the temporally-streamed position wire (schemaVersion 4).
 * The server streams positions only for connections carrying this token AND
 * the time and dictionary tokens - one linear negotiation ladder, so every
 * client keeps receiving exactly its negotiated form.
 */
export const CURSOR_CAPABILITY_STREAM = 'cursor.protocol:5';

/** 1-byte in-frame schema version for the temporally-streamed wire. */
export const CURSOR_SCHEMA_VERSION_STREAM = 4;

const OP_UPDATE = 1;
const OP_BULK = 2;
const OP_REMOVE = 3;
const OP_JOIN = 4;
const OP_CATALOG = 5;

/**
 * True when `d` is exactly a `{ x, y }` pair of finite numbers that survive
 * the float32 wire format - the only shape the binary position encoding is
 * lossless-enough for. Extra fields or non-numeric coords fall back to JSON
 * so no data is silently lost, and a magnitude past float32 range (which
 * would narrow to Infinity on the wire) falls back the same way.
 * @param {any} d
 */
function isXY(d) {
	if (d === null || typeof d !== 'object') return false;
	if (typeof d.x !== 'number' || !Number.isFinite(Math.fround(d.x))) return false;
	if (typeof d.y !== 'number' || !Number.isFinite(Math.fround(d.y))) return false;
	// Reject anything carrying fields beyond x/y so they are not dropped.
	for (const k in d) {
		if (k !== 'x' && k !== 'y') return false;
	}
	return true;
}

/**
 * Per-connection encoder dictionary for the schemaVersion-2 cursor wire: the
 * shared short-id dictionary (see src/runtime/keydict.js for the keyref encoding
 * and the LRU eviction discipline) stamped with the cursor schema version.
 * State is per-connection and discarded when the connection closes; a REMOVE
 * leaves the id bound so a re-appearing cursor reuses it with no new assign.
 */
export class CursorEncodeDict extends KeyEncodeDict {
	/** @param {number} [maxEntries] */
	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		super(maxEntries);
		this.schemaVersion = CURSOR_SCHEMA_VERSION_DICT;
	}
}

/**
 * Per-connection encoder dictionary for the schemaVersion-3 time-stamped
 * cursor wire: the short-id dictionary plus the delta-coded stamp state and
 * the injected time source the stamps are read from. The time source is
 * injected (never imported) so this module stays runtime-free and bundles
 * for the browser; the server factory binds it to its own clock seam.
 */
export class CursorTimeEncodeDict extends CursorEncodeDict {
	/** @param {() => number} timeSource @param {number} [maxEntries] */
	constructor(timeSource, maxEntries = DEFAULT_MAX_ENTRIES) {
		super(maxEntries);
		this.schemaVersion = CURSOR_SCHEMA_VERSION_TIME;
		this.timeSource = timeSource;
		this.lastT = -1;
	}
}

/**
 * Per-connection encoder dictionary for the schemaVersion-4 temporally-streamed
 * cursor wire: the stamped dictionary plus per-cursor value-stream state -
 * `slots` maps a cursor key to its `{ x, y }` stream slots, the reference each
 * position frame's bits are encoded against. Cleared per cursor on REMOVE,
 * wholesale on detach; reset on reconnect like everything else here.
 */
export class CursorStreamEncodeDict extends CursorTimeEncodeDict {
	/** @param {() => number} timeSource @param {number} [maxEntries] */
	constructor(timeSource, maxEntries = DEFAULT_MAX_ENTRIES) {
		super(timeSource, maxEntries);
		this.schemaVersion = CURSOR_SCHEMA_VERSION_STREAM;
		/** @type {Map<string, { x: ReturnType<typeof createStreamSlot>, y: ReturnType<typeof createStreamSlot> }>} */
		this.slots = new Map();
	}
}

/**
 * Per-connection decoder dictionary for the schemaVersion-2 and -3 cursor
 * wires. Inverse of {@link CursorEncodeDict} via the shared decode dictionary
 * (src/runtime/keydict.js): resolves a keyref back to its key, caching `id -> key`
 * so a REF costs one `Map.get` and no per-entry string decode (the
 * decode-cost win). `lastT` mirrors the encoder's delta-coded stamp state for
 * schemaVersion-3 frames. Reset on reconnect.
 */
export class CursorDecodeDict extends KeyDecodeDict {
	constructor() {
		super();
		this.schemaVersion = CURSOR_SCHEMA_VERSION_DICT;
		this.lastT = -1;
		// Per-cursor value-stream state, the decode twin of the schemaVersion-4
		// encoder's `slots`. Populated only by v4 frames; inert on older wires.
		/** @type {Map<string, { x: ReturnType<typeof createStreamSlot>, y: ReturnType<typeof createStreamSlot> }>} */
		this.slots = new Map();
	}
}

/** @param {ByteWriter} w @param {string} key @param {CursorEncodeDict | null} dict */
function writeKeyRef(w, key, dict) {
	if (dict) dict.writeKey(w, key);
	else w.str(key);
}

/** @param {ByteReader} r @param {CursorDecodeDict | null} dict @returns {string | null} */
function readKeyRef(r, dict) {
	if (dict) return dict.readKey(r);
	return r.str();
}

// The delta-coded stamp discipline (absolute first, non-negative deltas in
// lock-step, untouched on JSON fallback) is shared with the other stamped
// codecs - see src/runtime/keydict.js.
const writeStamp = writeDeltaStamp;
const readStamp = readDeltaStamp;

/** A cursor's `{ x, y }` stream slots, created on first sight. */
function slotsFor(dict, key) {
	let s = dict.slots.get(key);
	if (s === undefined) {
		s = { x: createStreamSlot(), y: createStreamSlot() };
		dict.slots.set(key, s);
	}
	return s;
}

/**
 * Encode a cursor wire event into a codec payload.
 *
 * @param {string} event - one of 'update' | 'bulk' | 'remove' | 'join' | 'catalog'
 * @param {any} data - the same value `platform.publish`/`send` would carry
 * @param {CursorEncodeDict} [state] - per-connection dictionary for the
 *   schemaVersion-2 wire; omit (or pass a non-dictionary value) for the
 *   full-string schemaVersion-1 wire.
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodeCursor(event, data, state) {
	const sv = state != null ? state.schemaVersion : 0;
	const dict = (sv === CURSOR_SCHEMA_VERSION_DICT || sv === CURSOR_SCHEMA_VERSION_TIME || sv === CURSOR_SCHEMA_VERSION_STREAM) ? state : null;
	const stamped = sv === CURSOR_SCHEMA_VERSION_TIME || sv === CURSOR_SCHEMA_VERSION_STREAM;
	const streamed = sv === CURSOR_SCHEMA_VERSION_STREAM;
	try {
		// Advance the per-frame clock before any key is interned so eviction can
		// distinguish ids assigned this frame from older ones.
		if (dict) dict.beginFrame();
		switch (event) {
			case 'update': {
				if (!data || typeof data.key !== 'string' || !isXY(data.data)) return null;
				const w = new ByteWriter(24);
				w.u8(OP_UPDATE);
				if (stamped) writeStamp(w, dict);
				writeKeyRef(w, data.key, dict);
				if (streamed) {
					// The streamed value is the float32-narrowed position, so the
					// decoded value is exactly what the f32 wire would deliver.
					const s = slotsFor(dict, data.key);
					const bw = new BitWriter();
					writeStreamValue(bw, s.x, Math.fround(data.data.x));
					writeStreamValue(bw, s.y, Math.fround(data.data.y));
					w.bytes(bw.finish());
				} else {
					w.f32(data.data.x);
					w.f32(data.data.y);
				}
				return w.take();
			}
			case 'bulk': {
				if (!Array.isArray(data)) return null;
				// Validate every entry before interning any key: a frame that
				// returns null falls back to JSON and must leave the dict untouched.
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					if (!e || typeof e.key !== 'string' || !isXY(e.data)) return null;
				}
				const w = new ByteWriter(16 + data.length * 16);
				w.u8(OP_BULK);
				if (stamped) writeStamp(w, dict);
				w.varint(data.length);
				if (streamed) {
					// Byte-aligned keyrefs first, then every position in entry order
					// as one trailing bit block.
					for (let i = 0; i < data.length; i++) writeKeyRef(w, data[i].key, dict);
					const bw = new BitWriter();
					for (let i = 0; i < data.length; i++) {
						const e = data[i];
						const s = slotsFor(dict, e.key);
						writeStreamValue(bw, s.x, Math.fround(e.data.x));
						writeStreamValue(bw, s.y, Math.fround(e.data.y));
					}
					w.bytes(bw.finish());
					return w.take();
				}
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					writeKeyRef(w, e.key, dict);
					w.f32(e.data.x);
					w.f32(e.data.y);
				}
				return w.take();
			}
			case 'remove': {
				if (!data || typeof data.key !== 'string') return null;
				const w = new ByteWriter(16);
				w.u8(OP_REMOVE);
				writeKeyRef(w, data.key, dict);
				// A departed cursor leaves the value-stream chain: a re-appearing
				// key starts a fresh stream. Both ends clear from this same frame.
				if (streamed) dict.slots.delete(data.key);
				return w.take();
			}
			case 'join': {
				if (!data || typeof data.key !== 'string') return null;
				// Serialize before interning the key so a non-serializable `user`
				// returns null without having mutated the dict.
				const userJson = JSON.stringify(data.user ?? null);
				const w = new ByteWriter(32);
				w.u8(OP_JOIN);
				writeKeyRef(w, data.key, dict);
				w.str(userJson);
				return w.take();
			}
			case 'catalog': {
				if (!Array.isArray(data)) return null;
				// Validate + pre-serialize every entry before interning any key,
				// for the same dict-stays-untouched-on-fallback reason as bulk.
				const userJsons = new Array(data.length);
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					if (!e || typeof e.key !== 'string') return null;
					userJsons[i] = JSON.stringify(e.user ?? null);
				}
				const w = new ByteWriter(16 + data.length * 24);
				w.u8(OP_CATALOG);
				w.varint(data.length);
				for (let i = 0; i < data.length; i++) {
					writeKeyRef(w, data[i].key, dict);
					w.str(userJsons[i]);
				}
				return w.take();
			}
			default:
				return null;
		}
	} catch {
		// Any encode failure (e.g. a `user` value that will not JSON-serialize)
		// falls back to JSON for this frame rather than throwing into publish.
		return null;
	}
}

/**
 * Decode a cursor codec payload back into the `{ event, data }` shape the JSON
 * path would have dispatched. Returns null on an unknown opcode, an unknown
 * schema version, a dictionary desync, or a truncated / malformed frame (the
 * frame is then dropped; cursor is best-effort). A schemaVersion-3 position
 * frame additionally carries its server stamp as `t` on the returned object -
 * an additive field consumers that never smooth simply ignore.
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {CursorDecodeDict} [state] - per-connection dictionary, required for
 *   schemaVersion 2 and 3 and ignored for schemaVersion 1.
 * @param {number} [schemaVersion] - the frame's 1-byte schema version. Defaults
 *   to the full-string wire so the shipped single-arg call site stays correct.
 * @returns {{ event: string, data: any, t?: number } | null}
 */
export function decodeCursor(payload, state, schemaVersion = CURSOR_SCHEMA_VERSION) {
	if (schemaVersion !== CURSOR_SCHEMA_VERSION
		&& schemaVersion !== CURSOR_SCHEMA_VERSION_DICT
		&& schemaVersion !== CURSOR_SCHEMA_VERSION_TIME
		&& schemaVersion !== CURSOR_SCHEMA_VERSION_STREAM) {
		return null; // unknown schema: drop rather than mis-decode
	}
	const needsDict = schemaVersion !== CURSOR_SCHEMA_VERSION;
	const dict = needsDict && state != null && state.byId instanceof Map ? state : null;
	// A dictionaried frame with no decoder dictionary cannot resolve its refs -
	// drop it rather than read the keyref varints as full-string lengths.
	if (needsDict && !dict) return null;
	const stamped = schemaVersion === CURSOR_SCHEMA_VERSION_TIME || schemaVersion === CURSOR_SCHEMA_VERSION_STREAM;
	const streamed = schemaVersion === CURSOR_SCHEMA_VERSION_STREAM;
	// A streamed frame needs the per-cursor slot store (an old decode dictionary
	// instance would lack it) - drop rather than misread the bit block.
	if (streamed && !(dict.slots instanceof Map)) return null;
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_UPDATE: {
				const t = stamped ? readStamp(r, dict) : undefined;
				const key = readKeyRef(r, dict);
				if (key === null) return null;
				let x;
				let y;
				if (streamed) {
					const s = slotsFor(dict, key);
					const br = new BitReader(r.rest());
					x = readStreamValue(br, s.x);
					y = readStreamValue(br, s.y);
				} else {
					x = r.f32();
					y = r.f32();
				}
				const out = { event: 'update', data: { key, data: { x, y } } };
				if (t !== undefined) out.t = t;
				return out;
			}
			case OP_BULK: {
				const t = stamped ? readStamp(r, dict) : undefined;
				const count = r.varint();
				const arr = new Array(count);
				if (streamed) {
					for (let i = 0; i < count; i++) {
						const key = readKeyRef(r, dict);
						if (key === null) return null;
						arr[i] = { key, data: null };
					}
					const br = new BitReader(r.rest());
					for (let i = 0; i < count; i++) {
						const s = slotsFor(dict, arr[i].key);
						const x = readStreamValue(br, s.x);
						const y = readStreamValue(br, s.y);
						arr[i].data = { x, y };
					}
					const out = { event: 'bulk', data: arr };
					if (t !== undefined) out.t = t;
					return out;
				}
				for (let i = 0; i < count; i++) {
					const key = readKeyRef(r, dict);
					if (key === null) return null;
					const x = r.f32();
					const y = r.f32();
					arr[i] = { key, data: { x, y } };
				}
				const out = { event: 'bulk', data: arr };
				if (t !== undefined) out.t = t;
				return out;
			}
			case OP_REMOVE: {
				const key = readKeyRef(r, dict);
				if (key === null) return null;
				if (streamed) dict.slots.delete(key);
				return { event: 'remove', data: { key } };
			}
			case OP_JOIN: {
				const key = readKeyRef(r, dict);
				if (key === null) return null;
				const user = JSON.parse(r.str());
				return { event: 'join', data: { key, user } };
			}
			case OP_CATALOG: {
				const count = r.varint();
				const arr = new Array(count);
				for (let i = 0; i < count; i++) {
					const key = readKeyRef(r, dict);
					if (key === null) return null;
					const user = JSON.parse(r.str());
					arr[i] = { key, user };
				}
				return { event: 'catalog', data: arr };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}
