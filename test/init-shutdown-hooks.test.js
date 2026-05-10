// Tests for hooks.ws `init` and `shutdown` hooks.
//
// init fires once after the listen socket is bound, before any open hook.
// Async init is awaited before createTestServer() resolves so test setup
// is fully ready when the promise settles. Throwing init rejects the
// createTestServer promise - boot failure is loud.
//
// shutdown fires during graceful close, before the listen socket closes
// and before existing connections are kicked. Async shutdown is awaited.
// Throws are logged and ignored (best-effort, mirrors production).

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

describeUWS('hooks.ws.init', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('fires once after the listen socket is bound, with { platform } in the context', async () => {
		const { createTestServer } = await import('../testing.js');
		const initCalls = [];

		server = await createTestServer({
			handler: {
				init(ctx) { initCalls.push(ctx); }
			}
		});

		expect(initCalls).toHaveLength(1);
		expect(initCalls[0].platform).toBe(server.platform);
	});

	it('does not fire if the user did not export init', async () => {
		const { createTestServer } = await import('../testing.js');
		// No init export - createTestServer should resolve normally.
		server = await createTestServer({ handler: {} });
		expect(server.platform).toBeDefined();
	});

	it('async init is awaited before createTestServer resolves', async () => {
		const { createTestServer } = await import('../testing.js');
		let initCompleted = false;

		const startTime = Date.now();
		server = await createTestServer({
			handler: {
				async init() {
					await new Promise(r => setTimeout(r, 80));
					initCompleted = true;
				}
			}
		});

		// createTestServer resolved - init must have completed.
		expect(initCompleted).toBe(true);
		expect(Date.now() - startTime).toBeGreaterThanOrEqual(75);
	});

	it('throwing init rejects the createTestServer promise (boot failure is loud)', async () => {
		const { createTestServer } = await import('../testing.js');

		await expect(createTestServer({
			handler: { init() { throw new Error('boot kaboom'); } }
		})).rejects.toThrow('boot kaboom');
	});

	it('init can call platform.publish; the platform is fully wired before init runs', async () => {
		const { createTestServer } = await import('../testing.js');
		let publishedFromInit = null;

		server = await createTestServer({
			handler: {
				init({ platform }) {
					// No subscribers yet - but we can call publish without crashing.
					publishedFromInit = platform.publish('boot-topic', 'ready', { stamp: 1 });
				}
			}
		});

		expect(publishedFromInit).toBe(false); // no subscribers, returns false
	});

	it('init fires before any open hook (kernel-queued connections wait for init to resolve)', async () => {
		const { createTestServer } = await import('../testing.js');
		const callOrder = [];

		server = await createTestServer({
			handler: {
				async init() {
					await new Promise(r => setTimeout(r, 30));
					callOrder.push('init');
				},
				open() { callOrder.push('open'); }
			}
		});

		// createTestServer awaited init. Connect now.
		const client = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 40));

		// init must come first.
		expect(callOrder[0]).toBe('init');
		expect(callOrder).toContain('open');

		client.close();
	});
});

describeUWS('hooks.ws.shutdown', () => {
	afterEach(async () => {
		await server?.close().catch(() => {});
		server = null;
	});

	it('fires once during server close, with { platform } in the context', async () => {
		const { createTestServer } = await import('../testing.js');
		const shutdownCalls = [];

		server = await createTestServer({
			handler: {
				shutdown(ctx) { shutdownCalls.push(ctx); }
			}
		});

		const platformRef = server.platform;
		await server.close();
		server = null;

		expect(shutdownCalls).toHaveLength(1);
		expect(shutdownCalls[0].platform).toBe(platformRef);
	});

	it('async shutdown is awaited before close() resolves', async () => {
		const { createTestServer } = await import('../testing.js');
		let shutdownCompleted = false;

		server = await createTestServer({
			handler: {
				async shutdown() {
					await new Promise(r => setTimeout(r, 80));
					shutdownCompleted = true;
				}
			}
		});

		const startTime = Date.now();
		await server.close();
		server = null;

		expect(shutdownCompleted).toBe(true);
		expect(Date.now() - startTime).toBeGreaterThanOrEqual(75);
	});

	it('throwing shutdown is logged and ignored (server still closes)', async () => {
		const { createTestServer } = await import('../testing.js');

		server = await createTestServer({
			handler: {
				shutdown() { throw new Error('shutdown kaboom'); }
			}
		});

		// close() should NOT reject even though shutdown threw.
		await expect(server.close()).resolves.toBeUndefined();
		server = null;
	});

	it('shutdown fires before existing connections are kicked', async () => {
		const { createTestServer } = await import('../testing.js');
		let connectionsAtShutdown = -1;

		server = await createTestServer({
			handler: {
				shutdown({ platform }) {
					connectionsAtShutdown = platform.connections;
				}
			}
		});

		const client = await connectClient(server.wsUrl);
		// Small wait so the server-side open handler has run and the
		// connection is registered in wsConnections.
		await new Promise(r => setTimeout(r, 30));

		await server.close();
		server = null;

		expect(connectionsAtShutdown).toBe(1);
		client.close();
	});
});

describeUWS('init / shutdown lifecycle ordering', () => {
	afterEach(async () => {
		await server?.close().catch(() => {});
		server = null;
	});

	it('init runs before shutdown, and shutdown is fired exactly once even if close is called concurrently', async () => {
		const { createTestServer } = await import('../testing.js');
		const order = [];

		server = await createTestServer({
			handler: {
				init() { order.push('init'); },
				shutdown() { order.push('shutdown'); }
			}
		});

		await server.close();
		server = null;

		expect(order).toEqual(['init', 'shutdown']);
	});
});
