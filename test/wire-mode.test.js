// Integration tests for the 0x03 binary wire mechanism, driven through a real
// uWS server (createTestServer) and a real ws client that reads binary frames.
//
// Covers: platform.publishWire / sendWire capability gating, the
// lazy {type:'wire-id'} announce (once per conn+topic, before the first binary
// frame), seq carried on the binary frame, the no-capable-client JSON fast
// path, and the real cursor codec end-to-end.

import { describe, it, expect, afterEach } from 'vitest';
import { ByteWriter, ByteReader, parseBinaryFrame } from '../files/wire.js';
import { decodeCursor, CURSOR_CAPABILITY } from '../plugins/cursor/codec.js';
import { createCursor } from '../plugins/cursor/server.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
// Imported only when uWS is present (testing.js statically imports uWS).
const { createTestServer } = uWS ? await import('../testing.js') : {};

// A tiny test codec exercising the framework mechanism independent of cursor.
const TEST_CAP = 'test.bin:1';
const TEST_CODEC = {
	capability: TEST_CAP,
	schemaVersion: 9,
	encode(event, data) {
		if (event !== 'tick') return null; // unhandled events ride JSON
		const w = new ByteWriter();
		w.u8(0xab);
		w.varint(data.n);
		return w.take();
	}
};
function decodeTest(payload) {
	const r = new ByteReader(payload);
	if (r.u8() !== 0xab) return null;
	return { event: 'tick', data: { n: r.varint() } };
}

let server;

/**
 * Connect a ws client that captures BOTH text and binary frames. Optionally
 * sends a `hello` with the given caps once open.
 */
async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		let frame;
		if (isBinary) {
			const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
			frame = { binary: true, bytes, parsed: parseBinaryFrame(bytes) };
		} else {
			const text = raw.toString();
			let json = null;
			try { json = JSON.parse(text); } catch { /* not json */ }
			frame = { binary: false, text, parsed: json };
		}
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
		}
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	return {
		ws,
		frames,
		send: (obj) => ws.send(JSON.stringify(obj)),
		waitFor(pred, timeout = 1500) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeUWS('binary wire mechanism (0x03 + publishWire)', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('sends binary to a capable subscriber and JSON to a non-capable one, from one publish', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.publishWire('room', 'tick', { n: msg.n }, TEST_CODEC);
				}
			}
		});
		const a = await connectClient(server.wsUrl, ['batch', TEST_CAP]); // binary-capable
		const b = await connectClient(server.wsUrl);                      // old client, no caps

		a.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await a.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed.topic === 'room');
		b.send({ type: 'subscribe', topic: 'room', ref: 2 });
		await b.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed.topic === 'room');

		a.send({ type: 'pub', n: 7 });

		// A: a wire-id announce (text) then a binary 0x03 frame that decodes to n=7.
		const announce = await a.waitFor((f) => f.parsed?.type === 'wire-id' && f.parsed.topic === 'room');
		expect(announce.parsed.id).toBe(1);
		const binFrame = await a.waitFor((f) => f.binary);
		expect(binFrame.parsed).not.toBeNull();
		expect(binFrame.parsed.topicId).toBe(1);
		expect(binFrame.parsed.seq).toBeGreaterThan(0);
		expect(decodeTest(binFrame.parsed.payload)).toEqual({ event: 'tick', data: { n: 7 } });

		// B: the JSON envelope, same seq, no binary, no wire-id.
		const jsonFrame = await b.waitFor((f) => f.parsed?.topic === 'room' && f.parsed.event === 'tick');
		expect(jsonFrame.binary).toBe(false);
		expect(jsonFrame.parsed.data).toEqual({ n: 7 });
		expect(jsonFrame.parsed.seq).toBe(binFrame.parsed.seq);
		expect(b.frames.some((f) => f.binary)).toBe(false);
		expect(b.frames.some((f) => f.parsed?.type === 'wire-id')).toBe(false);

		a.ws.close(); b.ws.close();
	});

	it('announces the wire-id once per (connection, topic), not per frame', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.publishWire('room', 'tick', { n: msg.n }, TEST_CODEC);
				}
			}
		});
		const a = await connectClient(server.wsUrl, [TEST_CAP]);
		a.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await a.waitFor((f) => f.parsed?.type === 'subscribed');

		a.send({ type: 'pub', n: 1 });
		await a.waitFor((f) => f.binary);
		a.send({ type: 'pub', n: 2 });
		await a.waitFor((f) => f.binary && decodeTest(f.parsed.payload).data.n === 2);
		await sleep(50);

		const announces = a.frames.filter((f) => f.parsed?.type === 'wire-id');
		const binaries = a.frames.filter((f) => f.binary);
		expect(announces).toHaveLength(1);          // announced once
		expect(binaries.length).toBeGreaterThanOrEqual(2); // both frames binary
		a.ws.close();
	});

	it('takes the JSON fast path when no connected client advertises the capability', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.publishWire('room', 'tick', { n: msg.n }, TEST_CODEC);
				}
			}
		});
		const b1 = await connectClient(server.wsUrl); // no caps
		const b2 = await connectClient(server.wsUrl); // no caps
		for (const [c, ref] of [[b1, 1], [b2, 2]]) {
			c.send({ type: 'subscribe', topic: 'room', ref });
			await c.waitFor((f) => f.parsed?.type === 'subscribed');
		}
		b1.send({ type: 'pub', n: 99 });

		const f1 = await b1.waitFor((f) => f.parsed?.event === 'tick');
		const f2 = await b2.waitFor((f) => f.parsed?.event === 'tick');
		expect(f1.binary).toBe(false);
		expect(f2.binary).toBe(false);
		expect([...b1.frames, ...b2.frames].some((f) => f.binary || f.parsed?.type === 'wire-id')).toBe(false);
		b1.ws.close(); b2.ws.close();
	});

	it('delivers real cursor frames as binary to a capable client and JSON to an old client', async () => {
		const cursors = createCursor({ throttle: 0, topicThrottle: 0 }); // immediate broadcast
		server = await createTestServer({
			handler: {
				async message(ws, ctx) {
					const { msg, platform } = ctx;
					if (msg && msg.type === 'join-board') { await platform.subscribe(ws, '__cursor:board'); return; }
					if (cursors.hooks.message(ws, ctx)) return;
				},
				close: cursors.hooks.close
			}
		});
		const a = await connectClient(server.wsUrl, [CURSOR_CAPABILITY]); // binary cursor
		const b = await connectClient(server.wsUrl);                      // old client

		a.send({ type: 'join-board' });
		b.send({ type: 'join-board' });
		await sleep(60); // let the server-side subscribes settle

		// A moves; the tracker broadcasts join + update to every board subscriber.
		a.send({ type: 'cursor', topic: 'board', data: { x: 523.5, y: 128.25 } });

		const aUpdate = await a.waitFor((f) => f.binary && decodeCursor(f.parsed.payload)?.event === 'update');
		const decoded = decodeCursor(aUpdate.parsed.payload);
		expect(decoded.data.data.x).toBeCloseTo(523.5, 2);
		expect(decoded.data.data.y).toBeCloseTo(128.25, 2);
		expect(typeof decoded.data.key).toBe('string');

		const bUpdate = await b.waitFor((f) => !f.binary && f.parsed?.event === 'update' && f.parsed.topic === '__cursor:board');
		expect(bUpdate.parsed.data.data).toEqual({ x: 523.5, y: 128.25 });
		expect(b.frames.some((f) => f.binary)).toBe(false);

		a.ws.close(); b.ws.close();
	});
});
