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
 * Connect a ws client and wait for it to be fully open.
 * Returns the connected WebSocket instance.
 */
async function connectClient(url, options) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url, options);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return ws;
}

describeUWS('createTestServer', () => {
	afterEach(() => {
		server?.close();
		server = null;
	});

	it('starts on a random port and exposes urls', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		expect(server.port).toBeGreaterThan(0);
		expect(server.url).toBe(`http://localhost:${server.port}`);
		expect(server.wsUrl).toBe(`ws://localhost:${server.port}/ws`);
	});

	it('uses custom wsPath', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({ wsPath: '/live' });
		expect(server.wsUrl).toBe(`ws://localhost:${server.port}/live`);
	});

	it('tracks connections via platform.connections', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		expect(server.platform.connections).toBe(0);

		const ws = await connectClient(server.wsUrl);
		expect(server.platform.connections).toBe(1);

		ws.close();
		await new Promise(r => setTimeout(r, 50));
		expect(server.platform.connections).toBe(0);
	});

	it('calls upgrade handler and rejects with false', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				upgrade() { return false; }
			}
		});

		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);

		const closeCode = await new Promise((resolve) => {
			ws.on('unexpected-response', (_req, res) => {
				resolve(res.statusCode);
			});
			ws.on('open', () => resolve('open'));
		});
		expect(closeCode).toBe(401);
	});

	it('passes cookies and url to upgrade handler', async () => {
		const { createTestServer } = await import('../testing.js');
		let captured;
		server = await createTestServer({
			handler: {
				upgrade(ctx) {
					captured = { cookies: ctx.cookies, url: ctx.url };
					return { userId: 'test' };
				}
			}
		});

		const ws = await connectClient(server.wsUrl + '?token=abc', {
			headers: { cookie: 'session=xyz123' }
		});
		ws.close();

		expect(captured.cookies).toEqual({ session: 'xyz123' });
		expect(captured.url).toBe('/ws?token=abc');
	});

	it('handles subscribe/unsubscribe protocol', async () => {
		const { createTestServer } = await import('../testing.js');
		const events = [];
		server = await createTestServer({
			handler: {
				subscribe(ws, topic) { events.push({ type: 'sub', topic }); },
				unsubscribe(ws, topic) { events.push({ type: 'unsub', topic }); }
			}
		});

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat' }));
		await new Promise(r => setTimeout(r, 20));
		expect(events).toContainEqual({ type: 'sub', topic: 'chat' });
		expect(server.platform.subscribers('chat')).toBe(1);

		ws.send(JSON.stringify({ type: 'unsubscribe', topic: 'chat' }));
		await new Promise(r => setTimeout(r, 20));
		expect(events).toContainEqual({ type: 'unsub', topic: 'chat' });
		expect(server.platform.subscribers('chat')).toBe(0);

		ws.close();
	});

	it('subscribe handler can deny topics', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				subscribe(ws, topic) {
					if (topic.startsWith('admin')) return false;
				}
			}
		});

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'admin:logs' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'public' }));
		await new Promise(r => setTimeout(r, 20));
		expect(server.platform.subscribers('admin:logs')).toBe(0);
		expect(server.platform.subscribers('public')).toBe(1);

		ws.close();
	});

	it('handles subscribe-batch', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe-batch', topics: ['a', 'b', 'c'] }));
		await new Promise(r => setTimeout(r, 20));
		expect(server.platform.subscribers('a')).toBe(1);
		expect(server.platform.subscribers('b')).toBe(1);
		expect(server.platform.subscribers('c')).toBe(1);

		ws.close();
	});

	it('publishes messages to subscribers', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'todos' }));
		await new Promise(r => setTimeout(r, 20));

		const msgPromise = new Promise((resolve) => {
			ws.on('message', (data) => resolve(JSON.parse(data.toString())));
		});

		server.platform.publish('todos', 'created', { id: 1, text: 'hello' });
		const msg = await msgPromise;
		expect(msg).toEqual({ topic: 'todos', event: 'created', data: { id: 1, text: 'hello' }, seq: 1 });

		ws.close();
	});

	it('topic helper publishes CRUD events', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'items' }));
		await new Promise(r => setTimeout(r, 20));

		const messages = [];
		ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

		const items = server.platform.topic('items');
		items.created({ id: 1 });
		items.updated({ id: 1, name: 'changed' });
		items.deleted({ id: 1 });
		await new Promise(r => setTimeout(r, 50));

		expect(messages).toHaveLength(3);
		expect(messages[0]).toEqual({ topic: 'items', event: 'created', data: { id: 1 }, seq: 1 });
		expect(messages[1]).toEqual({ topic: 'items', event: 'updated', data: { id: 1, name: 'changed' }, seq: 2 });
		expect(messages[2]).toEqual({ topic: 'items', event: 'deleted', data: { id: 1 }, seq: 3 });

		ws.close();
	});

	it('calls open and close handlers', async () => {
		const { createTestServer } = await import('../testing.js');
		const events = [];
		server = await createTestServer({
			handler: {
				open(ws) { events.push('open'); },
				close(ws, ctx) { events.push(`close:${ctx.code}`); }
			}
		});

		const ws = await connectClient(server.wsUrl);
		expect(events).toEqual(['open']);

		ws.close(1000);
		await new Promise(r => setTimeout(r, 50));
		expect(events).toEqual(['open', 'close:1000']);
	});

	it('delegates non-control messages to message handler', async () => {
		const { createTestServer } = await import('../testing.js');
		const received = [];
		server = await createTestServer({
			handler: {
				message(ws, ctx) {
					received.push(Buffer.from(ctx.data).toString());
				}
			}
		});

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ topic: 'chat', event: 'msg', data: 'hello' }));
		await new Promise(r => setTimeout(r, 20));
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({ topic: 'chat', event: 'msg', data: 'hello' });

		ws.close();
	});

	it('sendTo filters by userData', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				upgrade({ headers }) {
					return { role: headers['x-role'] || 'user' };
				}
			}
		});

		const ws1 = await connectClient(server.wsUrl, { headers: { 'x-role': 'admin' } });
		const ws2 = await connectClient(server.wsUrl, { headers: { 'x-role': 'user' } });

		const admin_msgs = [];
		const user_msgs = [];
		ws1.on('message', (d) => admin_msgs.push(JSON.parse(d.toString())));
		ws2.on('message', (d) => user_msgs.push(JSON.parse(d.toString())));

		server.platform.sendTo(
			(ud) => ud.role === 'admin',
			'alert', 'critical', { msg: 'disk full' }
		);
		await new Promise(r => setTimeout(r, 50));

		expect(admin_msgs).toHaveLength(1);
		expect(admin_msgs[0].event).toBe('critical');
		expect(user_msgs).toHaveLength(0);

		ws1.close();
		ws2.close();
	});

	it('provides subscriptions set in close context', async () => {
		const { createTestServer } = await import('../testing.js');
		let closeSubs;
		server = await createTestServer({
			handler: {
				close(ws, ctx) { closeSubs = [...ctx.subscriptions]; }
			}
		});

		const ws = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'a' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'b' }));
		await new Promise(r => setTimeout(r, 20));

		ws.close(1000);
		await new Promise(r => setTimeout(r, 50));
		expect(closeSubs.sort()).toEqual(['a', 'b']);
	});

	it('waitForConnection times out', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		await expect(server.waitForConnection(50)).rejects.toThrow('timed out');
	});

	it('waitForMessage times out', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();
		await expect(server.waitForMessage(50)).rejects.toThrow('timed out');
	});

	it('close() cleans up all connections', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const { WebSocket } = await import('ws');
		const ws = await connectClient(server.wsUrl);

		server.close();
		await new Promise(r => setTimeout(r, 50));
		expect(ws.readyState).toBe(WebSocket.CLOSED);
		server = null;
	});
});
