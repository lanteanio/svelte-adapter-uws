// The repeat-set field delta (steady motion elides the field list) and the
// batched update frame (one tick, one frame, one shared stamp), plus the
// platform fan-out that delivers them: publishWireBatch (per-entry JSON
// envelopes for everyone else, per-entry sender exclusion, poison-on-drop)
// and sendWireBatch (the per-subscriber twin for culled delivery walks).
//
// The codec sections are pure; the platform sections ride the real
// createTestServer harness with a scripted fake connection injected into the
// live connection set, the same shape wire-backpressure-degrade.test.js uses.

import { describe, it, expect, afterEach } from 'vitest';
import {
	encodeSmooth,
	decodeSmooth,
	SmoothEncodeDict,
	SmoothDecodeDict,
	SMOOTH_CAPABILITY,
	SMOOTH_TOPIC_PREFIX
} from '../src/plugins/smooth/codec.js';
import { createSmoothWireCodec } from '../src/plugins/smooth/server.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe, WS_SUBSCRIPTIONS, WS_CAPS } from '../src/runtime/utils.js';

const OP_STATE_DELTA = 5;
const OP_STATE_DELTA_SAME = 6;
const OP_UPDATE_BATCH = 7;

/** A scripted time source: returns the next value on each call. */
function scriptedTime(values) {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

function fixedTime(v) {
	return () => v;
}

describe('repeat-set field delta (OP_STATE_DELTA_SAME)', () => {
	it('steady motion elides the field list: second frame carries the repeat-set op and is smaller', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		const f1 = encodeSmooth('update', { key: 'p', data: { x: 1, y: 2, hp: 10 } }, enc);
		const f2 = encodeSmooth('update', { key: 'p', data: { x: 2, y: 3, hp: 10 } }, enc);
		const f3 = encodeSmooth('update', { key: 'p', data: { x: 3, y: 4, hp: 10 } }, enc);
		// Frame 1 first-sights every field (full delta); frames 2 and 3 change
		// the SAME numeric set {x, y} - the repeat form.
		expect(f1[0]).toBe(OP_STATE_DELTA);
		expect(f2[0]).toBe(OP_STATE_DELTA);
		expect(f3[0]).toBe(OP_STATE_DELTA_SAME);
		expect(f3.length).toBeLessThan(f2.length);
		expect(decodeSmooth(f1, dec).data.data).toEqual({ x: 1, y: 2, hp: 10 });
		expect(decodeSmooth(f2, dec).data.data).toEqual({ x: 2, y: 3, hp: 10 });
		const d3 = decodeSmooth(f3, dec);
		expect(d3.event).toBe('update');
		expect(d3.t).toBe(1032);
		expect(d3.data.data).toEqual({ x: 3, y: 4, hp: 10 });
	});

	it('a changed field SET falls back to the full delta and re-arms the repeat form', () => {
		// hp keeps every state past the exactly-{x,y} OP_XY short-circuit.
		const enc = new SmoothEncodeDict(fixedTime(2000));
		const dec = new SmoothDecodeDict();
		const frames = [
			encodeSmooth('update', { key: 'p', data: { x: 1, y: 1, hp: 5 } }, enc), // first-sight {x,y,hp}
			encodeSmooth('update', { key: 'p', data: { x: 2, y: 2, hp: 5 } }, enc), // set shrinks to {x,y}
			encodeSmooth('update', { key: 'p', data: { x: 3, y: 3, hp: 5 } }, enc), // repeat {x,y}
			encodeSmooth('update', { key: 'p', data: { x: 3, y: 4, hp: 5 } }, enc), // only y: new set
			encodeSmooth('update', { key: 'p', data: { x: 3, y: 5, hp: 5 } }, enc), // repeat {y}
			encodeSmooth('update', { key: 'p', data: { x: 3, y: 5, hp: 5, label: 'hi' } }, enc), // literal appears
			encodeSmooth('update', { key: 'p', data: { x: 4, y: 6, hp: 5, label: 'hi' } }, enc) // numeric again, full
		];
		expect(frames.map((f) => f[0])).toEqual([
			OP_STATE_DELTA, OP_STATE_DELTA, OP_STATE_DELTA_SAME,
			OP_STATE_DELTA, OP_STATE_DELTA_SAME, OP_STATE_DELTA, OP_STATE_DELTA
		]);
		const decoded = frames.map((f) => decodeSmooth(f, dec).data.data);
		expect(decoded[2]).toEqual({ x: 3, y: 3, hp: 5 });
		expect(decoded[4]).toEqual({ x: 3, y: 5, hp: 5 });
		expect(decoded[5]).toEqual({ x: 3, y: 5, hp: 5, label: 'hi' });
		expect(decoded[6]).toEqual({ x: 4, y: 6, hp: 5, label: 'hi' });
	});

	it('REMOVE clears the repeat basis: a re-appearing key first-sights with a full delta', () => {
		const enc = new SmoothEncodeDict(fixedTime(3000));
		const dec = new SmoothDecodeDict();
		decodeSmooth(encodeSmooth('update', { key: 'p', data: { x: 1, y: 1, hp: 5 } }, enc), dec);
		decodeSmooth(encodeSmooth('update', { key: 'p', data: { x: 2, y: 2, hp: 5 } }, enc), dec);
		decodeSmooth(encodeSmooth('remove', { key: 'p' }, enc), dec);
		const back = encodeSmooth('update', { key: 'p', data: { x: 9, y: 9, hp: 5 } }, enc);
		expect(back[0]).toBe(OP_STATE_DELTA);
		expect(decodeSmooth(back, dec).data.data).toEqual({ x: 9, y: 9, hp: 5 });
	});

	it('an interleaved full-state frame freezes the chain and the repeat form resumes correctly', () => {
		// An array state rides OP_STATE (baseline frozen); the object frames
		// around it keep their delta chain intact on both ends.
		const enc = new SmoothEncodeDict(fixedTime(4000));
		const dec = new SmoothDecodeDict();
		decodeSmooth(encodeSmooth('update', { key: 'p', data: { x: 1, y: 1, hp: 5 } }, enc), dec);
		decodeSmooth(encodeSmooth('update', { key: 'p', data: { x: 2, y: 2, hp: 5 } }, enc), dec);
		decodeSmooth(encodeSmooth('update', { key: 'q', data: [1, 2, 3] }, enc), dec);
		const resumed = encodeSmooth('update', { key: 'p', data: { x: 3, y: 3, hp: 5 } }, enc);
		expect(resumed[0]).toBe(OP_STATE_DELTA_SAME);
		expect(decodeSmooth(resumed, dec).data.data).toEqual({ x: 3, y: 3, hp: 5 });
	});

	it('a literal that throws during planning falls back to JSON with every dictionary untouched', () => {
		const enc = new SmoothEncodeDict(fixedTime(5000));
		// A throwing getter is read during classification - BEFORE any key or
		// field name is interned, so the decline leaves both ends' state clean.
		// (The same state also breaks JSON.stringify, so no path carries it.)
		const poisoned = { x: 1, get bad() { throw new Error('boom'); } };
		expect(encodeSmooth('update', { key: 'p', data: poisoned }, enc)).toBe(null);
		expect(enc.byKey.size).toBe(0);
		expect(enc.fields.byKey.size).toBe(0);
		expect(enc.baseline.size).toBe(0);
		expect(enc.lastT).toBe(-1);
		// The next valid frame is a clean first frame a FRESH decoder reads.
		const dec = new SmoothDecodeDict();
		const f = encodeSmooth('update', { key: 'p', data: { x: 1, y: 2 } }, enc);
		expect(decodeSmooth(f, dec).data.data).toEqual({ x: 1, y: 2 });
	});
});

