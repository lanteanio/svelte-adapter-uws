// Integration tests for the 0x03 binary wire mechanism, driven through a real
// uWS server (createTestServer) and a real ws client that reads binary frames.
//
// Covers: platform.publishWire / sendWire capability gating, the
// lazy {type:'wire-id'} announce (once per conn+topic, before the first binary
// frame), seq carried on the binary frame, the no-capable-client JSON fast
// path, and the real cursor codec end-to-end.

import { describe, it, expect, afterEach } from 'vitest';
import { ByteWriter, ByteReader, parseBinaryFrame } from '../files/wire.js';
import {
	decodeCursor,
	CursorDecodeDict,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_SCHEMA_VERSION,
	CURSOR_SCHEMA_VERSION_DICT
} from '../plugins/cursor/codec.js';
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

	// Decode a client's binary cursor frames in arrival order through one
	// decoder dictionary (schemaVersion 2) or statelessly (schemaVersion 1),
	// exactly as the real client's per-connection, shared-by-prefix decoder
	// state would. Returns the decoded { event, data } sequence.
	function decodeCursorStream(client) {
		const dict = new CursorDecodeDict();
		const out = [];
		for (const f of client.frames) {
			if (!f.binary || !f.parsed) continue;
			const decoded = decodeCursor(f.parsed.payload, dict, f.parsed.schemaVersion);
			if (decoded) out.push({ sv: f.parsed.schemaVersion, ...decoded });
		}
		return out;
	}

	it('negotiation matrix: dict client gets schemaVersion 2, old binary client gets 1, no-caps gets JSON - from one publish', async () => {
		const cursors = createCursor({ throttle: 0, topicThrottle: 0 });
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
		const dictClient = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]); // new client
		const v1Client = await connectClient(server.wsUrl, [CURSOR_CAPABILITY]);                          // old binary client
		const jsonClient = await connectClient(server.wsUrl);                                             // no caps
		const mover = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);

		for (const c of [dictClient, v1Client, jsonClient, mover]) c.send({ type: 'join-board' });
		await sleep(80);
		mover.send({ type: 'cursor', topic: 'board', data: { x: 100.5, y: 200.25 } });
		await sleep(80);

		// Dict client: every binary frame is schemaVersion 2; the stream decodes
		// (join then update) to the mover's key against one dictionary.
		const dictStream = decodeCursorStream(dictClient);
		expect(dictClient.frames.some((f) => f.binary)).toBe(true);
		expect(dictClient.frames.filter((f) => f.binary).every((f) => f.parsed.schemaVersion === CURSOR_SCHEMA_VERSION_DICT)).toBe(true);
		const dictUpdate = dictStream.find((e) => e.event === 'update');
		expect(dictUpdate).toBeTruthy();
		expect(dictUpdate.data.data.x).toBeCloseTo(100.5, 2);
		const moverKey = dictUpdate.data.key;
		expect(typeof moverKey).toBe('string');

		// Old binary client: every binary frame is schemaVersion 1 (full-string).
		const v1Stream = decodeCursorStream(v1Client);
		expect(v1Client.frames.some((f) => f.binary)).toBe(true);
		expect(v1Client.frames.filter((f) => f.binary).every((f) => f.parsed.schemaVersion === CURSOR_SCHEMA_VERSION)).toBe(true);
		expect(v1Stream.find((e) => e.event === 'update')?.data.key).toBe(moverKey);

		// No-caps client: JSON only, never a binary frame.
		expect(jsonClient.frames.some((f) => f.binary)).toBe(false);
		const jsonUpdate = await jsonClient.waitFor((f) => !f.binary && f.parsed?.event === 'update' && f.parsed.topic === '__cursor:board');
		expect(jsonUpdate.parsed.data.data).toEqual({ x: 100.5, y: 200.25 });

		dictClient.ws.close(); v1Client.ws.close(); jsonClient.ws.close(); mover.ws.close();
	});

	it('shares one short-id dictionary across cursor topics on a connection (assign on the first, ref on the rest)', async () => {
		const cursors = createCursor({ throttle: 0, topicThrottle: 0 });
		server = await createTestServer({
			handler: {
				async message(ws, ctx) {
					const { msg, platform } = ctx;
					if (msg && msg.type === 'join' && typeof msg.board === 'string') { await platform.subscribe(ws, '__cursor:' + msg.board); return; }
					if (cursors.hooks.message(ws, ctx)) return;
				},
				close: cursors.hooks.close
			}
		});
		const sub = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);
		const mover = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);
		for (const board of ['a', 'b']) { sub.send({ type: 'join', board }); mover.send({ type: 'join', board }); }
		await sleep(80);

		// Same mover (one connection key) moves on both topics. The subscriber's
		// shared-by-prefix dictionary interns the key once (on whichever topic's
		// frame lands first) and references it on the other - so decoding both
		// topics' frames through ONE dictionary resolves every key.
		mover.send({ type: 'cursor', topic: 'a', data: { x: 1.5, y: 2.5 } });
		mover.send({ type: 'cursor', topic: 'b', data: { x: 3.5, y: 4.5 } });
		await sleep(100);

		const stream = decodeCursorStream(sub);
		const updatesA = stream.filter((e) => e.event === 'update' && e.data.data.x === 1.5);
		const updatesB = stream.filter((e) => e.event === 'update' && e.data.data.x === 3.5);
		expect(updatesA.length).toBeGreaterThanOrEqual(1);
		expect(updatesB.length).toBeGreaterThanOrEqual(1);
		// Same physical cursor, same resolved key on both topics, no desync/null.
		expect(updatesA[0].data.key).toBe(updatesB[0].data.key);
		expect(stream.every((e) => typeof (e.data.key ?? e.data[0]?.key ?? '') === 'string')).toBe(true);

		sub.ws.close(); mover.ws.close();
	});

	it('disposes per-connection wire-codec state (onDetach) when the connection closes', async () => {
		let attached = 0;
		let detached = 0;
		const STATEFUL = {
			capability: 'stateful.bin:1',
			schemaVersion: 1,
			encode(event, data) {
				if (event !== 'tick') return null;
				const w = new ByteWriter();
				w.u8(0xcd);
				w.varint(data.n);
				return w.take();
			},
			// A per-connection state object; onDetach must fire exactly once on close
			// (the close handler runs cleanup in a finally, mirroring production, so
			// it also fires if a user close hook throws).
			state: { onAttach: () => { attached++; return { n: 0 }; }, onDetach: () => { detached++; } }
		};
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) { if (msg && msg.type === 'pub') platform.publishWire('room', 'tick', { n: msg.n }, STATEFUL); }
			}
		});
		const a = await connectClient(server.wsUrl, ['stateful.bin:1']);
		a.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await a.waitFor((f) => f.parsed?.type === 'subscribed');
		a.send({ type: 'pub', n: 1 });
		await a.waitFor((f) => f.binary); // first binary publish allocates the per-connection state via onAttach
		expect(attached).toBe(1);
		a.ws.close();
		await sleep(80);
		expect(detached).toBe(1); // freed on close
	});

	it('dictionary:false forces the full-string wire (schemaVersion 1) even for a dictionary-capable client', async () => {
		const cursors = createCursor({ throttle: 0, topicThrottle: 0, dictionary: false });
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
		const dictClient = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);
		const mover = await connectClient(server.wsUrl, [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);
		dictClient.send({ type: 'join-board' }); mover.send({ type: 'join-board' });
		await sleep(80);
		mover.send({ type: 'cursor', topic: 'board', data: { x: 5.5, y: 6.5 } });
		await sleep(80);

		// Even though the client advertised the dictionary capability, the server
		// opted out, so every binary frame is the full-string schemaVersion 1.
		const bins = dictClient.frames.filter((f) => f.binary);
		expect(bins.length).toBeGreaterThan(0);
		expect(bins.every((f) => f.parsed.schemaVersion === CURSOR_SCHEMA_VERSION)).toBe(true);
		const update = decodeCursorStream(dictClient).find((e) => e.event === 'update');
		expect(update.data.data.x).toBeCloseTo(5.5, 2);

		dictClient.ws.close(); mover.ws.close();
	});
});
