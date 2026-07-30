// Vite must apply the same fixed-ORIGIN authority as production at the actual
// auth and upgrade boundaries. Helper-only tests cannot prove the plugin passed
// `pinnedOrigin` into either call site.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import uws from '../src/vite.js';

const originalOrigin = process.env.ORIGIN;
const servers = [];
const clients = [];

afterEach(async () => {
	for (const ws of clients.splice(0)) {
		try { ws.terminate(); } catch { /* already closed */ }
	}
	for (const server of servers.splice(0).reverse()) {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
	if (originalOrigin === undefined) delete process.env.ORIGIN;
	else process.env.ORIGIN = originalOrigin;
});

async function bootDev({ origin, handler = {}, loadHandler } = {}) {
	if (origin === undefined) delete process.env.ORIGIN;
	else process.env.ORIGIN = origin;

	const middleware = [];
	const httpServer = createServer((req, res) => {
		const pathname = new URL(req.url || '/', 'http://localhost').pathname;
		const hit = middleware.find((entry) => entry.path === pathname);
		if (!hit) { res.statusCode = 404; res.end('Not Found'); return; }
		hit.fn(req, res, () => { res.statusCode = 404; res.end('Not Found'); });
	});
	servers.push(httpServer);

	const plugin = uws({
		allowedOrigins: 'same-origin',
		handler: '/virtual-origin-handler'
	});
	await plugin.configureServer({
		httpServer,
		middlewares: {
			use(path, fn) { middleware.push({ path, fn }); }
		},
		config: {
			root: process.cwd(),
			server: {},
			logger: { warn() {}, info() {}, error() {} }
		},
		async ssrLoadModule() {
			if (loadHandler) return loadHandler();
			return { default: handler, ...handler };
		}
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const port = httpServer.address().port;
	return { port };
}

function postAuth(port, origin, host = 'attacker.example') {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
		host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { host, origin, 'content-length': '0' }
		}, (res) => {
			res.resume();
			res.once('end', () => resolve(res.statusCode));
		});
		req.once('error', reject);
		req.end();
	});
}

function connect(port, { origin, host = 'attacker.example' } = {}) {
	return new Promise((resolve, reject) => {
		const headers = { host };
		if (origin !== undefined) headers.origin = origin;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
		clients.push(ws);
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		ws.once('open', () => finish(101));
		ws.once('unexpected-response', (_req, res) => {
			res.resume();
			finish(res.statusCode);
		});
		ws.once('error', (err) => { if (!settled) reject(err); });
	});
}

describe('Vite fixed-origin parity', () => {
	it('uses ORIGIN rather than attacker-controlled Host on auth and upgrade', async () => {
		let authenticated = 0;
		const { port } = await bootDev({
			origin: 'https://pinned.example',
			handler: {
				authenticate() { authenticated++; },
				open() {}
			}
		});
		// Let the handler module's promise settle before exercising the boundary;
		// the separate race test below deliberately does the opposite.
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Without pinnedOrigin these attacker-supplied values agree and both
		// requests pass the `same-origin` Host fallback.
		expect(await postAuth(port, 'http://attacker.example')).toBe(403);
		expect(await connect(port, { origin: 'http://attacker.example' })).toBe(403);

		// The fixed deployment origin is authoritative even when Host disagrees.
		expect(await postAuth(port, 'https://pinned.example')).toBe(204);
		expect(await connect(port, { origin: 'https://pinned.example' })).toBe(101);
		expect(authenticated).toBe(1);
	});

	it('waits for the handler before deciding whether a missing Origin is allowed', async () => {
		let releaseLoad;
		const loading = new Promise((resolve) => { releaseLoad = resolve; });
		const handler = { upgrade: () => ({ id: 'hook-authenticated' }) };
		const { port } = await bootDev({
			origin: undefined,
			async loadHandler() {
				await loading;
				return { default: handler, ...handler };
			}
		});

		const connecting = connect(port, { origin: undefined });
		setTimeout(releaseLoad, 20);
		// Production knows its static handler before it checks Origin and permits
		// an Origin-less native client when upgrade() performs authentication.
		// Dev previously observed an empty userHandlers object while the module
		// was still loading and returned 403 before the hook existed.
		expect(await connecting).toBe(101);
	});
});
