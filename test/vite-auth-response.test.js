import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
	it('keeps authentication response bodies owned by the current handler', async () => {
		try {
			await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--native'], { timeout: 30000 });
		} catch (error) {
			throw new Error((error.stdout || '') + '\n' + (error.stderr || ''), { cause: error });
		}
	}, 35000);
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
	const handler = path.join(root, 'handler.js');
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
	async function connect(origin) {
		const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
		sockets.push(socket);
		socket.on('error', () => {});
		try {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('WebSocket version timed out')), 1000);
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
		await rename(handler + '.next', handler);
		await until(async () => (await connect(origin)).version === 2, 'Replacement WebSocket handler');
	}
	try {
		await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
		await writeFile(handler, source(1));
		server = await createServer({
			root, configFile: false, cacheDir: path.join(root, '.cache'), logLevel: 'error',
			optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0 },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {}, adapter: { name: 'adapter-uws' } } } }, uws({ handler: './handler.js', allowedOrigins: '*' })]
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
			pending = fetch(auth, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(10000) });
			pending.catch(() => {});
			await until(() => probe.finish, 'Authentication response body');
			if (mode.startsWith('reload')) await replace(origin);
			probe.finish(mode.endsWith('reject'));
			const response = await pending;
			assert.equal(response.status, mode === 'reload' ? 503 : 500);
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
		await pending?.catch(() => {});
		for (const socket of sockets) socket.terminate();
		await server?.close();
		delete globalThis[key];
		await rm(root, { recursive: true, force: true });
	}
}
