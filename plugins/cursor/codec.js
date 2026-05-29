/**
 * Binary wire codec for the cursor plugin.
 *
 * Produces / consumes the `codec payload` that rides inside the framework's
 * `0x03` topic frame (see files/wire.js for the frame envelope). The payload
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

import { ByteWriter, ByteReader } from '../../files/wire.js';

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

const OP_UPDATE = 1;
const OP_BULK = 2;
const OP_REMOVE = 3;
const OP_JOIN = 4;
const OP_CATALOG = 5;

/** Default id-space size: 16-bit ids, evicted least-recently-used at the cap. */
const DEFAULT_MAX_ENTRIES = 65536;

/**
 * True when `d` is exactly a `{ x, y }` pair of finite numbers and nothing
 * else - the only shape the binary position encoding is lossless for. Extra
 * fields or non-numeric coords fall back to JSON so no data is silently lost.
 * @param {any} d
 */
function isXY(d) {
	if (d === null || typeof d !== 'object') return false;
	if (typeof d.x !== 'number' || !Number.isFinite(d.x)) return false;
	if (typeof d.y !== 'number' || !Number.isFinite(d.y)) return false;
	// Reject anything carrying fields beyond x/y so they are not dropped.
	for (const k in d) {
		if (k !== 'x' && k !== 'y') return false;
	}
	return true;
}

/**
 * Per-connection encoder dictionary for the schemaVersion-2 cursor wire. Maps
 * each cursor key to a small integer id so a frame carries a 1-2 byte id rather
 * than the full key string on every entry. A key is announced inline (KEY-ASSIGN)
 * the first time it appears on a connection; after that the frame references the
 * id only.
 *
 * Eviction: ids live in a 16-bit space (`maxEntries`, default 65536). The dict
 * grows until the cap, then a new key reclaims the least-recently-used entry
 * whose last use predates the current frame (so an id assigned earlier in the
 * same frame is never reused by a later entry in that frame) and takes its id;
 * the decoder re-syncs from the KEY-ASSIGN that carries the reused id. A key
 * that still cannot get an id (a single frame referencing > maxEntries distinct
 * keys) falls back to a full-string INLINE keyref. There is no free-on-remove:
 * a REMOVE leaves the id bound, so a re-appearing cursor reuses it with no new
 * assign, and LRU reclaims genuinely departed ids at the cap. State is
 * per-connection and discarded when the connection closes.
 */
export class CursorEncodeDict {
	/** @param {number} [maxEntries] */
	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		this.schemaVersion = CURSOR_SCHEMA_VERSION_DICT;
		this.maxEntries = maxEntries;
		/** @type {Map<string, { id: number, lastUsed: number }>} */
		this.byKey = new Map();
		this.nextId = 0;
		// Monotonic per-frame counter. `beginFrame()` advances it; an entry's
		// `lastUsed` records the frame it was last referenced, so eviction can
		// skip ids touched in the current frame.
		this.clock = 0;
	}

	/** Advance the per-frame clock. Call once at the start of each encode. */
	beginFrame() {
		this.clock++;
	}

	/**
	 * Write a keyref for `key`: a REF (`varint(id + 2)`) when the key is already
	 * interned, otherwise a KEY-ASSIGN (`varint(0)`, `varint(id)`, key string)
	 * after allocating an id - or an INLINE (`varint(1)`, key string) when the
	 * id space is exhausted for this frame.
	 * @param {ByteWriter} w
	 * @param {string} key
	 */
	writeKey(w, key) {
		const entry = this.byKey.get(key);
		if (entry !== undefined) {
			entry.lastUsed = this.clock;
			w.varint(entry.id + 2);
			return;
		}
		const id = this._alloc();
		if (id < 0) {
			w.varint(1);
			w.str(key);
			return;
		}
		this.byKey.set(key, { id, lastUsed: this.clock });
		w.varint(0);
		w.varint(id);
		w.str(key);
	}

	/** @returns {number} a usable id, or -1 when none can be freed this frame. */
	_alloc() {
		if (this.nextId < this.maxEntries) return this.nextId++;
		// At cap: reclaim the least-recently-used id whose last use predates the
		// current frame, so a key this frame just assigned is never evicted by a
		// later key in the same frame.
		let victimKey;
		let victimUsed = Infinity;
		let victimId = -1;
		for (const [k, e] of this.byKey) {
			if (e.lastUsed < this.clock && e.lastUsed < victimUsed) {
				victimUsed = e.lastUsed;
				victimKey = k;
				victimId = e.id;
			}
		}
		if (victimId < 0) return -1;
		this.byKey.delete(victimKey);
		return victimId;
	}
}

