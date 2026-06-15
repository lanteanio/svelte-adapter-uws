/**
 * Binary wire codec for the presence plugin.
 *
 * Produces / consumes the `codec payload` that rides inside the framework's
 * `0x03` topic frame (see src/runtime/wire.js for the frame envelope). The payload is
 * `[op:u8][op-args...]`, one op per presence wire event:
 *
 *   STATE      [op][count:varint]({key}{dataJson})*
 *   DIFF       [op][joinCount:varint]({key}{dataJson})*[leaveCount:varint]({key}{dataJson})*
 *   HEARTBEAT  [op][count:varint]({key}{dataJson})*
 *
 * where `{key}` is a length-prefixed UTF-8 user key and `{dataJson}` is a
 * length-prefixed UTF-8 string of `JSON.stringify(data)`. STATE and HEARTBEAT
 * are the same `{ [key]: data }` roster map; they use distinct opcodes so the
 * decoder maps each straight to its event name with no secondary flag.
 *
 * Design notes (why the encoding is shaped this way, recorded so the choices
 * are legible):
 *
 *   - A presence value is the `select()`-ed user data: arbitrary JSON, not a
 *     fixed shape (unlike a cursor's `{x, y}`). A length-prefixed JSON string is
 *     the only on-wire form that round-trips it losslessly, so the win over the
 *     JSON envelope is the `0x03` framing plus the short per-connection topic id
 *     (vs the repeated channel-name string in every JSON frame), not the value
 *     bytes themselves.
 *   - The codec is STATELESS: no per-connection short-id key dictionary. Presence
 *     publishes are infrequent (a diff on join/leave, one heartbeat per interval)
 *     but every state / heartbeat fans the WHOLE roster to every subscriber, so
 *     the encode-once-send-many path (one encode per publish, regardless of
 *     subscriber count) is the right trade. A per-connection dictionary would
 *     re-encode per subscriber to collapse keys that are already short
 *     (`"42"`, `"<instanceId>:42"`, a user id) - a CPU-for-bytes loss at
 *     presence's fan-out, the opposite of the cursor channel's economics. A
 *     dictionary could be added later as an additive `presence.protocol:2` if a
 *     bench ever justifies it, exactly as the cursor wire did.
 *   - A diff's `leaves` carry their data too, not keys-only: the decoded
 *     `{ joins, leaves }` is then byte-for-byte the value the JSON path produced,
 *     so the binary and JSON transports stay a true 1:1 with no field that
 *     silently differs by transport. A leave roster is tiny (usually one key), so
 *     this costs almost nothing on the frame that least matters.
 *
 * The encoder returns `null` for any frame it cannot represent (a non-object
 * roster, or a value that will not JSON-serialize), which tells the framework to
 * send JSON for that one frame, so apps with exotic presence data keep working.
 * The decoder returns `null` on an unknown opcode, an unknown schema version, or
 * a truncated / malformed frame; presence is self-healing (the next
 * diff / heartbeat / state reconciles), so a dropped frame is safe.
 *
 * @module svelte-adapter-uws/plugins/presence/codec
 */

import { ByteWriter, ByteReader } from '../../runtime/wire.js';

/** Negotiated capability for the presence binary wire. Bumped only for an incompatible schema. */
export const PRESENCE_CAPABILITY = 'presence.protocol:1';

/** 1-byte in-frame schema version for the presence wire. */
export const PRESENCE_SCHEMA_VERSION = 1;

const OP_STATE = 1;
const OP_DIFF = 2;
const OP_HEARTBEAT = 3;

/**
 * Write a `{ [key]: value }` roster as `[count:varint]({key}{valueJson})*`.
 * Pre-serializes every value before writing any bytes so a value that will not
 * JSON-serialize throws here - which `encodePresence`'s catch turns into a
 * `null` return (JSON fallback) with no half-written frame. A key whose value
 * serializes to `undefined` (an `undefined` / function / symbol value) is
 * omitted, exactly as `JSON.stringify` drops it from the JSON envelope - so the
 * binary roster stays a 1:1 of the value the JSON path would have sent.
 * @param {ByteWriter} w
 * @param {Record<string, any>} map
 */
