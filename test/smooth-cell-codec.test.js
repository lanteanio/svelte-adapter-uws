// Stateless cell-snapshot wire codec: encode/decode round-trips and native cohort
// fan-out. Unlike the smooth codec (per-connection dictionary), this one is
// stateless - full key strings + absolute stamps - so every subscriber's frame is
// byte-identical and rides the shared cohort path. The round-trip tests need no
// server; the fan-out test uses real ws clients (a scripted fake is not a native
// subscriber and would never receive an app.publish).

import { describe, it, expect, afterEach } from 'vitest';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import {
	encodeCell,
	decodeCell,
	createCellWireCodec,
	CELL_CAPABILITY,
	CELL_SCHEMA_VERSION
} from '../src/plugins/smooth/cell-codec.js';

describe('cell-snapshot codec encode/decode', () => {
	it('round-trips an exactly-{x,y} update through the compact XY op', () => {
		const payload = encodeCell('update', { key: 'e1', data: { x: 1.5, y: -2.5 }, t: 1234 });
		expect(payload).toBeInstanceOf(Uint8Array);
		expect(decodeCell(payload)).toEqual({ event: 'update', data: { key: 'e1', data: { x: 1.5, y: -2.5 } }, t: 1234 });
	});

	it('round-trips an arbitrary-state update through the JSON op', () => {
		const payload = encodeCell('update', { key: 'player:42', data: { hp: 10, name: 'a', pos: { x: 3, y: 4 } }, t: 7 });
		expect(decodeCell(payload)).toEqual({
			event: 'update',
			data: { key: 'player:42', data: { hp: 10, name: 'a', pos: { x: 3, y: 4 } } },
			t: 7
		});
	});

	it('round-trips a remove (no stamp)', () => {
		const payload = encodeCell('remove', { key: 'e3' });
		expect(decodeCell(payload)).toEqual({ event: 'remove', data: { key: 'e3' } });
	});

	it('is stateless: the same frame encodes to byte-identical output every time', () => {
		const a = encodeCell('update', { key: 'e1', data: { x: 1.5, y: -2.5 }, t: 1234 });
		const b = encodeCell('update', { key: 'e1', data: { x: 1.5, y: -2.5 }, t: 1234 });
		expect(Array.from(a)).toEqual(Array.from(b));
	});

	it('declines (null -> JSON) on a missing key, a missing/invalid stamp, or a non-update/remove event', () => {
		expect(encodeCell('update', { data: { x: 1, y: 2 }, t: 1 })).toBeNull(); // no key
		expect(encodeCell('update', { key: 'e', data: { x: 1, y: 2 } })).toBeNull(); // no stamp
		expect(encodeCell('update', { key: 'e', data: { x: 1, y: 2 }, t: -1 })).toBeNull(); // bad stamp
		expect(encodeCell('update', { key: 'e', data: undefined, t: 1 })).toBeNull(); // no state
		expect(encodeCell('ack', { id: 1, state: { x: 1, y: 2 }, t: 1 })).toBeNull(); // ack stays on the self channel
		expect(encodeCell('event', { key: 'e', data: {} })).toBeNull();
	});

	it('floors a fractional stamp (matches the smooth codec discipline)', () => {
		const payload = encodeCell('update', { key: 'e', data: { x: 0, y: 0 }, t: 42.9 });
		expect(decodeCell(payload).t).toBe(42);
	});

	it('decodeCell returns null on an unknown schema version', () => {
		const payload = encodeCell('update', { key: 'e', data: { x: 1, y: 2 }, t: 1 });
		expect(decodeCell(payload, CELL_SCHEMA_VERSION + 1)).toBeNull();
	});

	it('createCellWireCodec is a shared, stateless codec with the cell capability', () => {
		const codec = createCellWireCodec();
		expect(codec.capability).toBe(CELL_CAPABILITY);
		expect(codec.schemaVersion).toBe(CELL_SCHEMA_VERSION);
		expect(codec.shared).toBe(true);
		expect(codec.state).toBeUndefined(); // stateless: no per-connection dictionary
		expect(typeof codec.encode).toBe('function');
	});

	it('createCellWireCodec({ binary: false }) returns null (JSON for everyone)', () => {
		expect(createCellWireCodec({ binary: false })).toBeNull();
	});
});

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeout = 3000, step = 20) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const v = pred();
		if (v) return v;
		if (Date.now() > deadline) throw new Error('until() timed out');
		await sleep(step);
	}
}

let server;
let clients;

// A plain (non-`__`) topic so the client can subscribe over the wire without the
// system-topic gate. The codec's cohort behavior is prefix-agnostic; the real
// `__smoothcell:` subscription is server-driven and covered in the server tests.
const CELL_TOPIC = 'arena:cell:3,4';

async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { json: [], binary: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
		try {
			const obj = JSON.parse(data.toString());
			if (obj && obj.topic !== undefined && obj.event !== undefined) frames.json.push(obj);
		} catch { /* ignore */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'subscribe', topic: CELL_TOPIC }));
	await sleep(60);
	clients.push(ws);
	return { ws, frames };
}

describeUWS('cell codec native cohort fan-out', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('fans a cell snapshot out as one 0x03 frame to the binary cohort and the envelope to the JSON cohort', async () => {
		server = await createTestServer({});
		const bin = await connectClient(server.wsUrl, [CELL_CAPABILITY]);
		const json = await connectClient(server.wsUrl, []); // no capability -> JSON cohort

		server.platform.publishWire(CELL_TOPIC, 'update', { key: 'ship:7', data: { x: 12.5, y: -3.25 }, t: 99 }, createCellWireCodec());

		// Binary client: the 0x03 frame, decodeCell-able back to the cell update.
		await until(() => bin.frames.binary.length >= 1);
		const frame = parseBinaryFrame(bin.frames.binary[0]);
		expect(frame.schemaVersion).toBe(CELL_SCHEMA_VERSION);
		expect(decodeCell(frame.payload, frame.schemaVersion)).toEqual({
			event: 'update',
			data: { key: 'ship:7', data: { x: 12.5, y: -3.25 } },
			t: 99
		});

		// JSON-only client: the envelope, never a binary frame, same seq.
		await until(() => json.frames.json.length >= 1);
		expect(json.frames.binary.length).toBe(0);
		const env = json.frames.json[0];
		expect(env.topic).toBe(CELL_TOPIC);
		expect(env.event).toBe('update');
		expect(env.data).toEqual({ key: 'ship:7', data: { x: 12.5, y: -3.25 }, t: 99 });
		expect(frame.seq).toBe(env.seq);
	});
});
