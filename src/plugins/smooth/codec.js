/**
 * Binary wire codec for smoothed (predicted/reconciled) topics.
 *
 * Produces / consumes the codec payload that rides inside the framework's
 * `0x03` topic frame (see src/runtime/wire.js for the frame envelope). The payload
 * is `[op:u8][op-specific...]`, one op per smooth wire event:
 *
 *   STATE_DELTA [op][t][keyref][nChanged][fieldref,value]*[nRemoved][fieldref]*  object state, field delta
 *   STATE_DELTA_SAME [op][t][keyref][bits]           field delta, repeat set (field list implied)
 *   UPDATE_BATCH [op][t][count][sub,keyref,head]*[bits]  one tick's updates, one shared stamp
 *   STATE  [op][t:varint][keyref][stateJson]         array / primitive state (full)
 *   XY     [op][t:varint][keyref][x:f32][y:f32]      exactly-{x,y} state
 *   ACK    [op][id:varint][t:varint][sub:u8][state]  per-owner acknowledgement
 *   REMOVE [op][keyref]                              entity departure
 *
 * `keyref` is the shared per-connection short-id dictionary encoding and `t`
 * on STATE_DELTA/STATE/XY is the shared delta-coded server stamp
 * (src/runtime/keydict.js for both disciplines: in-order, reset on reconnect,
 * untouched on JSON fallback). The stamp is what client-side interpolation
 * reconstructs its server time axis from.
 *
 * STATE_DELTA carries an object entity state as a FIELD delta against the
 * connection's last-sent state for that key, not the whole state every tick. A
 * field counts as changed by the SAME reference-inequality the authority's own
 * change detection uses (`e.state !== before` - a functional update makes a
 * changed value a new reference), so an unchanged field costs nothing. The
 * changed fields split by value type:
 *
 *   - NUMERIC (finite number) fields ride a temporal value stream
 *     (src/runtime/wire-stream.js): each field's value is delta-of-delta /
 *     XOR-encoded against that field's previous sample on the connection, so a
 *     coordinate that drifts a little costs a handful of bits, not eight bytes.
 *     Their values travel bit-packed in a trailing block; the field NAMES ride
 *     the byte-aligned head.
 *   - every other kept field rides the JSON-faithful value codec
 *     (src/runtime/wire-value.js) inline, exactly as the full state did.
 *
 * The layout is `[nNumChanged][numFieldref]* [nLitChanged][litFieldref,value]*
 * [nRemoved][fieldref]* [numericBitStream]`. `fieldref` is a second short-id
 * dictionary over field NAMES, shared across every entity on the connection (a
 * topic's entities share a field vocabulary, so a name interns once). The
 * reconstruction is byte-identical (deep-equal) to the full-state round trip.
 *
 * The per-key baseline and the per-(key,field) numeric slots live on the
 * connection dictionary beside the key map and the stamp, with the identical
 * discipline: they advance only on a STATE_DELTA frame, are left frozen by an
 * XY / full-STATE / JSON-fallback frame (so an object stream that resumes after
 * them still deltas against a basis both ends hold), a field's numeric slot is
 * reset when that field is sent as a literal or removed, the whole key is
 * cleared on REMOVE, and everything resets on reconnect. Array / primitive /
 * null states ride the full STATE encoding and do not join the delta chain.
 *
 * ACK is a single-target frame (an entity's acknowledgement goes only to its
 * owning connection), so it carries no keyref - the owner knows which entity
 * is its own. Its stamp travels INSIDE the data as an absolute value rather
 * than through the delta dictionary: acks are low-volume (at most one per
 * server tick per owner), the absolute stamp also survives the JSON fallback
 * verbatim - the acknowledgement round trip is the clock estimator's upper
 * bound source, and it must work for JSON-only clients too - and keeping the
 * ack outside the delta chain means interleaved sendWire/publishWire frames
 * cannot perturb the update stamps' lock-step. `sub` selects the state
 * encoding: 0 = two f32 coordinates (exactly-{x,y} states), 1 = JSON string.
 *
 * Every other event (the snapshot-time 'time' seed, additive roster-style
 * events) is declined with null, telling the framework to send JSON for that
 * frame - additive events stay additive for old clients by construction.
 *
 * The encoder returns null for any frame it cannot represent, and a null
 * return leaves the dictionaries UNTOUCHED (everything that could fail is
 * validated and pre-serialized before the first key is interned or a stamp
 * is written), so the JSON-fallback frame can never desync the decoder.
 *
 * Pure: no clocks, no timers, no runtime imports. The encoder dictionary
 * takes an INJECTED time source (the server factory binds its own clock
 * seam), so this module bundles for the browser unchanged.
 *
 * @module svelte-adapter-uws/plugins/smooth/codec
 */

