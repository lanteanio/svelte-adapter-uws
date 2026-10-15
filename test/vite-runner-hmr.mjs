import { describe, it, after } from 'node:test';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
const { createServer } = await import(process.env.VITE_HMR_ENTRY || 'vite');
import uws from '../vite.js';

const fixtureBase = process.env.UWS_HMR_TEST_ROOT || await mkdtemp(path.join(tmpdir(), 'uws-hmr-'));
after(() => rm(fixtureBase, { recursive: true, force: true }));

async function waitFor(check, timeout = 5000) {
	const deadline = Date.now() + timeout;
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

const lifecycleHandler = (version, { importDelay = 0, initDelay = 20, shutdownDelay = 20, failInit = false, upgradeDelay = 0, platformChecks = false, pendingImport = false, platformMarker = false } = {}) => key => `
import { state } from './shared.js';
const lifecycle = globalThis[${JSON.stringify(key)}];
const id = crypto.randomUUID();
lifecycle.events.push(['load', ${version}, id]);
await new Promise(resolve => setTimeout(resolve, ${importDelay}));
${pendingImport ? 'await new Promise(resolve => { lifecycle.releaseImport = resolve; });' : ''}
let captured;
let timer;
const subscriptionData = { [Symbol.for('adapter-uws.ws.subscriptions')]: new Set() };
const subscriptionSocket = { getUserData: () => subscriptionData, subscribe() {}, unsubscribe() {} };
const snapshot = () => ({ state, version: ${version}, id, captured: !!captured });
export async function init({ platform }) {
 lifecycle.events.push(['init:start', ${version}, id]);
 await new Promise(resolve => setTimeout(resolve, ${initDelay}));
 ${failInit ? "throw new Error('Initialization failed');" : ''}
 captured = platform;
 ${platformMarker ? `platform.initMarker = 'owner-${version}';` : ''}
 ${platformChecks ? `subscriptionData[Symbol.for('adapter-uws.ws.platform')] = platform;
 lifecycle.events.push(['platform:check', ${version}, id, await platform.checkSubscribe(subscriptionSocket, 'private')]);
 lifecycle.events.push(['platform:subscribe', ${version}, id, await platform.subscribe(subscriptionSocket, 'private')]);
 lifecycle.events.push(['platform:public', ${version}, id, await platform.subscribe(subscriptionSocket, 'public')]);` : ''}
 timer = setInterval(() => {}, 10000);
 timer.unref();
 lifecycle.active.add(id);
 lifecycle.events.push(['init:end', ${version}, id]);
}
export async function shutdown({ platform }) {
 lifecycle.events.push(['shutdown:start', ${version}, id]);
 await new Promise(resolve => setTimeout(resolve, ${shutdownDelay}));
 ${platformChecks ? "platform.unsubscribe(subscriptionSocket, 'public');" : ''}
 clearInterval(timer);
 lifecycle.active.delete(id);
 lifecycle.events.push(['shutdown:end', ${version}, id]);
}
${upgradeDelay ? `export async function upgrade() {
 lifecycle.events.push(['upgrade:start', ${version}, id]);
 await new Promise(resolve => setTimeout(resolve, ${upgradeDelay}));
 lifecycle.events.push(['upgrade:end', ${version}, id]);
 return {};
}` : ''}
export function open(ws) { lifecycle.events.push(['open', ${version}, id]); ws.send(JSON.stringify(snapshot())); }
export function message() { lifecycle.events.push(['message', ${version}, id]); }
export function subscribe(_ws, topic) { lifecycle.events.push(['subscribe', ${version}, id]); ${platformChecks ? "if (topic === 'private') return false;" : ''} }
export function unsubscribe() { lifecycle.events.push(['unsubscribe', ${version}, id]); }
export function resume() { lifecycle.events.push(['resume', ${version}, id]); }
export function close() { lifecycle.events.push(['close', ${version}, id]); }
export function authenticate() { return Response.json(snapshot()); }
`;

// Replace a complete source file so the watcher never reads a truncated save.
async function saveSource(file, source) {
	await writeFile(file + '.next', source);
	await rename(file + '.next', file);
}

async function createFixture(hmr = true, handler = handlerSource(1), options = { allowedOrigins: '*' }) {
	const root = await mkdtemp(path.join(fixtureBase, 'app-'));
	const lifecycleKey = `uws-lifecycle:${root}`;
	const lifecycle = globalThis[lifecycleKey] = { events: [], active: new Set() };
	await Promise.all([
		writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
		writeFile(path.join(root, 'shared.js'), 'export const state = { id: crypto.randomUUID(), count: 0 };\n'),
		writeFile(path.join(root, 'handler.js'), typeof handler === 'function' ? handler(lifecycleKey) : handler),
		writeFile(path.join(root, 'route.js'), routeSource(1))
	]);
	let originalSend;
	let reloads = 0;
	const clients = [];
	const requests = [];
	const server = await createServer({
		root,
		configFile: false,
		cacheDir: path.join(root, '.cache'),
		logLevel: 'error',
		optimizeDeps: { noDiscovery: true },
		server: { host: '127.0.0.1', port: 0, hmr },
		plugins: [{
			name: 'vite-plugin-sveltekit-setup',
			api: { options: { paths: {}, kit: {}, adapter: { name: 'adapter-uws' } } },
			configureServer(vite) {
				const hot = vite.environments.ssr.hot;
				const send = hot.send;
				hot.send = function (...args) {
					if (args[0]?.type === 'full-reload' || args[0]?.type === 'update') reloads++;
					return send.apply(this, args);
				};
				originalSend = hot.send;
				vite.middlewares.use(async (req, res, next) => {
					requests.push(req.url);
					if (req.url !== '/state') return next();
					try {
						const { state, version } = await vite.environments.ssr.runner.import(path.join(root, 'route.js'));
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ state, version, initMarker: globalThis.__uws_dev_platform.initMarker ?? null }));
					} catch (error) {
						res.statusCode = 500;
						res.end(String(error));
					}
				});
			}
		}, uws({ handler: './handler.js', ...options })]
	});
	await server.listen();
	const origin = () => `http://127.0.0.1:${server.httpServer.address().port}`;
	return {
		server, lifecycle, requests,
		writeHandlerSource: (source) => saveSource(path.join(root, 'handler.js'), typeof source === 'function' ? source(lifecycleKey) : source),
		removeHandler: () => rm(path.join(root, 'handler.js')),
		get reloads() { return reloads; },
		get originalSend() { return originalSend; },
		writeRoute: (version, delay) => saveSource(path.join(root, 'route.js'), routeSource(version, delay)),
		writeHandler: (version) => saveSource(path.join(root, 'handler.js'), handlerSource(version)),
		async http() {
			const response = await fetch(`${origin()}/state`);
			assert.equal(response.status, 200);
			return response.json();
		},
		async authenticate(status = 200) {
			const response = await fetch(`${origin()}/__ws/auth`, {
				method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000)
			});
			assert.equal(response.status, status);
			return status === 200 ? response.json() : response.text();
		},
		async rejectedUpgrade() {
			const socket = new WebSocket(origin().replace('http:', 'ws:') + '/ws');
			clients.push(socket);
			return new Promise((resolve, reject) => {
				socket.once('error', error => resolve(error.message));
				socket.once('open', () => { socket.terminate(); reject(new Error('Upgrade unexpectedly succeeded')); });
			});
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
			try {
				for (const client of clients) client.terminate();
				lifecycle.releaseImport?.();
				await server.close();
				assert.equal(server.environments.ssr.hot.send, originalSend);
			} finally {
				delete globalThis[lifecycleKey];
				await rm(root, { recursive: true, force: true });
			}
		}
	};
}

