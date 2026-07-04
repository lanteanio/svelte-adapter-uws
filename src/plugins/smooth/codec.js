/**
 * Binary wire codec for smoothed (predicted/reconciled) topics.
 *
 * Produces / consumes the codec payload that rides inside the framework's
 * `0x03` topic frame (see src/runtime/wire.js for the frame envelope). The payload
 * is `[op:u8][op-specific...]`, one op per smooth wire event:
 *
 *   STATE  [op][t:varint][keyref][stateJson]         arbitrary entity state
 *   XY     [op][t:varint][keyref][x:f32][y:f32]      exactly-{x,y} state
 *   ACK    [op][id:varint][t:varint][sub:u8][state]  per-owner acknowledgement
 *   REMOVE [op][keyref]                              entity departure
 *
 * `keyref` is the shared per-connection short-id dictionary encoding and `t`
 * on STATE/XY is the shared delta-coded server stamp (src/runtime/keydict.js for
 * both disciplines: in-order, reset on reconnect, untouched on JSON
 * fallback). The stamp is what client-side interpolation reconstructs its
 * server time axis from.
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

const ACK_SUB_XY = 0;
const ACK_SUB_JSON = 1;

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
	}
}

/**
 * Encode a smooth wire event into a codec payload.
 *
 * @param {string} event - 'update' | 'ack' | 'remove' (anything else declines)
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
				// Serialize before the stamp is written or any key interned, so
				// a non-serializable state falls back to JSON with the dict and
				// stamp state untouched.
				const json = JSON.stringify(s);
				if (typeof json !== 'string') return null;
				const w = new ByteWriter(32 + json.length);
				w.u8(OP_STATE);
				writeDeltaStamp(w, dict);
				dict.writeKey(w, data.key);
				w.str(json);
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
 * Decode a smooth codec payload back into the `{ event, data }` shape the
 * JSON path would have dispatched. Returns null on an unknown opcode, an
 * unknown schema version, a dictionary desync, or a truncated / malformed
 * frame (the frame is then dropped). Update frames additionally carry their
 * server stamp as `t` on the returned object - the additive field the
 * interpolation ingest reads; ack frames carry `t` inside the data,
 * mirroring the JSON form.
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
				return { event: 'remove', data: { key } };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}
