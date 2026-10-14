import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
const { createServer } = await import(process.env.VITE_HMR_ENTRY || 'vite');
import uws from '../vite.js';

async function waitFor(check) {
	const deadline = Date.now() + 5000;
	for (;;) {
		try { return await check(); } catch (error) {
			if (Date.now() >= deadline) throw error;
			await delay(20);
		}
	}
}

const routeSource = (version, delay = 0) => `
export { state } from './shared.js';
export const version = ${version};
await new Promise(resolve => setTimeout(resolve, ${delay}));
`;
const handlerSource = (version) => `
import { state } from './shared.js';
export function open(ws) { ws.send(JSON.stringify({ state, handler: ${version} })); }
export function message(ws) { state.count++; ws.send(JSON.stringify({ state, handler: ${version} })); }
`;

// Replace a complete source file so the watcher never reads a truncated save.
async function saveSource(file, source) {
	await writeFile(file + '.next', source);
	await rename(file + '.next', file);
}

async function createFixture(hmr = true, handler = handlerSource(1)) {
	const root = await mkdtemp(path.join(process.cwd(), '.vite-hmr-test-'));
	await Promise.all([
		writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
		writeFile(path.join(root, 'shared.js'), 'export const state = { id: crypto.randomUUID(), count: 0 };\n'),
		writeFile(path.join(root, 'handler.js'), handler),
		writeFile(path.join(root, 'route.js'), routeSource(1))
	]);
	let originalSend;
	let reloads = 0;
	const clients = [];
	const server = await createServer({
		root,
		configFile: false,
		cacheDir: path.join(root, '.cache'),
		logLevel: 'error',
		optimizeDeps: { noDiscovery: true },
		server: { host: '127.0.0.1', port: 0, hmr },
		plugins: [{
			name: 'server-routes',
			api: { options: { adapter: { name: 'adapter-uws' } } },
			configureServer(vite) {
				const hot = vite.environments.ssr.hot;
				const send = hot.send;
				hot.send = function (...args) {
					if (args[0]?.type === 'full-reload' || args[0]?.type === 'update') reloads++;
					return send.apply(this, args);
				};
				originalSend = hot.send;
				vite.middlewares.use(async (req, res, next) => {
					if (req.url !== '/state') return next();
					try {
						const { state, version } = await vite.environments.ssr.runner.import(path.join(root, 'route.js'));
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ state, version }));
					} catch (error) {
						res.statusCode = 500;
						res.end(String(error));
					}
				});
			}
		}, uws({ handler: './handler.js', allowedOrigins: '*' })]
	});
	await server.listen();
	const origin = () => `http://127.0.0.1:${server.httpServer.address().port}`;
	return {
		server,
		get reloads() { return reloads; },
		get originalSend() { return originalSend; },
		writeRoute: (version, delay) => saveSource(path.join(root, 'route.js'), routeSource(version, delay)),
		writeHandler: (version) => saveSource(path.join(root, 'handler.js'), handlerSource(version)),
		async http() {
			const response = await fetch(`${origin()}/state`);
			assert.equal(response.status, 200);
			return response.json();
		},
		async authenticate() {
			const response = await fetch(`${origin()}/__ws/auth`, {
				method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }
			});
			assert.equal(response.status, 200);
			return response.json();
		},
		async connect() {
			const socket = new WebSocket(origin().replace('http:', 'ws:') + '/ws');
			clients.push(socket);
			const messages = [];
			let socketError;
			socket.on('error', error => { socketError = error; });
			socket.on('message', data => {
				const message = JSON.parse(data.toString());
				if (message.type !== 'welcome') messages.push(message);
			});
			const next = async () => {
				await waitFor(() => { if (socketError) throw socketError; assert.ok(messages.length > 0); });
				return messages.shift();
			};
			return { socket, next, initial: await next() };
		},
		async close() {
			for (const client of clients) client.terminate();
			await server.close();
			assert.equal(server.environments.ssr.hot.send, originalSend);
			await rm(root, { recursive: true, force: true });
		}
	};
}

