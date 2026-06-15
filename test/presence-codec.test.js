// Unit tests for the presence binary wire (presence.protocol:1, schemaVersion 1).
// Pure - no server, no sockets. Drives values straight through encode -> decode,
// exactly as one connection's server-side encode and that connection's
// client-side decode would. The codec is stateless, so there is no per-connection
// dictionary to pair (unlike the cursor dictionary wire).

import { describe, it, expect } from 'vitest';
import { ByteWriter, buildBinaryFrame } from '../src/runtime/wire.js';
import {
	encodePresence,
	decodePresence,
	PRESENCE_CAPABILITY,
	PRESENCE_SCHEMA_VERSION
} from '../src/plugins/presence/codec.js';

const SV = PRESENCE_SCHEMA_VERSION;

/** encode then decode, the way one publish + that subscriber's decode would. */
function rt(event, data) {
	const payload = encodePresence(event, data);
	if (payload == null) return { payload: null, out: null };
	return { payload, out: decodePresence(payload, null, SV) };
}

describe('presence binary wire (presence.protocol:1)', () => {
	it('round-trips state / diff / heartbeat to the exact { event, data } the JSON path produces', () => {
		expect(rt('state', { '1': { id: '1', name: 'Alice' }, '2': { id: '2', name: 'Bob' } }).out)
			.toEqual({ event: 'state', data: { '1': { id: '1', name: 'Alice' }, '2': { id: '2', name: 'Bob' } } });

		expect(rt('heartbeat', { '1': { id: '1', name: 'Alice' } }).out)
			.toEqual({ event: 'heartbeat', data: { '1': { id: '1', name: 'Alice' } } });

		expect(rt('diff', { joins: { '3': { id: '3', name: 'Cara' } }, leaves: { '2': { id: '2', name: 'Bob' } } }).out)
			.toEqual({ event: 'diff', data: { joins: { '3': { id: '3', name: 'Cara' } }, leaves: { '2': { id: '2', name: 'Bob' } } } });
	});

	it('falls back to JSON for an update-bearing diff (the field-level `updates` is JSON-only)', () => {
		// The binary DIFF op is `{joins, leaves}` by schema 1, so a diff carrying a
		// field-level `updates` map returns null (JSON fallback) - `updates` is
		// never silently dropped. A binary-capable client merges it from the JSON
		// frame the same way.
		expect(encodePresence('diff', { joins: {}, leaves: {}, updates: { '1': { typing: true } } })).toBeNull();
		// A pure join/leave diff (even with an empty/absent updates) still encodes
		// binary - the common case is unchanged.
		expect(encodePresence('diff', { joins: { '1': { id: '1' } }, leaves: {} })).not.toBeNull();
		expect(encodePresence('diff', { joins: { '1': { id: '1' } }, leaves: {}, updates: {} })).not.toBeNull();
	});

	it('carries leave DATA losslessly (not keys-only): the binary diff is a 1:1 of the JSON diff', () => {
		// The client only reads Object.keys(leaves), but the wire stays byte-for-byte
		// equal to the JSON path so no field silently differs by transport.
		const data = { joins: {}, leaves: { '7': { id: '7', name: 'Gone', role: 'admin' } } };
		const out = rt('diff', data).out;
		expect(out).toEqual({ event: 'diff', data });
		expect(out.data.leaves['7']).toEqual({ id: '7', name: 'Gone', role: 'admin' });
	});

	it('round-trips an empty roster to {} (not null) for every event', () => {
		expect(rt('state', {}).out).toEqual({ event: 'state', data: {} });
		expect(rt('heartbeat', {}).out).toEqual({ event: 'heartbeat', data: {} });
		expect(rt('diff', { joins: {}, leaves: {} }).out)
			.toEqual({ event: 'diff', data: { joins: {}, leaves: {} } });
	});

	it('round-trips arbitrary JSON value shapes losslessly', () => {
		const data = {
			obj: { nested: { deep: true }, arr: [1, 2, 3] },
			str: { v: 'hello' },
			num: { v: 42.5 },
			bool: { v: false },
			nul: { v: null },
			bytesPlaceholder: { avatar: '[bytes: 2048]' }, // what defaultPresenceSelect emits
			unicode: { name: 'Renée 🛰️', emoji: '日本語' }
		};
		expect(rt('state', data).out).toEqual({ event: 'state', data });
	});

	it('handles multi-byte UTF-8 keys', () => {
		const data = { 'usr:Renée': { n: 1 }, '会议室': { n: 2 } };
		expect(rt('heartbeat', data).out).toEqual({ event: 'heartbeat', data });
	});

	it('is deterministic / stateless: the same input encodes to identical bytes every call', () => {
		// This is the encode-once-send-many property: one encode is reused for every
		// subscriber, so encoding must not depend on any per-connection state.
		const data = { a: { id: 'a' }, b: { id: 'b' } };
		const first = encodePresence('state', data);
		const second = encodePresence('state', data);
		expect([...first]).toEqual([...second]);
	});

	it('falls back to JSON (returns null) for a value that will not JSON-serialize', () => {
		const cyclic = {}; cyclic.self = cyclic;
		expect(encodePresence('state', { a: cyclic })).toBeNull();
		expect(encodePresence('heartbeat', { a: { v: 1n } })).toBeNull(); // BigInt
		expect(encodePresence('diff', { joins: { a: { v: 1n } }, leaves: {} })).toBeNull();
	});

	it('falls back to JSON for shapes the binary form does not represent', () => {
		expect(encodePresence('unknownEvent', { a: 1 })).toBeNull();
		expect(encodePresence('state', null)).toBeNull();
		expect(encodePresence('state', 'not-an-object')).toBeNull();
		// An Array roster (the legacy keys-only heartbeat) is never binary-encoded;
		// it falls back to JSON, which the client's back-compat branch reads.
		expect(encodePresence('heartbeat', ['a', 'b'])).toBeNull();
		expect(encodePresence('state', ['a', 'b'])).toBeNull();
	});

	it('omits an undefined roster value, matching JSON.stringify (no phantom key:null)', () => {
		// The JSON envelope drops a key whose value is undefined; the binary roster
		// must drop it too, so the two transports stay a true 1:1.
		const out = rt('state', { a: { id: 'a' }, b: undefined }).out;
		expect(out).toEqual({ event: 'state', data: { a: { id: 'a' } } });
		expect('b' in out.data).toBe(false);
	});

	it('falls back to JSON for a malformed diff (array, or non-object joins/leaves)', () => {
		expect(encodePresence('diff', [1, 2, 3])).toBeNull();
		expect(encodePresence('diff', { joins: [1], leaves: {} })).toBeNull();
		expect(encodePresence('diff', { joins: {}, leaves: 'x' })).toBeNull();
		// A well-formed diff with only one side present still encodes.
		expect(rt('diff', { joins: { a: { id: 'a' } } }).out)
			.toEqual({ event: 'diff', data: { joins: { a: { id: 'a' } }, leaves: {} } });
	});

	it('drops an unknown schemaVersion rather than mis-decoding', () => {
		const good = encodePresence('state', { a: { id: 'a' } });
		expect(decodePresence(good, null, 99)).toBeNull();
		expect(decodePresence(good, null, 0)).toBeNull();
		expect(decodePresence(good, null, 2)).toBeNull();
	});

	it('drops an unknown opcode without throwing', () => {
		// op byte 9 is not state/diff/heartbeat.
		expect(decodePresence(new Uint8Array([9, 0]), null, SV)).toBeNull();
	});

	it('drops a truncated frame without throwing, and the decoder keeps working after', () => {
		const good = encodePresence('state', { aaa: { id: 'aaa', name: 'long-ish' }, bbb: { id: 'bbb' } });
		expect(decodePresence(good.subarray(0, good.length - 3), null, SV)).toBeNull();
		// A fresh, complete frame still decodes.
		expect(decodePresence(encodePresence('state', { z: { id: 'z' } }), null, SV))
			.toEqual({ event: 'state', data: { z: { id: 'z' } } });
	});

	it('drops a frame whose value bytes are not valid JSON', () => {
		// Hand-build a STATE frame (op=1, count=1) with a key and a non-JSON value.
		const w = new ByteWriter(32);
		w.u8(1); // OP_STATE
		w.varint(1);
		w.str('k');
		w.str('not json{');
		expect(decodePresence(w.take(), null, SV)).toBeNull();
	});

	it('exposes the capability token and schema version of record', () => {
		expect(PRESENCE_CAPABILITY).toBe('presence.protocol:1');
		expect(PRESENCE_SCHEMA_VERSION).toBe(1);
	});

	it('stamps schemaVersion 1 in the framework frame header', () => {
		const payload = encodePresence('state', { a: { id: 'a' } });
		const frame = buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 3, 5, payload);
		expect(frame[1]).toBe(PRESENCE_SCHEMA_VERSION);
	});
});
