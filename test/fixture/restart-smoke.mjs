import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureIndex = process.argv.indexOf('--fixture');
const fixture = fixtureIndex < 0 ? fileURLToPath(new URL('.', import.meta.url)) : resolve(process.argv[fixtureIndex + 1]);
const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex < 0 ? null : process.argv[modeIndex + 1];
if (!mode) {
	for (const name of ['config', 'inline']) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture', fixture, '--mode', name], { stdio: 'inherit', timeout: 45000 });
		assert.equal(result.status, 0, name + ' restart failed: ' + (result.error?.message ?? ''));
	}
} else {
	assert.ok(['config', 'inline'].includes(mode), 'Unknown restart mode');
	await run();
}

async function run() {
	process.chdir(fixture);
	const { createServer, loadConfigFromFile, version } = await import(pathToFileURL(resolve(fixture, 'node_modules/vite/dist/node/index.js')));
	const { WebSocket } = await import(pathToFileURL(resolve(fixture, 'node_modules/ws/wrapper.mjs')));
	const kit3 = existsSync(resolve(fixture, 'src/socket.js'));
	const hooks = resolve(fixture, 'src', kit3 ? 'socket.js' : 'hooks.ws.js');
	const dependency = resolve(fixture, 'src/restart-proof-state.js');
	const routeDir = resolve(fixture, 'src/routes/restart-proof');
	const route = resolve(routeDir, '+server.js');
	const originalHooks = readFileSync(hooks);
	for (const file of [dependency, routeDir]) assert.equal(existsSync(file), false, file + ' must not exist');
	const key = '__uwsRestartProof';
	const probe = globalThis[key] = { events: [], active: new Set() };
	const sockets = new Set();
	let server;
	let origin;

	const handler = value => `import { state } from './restart-proof-state.js';
const probe = globalThis[${JSON.stringify(key)}];
const owner = crypto.randomUUID();
const value = ${JSON.stringify(value)};
const event = name => probe.events.push({ name, owner, value, time: performance.now() });
event('load');
let initialized = false;
const snapshot = () => ({ owner, value, initialized, state });
export function init() {
	if (probe.active.size) throw new Error('The old handler has not finished shutdown');
	probe.active.add(owner);
	initialized = true;
	event('init');
}
export async function shutdown() {
	event('shutdown:start');
	await new Promise(resolve => setTimeout(resolve, 100));
	probe.active.delete(owner);
	event('shutdown:end');
}
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function message(ws) { state.count++; ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
	async function bounded(promise, label, timeout = 10000) {
		let timer;
		try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout); })]); }
		finally { clearTimeout(timer); }
	}
	function receive(ws) {
		return bounded(new Promise((resolveResult, reject) => {
			const failed = error => { cleanup(); reject(error); };
			const unexpected = (_request, response) => { response.resume(); failed(new Error('WebSocket admission returned ' + response.statusCode)); };
			const message = data => {
				const body = JSON.parse(data.toString());
				if (body.type === 'welcome') return;
				cleanup(); resolveResult(body);
			};
			const cleanup = () => { ws.off('error', failed); ws.off('unexpected-response', unexpected); ws.off('message', message); };
			ws.on('message', message); ws.once('error', failed); ws.once('unexpected-response', unexpected);
		}), 'WebSocket response', 5000);
	}
	async function healthy(value) {
		const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
		sockets.add(ws);
		ws.on('error', () => {});
		const body = await receive(ws);
		assert.equal(body.value, value);
		assert.equal(body.initialized, true);
		const response = await fetch(origin + '/restart-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), body.state, 'HTTP and WebSocket must share module state');
		const reply = receive(ws);
		ws.send('increment');
		const incremented = await reply;
		assert.equal(incremented.state.count, body.state.count + 1);
		const updated = await fetch(origin + '/restart-proof', { signal: AbortSignal.timeout(5000) });
		assert.deepEqual(await updated.json(), incremented.state);
		const auth = await fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin, 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(5000) });
		assert.equal(auth.status, 200, await auth.clone().text());
		assert.deepEqual(await auth.json(), incremented);
		return { ws, body: incremented };
	}
	try {
		mkdirSync(routeDir);
		writeFileSync(route, "import { state } from '../../restart-proof-state.js';\nexport function GET() { return Response.json(state); }\n");
		writeFileSync(dependency, 'export const state = { id: crypto.randomUUID(), count: 0 };\n');
		writeFileSync(hooks, handler('first'));
		const reservation = createNetServer();
		await new Promise((resolveResult, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolveResult); });
		const port = reservation.address().port;
		await new Promise((resolveResult, reject) => reservation.close(error => error ? reject(error) : resolveResult()));
		const loaded = mode === 'inline' ? await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(fixture, 'vite.config.js'), fixture) : null;
		server = await createServer({
			...(loaded ? { ...loaded.config, configFile: false } : {}),
			plugins: [...(loaded?.config.plugins ?? []), {
				name: 'observe-server-close', enforce: 'pre',
				configureServer(configured) {
					const http = configured.httpServer;
					let requests = 0;
					const observe = () => { requests++; };
					http.on('request', observe);
					const close = configured.close;
					configured.close = async function () {
						try {
							assert.ok(this?.httpServer === http, 'Composed server.close must retain its receiver');
							assert.ok(requests > 0, 'The server must handle real HTTP before closure');
							this.httpServer.off('request', observe);
						} finally { await close.call(configured); }
					};
				}
			}],
			root: fixture,
			server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/*'] } }
		});
		await server.listen();
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
		let previous = await healthy('first');
		for (const value of ['first', 'first', 'second', 'third']) {
			if (value !== previous.body.value) writeFileSync(hooks, handler(value));
			const closed = new Promise(resolveResult => previous.ws.once('close', code => resolveResult(code)));
			await bounded(server.restart(), 'Server restart');
			await bounded(closed, 'Retired connection close');
			origin = 'http://127.0.0.1:' + server.httpServer.address().port;
			const current = await healthy(value);
			assert.notEqual(current.body.owner, previous.body.owner, 'Restart must initialize a replacement handler');
			assert.notEqual(current.body.state.id, previous.body.state.id, 'Restart must use the replacement module graph');
			const retired = probe.events.filter(event => event.owner === previous.body.owner && event.name === 'shutdown:end');
			assert.equal(retired.length, 1, 'Retired handler must shut down once');
			const loadedHandler = probe.events.find(event => event.owner === current.body.owner && event.name === 'load');
			assert.ok(retired[0].time < loadedHandler.time, 'Old async shutdown must finish before the replacement handler loads');
			assert.deepEqual([...probe.active], [current.body.owner]);
			previous = current;
		}
		for (const socket of sockets) socket.terminate();
		await bounded(server.close(), 'Final close');
		server = null;
		assert.equal(probe.active.size, 0, 'Server close must await async shutdown');
		assert.equal(probe.events.filter(event => event.name === 'shutdown:end').length, 5);
		console.log('Restart lifecycle passed on Vite ' + version + ': ' + mode + ', unchanged and changed source, HTTP/WS/auth shared state');
	} finally {
		for (const socket of sockets) socket.terminate();
		try { await bounded(server?.close(), 'Cleanup close'); }
		finally {
			writeFileSync(hooks, originalHooks);
			for (const file of [dependency, route]) if (existsSync(file)) unlinkSync(file);
			if (existsSync(routeDir)) rmdirSync(routeDir);
			delete globalThis[key];
		}
	}
}