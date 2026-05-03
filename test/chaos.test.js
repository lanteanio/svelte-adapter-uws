import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectAndCollect(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => {
		const text = data.toString();
		frames.push({ at: Date.now(), text, parsed: tryParse(text) });
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, frames };
}

function tryParse(text) {
	try { return JSON.parse(text); } catch { return null; }
}

async function waitForClose(ws) {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise((resolve) => ws.on('close', resolve));
}

describeUWS('chaos / fault-injection harness on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('drop-outbound with rate 1 silences platform.publish for subscribers', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		// Wait for welcome
		await new Promise(r => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const before = frames.length;
		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 1 });
		for (let i = 0; i < 5; i++) {
			server.platform.publish('feed', 'tick', { i });
		}
		await new Promise(r => setTimeout(r, 60));
		expect(frames.length).toBe(before);

		ws.close();
		await waitForClose(ws);
	});

	it('drop-outbound with rate 0 leaves all publishes intact', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		// Activate then immediately set to a never-drop config; verifies
		// the JS-side fanout path still delivers when dropRate is 0.
		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 0 });
		for (let i = 0; i < 5; i++) {
			server.platform.publish('feed', 'tick', { i });
		}
		await new Promise(r => setTimeout(r, 60));
		const ticks = frames.filter(f => f.parsed?.event === 'tick');
		expect(ticks).toHaveLength(5);

		ws.close();
		await waitForClose(ws);
	});

	it('drop-outbound: dropRate gates platform.send', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		// One server-side ws ref - the only connection
		const serverWs = [...server.wsConnections][0];
		expect(serverWs).toBeDefined();

		const before = frames.length;
		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 1 });
		server.platform.send(serverWs, 'dm', 'hello', { msg: 'no' });
		await new Promise(r => setTimeout(r, 30));
		expect(frames.length).toBe(before);

		// Reset and try again - must arrive
		server.platform.__chaos(null);
		server.platform.send(serverWs, 'dm', 'hello', { msg: 'yes' });
		await new Promise(r => setTimeout(r, 30));
		const matching = frames.filter(f => f.parsed?.event === 'hello' && f.parsed?.data?.msg === 'yes');
		expect(matching).toHaveLength(1);

		ws.close();
		await waitForClose(ws);
	});

	it('slow-drain delays delivery by the configured ms', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		const baseline = frames.length;
		server.platform.__chaos({ scenario: 'slow-drain', delayMs: 80 });
		const sentAt = Date.now();
		server.platform.publish('feed', 'tick', { i: 0 });

		// Immediately after, the frame has not arrived yet.
		await new Promise(r => setTimeout(r, 20));
		expect(frames.length).toBe(baseline);

		// After the configured delay, it should have arrived.
		await new Promise(r => setTimeout(r, 100));
		const tick = frames.find(f => f.parsed?.event === 'tick');
		expect(tick).toBeDefined();
		expect(tick.at - sentAt).toBeGreaterThanOrEqual(70);

		ws.close();
		await waitForClose(ws);
	});

	it('reset() restores the fast-path fanout (delivery resumes immediately)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 1 });
		server.platform.publish('feed', 'tick', { i: 0 });
		await new Promise(r => setTimeout(r, 30));
		const droppedCount = frames.filter(f => f.parsed?.event === 'tick').length;

		server.platform.__chaos(null);
		server.platform.publish('feed', 'tick', { i: 1 });
		await new Promise(r => setTimeout(r, 30));
		const ticks = frames.filter(f => f.parsed?.event === 'tick');
		expect(ticks).toHaveLength(droppedCount + 1);
		expect(ticks[ticks.length - 1].parsed.data).toEqual({ i: 1 });

		ws.close();
		await waitForClose(ws);
	});

	it('rejects unknown scenarios', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		expect(() => server.platform.__chaos({ scenario: 'mystery' })).toThrow();
	});

	it('drop-outbound also affects subscribe acks', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 1 });
		const before = frames.length;
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed', ref: 7 }));
		await new Promise(r => setTimeout(r, 50));
		// The subscribe-ack frame travels through sendOutboundT and is
		// dropped under chaos; the client never sees a 'subscribed'.
		const ack = frames.slice(before).find(f => f.parsed?.type === 'subscribed');
		expect(ack).toBeUndefined();

		ws.close();
		await waitForClose(ws);
	});

	it('ipc-reorder validates maxJitterMs', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		expect(() => server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: -1 }))
			.toThrow('non-negative finite number');
		expect(() => server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: NaN }))
			.toThrow('non-negative finite number');
		expect(() => server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: Infinity }))
			.toThrow('non-negative finite number');
		expect(() => server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: 60_001 }))
			.toThrow('<= 60000');
	});

	it('ipc-reorder reorders publishes within the jitter window', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { ws, frames } = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed' }));
		await new Promise(r => setTimeout(r, 30));

		server.platform.__chaos({ scenario: 'ipc-reorder', maxJitterMs: 50 });
		// Publish 30 frames; with 0-50ms random per-frame delay the
		// arrival order is overwhelmingly likely to differ from the
		// publish order. Using N=30 makes a false-negative
		// vanishingly improbable (probability of perfect order is
		// ~1/30! which is far below test-flakiness territory).
		for (let i = 0; i < 30; i++) {
			server.platform.publish('feed', 'tick', { i });
		}
		// Wait well past max jitter for all frames to drain.
		await new Promise(r => setTimeout(r, 200));

		const ticks = frames.filter(f => f.parsed?.event === 'tick');
		expect(ticks).toHaveLength(30);
		const arrivalOrder = ticks.map(t => t.parsed.data.i);
		const sortedOrder = [...arrivalOrder].sort((a, b) => a - b);
		// The arrival order MUST differ from the publish order; sorting
		// the arrival ids gives the original sequence, so a strict equal
		// would mean we kept order (contradiction).
		expect(arrivalOrder).not.toEqual(sortedOrder);

		ws.close();
		await waitForClose(ws);
	});

	it('worker-flap closes all live connections with default code 1012', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCollect(server.wsUrl);
		const b = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		expect(server.platform.connections).toBe(2);

		const closes = Promise.all([
			new Promise((res) => a.ws.on('close', (code, reason) => res({ code, reason: reason.toString() }))),
			new Promise((res) => b.ws.on('close', (code, reason) => res({ code, reason: reason.toString() })))
		]);

		server.platform.__chaos({ scenario: 'worker-flap' });
		const [closeA, closeB] = await closes;
		expect(closeA.code).toBe(1012);
		expect(closeA.reason).toBe('worker restart');
		expect(closeB.code).toBe(1012);

		// Server stays up - new connections still accepted.
		const c = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		expect(server.platform.connections).toBe(1);
		c.ws.close();
		await waitForClose(c.ws);
	});

	it('worker-flap accepts custom code and reason', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCollect(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		const close = new Promise((res) => a.ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
		server.platform.__chaos({ scenario: 'worker-flap', code: 4001, reason: 'maintenance' });
		const closed = await close;
		expect(closed.code).toBe(4001);
		expect(closed.reason).toBe('maintenance');
	});

	it('worker-flap leaves continuous chaos state intact', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		// Set drop-outbound, then trigger a flap. After the flap the
		// continuous scenario must still be active for new connections.
		server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 1 });
		server.platform.__chaos({ scenario: 'worker-flap' });

		// New connection arrives. Subscribe acks are dropped because
		// drop-outbound is still active.
		const { ws, frames } = await connectAndCollect(server.wsUrl);
		const before = frames.length;
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'feed', ref: 1 }));
		await new Promise(r => setTimeout(r, 50));
		const ack = frames.slice(before).find(f => f.parsed?.type === 'subscribed');
		expect(ack).toBeUndefined();

		// Reset for cleanup
		server.platform.__chaos(null);
		ws.close();
		await waitForClose(ws);
	});

	it('worker-flap with no live connections is a no-op', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		expect(server.platform.connections).toBe(0);
		expect(() => server.platform.__chaos({ scenario: 'worker-flap' })).not.toThrow();
		expect(server.platform.connections).toBe(0);
	});
});
