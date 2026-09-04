// Custom 101 response headers under `vite dev`.
//
// `upgradeResponse(userData, headers)` puts application headers on the
// handshake. Production writes them through `res.writeHeader`; dev runs on
// `ws`, which assembles the handshake response itself and emits the assembled
// header lines before writing them - so the dev plugin appends there.
//
// What is asserted is what the CLIENT receives on the 101, read off the `ws`
// client's own `upgrade` event, not the snapshot the server parked. A test that
// checked the parked snapshot would pass with the listener removed entirely.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { upgradeResponse } from '../src/upgrade-response.js';

/** @type {any} */
let httpServer = null;
/** @type {any} */
let client = null;

afterEach(async () => {
	try { client?.terminate(); } catch { /* already gone */ }
	client = null;
	if (httpServer) {
		await new Promise((resolve) => httpServer.close(resolve));
		httpServer = null;
	}
});

/**
 * Boot the dev plugin against a real HTTP server and open one real client.
 *
 * @param {any} handler - the ws handler module the plugin will load
 * @returns {Promise<{ status: number, headers: Record<string, any>, raw: string[] }>}
 *   the 101 as the client saw it
 */
async function upgradeOnce(handler) {
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

	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('the handshake never settled')), 4000);
		/** @type {any} */
		let seen = null;
		client.on('upgrade', (res) => {
			seen = { status: res.statusCode, headers: res.headers, raw: res.rawHeaders };
		});
		client.on('open', () => {
			clearTimeout(timer);
			resolve(seen ?? { status: 0, headers: {}, raw: [] });
		});
		client.on('unexpected-response', (_req, res) => {
			clearTimeout(timer);
			resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders ?? [] });
		});
		client.on('error', (err) => {
			clearTimeout(timer);
			// A refused handshake surfaces here on some paths; report it as a
			// status-less result so the assertion names the real outcome.
			if (seen) resolve(seen);
			else reject(err);
		});
	});
}

describe('dev applies custom 101 response headers', () => {
	it('puts an application header on the handshake the client receives', async () => {
		const seen = await upgradeOnce({
			upgrade() {
				return upgradeResponse({ userId: 'u-1' }, { 'x-session-version': '2' });
			},
			open() {}
		});

		expect(seen.status).toBe(101);
		expect(seen.headers['x-session-version'], 'the header never reached the 101').toBe('2');
	});

	it('emits one header line per value for the array form', async () => {
		// Several cookies are several Set-Cookie headers, not one comma-joined
		// value - a joined value is a single malformed cookie to the browser.
		const seen = await upgradeOnce({
			upgrade() {
				return upgradeResponse({}, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
			},
			open() {}
		});

		expect(seen.status).toBe(101);
		expect(seen.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		// And on the wire: two distinct header lines carrying that name.
		const names = seen.raw.filter((_v, i) => i % 2 === 0).map((n) => String(n).toLowerCase());
		expect(names.filter((n) => n === 'set-cookie').length, 'the values were joined into one header').toBe(2);
	});

	it('adds nothing when the upgrade hook returns plain userData', async () => {
		const seen = await upgradeOnce({
			upgrade() { return { userId: 'u-2' }; },
			open() {}
		});

		expect(seen.status).toBe(101);
		expect(seen.headers['x-session-version']).toBeUndefined();
	});

	it('refuses a malformed header value in dev rather than letting it reach the handshake', async () => {
		// The validation production runs, run here too: an app that verifies a
		// broken upgrade in dev and only fails in production is the reason dev
		// validates at all. A CR splits the response, so it never goes out.
		const seen = await upgradeOnce({
			upgrade() {
				return upgradeResponse({}, { 'x-bad': 'value\r\nInjected: 1' });
			},
			open() {}
		});

		expect(seen.status, 'a malformed header value reached the handshake').not.toBe(101);
		expect(seen.headers['injected'], 'the response was split').toBeUndefined();
	});
});
