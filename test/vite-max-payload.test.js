import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import uws from '../src/vite.js';

const servers = [];
const clients = [];

afterEach(async () => {
	for (const ws of clients.splice(0)) {
		try { ws.terminate(); } catch {}
	}
	for (const server of servers.splice(0).reverse()) {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
});

function withTimeout(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label + ' timed out')), 5000);
		})
	]).finally(() => clearTimeout(timer));
}

async function bootDev(maxPayloadLength, onMessage) {
	const httpServer = createServer((_req, res) => {
		res.statusCode = 404;
		res.end('Not Found');
	});
	servers.push(httpServer);

	const plugin = uws({
		allowedOrigins: '*',
		handler: '/virtual-payload-handler',
		maxPayloadLength
	});
	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: {
			root: process.cwd(),
			server: {},
			logger: { warn() {}, info() {}, error() {} }
		},
		async ssrLoadModule() {
			const handler = { message: onMessage };
			return { default: handler, ...handler };
		}
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	return httpServer.address().port;
}

async function connect(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	clients.push(ws);
	ws.on('error', () => {});
	await withTimeout(new Promise((resolve) => ws.once('open', resolve)), 'open');
	return ws;
}

describe('Vite dev max payload parity', () => {
	it('reports the production default and validates a custom positive cap', () => {
		uws();
		expect(globalThis.__uws_dev_platform.maxPayloadLength).toBe(1024 * 1024);

		uws({ maxPayloadLength: 4096 });
		expect(globalThis.__uws_dev_platform.maxPayloadLength).toBe(4096);
		expect(() => uws({ maxPayloadLength: 0 })).toThrow('greater than 0');
		expect(() => uws({ maxPayloadLength: '4096' })).toThrow('must be a number');
		expect(() => uws({ maxPayloadLength: 1.5 })).toThrow('positive integer');
		expect(() => uws({ maxPayloadLength: 0x80000000 })).toThrow('2147483647');
	});

	it('delivers a message at the configured boundary and closes before an over-limit message reaches the hook', async () => {
		const delivered = [];
		let resolveExact;
		const exact = new Promise((resolve) => { resolveExact = resolve; });
		const port = await bootDev(64, (_ws, { data }) => {
			delivered.push(data.byteLength);
			resolveExact();
		});
		expect(globalThis.__uws_dev_platform.maxPayloadLength).toBe(64);

		const ws = await connect(port);
		ws.send(Buffer.alloc(64, 1));
		await withTimeout(exact, 'at-limit delivery');
		expect(delivered).toEqual([64]);

		const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
		ws.send(Buffer.alloc(65, 1));
		expect(await withTimeout(closed, 'over-limit close')).toBe(1009);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(delivered).toEqual([64]);
	});
});
