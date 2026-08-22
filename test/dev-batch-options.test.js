// `platform.batch()` is a loop over independent publishes, and each entry
// carries its own `options`. Production (src/runtime/handler/platform.js) reads
// that field and the createTestServer harness (src/testing.js) forwards it; the
// dev plugin destructured only `{ topic, event, data }` and dropped it, so the
// same call delivered a different frame under `vite dev` than under `npm start`.
//
// This drives the real plugin - a real http.Server, a real `ws` client - and
// asserts the frame the CLIENT is handed, because that is the only place the
// divergence shows. A test that inspected the platform object would agree with
// either implementation.
//
// `jitterMs` is the option under test because dev honours it observably: it
// lands in the envelope as `j`. Dev deliberately stamps no `seq` (documented on
// publishBatched), so seq would prove nothing here.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WS_PLATFORM } from '../src/runtime/utils/ws-symbols.js';

/** @type {any} */
let httpServer = null;
/** @type {any} */
let client = null;

/**
 * Boot the Vite plugin against a real HTTP server and a real client. The dev
 * platform is built inside `configureServer`'s closure, so booting the plugin
 * is the only way to reach it.
 *
 * @param {any} handler - the ws handler module the plugin will load
 */
async function bootDev(handler) {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

	httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const port = httpServer.address().port;

	/** @type {any} */
	let capturedWs = null;
	const appOpen = handler.open;
	const loaded = {
		...handler,
		open(ws) {
			capturedWs = ws;
			appOpen?.(ws);
		}
	};

	const server = {
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: loaded, ...loaded }; }
	};
	await plugin.configureServer(server);

	const wsMod = await import('ws');
	const WebSocket = wsMod.WebSocket ?? wsMod.default;
	client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	/** @type {any[]} */
	const frames = [];
	client.on('message', (raw) => {
		try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON frame */ }
	});
	await new Promise((resolve, reject) => {
		client.on('open', resolve);
		client.on('error', reject);
	});
	await new Promise((r) => setTimeout(r, 60));

	return {
		ws: capturedWs,
		frames,
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

describe('dev platform.batch() carries each entry OPTIONS (src/vite.js)', () => {
	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await new Promise((resolve) => {
			if (!httpServer) return resolve(undefined);
			httpServer.close(() => resolve(undefined));
		});
		httpServer = null;
	});

	it('stamps the de-herd window from a batch entry, exactly as a direct publish does', async () => {
		const { ws, waitFor } = await bootDev({});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(platform, 'the dev platform must be reachable from the connection').toBeTruthy();
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		// The control: the same option through the direct publish path, which
		// always honoured it. If this stops carrying `j` the option itself
		// changed and the batch assertion below would be measuring nothing.
		platform.publish('room', 'direct', { n: 1 }, { jitterMs: 250 });
		const direct = await waitFor((f) => f?.event === 'direct');
		expect(direct, 'the direct publish must be delivered').not.toBeNull();
		expect(direct.j, 'the direct publish carries the de-herd window').toBe(250);

		// The subject: the same option on a batch entry.
		platform.batch([{ topic: 'room', event: 'batched', data: { n: 2 }, options: { jitterMs: 250 } }]);
		const batched = await waitFor((f) => f?.event === 'batched');
		expect(batched, 'the batched publish must be delivered').not.toBeNull();
		expect(
			batched.j,
			'a batch entry carries its own options, so the de-herd window must survive'
		).toBe(250);
	});

	it('honours a batch entry EXCLUSION, so the excluded socket is not a recipient', async () => {
		// The second observable option, and the one whose loss is silent in the
		// other direction: dropping `excludeWs` delivers a frame to a socket that
		// asked not to receive it, rather than omitting a field.
		const { ws, frames, waitFor } = await bootDev({});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		const delivered = platform.batch([
			{ topic: 'room', event: 'excluded', data: { n: 1 }, options: { excludeWs: ws } }
		]);
		expect(delivered, 'the only recipient was excluded, so nothing was sent').toEqual([false]);

		// Prove the topic is live, so the absence above is the exclusion and not
		// a broken subscription.
		platform.batch([{ topic: 'room', event: 'included', data: { n: 2 } }]);
		expect(await waitFor((f) => f?.event === 'included'), 'the topic must be live').not.toBeNull();
		expect(
			frames.find((f) => f?.event === 'excluded'),
			'the excluded socket must never have received the frame'
		).toBeUndefined();
	});
});
