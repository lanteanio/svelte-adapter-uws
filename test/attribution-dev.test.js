// Attribution resolution on the dev plugin (src/vite.js), driven through the
// real plugin against a real http.Server and a real `ws` client. Dev must
// attribute exactly as production does - resolve once at open, before the app
// open hook, fail closed - or a resolver defect ships unseen because dev
// admitted what the built runtime refuses.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { attribution } from '../src/connection.js';

/** @type {any} */
let httpServer = null;
/** @type {any} */
let client = null;

/**
 * Boot the Vite plugin against a real HTTP server and connect a real client.
 * Shaped after test/dev-batch-landing-order.test.js: the dev runtime is built
 * inside the plugin's `configureServer` closure, so the only way to reach it
 * is to boot the plugin.
 *
 * @param {any} handler - the ws handler module the plugin will load
 */
async function bootDev(handler) {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

	httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const port = httpServer.address().port;

	const server = {
		httpServer,
		middlewares: { use() {} },
		config: {
			root: process.cwd(),
			logger: { warn() {}, info() {}, error() {} },
			server: {}
		},
		async ssrLoadModule() {
			return { default: handler, ...handler };
		}
	};
	await plugin.configureServer(server);

	const wsMod = await import('ws');
	const WebSocket = wsMod.WebSocket ?? wsMod.default;
	client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	/** @type {any[]} */
	const frames = [];
	/** @type {{ code: number, reason: string } | null} */
	let closed = null;
	const closedPromise = new Promise((resolve) => {
		client.on('close', (code, reason) => {
			closed = { code, reason: reason.toString() };
			resolve(closed);
		});
	});
	client.on('message', (raw) => {
		try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON frame */ }
	});
	await new Promise((resolve, reject) => {
		client.on('open', resolve);
		client.on('error', reject);
	});
	await new Promise((r) => setTimeout(r, 60));

	return {
		frames,
		get closed() { return closed; },
		closedPromise,
		/** @param {any} obj */
		send: (obj) => client.send(JSON.stringify(obj)),
		/**
		 * @param {(f: any) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 1000) {
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

describe('attribution on the dev plugin (src/vite.js)', () => {
	afterEach(async () => {
		setOperationalEventSink(null);
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await new Promise((resolve) => {
			if (!httpServer) return resolve(undefined);
			httpServer.close(() => resolve(undefined));
		});
		httpServer = null;
	});

	it('resolves once before the open hook and the accessor reads the frozen result', async () => {
		let resolverCalls = 0;
		let openSaw = null;
		const dev = await bootDev({
			upgrade: () => ({ orgId: 'acme' }),
			attribution: (user) => { resolverCalls++; return { tenantId: user.orgId }; },
			open: (ws) => { openSaw = attribution(ws); }
		});
		expect(await dev.waitFor((f) => f.type === 'welcome')).toBeTruthy();
		expect(openSaw).toEqual({ tenantId: 'acme' });
		expect(Object.isFrozen(openSaw)).toBe(true);
		expect(resolverCalls).toBe(1);
	});

	it('admits an unattributed connection unchanged', async () => {
		let openSaw = 'unset';
		const dev = await bootDev({
			open: (ws) => { openSaw = attribution(ws); }
		});
		expect(await dev.waitFor((f) => f.type === 'welcome')).toBeTruthy();
		expect(openSaw).toBeNull();
	});

	it('closes 1008 before welcome and the open hook on an invalid id, with the indexed line', async () => {
		const events = [];
		setOperationalEventSink((record) => { events.push(record); });
		let openRan = false;
		const dev = await bootDev({
			attribution: () => ({ tenantId: 'not a valid id' }),
			open: () => { openRan = true; }
		});
		const closed = await dev.closedPromise;
		expect(closed.code).toBe(1008);
		expect(openRan).toBe(false);
		expect(dev.frames.find((f) => f.type === 'welcome')).toBeUndefined();
		const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
		expect(hit, 'the refusal must be reported').toBeTruthy();
		expect(hit.attributes.error.message).toContain('attribution.tenantId');
	});

	it('closes 1008 on a throwing resolver', async () => {
		const events = [];
		setOperationalEventSink((record) => { events.push(record); });
		const dev = await bootDev({
			attribution: () => { throw new Error('__DEV_RESOLVER_BOOM__'); }
		});
		const closed = await dev.closedPromise;
		expect(closed.code).toBe(1008);
		const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
		expect(hit.attributes.error.message).toContain('__DEV_RESOLVER_BOOM__');
	});
});
