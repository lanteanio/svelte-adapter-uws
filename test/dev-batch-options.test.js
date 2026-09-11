// `platform.batch()` is a loop over independent publishes, and each entry
// carries its own `options` - the ones this lane reads. Production
// (src/runtime/handler/platform.js) snapshots seq, relay, compress and jitterMs,
// and the createTestServer harness forwards the same set; the dev plugin
// destructured only `{ topic, event, data }` and dropped them, so the same call
// delivered a different frame under `vite dev` than under `npm start`.
//
// Which keys those are is the other half of the contract, and dev got it wrong
// in both directions: it dropped `jitterMs`, which production reads, and it
// honoured `excludeWs`, which production's publish and batch do not read at all
// (sender exclusion is a wire-lane option, where the per-connection walk it
// needs already lives). Both directions are pinned below.
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
/** @type {any[]} */
let extraClients = [];

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
	/** @type {any[]} */
	const opened = [];
	const loaded = {
		...handler,
		open(ws) {
			opened.push(ws);
			if (capturedWs === null) capturedWs = ws;
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

	const watch = (collected) => async (predicate, ms = 1000) => {
		const deadline = Date.now() + ms;
		for (;;) {
			const hit = collected.find(predicate);
			if (hit) return hit;
			if (Date.now() > deadline) return null;
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	return {
		ws: capturedWs,
		frames,
		waitFor: watch(frames),
		/**
		 * A second client on the same dev server, so a case that asserts an
		 * absence can show the same publish reaching someone else - an absence
		 * on the only subscriber is satisfied by a lane that delivers nothing.
		 */
		async connect() {
			const extra = new WebSocket('ws://127.0.0.1:' + port + '/ws');
			/** @type {any[]} */
			const extraFrames = [];
			extra.on('message', (raw) => {
				try { extraFrames.push(JSON.parse(raw.toString())); } catch { /* non-JSON frame */ }
			});
			await new Promise((resolve, reject) => {
				extra.on('open', resolve);
				extra.on('error', reject);
			});
			await new Promise((r) => setTimeout(r, 60));
			extraClients.push(extra);
			return { ws: opened[opened.length - 1], frames: extraFrames, waitFor: watch(extraFrames) };
		}
	};
}

describe('dev platform.batch() reads the entry options production reads (src/vite.js)', () => {
	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		for (const extra of extraClients.splice(0)) {
			try { extra.terminate(); } catch { /* already gone */ }
		}
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

	it("ignores a batch entry exclusion, because production's batch ignores it", async () => {
		// The option this lane must NOT read. Production's batch snapshots seq,
		// relay, compress and jitterMs - no exclusion - and its publish reads
		// none either, because that lane is one native fan-out and skipping one
		// socket means a per-connection walk. Sender exclusion is a WIRE-lane
		// option, and honouring it here made `vite dev` suppress an echo that
		// `npm start` delivers, silently.
		const { ws, frames, waitFor, connect } = await bootDev({});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		const delivered = platform.batch([
			{ topic: 'room', event: 'not-excluded', data: { n: 1 }, options: { excludeWs: ws } }
		]);
		expect(delivered, 'the frame goes out, as it does under npm start').toEqual([true]);
		expect(
			await waitFor((f) => f?.event === 'not-excluded'),
			'and reaches the socket the option named'
		).not.toBeNull();

		// The wire lane is where exclusion lives, and it still honours it here -
		// otherwise this parity would have been bought by breaking the lane that
		// declares the option.
		// A second subscriber, so the absence below is an exclusion and not a lane
		// that delivered nothing: the same publish has to reach this one.
		const other = await connect();
		expect(await platform.subscribe(other.ws, 'room')).toBeNull();
		const wire = { capability: 'dev.exclude:1', schemaVersion: 1, encode: () => null };
		expect(
			platform.publishWire('room', 'wire-excluded', { n: 2 }, wire, { excludeWs: ws }),
			'the wire lane delivered to the subscriber it was not asked to skip'
		).toBe(true);
		expect(
			await other.waitFor((f) => f?.event === 'wire-excluded'),
			'the other subscriber must receive it'
		).not.toBeNull();
		// Drain: wait for a frame published AFTER it, so the absence below is an
		// exclusion rather than a frame still in flight.
		platform.publish('room', 'drain', { n: 3 });
		expect(await waitFor((f) => f?.event === 'drain'), 'the topic must be live').not.toBeNull();
		expect(
			frames.find((f) => f?.event === 'wire-excluded'),
			'the wire lane must still withhold from the excluded socket'
		).toBeUndefined();
	});
});