import { ByteWriter, ByteReader } from '../../runtime/wire.js';
import { writeValue, readValue } from '../../runtime/wire-value.js';
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
 * Negotiated capability for the smooth binary wire. A client advertises it in
 * hello caps when the smooth client module is loaded; the server sends binary
 * smooth frames only to connections carrying it. Everyone else gets JSON.
 */
export const SMOOTH_CAPABILITY = 'smooth.protocol:1';

/**
 * Wire topic prefix for smoothed entity topics. Client codec registration is
 * prefix-keyed and `__`-prefixed topics use plugin-managed membership (the
 * server subscribes the socket during the sync request), so both ends of the
 * smooth wire share this one constant.
 */
export const SMOOTH_TOPIC_PREFIX = '__smooth:';

/** 1-byte in-frame schema version for the smooth wire. */
export const SMOOTH_SCHEMA_VERSION = 1;

/**
 * Ingress kind + schema for the client->server smooth COMMAND wire (the `0x03`
 * ingress frame, orthogonal to the egress topic wire above). A client that
 * negotiated binary ingress binds a command channel under this kind and sends
 * each flush batch as a `0x03` frame this schema decodes, removing the
 * per-flush `JSON.parse` the JSON volatile-RPC envelope costs. Its own number
 * space, independent of `SMOOTH_SCHEMA_VERSION` (a different direction and
 * codec).
 */
export const SMOOTH_COMMAND_CAPABILITY = 'smooth.command:1';

/** 1-byte in-frame schema version for the smooth command (ingress) wire. */
export const SMOOTH_COMMAND_SCHEMA_VERSION = 1;

/** Defensive ceiling on the decoded command count (a flush batch is tiny). */
const SMOOTH_COMMAND_MAX = 4096;

/**
 * Encode a smooth command flush batch into an ingress `0x03` payload.
 *
 * The batch is `Array<{ id, cmd }>` where `cmd` is already the app's
 * `wire.command.pack` output (or the raw command). Layout:
 *
 *   [count:varint] then per entry [idDelta:varint][cmd via wire-value]
 *
 * Ids are delta-coded from the previous entry (the first from 0, so its delta
 * IS its absolute id); the channel transmits commands in strictly ascending id
 * order, and this drops any non-monotonic or invalid entry so the delta is
 * always non-negative. `cmd` uses the generic compact value codec, matching the
 * JSON round trip exactly - so the decoded batch equals what the JSON path
 * delivers to `authority.enqueue`.
 *
 * @param {Array<{ id: number, cmd: any }>} batch
 * @returns {Uint8Array}
 */
export function encodeSmoothCommandBatch(batch) {
	// Keep only valid, strictly-increasing-id entries. Beyond validation, the
	// strict-increase filter makes the delta encoding total (never a negative
	// varint) even if a caller ever violated the id-order invariant.
	const kept = [];
	let last = -1;
	for (let i = 0; i < batch.length; i++) {
		const c = batch[i];
		if (!c || typeof c.id !== 'number' || !Number.isInteger(c.id) || c.id <= last) continue;
		kept.push(c);
		last = c.id;
	}
	const w = new ByteWriter(16 + kept.length * 8);
	w.varint(kept.length);
	let prev = 0;
	for (let i = 0; i < kept.length; i++) {
		const c = kept[i];
		w.varint(c.id - prev);
		prev = c.id;
		writeValue(w, c.cmd);
	}
	return w.take();
}

/**
 * Decode an ingress command payload back into the `Array<{ id, cmd }>` batch
 * the JSON volatile-RPC path would have delivered. Returns null on an unknown
 * schema version or a truncated / malformed / over-long frame (the frame is
 * then dropped); an empty batch decodes to `[]`.
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {number} [schemaVersion] - the frame's 1-byte schema version
 * @returns {Array<{ id: number, cmd: any }> | null}
 */
export function decodeSmoothCommandBatch(payload, schemaVersion = SMOOTH_COMMAND_SCHEMA_VERSION) {
	if (schemaVersion !== SMOOTH_COMMAND_SCHEMA_VERSION) return null;
	try {
		const r = new ByteReader(payload);
		const count = r.varint();
		if (count > SMOOTH_COMMAND_MAX) return null;
		const out = new Array(count);
		let prev = 0;
		for (let i = 0; i < count; i++) {
			const id = prev + r.varint();
			prev = id;
			out[i] = { id, cmd: readValue(r) };
		}
		return out;
	} catch {
		return null;
	}
}

