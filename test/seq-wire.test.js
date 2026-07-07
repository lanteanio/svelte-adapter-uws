import { describe, it, expect, afterEach } from 'vitest';
import { buildBinaryFrame, parseBinaryFrame } from '../src/runtime/wire.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectAndCollect(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) { frames.push({ binary: new Uint8Array(data), parsed: null }); return; }
		const text = data.toString();
		let parsed = null;
		try { parsed = JSON.parse(text); } catch { /* non-JSON control frame */ }
		frames.push({ text, parsed });
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	if (caps) {
		ws.send(JSON.stringify({ type: 'hello', caps }));
		await new Promise(r => setTimeout(r, 20));
	}
	return { ws, frames };
}

async function waitForClose(ws) {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise((resolve) => ws.on('close', resolve));
}

function parsedSince(frames, before, event) {
	return frames.slice(before).map(f => f.parsed).filter(Boolean).find(p => p.event === event);
}

// The 0x03 binary frame owns a varint seq field, so an explicit authoritative
// seq (which can exceed 2^31 over a long-lived topic) must survive a round-trip
// unchanged. Pure wire-codec check, independent of a live server - this is what
// lets a numeric seq option flow into the binary frame with no encoder change.
describe('0x03 binary frame carries an explicit seq', () => {
	it('round-trips a small and a > 2^31 seq through the varint field', () => {
		// Valid stamped seqs are positive integers; 0 is the codec's separate
		// "no seq" sentinel and is exercised by the send-path tests, not here.
		for (const seq of [1, 42, 2 ** 31, 9_000_000_000]) {
			const frame = buildBinaryFrame(1, 7, seq, new Uint8Array([9, 8, 7]));
			const parsed = parseBinaryFrame(frame);
			expect(parsed).not.toBe(null);
			expect(parsed.seq).toBe(seq);
			expect(parsed.topicId).toBe(7);
			expect(Array.from(parsed.payload)).toEqual([9, 8, 7]);
		}
	});
});

describeUWS('seq on the broadcast wire (end to end)', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('platform.publish stamps an explicit numeric seq onto the JSON envelope', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'seq-explicit' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publish('seq-explicit', 'tick', { i: 1 }, { seq: 42 });
		await new Promise(r => setTimeout(r, 30));
		expect(parsedSince(frames, before, 'tick').seq).toBe(42);

		ws.close();
		await waitForClose(ws);
	});

	it('omits seq for { seq: false } and auto-increments the counter when absent', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'seq-inc' }));
		await new Promise(r => setTimeout(r, 30));

		let before = frames.length;
		server.platform.publish('seq-inc', 'a', {}, { seq: false });
		await new Promise(r => setTimeout(r, 20));
		const a = parsedSince(frames, before, 'a');
		expect('seq' in a).toBe(false);

		before = frames.length;
		server.platform.publish('seq-inc', 'b', {});
		server.platform.publish('seq-inc', 'c', {});
		await new Promise(r => setTimeout(r, 20));
		// { seq: false } never advanced the counter, so b and c are the first two
		// stamps for this topic.
		expect(parsedSince(frames, before, 'b').seq).toBe(1);
		expect(parsedSince(frames, before, 'c').seq).toBe(2);

		ws.close();
		await waitForClose(ws);
	});

	it('treats a legacy seq:true as the in-memory counter, not numeric 1', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'seq-legacy' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publish('seq-legacy', 'x', {});                 // counter -> 1
		server.platform.publish('seq-legacy', 'y', {}, { seq: true });  // counter -> 2, NOT 1
		await new Promise(r => setTimeout(r, 20));
		expect(parsedSince(frames, before, 'x').seq).toBe(1);
		expect(parsedSince(frames, before, 'y').seq).toBe(2);

		ws.close();
		await waitForClose(ws);
	});

	it('publishBatched stamps an explicit per-message seq', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const { ws, frames } = await connectAndCollect(server.wsUrl, ['batch']);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'seq-batch' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'seq-batch', event: 't0', data: {}, options: { seq: 100 } },
			{ topic: 'seq-batch', event: 't1', data: {}, options: { seq: 101 } }
		]);
		await new Promise(r => setTimeout(r, 30));
		const batch = frames.slice(before).map(f => f.parsed).filter(Boolean).find(p => p.type === 'batch');
		expect(batch.events.map(e => e.seq)).toEqual([100, 101]);

		ws.close();
		await waitForClose(ws);
	});

	it('publishWire threads an explicit seq onto the JSON fallback for a non-cap client', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const { ws, frames } = await connectAndCollect(server.wsUrl); // no binary cap advertised
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'seq-wire' }));
		await new Promise(r => setTimeout(r, 30));

		const codec = { capability: 'seq-test-codec', schemaVersion: 1, encode: () => new Uint8Array([0]) };
		const before = frames.length;
		server.platform.publishWire('seq-wire', 'move', { x: 5 }, codec, { seq: 77 });
		await new Promise(r => setTimeout(r, 30));
		expect(parsedSince(frames, before, 'move').seq).toBe(77);

		ws.close();
		await waitForClose(ws);
	});
});
