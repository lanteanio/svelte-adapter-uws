import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

if (process.argv.includes('--native')) {
	const modeIndex = process.argv.indexOf('--mode');
	for (const mode of modeIndex < 0 ? ['reload', 'reject', 'reload-reject', 'abort'] : [process.argv[modeIndex + 1]]) await run(mode);
} else {
	const { it } = await import('vitest');
	for (const mode of ['reload', 'reject', 'reload-reject', 'abort']) {
		it('keeps authentication response bodies owned by the current handler: ' + mode, async () => {
			try {
				const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--native', '--mode', mode], { timeout: 30000 });
				assert.ok(stdout.includes('Authentication response ownership passed: ' + mode));
			} catch (error) {
				throw new Error((error.stdout || '') + '\n' + (error.stderr || ''), { cause: error });
			}
		}, 35000);
	}
	it('waits for a delayed handler import before releasing retired authentication', async () => {
		try {
			const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--native', '--mode', 'reload-delayed'], { timeout: 30000 });
			assert.ok(stdout.includes('Authentication response ownership passed: reload-delayed'));
			const held = stdout.match(/Authentication handler response delayed: ([\d.]+)/);
			assert.ok(held && Number(held[1]) >= 6000);
		} catch (error) {
			throw new Error((error.stdout || '') + '\n' + (error.stderr || ''), { cause: error });
		}
	}, 35000);
	it('fails when the matching reload event is missing', async () => {
		let now = 0;
		const hot = { send() {}, api: { innerEmitter: new EventEmitter() } };
		const reload = observeReload('/handler.js', 0, () => now);
		reload.plugin.configureServer({ environments: { ssr: { hot } } });
		reload.arm();
		hot.send({ type: 'full-reload', triggeredBy: '/other.js' });
		await assert.rejects(waitBefore(() => reload.deadline, 'Replacement SSR reload', 5000, () => now, async ms => { now += ms; }), /Replacement SSR reload timed out/);
		await reload.close();
	});
	it('keeps one reload deadline and rejects success after it', async () => {
		let now = 100;
		const hot = { send() {}, api: { innerEmitter: new EventEmitter() } };
		const reload = observeReload('/handler.js', 0, () => now);
		reload.plugin.configureServer({ environments: { ssr: { hot } } });
		reload.arm();
		hot.send({ type: 'full-reload', triggeredBy: '/handler.js' });
		const deadline = reload.deadline;
		assert.equal(deadline, 10100);
		now = 200;
		hot.send({ type: 'full-reload', triggeredBy: '/other.js' });
		assert.equal(reload.deadline, deadline);
		now = deadline - 1;
		assert.equal(await waitBefore(() => true, 'Replacement WebSocket handler', deadline, () => now), true);
		await assert.rejects(waitBefore(async () => { now = deadline; return true; }, 'Replacement WebSocket handler', deadline, () => now, async ms => { now += ms; }), /Replacement WebSocket handler timed out/);
		now = 300;
		await assert.rejects(waitBefore(() => false, 'Replacement WebSocket handler', deadline, () => now, async ms => { now += ms; }), /Replacement WebSocket handler timed out/);
		assert.equal(now, deadline);
		hot.send({ type: 'full-reload', triggeredBy: '/handler.js' });
		assert.throws(() => reload.deadline, /Repeated handler reload/);
		await reload.close();
	});
}

async function run(mode) {
	const { createServer } = await import('vite');
	const { default: uws } = await import('../vite.js');
	const { default: WebSocket } = await import('ws');
	const root = await mkdtemp(path.join(tmpdir(), 'uws-auth-body-'));
	const key = 'uws-auth-body:' + root;
	const probe = globalThis[key] = {};
	const sockets = [];
	let server;
	let aborted;
	let pending;
	let pendingAbort;
	const handler = path.join(root, 'handler.js');
	const reload = observeReload(handler, mode === 'reload-delayed' ? 6000 : 0);
	const source = version => `
const probe = globalThis[${JSON.stringify(key)}];
export function open(ws) { ws.send(JSON.stringify({ version: ${version} })); }
export function authenticate({ cookies }) {
 ${version === 1 ? `cookies.set('retired', 'yes', { path: '/' });
 return new Response(new ReadableStream({ start(controller) {
  let settled = false;
  probe.finish = (reject = false) => {
   if (settled) return;
   settled = true;
   if (reject) controller.error(new Error('Authentication body failed'));
   else { controller.enqueue(new TextEncoder().encode('retired authentication body')); controller.close(); }
  };
 }}), { headers: { 'x-handler': 'retired', 'set-cookie': 'response-cookie=retired; Path=/' } });`
 : `return Response.json({ version: ${version} });`}
}
`;
	async function until(check, label) {
		const end = Date.now() + 5000;
		let last;
		while (Date.now() < end) {
			try { const result = await check(); if (result) return result; } catch (error) { last = error; }
			await delay(20);
		}
		throw new Error(label + ' timed out' + (last ? ': ' + last.message : ''));
	}
	async function connect(origin, timeout = 1000) {
		const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
		sockets.push(socket);
		socket.on('error', () => {});
		try {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('WebSocket version timed out')), timeout);
				socket.once('error', error => { clearTimeout(timer); reject(error); });
				socket.on('message', raw => {
					const data = JSON.parse(raw.toString());
					if (data.type === 'welcome') return;
					clearTimeout(timer);
					resolve(data);
				});
			});
		} finally { socket.terminate(); }
	}
	async function replace(origin) {
		await writeFile(handler + '.next', source(2));
		reload.arm();
		await rename(handler + '.next', handler);
		const deadline = await waitBefore(() => reload.deadline, 'Replacement SSR reload', performance.now() + 5000);
		await waitBefore(async () => (await connect(origin, Math.max(1, Math.min(1000, deadline - performance.now())))).version === 2, 'Replacement WebSocket handler', deadline);
		reload.assertReady(mode === 'reload-delayed' ? 6000 : 0);
	}
	try {
		await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
		await writeFile(handler, source(1));
		server = await createServer({
			root, configFile: false, cacheDir: path.join(root, '.cache'), logLevel: 'error',
			optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0 },
			plugins: [reload.plugin, { name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {}, adapter: { name: 'adapter-uws' } } } }, uws({ handler: './handler.js', allowedOrigins: '*' })]
		});
		await server.listen();
		const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
		const auth = origin + '/__ws/auth';
		assert.equal((await connect(origin)).version, 1);
		await delay(150);
		if (mode === 'abort') {
			let responseClosed = false;
			server.httpServer.once('request', (_request, response) => response.once('close', () => { responseClosed = true; }));
			aborted = request(auth, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' } });
			aborted.on('error', () => {});
			aborted.end();
			await until(() => probe.finish, 'Authentication response body');
			aborted.destroy();
			await until(() => responseClosed, 'Aborted HTTP response');
			probe.finish();
			await replace(origin);
		} else {
			pendingAbort = new AbortController();
			pending = fetch(auth, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: pendingAbort.signal });
			pending.catch(() => {});
			await until(() => probe.finish, 'Authentication response body');
			if (mode.startsWith('reload')) await replace(origin);
			probe.finish(mode.endsWith('reject'));
			const response = await pending;
			assert.equal(response.status, mode === 'reload' || mode === 'reload-delayed' ? 503 : 500);
			assert.equal(response.headers.get('set-cookie'), null, 'Failed or retired response cookies must never be staged');
			assert.equal(response.headers.get('x-handler'), null, 'Failed or retired response headers must never be staged');
			assert.doesNotMatch(await response.text(), /retired authentication body/);
			if (mode === 'reject') await replace(origin);
		}
		const fresh = await fetch(auth, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000) });
		assert.equal(fresh.status, 200);
		assert.deepEqual(await fresh.json(), { version: 2 });
		console.log('Authentication response ownership passed: ' + mode);
	} finally {
		aborted?.destroy();
		probe.finish?.();
		pendingAbort?.abort();
		await pending?.catch(() => {});
		for (const socket of sockets) socket.terminate();
		await server?.close();
		await reload.close();
		delete globalThis[key];
		await rm(root, { recursive: true, force: true });
	}
}

