/**
 * Stateless binary wire codec for spatial cell-snapshot topics.
 *
 * The smooth wire codec (./codec.js) is per-connection stateful (a short-id key
 * dictionary + delta-coded stamps), so it cannot fan out natively - each capable
 * connection is encoded against its own dictionary. For a high-population spatial
 * topic, area-of-interest is expressed as SUBSCRIPTION to grid-cell topics rather
 * than per-client server-side filtering; each cell's snapshot is then identical to
 * all its subscribers, so it can ride the native cohort fan-out (one encode, C++
 * TopicTree does the sends) instead of a per-connection walk.
 *
 * This codec is that identical-to-all form: STATELESS (no per-connection
 * dictionary), so every subscriber's `0x03` frame is byte-identical and eligible
 * for the `shared: true` cohort path. Keys are written as full length-prefixed
 * strings (not dictionary short-ids) and the server stamp is absolute (not
 * delta-coded), so a frame is self-contained - a new cell subscriber decodes it
 * with no prior state, and a dropped frame cannot desync a decoder.
 *
 * Payload is `[op:u8][op-specific...]`:
 *
 *   STATE  [op][t:varint][key:str][stateJson:str]   arbitrary entity state
 *   XY     [op][t:varint][key:str][x:f32][y:f32]     exactly-{x,y} state
 *   REMOVE [op][key:str]                             entity departure
 *
 * There is no ACK op: an acknowledgement is a per-owner single-target frame and
 * stays on the stateful self channel (./codec.js); a cell broadcast carries only
 * the interpolated remote states everyone in the cell shares. `t` is the server
 * tick stamp the caller supplies in the frame data (the codec holds no clock), the
 * same value client-side interpolation reconstructs its time axis from.
 *
 * Pure: no clocks, no timers, no runtime state - bundles for the browser unchanged
 * and decodes with no per-connection dictionary.
 *
 * @module svelte-adapter-uws/plugins/smooth/cell-codec
 */

import { ByteWriter, ByteReader } from '../../runtime/wire.js';

/**
 * Negotiated capability for the stateless cell-snapshot wire. A client advertises
 * it when the smooth client module is loaded (the same load that advertises the
 * smooth wire); the server fans a cell topic out in binary only to connections
 * carrying it, and JSON to everyone else.
 */
export const CELL_CAPABILITY = 'cellsnap.protocol:1';

/**
 * Wire topic prefix for cell-snapshot topics. Distinct from `__smooth:` because
 * client codec registration is prefix-keyed: cell frames must decode with THIS
 * stateless codec, not the stateful smooth codec, so they cannot share the smooth
 * prefix. A cell topic is `__smoothcell:<name>#<cx>,<cy>`.
 */
export const CELL_TOPIC_PREFIX = '__smoothcell:';

/** 1-byte in-frame schema version for the cell-snapshot wire. */
export const CELL_SCHEMA_VERSION = 1;

const OP_STATE = 1;
const OP_XY = 2;
const OP_REMOVE = 3;

/**
 * True when `d` is exactly a `{ x, y }` pair of finite numbers that survive the
 * float32 wire format - the only shape the compact coordinate encoding is
 * lossless-enough for. Mirrors ./codec.js isXY so the two wires agree on which
 * states take the compact path.
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
 * Encode a cell-snapshot wire event into a codec payload. Stateless: no
 * per-connection dictionary, so the returned bytes are identical for every
 * subscriber of the cell (the requirement for native cohort fan-out).
 *
 * @param {string} event - 'update' | 'remove' (anything else declines to JSON)
 * @param {{ key: string, data?: any, t?: number }} data - `t` is the absolute
 *   server tick stamp (required on 'update'; the codec holds no clock).
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodeCell(event, data) {
	try {
		switch (event) {
			case 'update': {
				if (!data || typeof data.key !== 'string') return null;
				// The stamp must be a finite non-negative integer; a missing / bad
				// stamp declines to JSON (where interpolation simply reads the field
				// absent) rather than seeding a bogus time axis.
				if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0) return null;
				const t = Math.floor(data.t);
				const s = data.data;
				if (isXY(s)) {
					const w = new ByteWriter(24 + data.key.length);
					w.u8(OP_XY);
					w.varint(t);
					w.str(data.key);
					w.f32(s.x);
					w.f32(s.y);
					return w.take();
				}
				if (s === undefined) return null;
				const json = JSON.stringify(s);
				if (typeof json !== 'string') return null;
				const w = new ByteWriter(24 + data.key.length + json.length);
				w.u8(OP_STATE);
				w.varint(t);
				w.str(data.key);
				w.str(json);
				return w.take();
			}
			case 'remove': {
				if (!data || typeof data.key !== 'string') return null;
				const w = new ByteWriter(8 + data.key.length);
				w.u8(OP_REMOVE);
				w.str(data.key);
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
 * Decode a cell-snapshot codec payload back into the `{ event, data }` shape the
 * JSON path would have dispatched - identical to the smooth codec's output shape
 * so the client channel ingests cell frames through the same path. Update frames
 * carry their absolute server stamp as `t`. Returns null on an unknown opcode /
 * schema version or a truncated frame (the frame is then dropped).
 *
 * Stateless: no per-connection decode dictionary.
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {number} [schemaVersion] - the frame's 1-byte schema version
 * @returns {{ event: string, data: any, t?: number } | null}
 */
export function decodeCell(payload, schemaVersion = CELL_SCHEMA_VERSION) {
	if (schemaVersion !== CELL_SCHEMA_VERSION) return null;
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_STATE: {
				const t = r.varint();
				const key = r.str();
				const data = JSON.parse(r.str());
				return { event: 'update', data: { key, data }, t };
			}
			case OP_XY: {
				const t = r.varint();
				const key = r.str();
				const x = r.f32();
				const y = r.f32();
				return { event: 'update', data: { key, data: { x, y } }, t };
			}
			case OP_REMOVE: {
				const key = r.str();
				return { event: 'remove', data: { key } };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/**
 * Build the stateless cell-snapshot wire codec. No per-connection state and no
 * clock (the caller stamps each frame's `t`), so a single definition serves the
 * server (publishWire) and any consumer. `shared: true` marks it eligible for the
 * native cohort fan-out: because every subscriber's frame is byte-identical, one
 * `app.publish` to the binary cohort replaces the per-connection walk.
 *
 * @param {{ binary?: boolean }} [options] `binary: false` -> null (JSON for
 *   everyone), matching the smooth codec factory's escape hatch.
 * @returns {{ capability: string, schemaVersion: number, encode: typeof encodeCell, shared: true } | null}
 */
export function createCellWireCodec(options = {}) {
	if (options.binary === false) return null;
	return {
		capability: CELL_CAPABILITY,
		schemaVersion: CELL_SCHEMA_VERSION,
		encode: encodeCell,
		shared: true
	};
}