describe('shared SSR runner hot reload', () => {
	it('keeps HTTP and WebSocket state shared after a route-only edit', async () => {
		const fixture = await createFixture();
		try {
			const first = await fixture.connect();
			assert.deepEqual((await fixture.http()).state, first.initial.state);
			await fixture.writeRoute(2, 100);
			await waitFor(async () => assert.equal((await fixture.http()).version, 2));
			const second = await fixture.connect();
			const current = await fixture.http();
			assert.deepEqual(second.initial.state, current.state);
			assert.notEqual(current.state.id, first.initial.state.id);
			assert.equal(first.socket.readyState, WebSocket.CLOSED);
			second.socket.send('increment');
			assert.equal((await second.next()).state.count, 1);
			assert.equal((await fixture.http()).state.count, 1);
		} finally {
			await fixture.close();
		}
	});

	it('reloads an authentication-only handler with the HTTP module graph', async () => {
		const fixture = await createFixture(true, `
import { state } from './shared.js';
export function authenticate() { return Response.json(state); }
`);
		try {
			const first = await fixture.authenticate();
			assert.deepEqual(first, (await fixture.http()).state);
			await fixture.writeRoute(2, 100);
			await waitFor(async () => assert.equal((await fixture.http()).version, 2));
			const second = await fixture.authenticate();
			assert.deepEqual(second, (await fixture.http()).state);
			assert.notEqual(second.id, first.id);
		} finally {
			await fixture.close();
		}
	});

	it('handles overlapping route and handler edits before the next connection', async () => {
		const fixture = await createFixture();
		try {
			await fixture.connect();
			await fixture.http();
			await fixture.writeRoute(2, 300);
			await waitFor(() => assert.ok(fixture.reloads > 0));
			await fixture.writeHandler(2);
			await waitFor(async () => assert.equal((await fixture.http()).version, 2));
			await waitFor(() => assert.ok(fixture.reloads > 1));
			const client = await fixture.connect();
			assert.equal(client.initial.handler, 2);
			assert.deepEqual(client.initial.state, (await fixture.http()).state);
		} finally {
			await fixture.close();
		}
	});

	it('restores the old hot channel and registers reloads again after a restart', async () => {
		const fixture = await createFixture();
		try {
			const first = await fixture.connect();
			assert.deepEqual(first.initial.state, (await fixture.http()).state);
			first.socket.close();
			await waitFor(() => assert.equal(first.socket.readyState, WebSocket.CLOSED));
			const oldHot = fixture.server.environments.ssr.hot;
			const oldSend = fixture.originalSend;
			await fixture.server.restart();
			assert.equal(oldHot.send, oldSend);
			const restarted = await fixture.connect();
			assert.deepEqual(restarted.initial.state, (await fixture.http()).state);
			assert.notEqual(restarted.initial.state.id, first.initial.state.id);
			await fixture.writeRoute(2);
			await waitFor(async () => assert.equal((await fixture.http()).version, 2));
			const reloaded = await fixture.connect();
			assert.deepEqual(reloaded.initial.state, (await fixture.http()).state);
		} finally {
			await fixture.close();
		}
	});

	it('keeps reload subscriptions after reloading every runner entrypoint', async () => {
		const fixture = await createFixture();
		try {
			const first = await fixture.connect();
			assert.deepEqual(first.initial.state, (await fixture.http()).state);
			fixture.server.environments.ssr.hot.send({ type: 'full-reload' });
			const second = await fixture.connect();
			assert.notEqual(second.initial.state.id, first.initial.state.id);
			assert.deepEqual(second.initial.state, (await fixture.http()).state);
			await fixture.writeRoute(2);
			await waitFor(async () => assert.equal((await fixture.http()).version, 2));
			const third = await fixture.connect();
			assert.notEqual(third.initial.state.id, second.initial.state.id);
			assert.deepEqual(third.initial.state, (await fixture.http()).state);
		} finally {
			await fixture.close();
		}
	});

	it('serves HTTP and WebSockets when runner HMR is disabled', async () => {
		const fixture = await createFixture(false);
		try {
			const client = await fixture.connect();
			assert.deepEqual(client.initial.state, (await fixture.http()).state);
			client.socket.send('increment');
			assert.equal((await client.next()).state.count, 1);
			assert.equal((await fixture.http()).state.count, 1);
			assert.equal(fixture.server.environments.ssr.hot.send, fixture.originalSend);
		} finally {
			await fixture.close();
		}
	});
});
