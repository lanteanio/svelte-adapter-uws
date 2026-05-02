import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectAndCollect(url, sendHello = true) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => {
		const text = data.toString();
		frames.push({ text, parsed: tryParse(text) });
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	if (sendHello) {
		ws.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
		await new Promise(r => setTimeout(r, 20));
	}
	return { ws, frames };
}

function tryParse(text) {
	try { return JSON.parse(text); } catch { return null; }
}

async function waitForClose(ws) {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise((resolve) => ws.on('close', resolve));
}

describeUWS('platform.publishBatched', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('emits one batch frame to a cap-able subscriber on a single topic', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 0 } },
			{ topic: 'feed', event: 'tick', data: { i: 1 } },
			{ topic: 'feed', event: 'tick', data: { i: 2 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		const newFrames = frames.slice(before);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0].parsed.type).toBe('batch');
		expect(newFrames[0].parsed.events).toHaveLength(3);
		expect(newFrames[0].parsed.events.map(e => e.data.i)).toEqual([0, 1, 2]);

		ws.close();
		await waitForClose(ws);
	});

	it('falls back to N individual frames for a non-cap-able client', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		// Connect WITHOUT sending the hello frame -> server treats us as
		// an old client with no caps.
		const { ws, frames } = await connectAndCollect(server.wsUrl, false);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 0 } },
			{ topic: 'feed', event: 'tick', data: { i: 1 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		const newFrames = frames.slice(before);
		expect(newFrames).toHaveLength(2);
		expect(newFrames[0].parsed.topic).toBe('feed');
		expect(newFrames[0].parsed.event).toBe('tick');
		expect(newFrames[0].parsed.data.i).toBe(0);
		expect(newFrames[1].parsed.data.i).toBe(1);

		ws.close();
		await waitForClose(ws);
	});

	it('emits one batch frame per subscriber when all subscribers see all events', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCollect(server.wsUrl);
		const b = await connectAndCollect(server.wsUrl);
		// Both clients subscribe to both batch topics -> all-see-all,
		// so the fast path builds one shared batch frame per subscriber.
		a.ws.send(JSON.stringify({ type: 'subscribe', topic: 'orders' }));
		a.ws.send(JSON.stringify({ type: 'subscribe', topic: 'audit' }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'orders' }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'audit' }));
		await new Promise(r => setTimeout(r, 40));

		const beforeA = a.frames.length;
		const beforeB = b.frames.length;
		server.platform.publishBatched([
			{ topic: 'orders', event: 'created', data: { id: 1 } },
			{ topic: 'orders', event: 'created', data: { id: 2 } },
			{ topic: 'audit', event: 'note', data: { msg: 'created two' } }
		]);
		await new Promise(r => setTimeout(r, 40));

		const aNew = a.frames.slice(beforeA);
		const bNew = b.frames.slice(beforeB);

		expect(aNew).toHaveLength(1);
		expect(aNew[0].parsed.type).toBe('batch');
		expect(aNew[0].parsed.events).toHaveLength(3);
		expect(aNew[0].parsed.events.map(e => e.topic)).toEqual(['orders', 'orders', 'audit']);

		expect(bNew).toHaveLength(1);
		expect(bNew[0].parsed.events).toHaveLength(3);

		a.ws.close();
		b.ws.close();
		await waitForClose(a.ws);
		await waitForClose(b.ws);
	});

	it('falls back to per-event publish when subscriber views differ (slow path)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCollect(server.wsUrl);
		const b = await connectAndCollect(server.wsUrl);
		// a: 'orders' only, b: 'orders' + 'audit' -> mixed views.
		// publishBatched degrades to per-event publish() so the caller
		// pays no perf penalty for the disjoint-subset shape; both
		// clients receive plain envelopes, not a 'batch' frame.
		a.ws.send(JSON.stringify({ type: 'subscribe', topic: 'orders' }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'orders' }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'audit' }));
		await new Promise(r => setTimeout(r, 40));

		const beforeA = a.frames.length;
		const beforeB = b.frames.length;
		server.platform.publishBatched([
			{ topic: 'orders', event: 'created', data: { id: 1 } },
			{ topic: 'orders', event: 'created', data: { id: 2 } },
			{ topic: 'audit', event: 'note', data: { msg: 'created two' } }
		]);
		await new Promise(r => setTimeout(r, 40));

		const aNew = a.frames.slice(beforeA);
		const bNew = b.frames.slice(beforeB);

		// Slow-path fallback: per-event individual frames, no batch wrapper.
		expect(aNew.every(f => f.parsed?.type !== 'batch')).toBe(true);
		expect(aNew).toHaveLength(2);
		expect(aNew.every(f => f.parsed?.topic === 'orders')).toBe(true);

		expect(bNew.every(f => f.parsed?.type !== 'batch')).toBe(true);
		expect(bNew).toHaveLength(3);
		expect(bNew.map(f => f.parsed.topic)).toEqual(['orders', 'orders', 'audit']);

		a.ws.close();
		b.ws.close();
		await waitForClose(a.ws);
		await waitForClose(b.ws);
	});

	it('sends nothing to subscribers with no overlap with the batch topics', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'unrelated' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'orders', event: 'created', data: { id: 1 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		expect(frames.slice(before)).toHaveLength(0);

		ws.close();
		await waitForClose(ws);
	});

	it('stamps per-event seq independently of the batch wrapper', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		// Prior publish to advance the topic seq counter past 1.
		server.platform.publish('feed', 'tick', { i: 0 });
		await new Promise(r => setTimeout(r, 20));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 1 } },
			{ topic: 'feed', event: 'tick', data: { i: 2 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.slice(before).find(f => f.parsed?.type === 'batch');
		expect(batch).toBeDefined();
		expect(batch.parsed.events[0].seq).toBe(2);
		expect(batch.parsed.events[1].seq).toBe(3);

		ws.close();
		await waitForClose(ws);
	});

	it('honours per-event {seq: false} to skip seq stamping', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 0 }, options: { seq: false } },
			{ topic: 'feed', event: 'tick', data: { i: 1 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.slice(before).find(f => f.parsed?.type === 'batch');
		expect(batch).toBeDefined();
		expect(batch.parsed.events[0].seq).toBeUndefined();
		expect(typeof batch.parsed.events[1].seq).toBe('number');

		ws.close();
		await waitForClose(ws);
	});

	it('is a no-op for empty / non-array input', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([]);
		server.platform.publishBatched(null);
		server.platform.publishBatched(undefined);
		await new Promise(r => setTimeout(r, 30));

		expect(frames.slice(before)).toHaveLength(0);

		ws.close();
		await waitForClose(ws);
	});

	it('falls back to publish-loop when any interested subscriber lacks the batch cap', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCollect(server.wsUrl);            // cap-able
		const b = await connectAndCollect(server.wsUrl, false);     // no caps
		a.ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 40));

		const beforeA = a.frames.length;
		const beforeB = b.frames.length;
		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 0 } },
			{ topic: 'feed', event: 'tick', data: { i: 1 } }
		]);
		await new Promise(r => setTimeout(r, 40));

		// Mixed-cap interested subs forces the publish-loop fallback so
		// the C++ TopicTree fanout stays the dispatch path. Both subs
		// receive N individual frames; the cap-able sub does not get a
		// batch frame for this call (use publish() when batching is
		// not safely deliverable to all subs).
		const aNew = a.frames.slice(beforeA);
		const bNew = b.frames.slice(beforeB);
		expect(aNew.every(f => f.parsed?.type !== 'batch')).toBe(true);
		expect(aNew).toHaveLength(2);
		expect(bNew.every(f => f.parsed?.type !== 'batch')).toBe(true);
		expect(bNew).toHaveLength(2);

		a.ws.close();
		b.ws.close();
		await waitForClose(a.ws);
		await waitForClose(b.ws);
	});

	it('honours coalesceKey to drop earlier same-key events (latest wins)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'cursors' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'cursors', event: 'move', data: { x: 0, y: 0 },   coalesceKey: 'cursor:user1' },
			{ topic: 'cursors', event: 'move', data: { x: 5, y: 5 },   coalesceKey: 'cursor:user1' },
			{ topic: 'cursors', event: 'move', data: { x: 10, y: 10 }, coalesceKey: 'cursor:user1' },
			{ topic: 'cursors', event: 'move', data: { x: 7, y: 7 },   coalesceKey: 'cursor:user2' }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.slice(before).find(f => f.parsed?.type === 'batch');
		expect(batch).toBeDefined();
		expect(batch.parsed.events).toHaveLength(2);
		// user1's latest (10,10) survives; user2's only entry (7,7) survives.
		expect(batch.parsed.events[0].data).toEqual({ x: 10, y: 10 });
		expect(batch.parsed.events[1].data).toEqual({ x: 7, y: 7 });

		ws.close();
		await waitForClose(ws);
	});

	it('mixes coalesced and non-coalesced events in one batch', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 't' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 't', event: 'plain',  data: 'a' },
			{ topic: 't', event: 'cursor', data: 1, coalesceKey: 'k' },
			{ topic: 't', event: 'plain',  data: 'b' },
			{ topic: 't', event: 'cursor', data: 2, coalesceKey: 'k' }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.slice(before).find(f => f.parsed?.type === 'batch');
		expect(batch).toBeDefined();
		// Plain events stay in submitted order; cursor entries collapse
		// to the latest (data=2) at the latest occurrence position.
		expect(batch.parsed.events.map(e => [e.event, e.data])).toEqual([
			['plain', 'a'],
			['plain', 'b'],
			['cursor', 2]
		]);

		ws.close();
		await waitForClose(ws);
	});

	it('preserves submitted order across topics within one frame', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'a' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'b' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'c' }));
		await new Promise(r => setTimeout(r, 40));

		const before = frames.length;
		server.platform.publishBatched([
			{ topic: 'b', event: 'x', data: 1 },
			{ topic: 'a', event: 'x', data: 2 },
			{ topic: 'c', event: 'x', data: 3 },
			{ topic: 'a', event: 'y', data: 4 }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.slice(before).find(f => f.parsed?.type === 'batch');
		expect(batch.parsed.events.map(e => [e.topic, e.event, e.data])).toEqual([
			['b', 'x', 1],
			['a', 'x', 2],
			['c', 'x', 3],
			['a', 'y', 4]
		]);

		ws.close();
		await waitForClose(ws);
	});
});

describeUWS('client capability handshake', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('stores caps from a hello frame on the connection', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		// Already-cap-able after connectAndCollect's hello send.
		// Verify via a publishBatched round-trip producing a batch frame.
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: { i: 0 } }
		]);
		await new Promise(r => setTimeout(r, 30));

		const batch = frames.find(f => f.parsed?.type === 'batch');
		expect(batch).toBeDefined();

		ws.close();
		await waitForClose(ws);
	});

	it('ignores non-string entries in the caps array', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);
		const frames = [];
		ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
		await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });

		// Send a hello with mixed valid + invalid entries
		ws.send(JSON.stringify({ type: 'hello', caps: ['batch', 42, null, 'unknown'] }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		server.platform.publishBatched([
			{ topic: 'feed', event: 'tick', data: 1 }
		]);
		await new Promise(r => setTimeout(r, 30));

		// 'batch' was kept (valid) -> should receive a batch frame
		const batch = frames.find(f => f?.type === 'batch');
		expect(batch).toBeDefined();

		ws.close();
		await waitForClose(ws);
	});
});