describe('shared SSR runner hot reload', () => {
	it('awaits old shutdown and fresh init for WebSocket and authentication requests', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { initDelay: 80, shutdownDelay: 80 }));
		try {
			const first = await fixture.connect();
			assert.equal(first.initial.captured, true);
			await fixture.http();
			await fixture.writeRoute(2);
			await waitFor(() => assert.ok(fixture.reloads > 0));
			const [second, auth] = await Promise.all([fixture.connect(), fixture.authenticate()]);
			assert.equal(second.initial.captured, true);
			assert.equal(auth.id, second.initial.id);
			assert.notEqual(auth.id, first.initial.id);
			assert.deepEqual(second.initial.state, (await fixture.http()).state);
			assert.deepEqual([...fixture.lifecycle.active], [second.initial.id]);
			assert.deepEqual(fixture.lifecycle.events.filter(([event]) => event.startsWith('init:') || event.startsWith('shutdown:')).map(([event, , id]) => [event, id]), [
				['init:start', first.initial.id], ['init:end', first.initial.id],
				['shutdown:start', first.initial.id], ['shutdown:end', first.initial.id],
				['init:start', second.initial.id], ['init:end', second.initial.id]
			]);
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, , id]) => event === 'close' && id === first.initial.id)));
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	it('never installs an initial import after a newer handler has initialized', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { importDelay: 700 }));
		try {
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'load' && version === 1)));
			await fixture.writeHandlerSource(lifecycleHandler(2, { importDelay: 10 }));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 2)));
			const newest = await fixture.connect();
			assert.equal(newest.initial.version, 2);
			await delay(750);
			const later = await fixture.authenticate();
			assert.equal(later.id, newest.initial.id);
			assert.deepEqual(later.state, (await fixture.http()).state);
			assert.equal(fixture.lifecycle.events.some(([event, version]) => event === 'init:start' && version === 1), false);
			assert.deepEqual([...fixture.lifecycle.active], [newest.initial.id]);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	it('moves early WebSocket and authentication requests past an unresolved old import', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { pendingImport: true }));
		let requests;
		try {
			await waitFor(() => assert.equal(typeof fixture.lifecycle.releaseImport, 'function'));
			requests = Promise.all([fixture.connect(), fixture.authenticate()]);
			requests.catch(() => {});
			await waitFor(() => assert.ok(fixture.requests.includes('/__ws/auth')));
			await delay(50);
			await fixture.writeHandlerSource(lifecycleHandler(2));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 2)));
			const [socket, auth] = await requests;
			assert.equal(socket.initial.version, 2);
			assert.equal(auth.id, socket.initial.id);
			assert.equal(fixture.lifecycle.events.some(([event, version]) => event === 'init:start' && version === 1), false);
		} finally { await fixture.close(); await requests?.catch(() => {}); }
	});

	it('lets the runner process another save while a slow user init is pending', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1));
		try {
			await fixture.connect();
			const before = fixture.reloads;
			await fixture.writeHandlerSource(lifecycleHandler(2, { initDelay: 12000 }));
			await waitFor(() => assert.ok(fixture.reloads > before));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:start' && version === 2)));
			await delay(120);
			await fixture.writeHandlerSource(lifecycleHandler(3));
			await waitFor(() => assert.ok(fixture.reloads > before + 1));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'load' && version === 3)));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 3)), 16000);
			const current = await fixture.connect();
			assert.equal(current.initial.version, 3);
			assert.deepEqual([...fixture.lifecycle.active], [current.initial.id]);
		} finally { await fixture.close(); }
	});

	it('exposes initialized platform properties to HTTP routes', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { platformMarker: true }));
		try {
			await fixture.connect();
			assert.equal((await fixture.http()).initMarker, 'owner-1');
			await fixture.writeHandlerSource(lifecycleHandler(2, { platformMarker: true }));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 2)));
			await fixture.connect();
			assert.equal((await fixture.http()).initMarker, 'owner-2');
		} finally { await fixture.close(); }
	});

	it('fails closed after init errors and recovers with exactly one initialized owner', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1));
		try {
			await fixture.connect();
			await fixture.writeHandlerSource(lifecycleHandler(2, { failInit: true }));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'shutdown:end' && version === 2)));
			assert.match(await fixture.rejectedUpgrade(), /500/);
			await fixture.authenticate(500);
			assert.equal(fixture.lifecycle.active.size, 0);
			// Keep distinct saves outside the watcher's atomic-save coalescing window.
			await delay(120);
			await fixture.writeHandlerSource(lifecycleHandler(3));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 3)));
			const recovered = await fixture.connect();
			assert.equal(recovered.initial.version, 3);
			assert.equal(recovered.initial.captured, true);
			assert.equal((await fixture.authenticate()).id, recovered.initial.id);
			assert.deepEqual([...fixture.lifecycle.active], [recovered.initial.id]);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	it('recovers after deleting and recreating the handler', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1));
		try {
			await fixture.connect();
			await fixture.removeHandler();
			await waitFor(() => assert.equal(fixture.lifecycle.active.size, 0));
			assert.match(await fixture.rejectedUpgrade(), /500/);
			await fixture.authenticate(500);
			await fixture.writeHandlerSource(lifecycleHandler(2));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 2)));
			const recovered = await fixture.connect();
			assert.equal(recovered.initial.version, 2);
			assert.equal(recovered.initial.captured, true);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	for (const phase of ['startup', 'replacement']) it(`awaits ${phase} initialization before admitting a client without Origin`, async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { initDelay: 300, upgradeDelay: 10 }), {});
		try {
			let initial;
			if (phase === 'replacement') {
				await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event]) => event === 'init:end')));
				initial = (await fixture.connect()).initial;
				await fixture.http();
				await fixture.writeRoute(2);
			}
			const expectedStarts = phase === 'startup' ? 1 : 2;
			await waitFor(() => assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'init:start').length, expectedStarts));
			assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'init:end').length, expectedStarts - 1);
			const current = await fixture.connect();
			assert.equal(current.initial.captured, true);
			if (initial) assert.notEqual(current.initial.id, initial.id);
			const events = fixture.lifecycle.events.filter(([, , id]) => id === current.initial.id).map(([event]) => event);
			assert.ok(events.indexOf('init:end') < events.indexOf('upgrade:start'));
			assert.ok(events.indexOf('upgrade:end') < events.indexOf('open'));
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	it('keeps subscription gates owned by the module during init and shutdown', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { platformChecks: true }));
		let second;
		try {
			const first = await fixture.connect();
			assert.deepEqual(fixture.lifecycle.events.filter(([event]) => event.startsWith('platform:')).map(([event, , id, result]) => [event, id, result]), [
				['platform:check', first.initial.id, 'FORBIDDEN'],
				['platform:subscribe', first.initial.id, 'FORBIDDEN'],
				['platform:public', first.initial.id, null]
			]);
			await fixture.http();
			await fixture.writeRoute(2);
			await waitFor(() => assert.ok(fixture.reloads > 0));
			second = await fixture.connect();
			assert.notEqual(second.initial.id, first.initial.id);
			assert.deepEqual(fixture.lifecycle.events.filter(([event]) => event === 'unsubscribe').map(([, , id]) => id), [first.initial.id]);
			assert.equal(fixture.lifecycle.events.filter(([event, , , result]) => event === 'platform:check' && result === 'FORBIDDEN').length, 2);
			assert.equal(fixture.lifecycle.events.filter(([event, , , result]) => event === 'platform:subscribe' && result === 'FORBIDDEN').length, 2);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
		assert.equal(fixture.lifecycle.events.filter(([event, , id]) => event === 'unsubscribe' && id === second.initial.id).length, 1);
	});

	it('rejects an old async upgrade while a replacement is still initializing', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, { initDelay: 400, upgradeDelay: 300 }));
		try {
			await fixture.authenticate();
			await fixture.http();
			const upgrading = fixture.rejectedUpgrade();
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event]) => event === 'upgrade:start')));
			await fixture.writeRoute(2);
			await waitFor(() => assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'init:start').length, 2));
			assert.match(await upgrading, /503/);
			assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'init:end').length, 1);
			assert.equal(fixture.lifecycle.events.some(([event]) => event === 'open'), false);
			const current = await fixture.connect();
			assert.equal(current.initial.captured, true);
			assert.deepEqual(current.initial.state, (await fixture.http()).state);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	it('drops queued data and control frames from a retired connection', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1));
		try {
			const first = await fixture.connect();
			await fixture.http();
			await fixture.writeRoute(2, 300);
			await waitFor(() => assert.ok(fixture.reloads > 0));
			first.socket.send('queued');
			first.socket.send(JSON.stringify({ type: 'subscribe', topic: 'queued', ref: 1 }));
			first.socket.send(JSON.stringify({ type: 'resume', sessionId: 'old', lastSeenSeqs: {} }));
			const current = await fixture.connect();
			assert.notEqual(first.initial.id, current.initial.id);
			await waitFor(() => assert.equal(first.socket.readyState, WebSocket.CLOSED));
			assert.equal(fixture.lifecycle.events.some(([event]) => ['message', 'subscribe', 'resume'].includes(event)), false);
			current.socket.send('new frame');
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, , id]) => event === 'message' && id === current.initial.id)));
		} finally { await fixture.close(); }
	});

	it('retires an initialization superseded by another real runner reload', async () => {
		const fixture = await createFixture(true, lifecycleHandler(1));
		try {
			await fixture.connect();
			const reloads = fixture.reloads;
			await fixture.writeHandlerSource(lifecycleHandler(2, { initDelay: 300 }));
			await waitFor(() => assert.ok(fixture.reloads > reloads));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:start' && version === 2)));
			// Keep distinct saves outside the watcher's atomic-save coalescing window.
			await delay(120);
			await fixture.writeHandlerSource(lifecycleHandler(3));
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event, version]) => event === 'init:end' && version === 3)));
			const current = await fixture.connect();
			assert.equal(current.initial.version, 3);
			assert.deepEqual([...fixture.lifecycle.active], [current.initial.id]);
			assert.deepEqual(fixture.lifecycle.events.filter(([event]) => event.startsWith('init:') || event.startsWith('shutdown:')).map(([event, version]) => [event, version]), [
				['init:start', 1], ['init:end', 1], ['shutdown:start', 1], ['shutdown:end', 1],
				['init:start', 2], ['init:end', 2], ['shutdown:start', 2], ['shutdown:end', 2],
				['init:start', 3], ['init:end', 3]
			]);
		} finally { await fixture.close(); }
		assert.equal(fixture.lifecycle.active.size, 0);
	});

	for (const stage of ['import', 'init']) it(`closes safely during pending handler ${stage}`, async () => {
		const fixture = await createFixture(true, lifecycleHandler(1, stage === 'import' ? { importDelay: 400 } : { initDelay: 400 }));
		try {
			await waitFor(() => assert.ok(fixture.lifecycle.events.some(([event]) => event === (stage === 'import' ? 'load' : 'init:start'))));
		} finally { await fixture.close(); }
		await delay(450);
		assert.equal(fixture.lifecycle.active.size, 0);
		assert.equal(fixture.lifecycle.events.some(([event]) => event === 'open'), false);
		assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'shutdown:end').length, stage === 'init' ? 1 : 0);
		assert.equal(fixture.lifecycle.events.filter(([event]) => event === 'init:start').length, stage === 'init' ? 1 : 0);
	});

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