describe('batched update frame (OP_UPDATE_BATCH)', () => {
	it('mixed sub-forms round-trip in one frame sharing one stamp', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016]));
		const dec = new SmoothDecodeDict();
		// Tick 1: first-sight everything (full deltas / xy / state inside one batch).
		const b1 = encodeSmooth('update-batch', { updates: [
			{ key: 'a', data: { x: 1, y: 2, hp: 100 } },
			{ key: 'b', data: { x: 5.5, y: 6.5 } },
			{ key: 'c', data: [7, 8] }
		] }, enc);
		expect(b1[0]).toBe(OP_UPDATE_BATCH);
		const d1 = decodeSmooth(b1, dec);
		expect(d1.event).toBe('update-batch');
		expect(d1.t).toBe(1000);
		expect(d1.data.updates).toEqual([
			{ key: 'a', data: { x: 1, y: 2, hp: 100 } },
			{ key: 'b', data: { x: 5.5, y: 6.5 } },
			{ key: 'c', data: [7, 8] }
		]);
		// Tick 2: 'a' repeats its numeric set (the repeat form INSIDE the batch).
		const b2 = encodeSmooth('update-batch', { updates: [
			{ key: 'a', data: { x: 2, y: 3, hp: 100 } },
			{ key: 'b', data: { x: 6.5, y: 7.5 } }
		] }, enc);
		const d2 = decodeSmooth(b2, dec);
		expect(d2.t).toBe(1016);
		expect(d2.data.updates).toEqual([
			{ key: 'a', data: { x: 2, y: 3, hp: 100 } },
			{ key: 'b', data: { x: 6.5, y: 7.5 } }
		]);
	});

	it('a batch is cheaper than the same updates as single frames (shared stamp + repeat sets)', () => {
		const mkUpdates = (t) => Array.from({ length: 8 }, (_, i) => ({
			key: 'e' + i,
			data: { x: t + i, y: t * 2 + i, vx: 1.25 * t, hp: 100 }
		}));
		// Lane A: singles. Lane B: batches. Same values, both warmed one tick.
		const encA = new SmoothEncodeDict(fixedTime(9000));
		const encB = new SmoothEncodeDict(fixedTime(9000));
		for (const u of mkUpdates(1)) encodeSmooth('update', u, encA);
		encodeSmooth('update-batch', { updates: mkUpdates(1) }, encB);
		let singles = 0;
		for (const u of mkUpdates(2)) singles += encodeSmooth('update', u, encA).length;
		const batched = encodeSmooth('update-batch', { updates: mkUpdates(2) }, encB).length;
		expect(batched).toBeLessThan(singles);
	});

	it('batched decode equals the single-frame decode of the same tick stream (values byte-faithful)', () => {
		const ticks = 24;
		const entities = 6;
		const stateAt = (t, i) => ({
			x: Math.fround(10 * i + t * 0.7),
			y: Math.fround(5 * i - t * 0.3),
			vx: t % 7 === 0 ? -1.5 : 0.25 * i,
			frame: t % 4,
			mode: t % 9 === 0 ? 'dash' : 'run'
		});
		const encS = new SmoothEncodeDict(fixedTime(1_700_000_000_000));
		const decS = new SmoothDecodeDict();
		const encB = new SmoothEncodeDict(fixedTime(1_700_000_000_000));
		const decB = new SmoothDecodeDict();
		for (let t = 1; t <= ticks; t++) {
			const singleOut = new Map();
			for (let i = 0; i < entities; i++) {
				const u = { key: 'e' + i, data: stateAt(t, i) };
				const d = decodeSmooth(encodeSmooth('update', u, encS), decS);
				singleOut.set(d.data.key, d.data.data);
			}
			const updates = Array.from({ length: entities }, (_, i) => ({ key: 'e' + i, data: stateAt(t, i) }));
			const db = decodeSmooth(encodeSmooth('update-batch', { updates }, encB), decB);
			expect(db.event).toBe('update-batch');
			for (const u of db.data.updates) {
				expect(u.data).toEqual(singleOut.get(u.key));
				// And both equal the plain JSON round trip of the source state.
				expect(u.data).toEqual(JSON.parse(JSON.stringify(stateAt(t, Number(u.key.slice(1))))));
			}
		}
	});

	it('rejects a duplicate key, an empty list, and a malformed or throwing entry - with dictionaries untouched', () => {
		const enc = new SmoothEncodeDict(fixedTime(1000));
		const poisoned = { x: 1, get bad() { throw new Error('boom'); } };
		expect(encodeSmooth('update-batch', { updates: [] }, enc)).toBe(null);
		expect(encodeSmooth('update-batch', { updates: [{ key: 'a', data: { x: 1 } }, { key: 'a', data: { x: 2 } }] }, enc)).toBe(null);
		expect(encodeSmooth('update-batch', { updates: [{ key: 'a', data: { x: 1 } }, { data: { x: 2 } }] }, enc)).toBe(null);
		expect(encodeSmooth('update-batch', { updates: [{ key: 'a', data: { x: 1 } }, { key: 'b', data: poisoned }] }, enc)).toBe(null);
		expect(enc.byKey.size).toBe(0);
		expect(enc.fields.byKey.size).toBe(0);
		expect(enc.baseline.size).toBe(0);
		expect(enc.lastT).toBe(-1);
	});

	it('a rejected batch leaves the chain intact: single frames continue against the same basis', () => {
		const enc = new SmoothEncodeDict(fixedTime(1000));
		const dec = new SmoothDecodeDict();
		decodeSmooth(encodeSmooth('update', { key: 'a', data: { x: 1, y: 1 } }, enc), dec);
		expect(encodeSmooth('update-batch', { updates: [{ key: 'a', data: { x: 2, y: 2 } }, { key: 'a', data: { x: 3, y: 3 } }] }, enc)).toBe(null);
		const f = encodeSmooth('update', { key: 'a', data: { x: 2, y: 2 } }, enc);
		expect(decodeSmooth(f, dec).data.data).toEqual({ x: 2, y: 2 });
	});
});