const OP_STATE = 1;
const OP_XY = 2;
const OP_ACK = 3;
const OP_REMOVE = 4;
const OP_STATE_DELTA = 5;
// Repeat-set field delta: the changed NUMERIC field set (and its order) is
// identical to this key's previous delta frame, no literals changed, nothing
// removed - the steady-motion common case. The frame carries no field list at
// all (both ends replay the key's remembered list), so the byte-aligned head
// collapses to the keyref.
const OP_STATE_DELTA_SAME = 6;
// One tick's updates in one frame: a shared stamp, then per entity a sub-op
// byte + keyref + that op's byte-aligned head, then ONE trailing bit block
// carrying every entity's numeric values in entry order. Cuts the per-entity
// frame overhead (op + stamp + transport framing) to once per tick.
const OP_UPDATE_BATCH = 7;

const ACK_SUB_XY = 0;
const ACK_SUB_JSON = 1;

/** Defensive ceiling on a decoded batch's entry count. */
const UPDATE_BATCH_MAX = 65536;

/**
 * True when a value survives a JSON round trip at an object-field position:
 * `undefined`, functions and symbols are dropped by JSON.stringify (and by the
 * wire-value codec), so a field holding one is treated as absent by the field
 * delta - matching what the full-state JSON path would carry.
 * @param {any} v
 */
function isKeptValue(v) {
	if (v === undefined) return false;
	const t = typeof v;
	return t !== 'function' && t !== 'symbol';
}

/**
 * True when `d` is exactly a `{ x, y }` pair of finite numbers that survive
 * the float32 wire format - the only shape the compact coordinate encoding
 * is lossless-enough for. A magnitude past float32 range would narrow to
 * Infinity on the wire (states are arbitrary app data, unlike screen-pixel
 * cursors), so such values ride the lossless JSON state encoding instead.
 * @param {any} d
 */
function isXY(d) {
	if (d === null || typeof d !== 'object') return false;
	if (typeof d.x !== 'number' || !Number.isFinite(Math.fround(d.x))) return false;
	if (typeof d.y !== 'number' || !Number.isFinite(Math.fround(d.y))) return false;
	for (const k in d) {
		if (k !== 'x' && k !== 'y') return false;
	}
	return true;
}

/**
 * Per-connection encoder dictionary for the smooth wire: the shared short-id
 * dictionary plus the delta-coded stamp state and the injected time source
 * the update stamps are read from.
 */
export class SmoothEncodeDict extends KeyEncodeDict {
	/** @param {() => number} timeSource @param {number} [maxEntries] */
	constructor(timeSource, maxEntries = DEFAULT_MAX_ENTRIES) {
		super(maxEntries);
		this.schemaVersion = SMOOTH_SCHEMA_VERSION;
		this.timeSource = timeSource;
		this.lastT = -1;
		// Field-delta state. `fields` is a SECOND short-id dictionary, over field
		// NAMES rather than entity keys - shared across every entity on the
		// connection because a topic's entities share a field vocabulary, so a name
		// interns once. `baseline` holds the last-sent state per key, the reference
		// the field delta encodes against. `slots` holds the temporal stream state
		// per (key, field) for the numeric value streams.
		this.fields = new KeyEncodeDict(maxEntries);
		/** @type {Map<string, any>} */
		this.baseline = new Map();
		/** @type {Map<string, Map<string, ReturnType<typeof createStreamSlot>>>} */
		this.slots = new Map();
		// The numeric-changed field list of each key's last full delta frame: the
		// basis the repeat-set frame (OP_STATE_DELTA_SAME) elides its field list
		// against. Advances only on a full delta frame, is left untouched by a
		// repeat-set / XY / full-state / JSON-fallback frame, cleared on REMOVE,
		// reset on reconnect - the same discipline as the baseline, mirrored in
		// lock-step by the decode dictionary.
		/** @type {Map<string, string[]>} */
		this.lastNum = new Map();
	}
}

/**
 * Per-connection decoder dictionary for the smooth wire. Reset on reconnect.
 */