/**
 * Per-connection decoder dictionary for the schemaVersion-2 cursor wire.
 * Inverse of {@link CursorEncodeDict}: resolves a keyref back to its key,
 * caching `id -> key` so a REF costs one `Map.get` and no per-entry string
 * decode (the decode-cost win). Reset on reconnect.
 */
export class CursorDecodeDict {
	constructor() {
		this.schemaVersion = CURSOR_SCHEMA_VERSION_DICT;
		/** @type {Map<number, string>} */
		this.byId = new Map();
	}

	/**
	 * Read a keyref and resolve it to a key, recording any KEY-ASSIGN binding.
	 * Returns null when a REF cannot be resolved (a desync the caller turns into
	 * a dropped frame).
	 * @param {ByteReader} r
	 * @returns {string | null}
	 */
	readKey(r) {
		const v = r.varint();
		if (v === 0) {
			const id = r.varint();
			const key = r.str();
			this.byId.set(id, key);
			return key;
		}
		if (v === 1) return r.str();
		const key = this.byId.get(v - 2);
		return key === undefined ? null : key;
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
	const dict = (state != null && state.schemaVersion === CURSOR_SCHEMA_VERSION_DICT) ? state : null;
	try {
		// Advance the per-frame clock before any key is interned so eviction can
		// distinguish ids assigned this frame from older ones.
		if (dict) dict.beginFrame();
		switch (event) {
			case 'update': {
				if (!data || typeof data.key !== 'string' || !isXY(data.data)) return null;
				const w = new ByteWriter(24);
				w.u8(OP_UPDATE);
				writeKeyRef(w, data.key, dict);
				w.f32(data.data.x);
				w.f32(data.data.y);
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
				w.varint(data.length);
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
 * frame is then dropped; cursor is best-effort).
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {CursorDecodeDict} [state] - per-connection dictionary, required for
 *   schemaVersion 2 and ignored for schemaVersion 1.
 * @param {number} [schemaVersion] - the frame's 1-byte schema version. Defaults
 *   to the full-string wire so the shipped single-arg call site stays correct.
 * @returns {{ event: string, data: any } | null}
 */
export function decodeCursor(payload, state, schemaVersion = CURSOR_SCHEMA_VERSION) {
	if (schemaVersion !== CURSOR_SCHEMA_VERSION && schemaVersion !== CURSOR_SCHEMA_VERSION_DICT) {
		return null; // unknown schema: drop rather than mis-decode
	}
	const dict = schemaVersion === CURSOR_SCHEMA_VERSION_DICT
		? (state != null && state.schemaVersion === CURSOR_SCHEMA_VERSION_DICT ? state : null)
		: null;
	// A v2 frame with no decoder dictionary cannot resolve its refs - drop it
	// rather than read the keyref varints as full-string lengths.
	if (schemaVersion === CURSOR_SCHEMA_VERSION_DICT && !dict) return null;
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_UPDATE: {
				const key = readKeyRef(r, dict);
				if (key === null) return null;
				const x = r.f32();
				const y = r.f32();
				return { event: 'update', data: { key, data: { x, y } } };
			}
			case OP_BULK: {
				const count = r.varint();
				const arr = new Array(count);
				for (let i = 0; i < count; i++) {
					const key = readKeyRef(r, dict);
					if (key === null) return null;
					const x = r.f32();
					const y = r.f32();
					arr[i] = { key, data: { x, y } };
				}
				return { event: 'bulk', data: arr };
			}
			case OP_REMOVE: {
				const key = readKeyRef(r, dict);
				if (key === null) return null;
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