async function waitBefore(check, label, deadline, now = () => performance.now(), pause = delay) {
	let last;
	while (now() < deadline) {
		try {
			const result = await check();
			if (result && now() < deadline) return result;
		} catch (error) { last = error; }
		const remaining = deadline - now();
		if (remaining > 0) await pause(Math.min(20, remaining));
	}
	throw new Error(label + ' timed out' + (last ? ': ' + last.message : ''));
}

function observeReload(handler, responseDelay, now = () => performance.now()) {
	const normalize = value => String(value).replaceAll('\\', '/');
	const requests = new Set();
	let armed = false;
	let deadline;
	let failure;
	let held = 0;
	let released = false;
	let heldAt;
	let releasedAt;
	let release;
	let hot;
	let originalSend;
	let observedSend;
	function request(payload) {
		if (!armed || payload?.name !== 'fetchModule' || normalize(payload.data?.[0]) !== normalize(handler)) return;
		assert.ok(String(payload.id).startsWith('send:'), 'Handler import must have an RPC request identity');
		requests.add(payload.id.replace('send:', 'response:'));
	}
	return {
		arm() { armed = true; },
		get deadline() { if (failure) throw failure; return deadline; },
		plugin: { name: 'auth-reload-test', configureServer(server) {
			hot = server.environments.ssr.hot;
			originalSend = hot.send;
			hot.api.innerEmitter.on('vite:invoke', request);
			observedSend = hot.send = function (...args) {
				const payload = args[0];
				if (armed && payload?.type === 'full-reload' && normalize(payload.triggeredBy) === normalize(handler)) {
					if (deadline !== undefined) failure ??= new Error('Repeated handler reload');
					else deadline = now() + 10000;
				}
				const response = payload?.data?.data?.result;
				if (responseDelay && armed && payload?.type === 'custom' && payload.event === 'vite:invoke' && payload.data?.name === 'fetchModule' && requests.has(payload.data.id) && (normalize(response?.id) === normalize(handler) || normalize(response?.file) === normalize(handler))) {
					held++;
					if (held === 1) {
						const receiver = this;
						heldAt = now();
						release = new Promise(resolve => {
							function deliver() {
								const remaining = responseDelay - (now() - heldAt);
								if (remaining > 0) { setTimeout(deliver, remaining); return; }
								releasedAt = now();
								try { Reflect.apply(originalSend, receiver, args); }
								catch (error) { failure ??= error; }
								released = true;
								resolve();
							}
							setTimeout(deliver, responseDelay);
						});
						return;
					}
					failure ??= new Error('Repeated delayed handler response');
				}
				return Reflect.apply(originalSend, this, args);
			};
		} },
		assertReady(expectedDelay) {
			if (failure) throw failure;
			assert.ok(deadline !== undefined && now() < deadline, 'Handler must load before its original reload deadline');
			if (expectedDelay) {
				assert.equal(held, 1, 'Exactly one handler import response must be delayed');
				assert.equal(released, true);
				assert.ok(releasedAt - heldAt >= expectedDelay, 'Handler response must remain delayed for the full interval');
				console.log('Authentication handler response delayed: ' + (releasedAt - heldAt));
			}
		},
		async close() {
			await release;
			hot?.api.innerEmitter.off('vite:invoke', request);
			if (hot?.send === observedSend) hot.send = originalSend;
		}
	};
}
