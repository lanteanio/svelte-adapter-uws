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

async function waitForClose(ws) {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise((resolve) => ws.on('close', resolve));
}

describeUWS('per-connection stats on close', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('passes id, duration, and traffic counters to the close hook', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				close(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		// One client-to-server message
		client.send(JSON.stringify({ type: 'subscribe', topic: 'chat', ref: 1 }));
		await new Promise(r => setTimeout(r, 30));
		client.close();
		await waitForClose(client);
		await new Promise(r => setTimeout(r, 30));

		expect(captured).toBeDefined();
		expect(typeof captured.id).toBe('string');
		expect(captured.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(captured.duration).toBeGreaterThanOrEqual(0);
		expect(captured.messagesIn).toBe(1);
		expect(captured.bytesIn).toBeGreaterThan(0);
		// Welcome + subscribed-ack are direct sends -> at least 2 outgoing
		expect(captured.messagesOut).toBeGreaterThanOrEqual(2);
		expect(captured.bytesOut).toBeGreaterThan(0);
		expect(captured.subscriptions).toBeInstanceOf(Set);
		expect(captured.subscriptions.has('chat')).toBe(true);
	});

	it('counts platform.send but not platform.publish in messagesOut', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				close(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		// Capture baseline (welcome was already counted on open).
		// Now: 3 platform.send + 5 platform.publish.
		for (let i = 0; i < 3; i++) {
			server.platform.send(ws, 't', 'e', { i });
		}
		for (let i = 0; i < 5; i++) {
			server.platform.publish('t', 'e', { i });
		}
		await new Promise(r => setTimeout(r, 30));
		client.close();
		await waitForClose(client);
		await new Promise(r => setTimeout(r, 30));

		// 1 welcome + 3 sends = 4. publish() is not counted per the
		// documented caveat (uWS C++ fan-out is not instrumented).
		expect(captured.messagesOut).toBe(4);
	});

	it('omits stats fields when no close hook is registered', async () => {
		const { createTestServer } = await import('../testing.js');
		// No handler -> no close hook -> stats not initialised.
		server = await createTestServer();

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		const ws = [...server.wsConnections][0];

		// Stats slot should not have been allocated on open.
		const userData = ws.getUserData();
		const slots = Object.getOwnPropertySymbols(userData)
			.filter(s => s.description === 'adapter-uws.ws.stats');
		expect(slots).toHaveLength(0);

		client.close();
	});

	it('messagesIn reflects multiple client messages', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				close(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		for (let i = 0; i < 4; i++) {
			client.send(JSON.stringify({ type: 'subscribe', topic: 't' + i, ref: i }));
		}
		await new Promise(r => setTimeout(r, 50));
		client.close();
		await waitForClose(client);
		await new Promise(r => setTimeout(r, 30));

		expect(captured.messagesIn).toBe(4);
	});

	it('duration roughly matches connection lifetime', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				close(_ws, ctx) { captured = ctx; }
			}
		});

		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 100));
		client.close();
		await waitForClose(client);
		await new Promise(r => setTimeout(r, 30));

		expect(captured.duration).toBeGreaterThanOrEqual(80);
		expect(captured.duration).toBeLessThan(500);
	});
});