// ---------------------------------------------------------------------------
// Platform fan-out (real server; skipped when uWebSockets.js is unavailable).

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const TOPIC = SMOOTH_TOPIC_PREFIX + 'batchwalk';

let server;
let clients;

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

function batchServer() {
	return createTestServer({
		handler: {
			message(ws, ctx) {
				const msg = ctx.msg;
				if (msg && msg.type === 'sub-smooth' && typeof msg.topic === 'string') {
					trackedSubscribe(ws, msg.topic);
				}
			}
		}
	});
}

async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { json: [], binary: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) frames.binary.push(new Uint8Array(data));
		else { try { frames.json.push(JSON.parse(data.toString())); } catch { /* ignore */ } }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps.length > 0) ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'sub-smooth', topic: TOPIC }));
	await sleep(60);
	clients.push(ws);
	return { ws, frames };
}

function scriptedWs(script) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	ud[WS_CAPS] = new Set([SMOOTH_CAPABILITY]);
	const sent = { text: [], binary: [] };
	return {
		sent,
		envelopes() { return sent.text.filter((t) => t.startsWith('{"topic"')).map((t) => JSON.parse(t)); },
		getUserData() { return ud; },
		send(payload, isBinary) {
			if (isBinary) sent.binary.push(new Uint8Array(payload));
			else sent.text.push(String(payload));
			return script.length > 0 ? script.shift() : 1;
		},
		close() { /* server.close() ends every tracked connection */ }
	};
}

