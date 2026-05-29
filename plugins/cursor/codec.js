/**
 * Binary wire codec for the cursor plugin.
 *
 * Produces / consumes the `codec payload` that rides inside the framework's
 * `0x03` topic frame (see files/wire.js for the frame envelope). The payload
 * is `[op:u8][op-specific...]`, one op per cursor wire event:
 *
 *   UPDATE  [op][key][x:f32][y:f32]
 *   BULK    [op][count:varint]({key}{x:f32}{y:f32})*
 *   REMOVE  [op][key]
 *   JOIN    [op][key][userJson]
 *   CATALOG [op][count:varint]({key}{userJson})*
 *
 * where `key` and `userJson` are length-prefixed UTF-8 strings.
 *
 * Design notes (why the encoding is shaped this way, recorded so the choices
 * are legible):
 *
 *   - The key is a length-prefixed UTF-8 string, NOT 16 raw UUID bytes. Cursor
 *     keys are server-assigned connection ids - `"42"` in-process,
 *     `"<instanceId>:42"` in the Redis-backed variant - never UUIDs, and the
 *     same client decoder serves both backends. A length-prefixed string is
 *     correct for any key shape.
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
 *
 * @module svelte-adapter-uws/plugins/cursor/codec
 */

import { ByteWriter, ByteReader } from '../../files/wire.js';

/** Negotiated capability token. Bumped to `:3` only for an incompatible schema. */
export const CURSOR_CAPABILITY = 'cursor.protocol:2';

/** 1-byte in-frame schema version (the fine gate within the capability). */
export const CURSOR_SCHEMA_VERSION = 1;

const OP_UPDATE = 1;
const OP_BULK = 2;
const OP_REMOVE = 3;
const OP_JOIN = 4;
const OP_CATALOG = 5;

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
 * Encode a cursor wire event into a codec payload.
 *
 * @param {string} event - one of 'update' | 'bulk' | 'remove' | 'join' | 'catalog'
 * @param {any} data - the same value `platform.publish`/`send` would carry
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodeCursor(event, data) {
	try {
		switch (event) {
			case 'update': {
				if (!data || typeof data.key !== 'string' || !isXY(data.data)) return null;
				const w = new ByteWriter(24);
				w.u8(OP_UPDATE);
				w.str(data.key);
				w.f32(data.data.x);
				w.f32(data.data.y);
				return w.take();
			}
			case 'bulk': {
				if (!Array.isArray(data)) return null;
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					if (!e || typeof e.key !== 'string' || !isXY(e.data)) return null;
				}
				const w = new ByteWriter(16 + data.length * 16);
				w.u8(OP_BULK);
				w.varint(data.length);
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					w.str(e.key);
					w.f32(e.data.x);
					w.f32(e.data.y);
				}
				return w.take();
			}
			case 'remove': {
				if (!data || typeof data.key !== 'string') return null;
				const w = new ByteWriter(16);
				w.u8(OP_REMOVE);
				w.str(data.key);
				return w.take();
			}
			case 'join': {
				if (!data || typeof data.key !== 'string') return null;
				const w = new ByteWriter(32);
				w.u8(OP_JOIN);
				w.str(data.key);
				w.str(JSON.stringify(data.user ?? null));
				return w.take();
			}
			case 'catalog': {
				if (!Array.isArray(data)) return null;
				const w = new ByteWriter(16 + data.length * 24);
				w.u8(OP_CATALOG);
				w.varint(data.length);
				for (let i = 0; i < data.length; i++) {
					const e = data[i];
					if (!e || typeof e.key !== 'string') return null;
					w.str(e.key);
					w.str(JSON.stringify(e.user ?? null));
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
 * Decode a cursor codec payload back into the `{ event, data }` shape the
 * JSON path would have dispatched. Returns null on an unknown opcode or a
 * truncated / malformed frame (the frame is then dropped; cursor is
 * best-effort).
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @returns {{ event: string, data: any } | null}
 */
export function decodeCursor(payload) {
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_UPDATE: {
				const key = r.str();
				const x = r.f32();
				const y = r.f32();
				return { event: 'update', data: { key, data: { x, y } } };
			}
			case OP_BULK: {
				const count = r.varint();
				const arr = new Array(count);
				for (let i = 0; i < count; i++) {
					const key = r.str();
					const x = r.f32();
					const y = r.f32();
					arr[i] = { key, data: { x, y } };
				}
				return { event: 'bulk', data: arr };
			}
			case OP_REMOVE: {
				const key = r.str();
				return { event: 'remove', data: { key } };
			}
			case OP_JOIN: {
				const key = r.str();
				const user = JSON.parse(r.str());
				return { event: 'join', data: { key, user } };
			}
			case OP_CATALOG: {
				const count = r.varint();
				const arr = new Array(count);
				for (let i = 0; i < count; i++) {
					const key = r.str();
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
