// Attribution resolution on the createTestServer surface, driven through real
// sockets. The published test harness must attribute exactly as production
// does - resolve once at open, before the app open hook, fail closed on a bad
// resolver - or a suite written against it certifies a resolver the built
// runtime refuses.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { attribution } from '../src/connection.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server = null;
let client = null;

async function connect(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	let closed = null;
	const closedPromise = new Promise((resolve) => {
		ws.on('close', (code, reason) => {
			closed = { code, reason: reason.toString() };
			resolve(closed);
		});
	});
	ws.on('message', (data) => {
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	return {
		ws,
		frames,
		get closed() { return closed; },
		closedPromise,
		async waitFor(predicate, ms = 1500) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				if (Date.now() > deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		}
	};
}

afterEach(async () => {
	setOperationalEventSink(null);
	vi.restoreAllMocks();
	try { client?.ws.terminate(); } catch { /* already gone */ }
	client = null;
	await server?.close();
	server = null;
});

describeUWS('attribution on createTestServer', () => {
	it('resolves once at open, before the app open hook, and the accessor reads it everywhere', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let resolverCalls = 0;
		let openSaw = null;
		let messageSaw = null;
		server = await createTestServer({
			handler: {
				upgrade: () => ({ orgId: 'acme', userId: 'u1' }),
				attribution: (user) => {
					resolverCalls++;
					return { tenantId: user.orgId, principalId: user.userId };
				},
				open: (ws) => { openSaw = attribution(ws); },
				message: (ws) => { messageSaw = attribution(ws); }
			}
		});
		client = await connect(server.wsUrl);
		expect(await client.waitFor((f) => f.type === 'welcome')).toBeTruthy();
		// The open hook already read the settled answer.
		expect(openSaw).toEqual({ tenantId: 'acme', principalId: 'u1' });
		expect(Object.isFrozen(openSaw)).toBe(true);
		client.ws.send(JSON.stringify({ hello: 1 }));
		await new Promise((r) => setTimeout(r, 100));
		// The message hook reads the SAME frozen object - once per connection.
		expect(messageSaw).toBe(openSaw);
		expect(resolverCalls).toBe(1);
	});

	it('admits an unattributed connection unchanged', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let openSaw = 'unset';
		server = await createTestServer({
			handler: {
				attribution: () => null,
				open: (ws) => { openSaw = attribution(ws); }
			}
		});
		client = await connect(server.wsUrl);
		expect(await client.waitFor((f) => f.type === 'welcome')).toBeTruthy();
		expect(openSaw).toBeNull();
	});

	it('closes 1008 before welcome and the open hook on an invalid id, with the indexed line', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const events = [];
		setOperationalEventSink((record) => { events.push(record); });
		let openRan = false;
		server = await createTestServer({
			handler: {
				attribution: () => ({ tenantId: 'not a valid id' }),
				open: () => { openRan = true; }
			}
		});
		client = await connect(server.wsUrl);
		const closed = await client.closedPromise;
		expect(closed.code).toBe(1008);
		expect(openRan).toBe(false);
		expect(client.frames.find((f) => f.type === 'welcome')).toBeUndefined();
		const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
		expect(hit, 'the refusal must be reported').toBeTruthy();
		expect(hit.attributes.error.message).toContain('attribution.tenantId');
		// The reported line is the one the registry indexes for operators.
		const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.ATTRIBUTION_HOOK);
		expect(entry).toBeTruthy();
		expect(hit.message).toBe(entry.problemPrefix);
	});

	it('closes 1008 on a throwing resolver', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const events = [];
		setOperationalEventSink((record) => { events.push(record); });
		server = await createTestServer({
			handler: {
				attribution: () => { throw new Error('__RESOLVER_BOOM__'); }
			}
		});
		client = await connect(server.wsUrl);
		const closed = await client.closedPromise;
		expect(closed.code).toBe(1008);
		const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
		expect(hit.attributes.error.message).toContain('__RESOLVER_BOOM__');
	});

	it('refuses a non-function attribution export instead of admitting unattributed', async () => {
		// The object where the resolver belongs is a plausible authoring slip;
		// silently unattributed connections would stand down every
		// tenant-scoped limit without a word.
		const { createTestServer } = await import('../src/testing.js');
		const events = [];
		setOperationalEventSink((record) => { events.push(record); });
		server = await createTestServer({
			handler: {
				attribution: /** @type {any} */ ({ tenantId: 'acme' })
			}
		});
		client = await connect(server.wsUrl);
		const closed = await client.closedPromise;
		expect(closed.code).toBe(1008);
		const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
		expect(hit.attributes.error.message).toContain('attribution export must be a function');
	});

	it('keeps the app close hook silent for a refused connection', async () => {
		// close mirrors open: the open hook never ran for a refused
		// connection, so a counter paired across open/close must not go
		// negative under attribution refusals. Verified against the CLIENT
		// observable (the 1008 close) plus the hook records.
		const { createTestServer } = await import('../src/testing.js');
		setOperationalEventSink(() => {});
		const ran = [];
		server = await createTestServer({
			handler: {
				attribution: () => ({ tenantId: 'not a valid id' }),
				open: () => { ran.push('open'); },
				close: () => { ran.push('close'); }
			}
		});
		client = await connect(server.wsUrl);
		const closed = await client.closedPromise;
		expect(closed.code).toBe(1008);
		// Let the server-side close callback run before asserting.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ran).toEqual([]);
	});

	it('still runs the app close hook for an admitted connection', async () => {
		// The guard must key on the refusal, not suppress close generally.
		const { createTestServer } = await import('../src/testing.js');
		const ran = [];
		server = await createTestServer({
			handler: {
				attribution: () => ({ tenantId: 'acme' }),
				open: () => { ran.push('open'); },
				close: () => { ran.push('close'); }
			}
		});
		client = await connect(server.wsUrl);
		expect(await client.waitFor((f) => f.type === 'welcome')).toBeTruthy();
		client.ws.close();
		await client.closedPromise;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ran).toEqual(['open', 'close']);
	});
});
