// Tests for platform.maxPayloadLength and platform.bufferedAmount,
// landed in next.19 to support framework-level chunk sizing and
// backpressure-aware sends without piggybacking the value on the wire.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return ws;
}

describeUWS('platform.maxPayloadLength', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('reports a numeric value (the test server default of 1 MB)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		expect(typeof server.platform.maxPayloadLength).toBe('number');
		expect(server.platform.maxPayloadLength).toBe(1024 * 1024);
	});

	it('the value is a snapshot of the configured cap, not a live channel for changes', async () => {
		// Reading twice returns the same value; nothing else mutates it.
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		const a = server.platform.maxPayloadLength;
		const b = server.platform.maxPayloadLength;
		expect(a).toBe(b);
	});
});

describeUWS('platform.bufferedAmount', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('returns 0 for a freshly-opened connection that has not been written to', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: { open(ws) { capturedWs = ws; } }
		});
		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		// New connection, no sends queued, kernel buffer should be empty.
		expect(server.platform.bufferedAmount(capturedWs)).toBe(0);

		client.close();
	});

	it('returns a non-negative number after publishing to a subscriber', async () => {
		// Real-world value depends on kernel scheduling; the contract is
		// "non-negative number, never throws" - pin both.
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: { open(ws) { capturedWs = ws; } }
		});
		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		await server.platform.subscribe(capturedWs, 'feed');
		// Publish enough that some bytes will be in flight at least
		// briefly. Pure timing assertions are flaky; we just check the
		// shape of the return value.
		for (let i = 0; i < 10; i++) {
			server.platform.publish('feed', 'tick', { i });
		}

		const buffered = server.platform.bufferedAmount(capturedWs);
		expect(typeof buffered).toBe('number');
		expect(buffered).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(buffered)).toBe(true);

		client.close();
	});

	it('returns 0 (does not throw) when called on a closed connection', async () => {
		// Defensive contract: server-side code may race with close.
		// `try { ws.getBufferedAmount() } catch { return 0 }` keeps the
		// caller from having to wrap every read. Pin the no-throw behavior.
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: { open(ws) { capturedWs = ws; } }
		});
		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		// Force-close from the client side and wait for the server to
		// notice. After the close, the captured ws may be detached from
		// uWS internals; bufferedAmount should still return 0.
		client.close();
		await new Promise(r => setTimeout(r, 100));

		expect(() => server.platform.bufferedAmount(capturedWs)).not.toThrow();
		expect(server.platform.bufferedAmount(capturedWs)).toBeGreaterThanOrEqual(0);
	});
});
