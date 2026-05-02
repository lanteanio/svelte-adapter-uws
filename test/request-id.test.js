import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url, headers) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url, headers ? { headers } : undefined);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return ws;
}

async function waitForClose(ws) {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise((resolve) => ws.on('close', resolve));
}

describeUWS('platform.requestId on WebSocket connections', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('exposes a fresh UUID on platform.requestId when no header is sent', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(captured).toBeDefined();
		expect(typeof captured.platform.requestId).toBe('string');
		expect(captured.platform.requestId).toMatch(/^[0-9a-f-]{36}$/);

		client.close();
		await waitForClose(client);
	});

	it('honours an X-Request-ID header on the upgrade request', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl, { 'X-Request-ID': 'trace-abc-123' });
		await new Promise(r => setTimeout(r, 30));

		expect(captured.platform.requestId).toBe('trace-abc-123');

		client.close();
		await waitForClose(client);
	});

	it('falls back to a UUID when X-Request-ID is malformed', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { captured = ctx; }
			}
		});

		// 'has space' contains whitespace -> rejected by resolveRequestId
		const client = await connectClient(server.wsUrl, { 'X-Request-ID': 'has space' });
		await new Promise(r => setTimeout(r, 30));

		expect(captured.platform.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(captured.platform.requestId).not.toBe('has space');

		client.close();
		await waitForClose(client);
	});

	it('threads the same requestId through subscribe / message / close hooks', async () => {
		const { createTestServer } = await import('../testing.js');
		const seen = [];
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { seen.push(['open', ctx.platform.requestId]); },
				subscribe(_ws, _topic, ctx) { seen.push(['subscribe', ctx.platform.requestId]); return null; },
				message(_ws, ctx) { seen.push(['message', ctx.platform.requestId]); },
				close(_ws, ctx) { seen.push(['close', ctx.platform.requestId]); }
			}
		});

		const client = await connectClient(server.wsUrl, { 'X-Request-ID': 'thread-me' });
		await new Promise(r => setTimeout(r, 30));
		client.send(JSON.stringify({ type: 'subscribe', topic: 'chat' }));
		await new Promise(r => setTimeout(r, 30));
		client.send('hello server');
		await new Promise(r => setTimeout(r, 30));
		client.close();
		await waitForClose(client);
		await new Promise(r => setTimeout(r, 30));

		const ids = new Set(seen.map(([, id]) => id));
		expect(ids.size).toBe(1);
		expect([...ids][0]).toBe('thread-me');
		expect(seen.map(([hook]) => hook)).toEqual(
			expect.arrayContaining(['open', 'subscribe', 'message', 'close'])
		);
	});

	it('exposes platform.publish (and other methods) on the per-connection clone', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(typeof captured.platform.publish).toBe('function');
		expect(typeof captured.platform.send).toBe('function');
		expect(typeof captured.platform.topic).toBe('function');
		expect(typeof captured.platform.connections).toBe('number');

		client.close();
		await waitForClose(client);
	});

	it('gives every connection its own requestId', async () => {
		const { createTestServer } = await import('../testing.js');
		const ids = [];
		server = await createTestServer({
			handler: {
				open(_ws, ctx) { ids.push(ctx.platform.requestId); }
			}
		});

		const a = await connectClient(server.wsUrl);
		const b = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);

		a.close();
		b.close();
		await waitForClose(a);
		await waitForClose(b);
	});

	it('passes the requestId into the upgrade hook context', async () => {
		const { createTestServer } = await import('../testing.js');
		let upgradeCtx;
		let openCtx;
		server = await createTestServer({
			handler: {
				upgrade(ctx) { upgradeCtx = ctx; return {}; },
				open(_ws, ctx) { openCtx = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl, { 'X-Request-ID': 'upgrade-trace' });
		await new Promise(r => setTimeout(r, 30));

		expect(upgradeCtx.requestId).toBe('upgrade-trace');
		expect(openCtx.platform.requestId).toBe('upgrade-trace');

		client.close();
		await waitForClose(client);
	});
});