/** Decode every binary frame a connection received through one dictionary. */
function decodeAll(binaryFrames) {
	const dict = new SmoothDecodeDict();
	return binaryFrames.map((f) => {
		const parsed = parseBinaryFrame(f);
		expect(parsed).toBeTruthy();
		return decodeSmooth(parsed.payload, dict, parsed.schemaVersion);
	});
}

describeUWS('publishWireBatch fan-out', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('one binary frame for a capable connection, per-entry JSON envelopes for a JSON connection', async () => {
		server = await batchServer();
		const codec = createSmoothWireCodec();
		const bin = await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]);
		const json = await connectClient(server.wsUrl, []);

		server.platform.publishWireBatch(TOPIC, 'update', [
			{ data: { key: 'a', data: { x: 1, y: 2 } } },
			{ data: { key: 'b', data: { x: 3, y: 4, hp: 9 } } }
		], codec);

		await until(() => bin.frames.binary.length >= 1 && json.frames.json.filter((e) => e.topic === TOPIC).length >= 2);
		const [decoded] = decodeAll(bin.frames.binary);
		expect(decoded.event).toBe('update-batch');
		expect(decoded.data.updates).toEqual([
			{ key: 'a', data: { x: 1, y: 2 } },
			{ key: 'b', data: { x: 3, y: 4, hp: 9 } }
		]);
		const envs = json.frames.json.filter((e) => e.topic === TOPIC);
		expect(envs.map((e) => e.event)).toEqual(['update', 'update']);
		expect(envs[0].data).toEqual({ key: 'a', data: { x: 1, y: 2 } });
		expect(envs[1].data).toEqual({ key: 'b', data: { x: 3, y: 4, hp: 9 } });
		// Per-entry sequencing, exactly like N publishWire calls.
		expect(envs[1].seq).toBe(envs[0].seq + 1);
	});

	it('a JSON fallback mid-stream leaves the binary delta chain intact at a real client', async () => {
		// The delta decoder's chain integrity, observed where it matters: a
		// capable client that receives binary, then a JSON detour (a batch the
		// codec refuses to encode falls back to per-entry envelopes), then
		// binary again - and the frame AFTER the detour must decode through
		// the SAME per-connection dictionary to the right values. A fallback
		// that advanced or corrupted the chain would decode the last frame
		// wrong or not at all.
		server = await batchServer();
		const codec = createSmoothWireCodec();
		const bin = await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]);

		server.platform.publishWire(TOPIC, 'update', { key: 'a', data: { x: 1, y: 2 } }, codec);
		await until(() => bin.frames.binary.length >= 1);

		// An event the smooth codec declines to encode falls back to a JSON
		// envelope for EVERY subscriber, the capable one included - the
		// detour the design position documents.
		server.platform.publishWire(TOPIC, 'note', { text: 'mid-stream' }, codec);
		await until(() => bin.frames.json.some((e) => e.topic === TOPIC && e.event === 'note'));
		expect(bin.frames.binary).toHaveLength(1);

		server.platform.publishWire(TOPIC, 'update', { key: 'a', data: { x: 5, y: 2 } }, codec);
		await until(() => bin.frames.binary.length >= 2);
		const decoded = decodeAll(bin.frames.binary);
		expect(decoded[0].data).toEqual({ key: 'a', data: { x: 1, y: 2 } });
		expect(decoded[1].data).toEqual({ key: 'a', data: { x: 5, y: 2 } });
	});

	it('explicit per-entry seqs arrive verbatim at a real client', async () => {
		// The explicit entry-seq lane observed end to end: the numbers the
		// caller stamps are the numbers a plain JSON subscriber receives, in
		// entry order, with the topic counter untouched.
		server = await batchServer();
		const codec = createSmoothWireCodec();
		const json = await connectClient(server.wsUrl, []);

		server.platform.publishWireBatch(TOPIC, 'update', [
			{ data: { key: 'a', data: { x: 1 } }, seq: 10 },
			{ data: { key: 'b', data: { x: 2 } }, seq: 20 }
		], codec, { seq: false });

		await until(() => json.frames.json.filter((e) => e.topic === TOPIC).length >= 2);
		const envs = json.frames.json.filter((e) => e.topic === TOPIC);
		expect(envs.map((e) => e.seq)).toEqual([10, 20]);
		expect(envs.map((e) => e.data)).toEqual([
			{ key: 'a', data: { x: 1 } },
			{ key: 'b', data: { x: 2 } }
		]);
	});

	it('per-entry excludeWs withholds exactly that entry from exactly that socket, on both delivery forms', async () => {
		server = await batchServer();
		const codec = createSmoothWireCodec();
		const other = await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]);
		// The author is a scripted binary-capable connection.
		const author = scriptedWs([]);
		server.wsConnections.add(author);
		// And a JSON viewer to prove the envelope path filters too.
		const jsonViewer = await connectClient(server.wsUrl, []);

		server.platform.publishWireBatch(TOPIC, 'update', [
			{ data: { key: 'me', data: { x: 1, y: 1 } }, excludeWs: author },
			{ data: { key: 'them', data: { x: 2, y: 2 } } }
		], codec);

		await until(() => other.frames.binary.length >= 1 && jsonViewer.frames.json.filter((e) => e.topic === TOPIC).length >= 2);
		// The full room sees both entries...
		const [full] = decodeAll(other.frames.binary);
		expect(full.data.updates.map((u) => u.key)).toEqual(['me', 'them']);
		// ...the author's batch carries only the entry it did not author.
		expect(author.sent.binary.length).toBe(1);
		const authorDict = new SmoothDecodeDict();
		const parsed = parseBinaryFrame(author.sent.binary[0]);
		const authorDecoded = decodeSmooth(parsed.payload, authorDict, parsed.schemaVersion);
		expect(authorDecoded.event).toBe('update-batch');
		expect(authorDecoded.data.updates.map((u) => u.key)).toEqual(['them']);
	});

	it('a dropped batch frame poisons the capability: the next batch arrives as per-entry JSON envelopes', async () => {
		server = await batchServer();
		const codec = createSmoothWireCodec();
		await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]);
		// announce -> 1 (sent), first batch frame -> 2 (dropped past maxBackpressure)
		const fake = scriptedWs([1, 2]);
		server.wsConnections.add(fake);

		server.platform.publishWireBatch(TOPIC, 'update', [
			{ data: { key: 'a', data: { x: 1, y: 1 } } },
			{ data: { key: 'b', data: { x: 2, y: 2 } } }
		], codec);
		expect(fake.sent.binary.length).toBe(1);
		expect(fake.envelopes().length).toBe(0);

		server.platform.publishWireBatch(TOPIC, 'update', [
			{ data: { key: 'a', data: { x: 3, y: 3 } } },
			{ data: { key: 'b', data: { x: 4, y: 4 } } }
		], codec);
		expect(fake.sent.binary.length).toBe(1);
		const envs = fake.envelopes();
		expect(envs.length).toBe(2);
		expect(envs.map((e) => e.data.key)).toEqual(['a', 'b']);
		expect(envs.map((e) => e.data.data)).toEqual([{ x: 3, y: 3 }, { x: 4, y: 4 }]);
	});
});

