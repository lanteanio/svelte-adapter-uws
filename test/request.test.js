import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

/**
 * Connect a ws client and let the test drive replies / capture frames.
 */
async function connectAndCapture(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw) => {
		const text = raw.toString();
		const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
		const frame = { text, parsed };
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) {
				waiters[i].resolve(frame);
				waiters.splice(i, 1);
			}
		}
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		waitFor(pred, timeout = 1000) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex(w => w.pred === pred);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error('waitFor timed out'));
				}, timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

describeUWS('platform.request push-with-reply', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('resolves with the client reply data', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		// Wait for the connection to register on the server side
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];
		expect(ws).toBeDefined();

		// Auto-reply on the client side
		client.ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === 'request') {
				client.ws.send(JSON.stringify({ type: 'reply', ref: msg.ref, data: { ok: true, echo: msg.data } }));
			}
		});

		const reply = await server.platform.request(ws, 'ping', { n: 1 }, { timeoutMs: 1000 });
		expect(reply).toEqual({ ok: true, echo: { n: 1 } });

		client.ws.close();
	});

	it('rejects with "request timed out" when the client never replies', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		// Client never replies
		await expect(server.platform.request(ws, 'ping', null, { timeoutMs: 100 })).rejects.toThrow('request timed out');

		client.ws.close();
	});

	it('rejects with "connection closed" when the ws closes mid-request', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		const reqPromise = server.platform.request(ws, 'ping', null, { timeoutMs: 5000 });
		// Close from the client side while the request is in flight
		setTimeout(() => client.ws.close(), 30);
		await expect(reqPromise).rejects.toThrow('connection closed');
	});

	it('rejects with the error message when the client sends an error reply', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		client.ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === 'request') {
				client.ws.send(JSON.stringify({ type: 'reply', ref: msg.ref, error: 'handler exploded' }));
			}
		});

		await expect(server.platform.request(ws, 'risky', null, { timeoutMs: 1000 })).rejects.toThrow('handler exploded');

		client.ws.close();
	});

	it('handles concurrent requests without crossing wires', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		client.ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type !== 'request') return;
			// Reply order intentionally inverted to ensure ref matching, not order, drives resolution
			setTimeout(() => {
				client.ws.send(JSON.stringify({ type: 'reply', ref: msg.ref, data: { for: msg.event } }));
			}, msg.event === 'first' ? 60 : 20);
		});

		const [a, b] = await Promise.all([
			server.platform.request(ws, 'first', null, { timeoutMs: 500 }),
			server.platform.request(ws, 'second', null, { timeoutMs: 500 })
		]);
		expect(a).toEqual({ for: 'first' });
		expect(b).toEqual({ for: 'second' });

		client.ws.close();
	});

	it('does not let a reply on one connection resolve a request on another', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const a = await connectAndCapture(server.wsUrl);
		const b = await connectAndCapture(server.wsUrl);
		await a.waitFor(f => f.parsed?.type === 'welcome');
		await b.waitFor(f => f.parsed?.type === 'welcome');
		await new Promise(r => setTimeout(r, 30));
		const wsA = [...server.wsConnections][0];

		// b replies with a stray ref before a has even been called
		b.ws.send(JSON.stringify({ type: 'reply', ref: 1, data: { from: 'b' } }));
		await new Promise(r => setTimeout(r, 30));

		// a still times out because its pending map is per-connection
		await expect(server.platform.request(wsA, 'ping', null, { timeoutMs: 100 })).rejects.toThrow('request timed out');

		a.ws.close();
		b.ws.close();
	});
});
