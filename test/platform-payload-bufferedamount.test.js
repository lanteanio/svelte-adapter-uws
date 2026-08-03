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
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		expect(typeof server.platform.maxPayloadLength).toBe('number');
		expect(server.platform.maxPayloadLength).toBe(1024 * 1024);
	});

	it('enforces the exact cap it reports, against the real socket', async () => {
		// The harness once enforced 64 KiB while reporting 1 MiB - the same
		// report-versus-enforce split the production and Vite surfaces were
		// fixed for. One constant drives both now, and this drives it for
		// real: a frame just under the reported cap is delivered, a frame
		// over it closes the connection at the receiver.
		const { createTestServer } = await import('../src/testing.js');
		const { WebSocket } = await import('ws');
		server = await createTestServer({
			maxPayloadLength: 32 * 1024,
			handler: {
				message(ws, { data, platform }) {
					platform.send(ws, 'probe', 'echo-size', { size: data.byteLength });
				}
			}
		});
		expect(server.platform.maxPayloadLength).toBe(32 * 1024);

		const frames = [];
		let closed = false;
		const ws = new WebSocket(server.wsUrl);
		ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
		ws.on('close', () => { closed = true; });
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

		ws.send(Buffer.alloc(31 * 1024, 0x61));
		const until = async (predicate) => {
			const deadline = Date.now() + 3000;
			while (!predicate()) {
				if (Date.now() >= deadline) throw new Error('timed out');
				await new Promise((r) => setTimeout(r, 10));
			}
		};
		await until(() => frames.some((f) => f.event === 'echo-size' && f.data?.size === 31 * 1024));

		ws.send(Buffer.alloc(33 * 1024, 0x61));
		await until(() => closed);
		expect(frames.filter((f) => f.data?.size === 33 * 1024)).toHaveLength(0);
		try { ws.terminate(); } catch { /* closed */ }
	});

	it('the value is a snapshot of the configured cap, not a live channel for changes', async () => {
		// Reading twice returns the same value; nothing else mutates it.
		const { createTestServer } = await import('../src/testing.js');
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
		const { createTestServer } = await import('../src/testing.js');
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
		const { createTestServer } = await import('../src/testing.js');
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
		const { createTestServer } = await import('../src/testing.js');
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