describeUWS('sendWireBatch (per-subscriber culled delivery)', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('a capable subscriber receives one binary frame; an incapable one the per-entry envelopes', async () => {
		server = await batchServer();
		const codec = createSmoothWireCodec();
		const capable = scriptedWs([]);
		const plain = scriptedWs([]);
		plain.getUserData()[WS_CAPS] = new Set();
		server.wsConnections.add(capable);
		server.wsConnections.add(plain);

		const entries = [
			{ data: { key: 'a', data: { x: 1, y: 1 } } },
			{ data: { key: 'b', data: { x: 2, y: 2 } } }
		];
		server.platform.sendWireBatch(capable, TOPIC, 'update', entries, codec);
		server.platform.sendWireBatch(plain, TOPIC, 'update', entries, codec);

		expect(capable.sent.binary.length).toBe(1);
		const dict = new SmoothDecodeDict();
		const parsed = parseBinaryFrame(capable.sent.binary[0]);
		const decoded = decodeSmooth(parsed.payload, dict, parsed.schemaVersion);
		expect(decoded.event).toBe('update-batch');
		expect(decoded.data.updates.map((u) => u.key)).toEqual(['a', 'b']);

		expect(plain.sent.binary.length).toBe(0);
		const envs = plain.envelopes();
		expect(envs.length).toBe(2);
		expect(envs.map((e) => e.event)).toEqual(['update', 'update']);
		expect(envs.map((e) => e.data.key)).toEqual(['a', 'b']);
	});

	it('a dropped batch frame poisons: the same subscriber falls to JSON for the next tick', async () => {
		server = await batchServer();
		const codec = createSmoothWireCodec();
		// announce -> 1 (sent), first batch frame -> 2 (dropped)
		const fake = scriptedWs([1, 2]);
		server.wsConnections.add(fake);

		server.platform.sendWireBatch(fake, TOPIC, 'update', [{ data: { key: 'a', data: { x: 1, y: 1 } } }], codec);
		expect(fake.sent.binary.length).toBe(1);

		server.platform.sendWireBatch(fake, TOPIC, 'update', [{ data: { key: 'a', data: { x: 2, y: 2 } } }], codec);
		expect(fake.sent.binary.length).toBe(1);
		const envs = fake.envelopes();
		expect(envs.length).toBe(1);
		expect(envs[0].data).toEqual({ key: 'a', data: { x: 2, y: 2 } });
	});
});