export class SmoothDecodeDict extends KeyDecodeDict {
	constructor() {
		super();
		this.schemaVersion = SMOOTH_SCHEMA_VERSION;
		this.lastT = -1;
		// The decode-side twins of the encoder's field-delta state: the field-name
		// dictionary, the last-reconstructed state per key (the basis the next
		// delta applies onto), and the per-(key,field) numeric stream slots.
		this.fields = new KeyDecodeDict();
		/** @type {Map<string, any>} */
		this.baseline = new Map();
		/** @type {Map<string, Map<string, ReturnType<typeof createStreamSlot>>>} */
		this.slots = new Map();
		// Decode-side twin of the encoder's `lastNum` (see SmoothEncodeDict).
		/** @type {Map<string, string[]>} */
		this.lastNum = new Map();
	}
}

/** True when `a` (a string array) equals `b` element-for-element in order. */
function sameFieldList(a, b) {
	if (b === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Classify one object-state update against the connection's baseline: which
 * fields ride the numeric stream, which ride the literal value codec (their
 * bytes PRE-SERIALIZED here, so a value the codec cannot carry throws BEFORE
 * any dictionary state is touched - the caller turns the throw into a JSON
 * fallback / a rejected batch with both ends' state intact), which fields
 * dropped out, and whether the numeric set repeats the key's previous delta
 * frame (the repeat-set form). Read-only over the dictionary.
 *
 * @param {SmoothEncodeDict} dict
 * @param {string} key
 * @param {Record<string, any>} s
 */
function planDelta(dict, key, s) {
	const prev = dict.baseline.get(key);
	const keys = Object.keys(s);
	const numChanged = [];
	const litChanged = [];
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		const v = s[k];
		if (!isKeptValue(v)) continue;
		if (prev !== undefined && v === prev[k]) continue;
		if (typeof v === 'number' && Number.isFinite(v)) numChanged.push(k);
		else litChanged.push(k);
	}
	const removed = [];
	if (prev !== undefined) {
		const pkeys = Object.keys(prev);
		for (let i = 0; i < pkeys.length; i++) {
			const k = pkeys[i];
			if (!isKeptValue(prev[k])) continue;
			if (isKeptValue(s[k])) continue;
			removed.push(k);
		}
	}
	// Pre-serialize the literal values into one scratch buffer with per-value
	// offsets, so assembly interleaves [fieldref, value] without running the
	// (throw-capable) value codec after a dictionary mutation.
	let litBytes = null;
	let litOffsets = null;
	if (litChanged.length > 0) {
		const lw = new ByteWriter(16);
		litOffsets = new Array(litChanged.length + 1);
		litOffsets[0] = 0;
		for (let i = 0; i < litChanged.length; i++) {
			writeValue(lw, s[litChanged[i]]);
			litOffsets[i + 1] = lw.len;
		}
		litBytes = lw.take();
	}
	const same = prev !== undefined && litChanged.length === 0 && removed.length === 0 &&
		numChanged.length > 0 && sameFieldList(numChanged, dict.lastNum.get(key));
	return { numChanged, litChanged, removed, litBytes, litOffsets, same };
}

/**
 * Write one planned delta body - keyref plus the byte-aligned head - into `w`,
 * stream the numeric values into `bw`, and advance the key's delta state
 * (baseline, slots, remembered numeric set). A repeat-set plan writes no field
 * list at all. Shared by the single-frame delta ops and the batch entries.
 *
 * @param {import('../../runtime/wire.js').ByteWriter} w
 * @param {import('../../runtime/wire-bits.js').BitWriter} bw
 * @param {SmoothEncodeDict} dict
 * @param {string} key
 * @param {Record<string, any>} s
 * @param {ReturnType<typeof planDelta>} plan
 */
function writeDeltaBody(w, bw, dict, key, s, plan) {
	dict.writeKey(w, key);
	if (!plan.same) {
		w.varint(plan.numChanged.length);
		for (let i = 0; i < plan.numChanged.length; i++) dict.fields.writeKey(w, plan.numChanged[i]);
		w.varint(plan.litChanged.length);
		for (let i = 0; i < plan.litChanged.length; i++) {
			dict.fields.writeKey(w, plan.litChanged[i]);
			w.bytes(plan.litBytes.subarray(plan.litOffsets[i], plan.litOffsets[i + 1]));
		}
		w.varint(plan.removed.length);
		for (let i = 0; i < plan.removed.length; i++) dict.fields.writeKey(w, plan.removed[i]);
	}
	// Per-(key,field) numeric slots for the temporal streams.
	let keySlots = dict.slots.get(key);
	if (plan.numChanged.length > 0) {
		if (keySlots === undefined) {
			keySlots = new Map();
			dict.slots.set(key, keySlots);
		}
		for (let i = 0; i < plan.numChanged.length; i++) {
			const k = plan.numChanged[i];
			let slot = keySlots.get(k);
			if (slot === undefined) {
				slot = createStreamSlot();
				keySlots.set(k, slot);
			}
			const v = s[k];
			// Normalize -0 to 0 so the stream matches the JSON / value-codec
			// round trip (JSON has no negative zero).
			writeStreamValue(bw, slot, v === 0 ? 0 : v);
		}
	}
	// A field that left the numeric stream (sent as a literal now, or removed)
	// drops its slot so a later numeric value first-sights. A repeat-set frame
	// by definition has neither.
	if (keySlots !== undefined && !plan.same) {
		for (let i = 0; i < plan.litChanged.length; i++) keySlots.delete(plan.litChanged[i]);
		for (let i = 0; i < plan.removed.length; i++) keySlots.delete(plan.removed[i]);
	}
	// Advance the baseline only after the whole body is built - the freeze
	// discipline the stamp and key dicts keep. Store the state reference
	// itself: the next frame's reference-inequality reads it.
	dict.baseline.set(key, s);
	if (!plan.same) dict.lastNum.set(key, plan.numChanged);
}

/**
 * Encode a smooth wire event into a codec payload.
 *
 * @param {string} event - 'update' | 'update-batch' | 'ack' | 'remove'
 *   (anything else declines)
 * @param {any} data - the same value the JSON envelope would carry
 * @param {SmoothEncodeDict} [state] - per-connection dictionary; without one
 *   every frame declines to JSON (the smooth wire is dictionary-only).
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodeSmooth(event, data, state) {
	const dict = state != null && state.schemaVersion === SMOOTH_SCHEMA_VERSION ? state : null;
	if (!dict) return null;
	try {
		dict.beginFrame();
		switch (event) {
			case 'update': {
				if (!data || typeof data.key !== 'string') return null;
				const s = data.data;
				if (isXY(s)) {
					const w = new ByteWriter(24);
					w.u8(OP_XY);
					writeDeltaStamp(w, dict);
					dict.writeKey(w, data.key);
					w.f32(s.x);
					w.f32(s.y);
					return w.take();
				}
				if (s === undefined) return null;
				if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
					// Field delta. Split the changed fields into NUMERIC (a temporal
					// value stream, bit-packed in a trailing block) and LITERAL (the
					// JSON-faithful value codec, inline), plus the fields that dropped
					// out. A field is "changed" by reference-inequality (a functional
					// update makes a changed value a new reference, the same contract
					// the authority's change detection rests on), so unchanged fields
					// cost nothing and the reconstruction is byte-identical to the
					// full-state round trip. When the numeric set repeats the key's
					// previous delta frame with no literals and no removals (steady
					// motion), the repeat-set op elides the field list entirely.
					let plan;
					try {
						plan = planDelta(dict, data.key, s);
					} catch {
						// A literal the value codec cannot carry: JSON fallback with
						// every dictionary untouched (planDelta is read-only).
						return null;
					}
					dict.fields.beginFrame();
					const w = new ByteWriter(32);
					w.u8(plan.same ? OP_STATE_DELTA_SAME : OP_STATE_DELTA);
					writeDeltaStamp(w, dict);
					const bw = new BitWriter();
					writeDeltaBody(w, bw, dict, data.key, s, plan);
					if (plan.numChanged.length > 0) w.bytes(bw.finish());
					return w.take();
				}
				// Array / primitive / null state: the full JSON encoding. Serialize
				// before the stamp is written or any key interned, so a
				// non-serializable state falls back to JSON with the dict and stamp
				// state untouched. Does not join the delta chain (baseline frozen).
				const json = JSON.stringify(s);
				if (typeof json !== 'string') return null;
				const w = new ByteWriter(32 + json.length);
				w.u8(OP_STATE);
				writeDeltaStamp(w, dict);
				dict.writeKey(w, data.key);
				w.str(json);
				return w.take();
			}
			case 'update-batch': {
				// One tick's updates in one frame. Two passes: EVERY entry is
				// validated and planned (throw-capable work included: literal
				// pre-serialization, full-state JSON.stringify) before the first
				// dictionary mutation, so a rejected batch returns null with both
				// ends' state untouched and the caller can fall back to the
				// per-entity path, which has per-entity fallback. One entry per key
				// (the decoder applies entries in order against shared per-key
				// state); a duplicate rejects the batch.
				const u = data && Array.isArray(data.updates) ? data.updates : null;
				if (u === null || u.length === 0 || u.length > UPDATE_BATCH_MAX) return null;
				const plans = new Array(u.length);
				const seen = new Set();
				for (let i = 0; i < u.length; i++) {
					const e = u[i];
					if (!e || typeof e.key !== 'string') return null;
					if (seen.has(e.key)) return null;
					seen.add(e.key);
					const s = e.data;
					if (isXY(s)) {
						plans[i] = { sub: OP_XY };
						continue;
					}
					if (s === undefined) return null;
					if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
						const plan = planDelta(dict, e.key, s);
						plans[i] = { sub: plan.same ? OP_STATE_DELTA_SAME : OP_STATE_DELTA, plan };
						continue;
					}
					const json = JSON.stringify(s);
					if (typeof json !== 'string') return null;
					plans[i] = { sub: OP_STATE, json };
				}
				// Assembly: shared stamp, then per entry a sub-op byte + keyref +
				// that op's byte-aligned head; every entity's numeric values ride
				// ONE trailing bit block in entry order.
				dict.fields.beginFrame();
				const w = new ByteWriter(64);
				w.u8(OP_UPDATE_BATCH);
				writeDeltaStamp(w, dict);
				w.varint(u.length);
				const bw = new BitWriter();
				let anyBits = false;
				for (let i = 0; i < u.length; i++) {
					const e = u[i];
					const p = plans[i];
					w.u8(p.sub);
					if (p.sub === OP_XY) {
						dict.writeKey(w, e.key);
						w.f32(e.data.x);
						w.f32(e.data.y);
						continue;
					}
					if (p.sub === OP_STATE) {
						dict.writeKey(w, e.key);
						w.str(p.json);
						continue;
					}
					writeDeltaBody(w, bw, dict, e.key, e.data, p.plan);
					if (p.plan.numChanged.length > 0) anyBits = true;
				}
				if (anyBits) w.bytes(bw.finish());
				return w.take();
			}
			case 'ack': {
				if (!data || typeof data.id !== 'number' || !Number.isInteger(data.id) || data.id < 0) return null;
				// A missing or invalid stamp declines to JSON (where the field
				// is simply absent and the client skips the clock sample) -
				// coercing it would seed binary clients' clock estimators with
				// a bogus epoch the JSON form never carries.
				if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0) return null;
				const t = Math.floor(data.t);
				const s = data.state;
				if (isXY(s)) {
					const w = new ByteWriter(24);
					w.u8(OP_ACK);
					w.varint(data.id);
					w.varint(t);
					w.u8(ACK_SUB_XY);
					w.f32(s.x);
					w.f32(s.y);
					return w.take();
				}
				const json = JSON.stringify(s === undefined ? null : s);
				if (typeof json !== 'string') return null;
				const w = new ByteWriter(24 + json.length);
				w.u8(OP_ACK);
				w.varint(data.id);
				w.varint(t);
				w.u8(ACK_SUB_JSON);
				w.str(json);
				return w.take();
			}
			case 'remove': {
				if (!data || typeof data.key !== 'string') return null;
				const w = new ByteWriter(16);
				w.u8(OP_REMOVE);
				dict.writeKey(w, data.key);
				// A departed entity leaves the delta chain: a re-appearing key is
				// first-sight again. Both ends clear from the same REMOVE frame.
				dict.baseline.delete(data.key);
				dict.slots.delete(data.key);
				dict.lastNum.delete(data.key);
				return w.take();
			}
			default:
				return null;
		}
	} catch {
		// Any encode failure falls back to JSON for this frame rather than
		// throwing into publish.
		return null;
	}
}

/**
 * Read one field-delta head (numeric field names, literal field/value pairs,
 * removed field names) off the byte-aligned section. Returns null on a keyref
 * desync. Shared by the single delta frame and the batch entries; the numeric
 * VALUES ride a bit block the caller hands to {@link applyDeltaEntry}.
 * @param {import('../../runtime/wire.js').ByteReader} r
 * @param {SmoothDecodeDict} dict
 */
function readDeltaHead(r, dict) {
	const nNum = r.varint();
	const numFields = [];
	for (let i = 0; i < nNum; i++) {
		const fname = dict.fields.readKey(r);
		if (fname === null) return null;
		numFields.push(fname);
	}
	const nLit = r.varint();
	const litPairs = [];
	for (let i = 0; i < nLit; i++) {
		const fname = dict.fields.readKey(r);
		if (fname === null) return null;
		litPairs.push([fname, readValue(r)]);
	}
	const nRem = r.varint();
	const remFields = [];
	for (let i = 0; i < nRem; i++) {
		const fname = dict.fields.readKey(r);
		if (fname === null) return null;
		remFields.push(fname);
	}
	return { numFields, litPairs, remFields };
}

/**
 * Set one decoded field on a reconstructed state. A '__proto__' field name is
 * defined as an OWN DATA property - matching JSON.parse, whose reconstruction
 * the field delta must stay byte-identical to - rather than assigned through
 * the inherited setter, which would replace the object's prototype with
 * wire-controlled data instead of creating the field.
 * @param {Record<string, any>} out
 * @param {string} field
 * @param {any} value
 */
function setDecodedField(out, field, value) {
	if (field === '__proto__') {
		Object.defineProperty(out, field, { value, enumerable: true, writable: true, configurable: true });
	} else {
		out[field] = value;
	}
}

/**
 * Apply one decoded field-delta entry: reconstruct the state from the key's
 * baseline plus the head, pull the numeric values off `br`, and advance the
 * key's delta state (baseline, slots, remembered numeric set). A fresh object
 * each frame (never the one handed to the consumer last time), so a
 * downstream reader mutating a frame cannot corrupt the reconstruction basis.
 * @param {SmoothDecodeDict} dict
 * @param {string} key
 * @param {ReturnType<typeof readDeltaHead>} head
 * @param {import('../../runtime/wire-bits.js').BitReader | null} br
 */
function applyDeltaEntry(dict, key, head, br) {
	const prev = dict.baseline.get(key);
	const out = prev === undefined ? {} : { ...prev };
	for (let i = 0; i < head.litPairs.length; i++) setDecodedField(out, head.litPairs[i][0], head.litPairs[i][1]);
	for (let i = 0; i < head.remFields.length; i++) delete out[head.remFields[i]];
	let keySlots = dict.slots.get(key);
	if (head.numFields.length > 0) {
		if (keySlots === undefined) {
			keySlots = new Map();
			dict.slots.set(key, keySlots);
		}
		for (let i = 0; i < head.numFields.length; i++) {
			const f = head.numFields[i];
			let slot = keySlots.get(f);
			if (slot === undefined) {
				slot = createStreamSlot();
				keySlots.set(f, slot);
			}
			setDecodedField(out, f, readStreamValue(br, slot));
		}
	}
	if (keySlots !== undefined) {
		for (let i = 0; i < head.litPairs.length; i++) keySlots.delete(head.litPairs[i][0]);
		for (let i = 0; i < head.remFields.length; i++) keySlots.delete(head.remFields[i]);
	}
	dict.lastNum.set(key, head.numFields);
	dict.baseline.set(key, out);
	return out;
}

/**
 * Apply one repeat-set entry: the field list is the key's remembered numeric
 * set from its previous delta frame. Null (a dropped frame) when the mirror
 * state is missing - a desync this connection heals from on reconnect. The
 * slot presence is verified for EVERY field before the first bit is read, so
 * a rejected entry leaves the stream slots untouched.
 * @param {SmoothDecodeDict} dict
 * @param {string} key
 * @param {import('../../runtime/wire-bits.js').BitReader} br
 */
function applySameEntry(dict, key, br) {
	const fields = dict.lastNum.get(key);
	if (fields === undefined || fields.length === 0) return null;
	const prev = dict.baseline.get(key);
	if (prev === undefined) return null;
	const keySlots = dict.slots.get(key);
	if (keySlots === undefined) return null;
	for (let i = 0; i < fields.length; i++) {
		if (keySlots.get(fields[i]) === undefined) return null;
	}
	const out = { ...prev };
	for (let i = 0; i < fields.length; i++) {
		setDecodedField(out, fields[i], readStreamValue(br, keySlots.get(fields[i])));
	}
	dict.baseline.set(key, out);
	return out;
}

/**
 * Decode a smooth codec payload back into the `{ event, data }` shape the
 * JSON path would have dispatched. Returns null on an unknown opcode, an
 * unknown schema version, a dictionary desync, or a truncated / malformed
 * frame (the frame is then dropped). Update frames additionally carry their
 * server stamp as `t` on the returned object - the additive field the
 * interpolation ingest reads; ack frames carry `t` inside the data,
 * mirroring the JSON form. A batch frame decodes to ONE
 * `{ event: 'update-batch', data: { updates }, t }` envelope; the client
 * channel splits it back into per-entity updates sharing the stamp.
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {SmoothDecodeDict} [state] - per-connection dictionary, required.
 * @param {number} [schemaVersion] - the frame's 1-byte schema version.
 * @returns {{ event: string, data: any, t?: number } | null}
 */
export function decodeSmooth(payload, state, schemaVersion = SMOOTH_SCHEMA_VERSION) {
	if (schemaVersion !== SMOOTH_SCHEMA_VERSION) return null;
	const dict = state != null && state.byId instanceof Map ? state : null;
	if (!dict) return null;
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_STATE: {
				const t = readDeltaStamp(r, dict);
				const key = dict.readKey(r);
				if (key === null) return null;
				const data = JSON.parse(r.str());
				return { event: 'update', data: { key, data }, t };
			}
			case OP_STATE_DELTA: {
				const t = readDeltaStamp(r, dict);
				const key = dict.readKey(r);
				if (key === null) return null;
				const head = readDeltaHead(r, dict);
				if (head === null) return null;
				const br = head.numFields.length > 0 ? new BitReader(r.rest()) : null;
				const out = applyDeltaEntry(dict, key, head, br);
				return { event: 'update', data: { key, data: out }, t };
			}
			case OP_STATE_DELTA_SAME: {
				const t = readDeltaStamp(r, dict);
				const key = dict.readKey(r);
				if (key === null) return null;
				const out = applySameEntry(dict, key, new BitReader(r.rest()));
				if (out === null) return null;
				return { event: 'update', data: { key, data: out }, t };
			}
			case OP_UPDATE_BATCH: {
				const t = readDeltaStamp(r, dict);
				const count = r.varint();
				if (count === 0 || count > UPDATE_BATCH_MAX) return null;
				// Byte-aligned pass: every entry's sub-op, keyref, and head. The
				// repeat-set entries resolve their field list from the mirror map;
				// an unknown list is a desync and drops the whole frame.
				const heads = new Array(count);
				for (let i = 0; i < count; i++) {
					const sub = r.u8();
					const key = dict.readKey(r);
					if (key === null) return null;
					if (sub === OP_XY) {
						heads[i] = { sub, key, out: { x: r.f32(), y: r.f32() } };
						continue;
					}
					if (sub === OP_STATE) {
						heads[i] = { sub, key, out: JSON.parse(r.str()) };
						continue;
					}
					if (sub === OP_STATE_DELTA) {
						const head = readDeltaHead(r, dict);
						if (head === null) return null;
						heads[i] = { sub, key, head };
						continue;
					}
					if (sub === OP_STATE_DELTA_SAME) {
						heads[i] = { sub, key };
						continue;
					}
					return null;
				}
				// One trailing bit block carries every entry's numeric values in
				// entry order; state advances per entry, in order.
				const br = new BitReader(r.rest());
				const updates = new Array(count);
				for (let i = 0; i < count; i++) {
					const h = heads[i];
					if (h.sub === OP_XY || h.sub === OP_STATE) {
						updates[i] = { key: h.key, data: h.out };
						continue;
					}
					if (h.sub === OP_STATE_DELTA_SAME) {
						const out = applySameEntry(dict, h.key, br);
						if (out === null) return null;
						updates[i] = { key: h.key, data: out };
						continue;
					}
					updates[i] = { key: h.key, data: applyDeltaEntry(dict, h.key, h.head, br) };
				}
				return { event: 'update-batch', data: { updates }, t };
			}
			case OP_XY: {
				const t = readDeltaStamp(r, dict);
				const key = dict.readKey(r);
				if (key === null) return null;
				const x = r.f32();
				const y = r.f32();
				return { event: 'update', data: { key, data: { x, y } }, t };
			}
			case OP_ACK: {
				const id = r.varint();
				const t = r.varint();
				const sub = r.u8();
				if (sub === ACK_SUB_XY) {
					const x = r.f32();
					const y = r.f32();
					return { event: 'ack', data: { id, state: { x, y }, t } };
				}
				if (sub !== ACK_SUB_JSON) return null;
				const stateValue = JSON.parse(r.str());
				return { event: 'ack', data: { id, state: stateValue, t } };
			}
			case OP_REMOVE: {
				const key = dict.readKey(r);
				if (key === null) return null;
				dict.baseline.delete(key);
				dict.slots.delete(key);
				dict.lastNum.delete(key);
				return { event: 'remove', data: { key } };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}