function writeRoster(w, map) {
	const keys = Object.keys(map);
	/** @type {string[]} */
	const outKeys = [];
	/** @type {string[]} */
	const outJsons = [];
	for (let i = 0; i < keys.length; i++) {
		const json = JSON.stringify(map[keys[i]]);
		if (json === undefined) continue; // matches JSON.stringify dropping the key
		outKeys.push(keys[i]);
		outJsons.push(json);
	}
	w.varint(outKeys.length);
	for (let i = 0; i < outKeys.length; i++) {
		w.str(outKeys[i]);
		w.str(outJsons[i]);
	}
}

/**
 * Read a `[count:varint]({key}{valueJson})*` roster back into a plain object.
 * @param {ByteReader} r
 * @returns {Record<string, any>}
 */
function readRoster(r) {
	const count = r.varint();
	/** @type {Record<string, any>} */
	const obj = {};
	for (let i = 0; i < count; i++) {
		const key = r.str();
		obj[key] = JSON.parse(r.str());
	}
	return obj;
}

/**
 * Encode a presence wire event into a codec payload.
 *
 * @param {string} event - one of 'state' | 'diff' | 'heartbeat'
 * @param {any} data - the same value `platform.publish`/`send` would carry
 * @returns {Uint8Array | null} payload bytes, or null to fall back to JSON
 */
export function encodePresence(event, data) {
	try {
		switch (event) {
			case 'state':
			case 'heartbeat': {
				// A roster is a `{ [key]: data }` object. An array (the legacy
				// keys-only heartbeat shape) is never binary-encoded - it falls
				// back to JSON, which the client's back-compat branch reads.
				if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
				const w = new ByteWriter(64);
				w.u8(event === 'state' ? OP_STATE : OP_HEARTBEAT);
				writeRoster(w, data);
				return w.take();
			}
			case 'diff': {
				if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
				// A field-level `updates` map is carried only by the JSON form (the
				// binary DIFF op is `{joins, leaves}` by schema 1). Fall back to JSON
				// for an update-bearing diff so `updates` is never silently dropped;
				// a binary-capable client merges it from the JSON frame the same way.
				// Pure join/leave diffs (the overwhelming common case) stay binary.
				if (data.updates != null && typeof data.updates === 'object' && Object.keys(data.updates).length > 0) return null;
				const joins = data.joins == null ? {} : data.joins;
				const leaves = data.leaves == null ? {} : data.leaves;
				// A diff whose joins/leaves are present but not plain objects is
				// malformed for the binary form - fall back to JSON (lossless)
				// rather than silently emitting an empty diff.
				if (typeof joins !== 'object' || Array.isArray(joins) || typeof leaves !== 'object' || Array.isArray(leaves)) return null;
				const w = new ByteWriter(64);
				w.u8(OP_DIFF);
				writeRoster(w, joins);
				writeRoster(w, leaves);
				return w.take();
			}
			default:
				return null;
		}
	} catch {
		// A value that will not JSON-serialize (a BigInt, a cyclic object) falls
		// back to JSON for this frame rather than throwing into publish.
		return null;
	}
}

/**
 * Decode a presence codec payload back into the `{ event, data }` shape the JSON
 * path would have dispatched. Returns null on an unknown opcode, an unknown
 * schema version, or a truncated / malformed frame (the frame is then dropped;
 * presence reconciles on the next diff / heartbeat / state).
 *
 * @param {Uint8Array} payload - codec bytes (frame header already stripped)
 * @param {any} [state] - unused; the presence wire is stateless. Accepted for
 *   the codec-contract signature `decode(payload, state, schemaVersion)`.
 * @param {number} [schemaVersion] - the frame's 1-byte schema version.
 * @returns {{ event: string, data: any } | null}
 */
export function decodePresence(payload, state, schemaVersion = PRESENCE_SCHEMA_VERSION) {
	if (schemaVersion !== PRESENCE_SCHEMA_VERSION) {
		return null; // unknown schema: drop rather than mis-decode
	}
	try {
		const r = new ByteReader(payload);
		const op = r.u8();
		switch (op) {
			case OP_STATE:
				return { event: 'state', data: readRoster(r) };
			case OP_HEARTBEAT:
				return { event: 'heartbeat', data: readRoster(r) };
			case OP_DIFF: {
				const joins = readRoster(r);
				const leaves = readRoster(r);
				return { event: 'diff', data: { joins, leaves } };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}
