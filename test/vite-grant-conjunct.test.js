// The grant conjunct on the DEV surface, driven behaviourally.
//
// src/vite.js is the third implementation of the subscribe-authorization
// decision, and it had no behavioural coverage at all: neutering its
// `requireGrant` block left the entire suite green, with only a source-string
// assertion against production's platform.js standing behind it. A string
// assertion cannot tell whether a code path runs.
//
// The dev platform is constructed inside the plugin's `configureServer`
// closure, so reaching it means actually booting the plugin. That is what this
// does - a real http.Server, a minimal Vite-shaped `server` object carrying
// only the seven members the plugin touches, and a real `ws` client - rather
// than reimplementing the decision and asserting against the reimplementation.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import {
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	markSideEffectHooks
} from '../src/runtime/utils/ws-symbols.js';

/** @type {any} */
let httpServer = null;
/** @type {any} */
let client = null;

/**
 * Boot the Vite plugin against a real HTTP server.
 * @param {any} pluginOptions
 * @param {any} handler - the ws handler module the plugin will load
 * @returns {Promise<{ platform: any, ws: any }>}
 */
async function bootDev(pluginOptions, handler) {
	const mod = await import('../src/vite.js');
	// allowedOrigins is widened because a bare ws client sends no Origin header;
	// the origin gate is a separate concern with its own coverage.
	const plugin = mod.default({ allowedOrigins: '*', ...pluginOptions, handler: '/virtual-ws-handler' });

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
		config: {
			root: process.cwd(),
			logger: { warn() {}, info() {}, error() {} },
			server: {}
		},
		async ssrLoadModule() {
			return { default: loaded, ...loaded };
		}
	};

	await plugin.configureServer(server);

	const wsMod = await import('ws');
	const WebSocket = wsMod.WebSocket ?? wsMod.default;
	client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	await new Promise((resolve, reject) => {
		client.on('open', resolve);
		client.on('error', reject);
	});
	await new Promise((r) => setTimeout(r, 60));
	return { ws: capturedWs };
}

/** Wait for one parsed frame from the real dev WebSocket client. */
function waitClientFrame(predicate, timeoutMs = 1000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			client?.off('message', onMessage);
			reject(new Error('timed out waiting for dev WebSocket frame'));
		}, timeoutMs);
		function onMessage(data) {
			let frame;
			try { frame = JSON.parse(Buffer.from(data).toString('utf8')); }
			catch { return; }
			if (!predicate(frame)) return;
			clearTimeout(timer);
			client.off('message', onMessage);
			resolve(frame);
		}
		client.on('message', onMessage);
	});
}

describe('dev-server grant conjunct (src/vite.js)', () => {
	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await new Promise((resolve) => {
			if (!httpServer) return resolve(undefined);
			httpServer.close(() => resolve(undefined));
		});
		httpServer = null;
	});

	it('boots the dev WebSocket surface at all', async () => {
		// Guard for the harness itself: if the plugin stops reaching its open
		// hook, every assertion below would pass vacuously.
		const { ws } = await bootDev({}, {});
		expect(ws, 'the dev server should have reached the open hook').toBeTruthy();
		expect(typeof ws.getUserData).toBe('function');
	});

	it('refuses an observer lane for an ungranted topic when armed', async () => {
		const { ws } = await bootDev({ authorizeWireSubscribe: true }, {});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(platform, 'the dev platform must be reachable from the connection').toBeTruthy();
		expect(
			await platform.checkSubscribe(ws, 'room', { requireGrant: true }),
			'an ungranted topic must be refused under a pure-grant dev deployment'
		).toBe('FORBIDDEN');
		// Granting it flips the same call, so the refusal is the grant set talking.
		expect(await platform.subscribe(ws, 'room')).toBeNull();
		expect(await platform.checkSubscribe(ws, 'room', { requireGrant: true })).toBeNull();
	});

	it('applies the conjunct only under requireGrant', async () => {
		const { ws } = await bootDev({ authorizeWireSubscribe: true }, {});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.checkSubscribe(ws, 'room')).toBeNull();
	});

	it('denies an ungranted raw subscribe when the flat plugin option is armed', async () => {
		await bootDev({ authorizeWireSubscribe: true }, {});
		const denied = waitClientFrame(
			(frame) => frame?.type === 'subscribe-denied' && frame.topic === 'private:dev'
		);
		client.send(JSON.stringify({ type: 'subscribe', topic: 'private:dev', ref: 21 }));
		expect(await denied).toMatchObject({
			type: 'subscribe-denied',
			topic: 'private:dev',
			ref: 21,
			reason: 'FORBIDDEN'
		});
	});

	it('applies the flat plugin option to each topic in subscribe-batch', async () => {
		const { ws } = await bootDev({ authorizeWireSubscribe: true }, {});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.subscribe(ws, 'allowed:dev-batch')).toBeNull();

		const allowed = waitClientFrame(
			(frame) => frame?.type === 'subscribed' && frame.topic === 'allowed:dev-batch'
		);
		const denied = waitClientFrame(
			(frame) => frame?.type === 'subscribe-denied' && frame.topic === 'denied:dev-batch'
		);
		client.send(JSON.stringify({
			type: 'subscribe-batch',
			topics: ['allowed:dev-batch', 'denied:dev-batch'],
			ref: 22
		}));

		expect(await allowed).toMatchObject({
			type: 'subscribed',
			topic: 'allowed:dev-batch',
			ref: 22
		});
		expect(await denied).toMatchObject({
			type: 'subscribe-denied',
			topic: 'denied:dev-batch',
			ref: 22,
			reason: 'FORBIDDEN'
		});
	});

	it('defers to an app subscribe hook rather than the grant set', async () => {
		const { ws } = await bootDev({ authorizeWireSubscribe: true }, { subscribe: () => null });
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.checkSubscribe(ws, 'never-granted', { requireGrant: true })).toBeNull();
	});

	it('rechecks an observer grant after an async side-effect hook lands', async () => {
		let observerPhase = false;
		let releaseHook;
		let hookStarted;
		const started = new Promise((resolve) => { hookStarted = resolve; });
		const parked = new Promise((resolve) => { releaseHook = resolve; });
		const handler = markSideEffectHooks({
			async subscribe() {
				if (!observerPhase) return;
				hookStarted();
				await parked;
			}
		}, ['subscribe']);
		const { ws } = await bootDev({ authorizeWireSubscribe: true }, handler);
		const platform = ws.getUserData()[WS_PLATFORM];
		ws.getUserData()[WS_SUBSCRIPTIONS].add('room');
		observerPhase = true;

		const checking = platform.checkSubscribe(ws, 'room', { requireGrant: true });
		await started;
		expect(platform.unsubscribe(ws, 'room')).toBe(true);
		releaseHook();

		// This is the dev-surface twin of the published testing-server
		// regression. Removing only Vite's landing recheck must turn this red.
		expect(await checking).toBe('FORBIDDEN');
	});
});
