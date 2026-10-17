import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scenarioIndex = process.argv.indexOf('--import-recovery-scenario');
const scenario = scenarioIndex < 0 ? null : process.argv[scenarioIndex + 1];
const fixture = fileURLToPath(new URL('.', import.meta.url));
const scenarios = ['direct-rejection', 'transitive-rejection', 'direct-overlap', 'transitive-overlap', 'direct-recreate', 'transitive-recreate', 'unresolved-import'];
if (!scenario) {
	for (const name of scenarios) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--import-recovery-scenario', name], { stdio: 'inherit', timeout: 40000 });
		assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message ?? ''));
	}
} else {
	assert.ok([...scenarios, 'fresh-process'].includes(scenario));
	await run();
}

async function run() {
	process.chdir(fixture);
	const { createServer, version } = await import('vite');
	const { WebSocket } = await import('ws');
	assert.match(version, /^5\./);
	const hooks = resolve(fixture, 'src/hooks.ws.js');
	const state = resolve(fixture, 'src/import-recovery-state.js');
	const bridge = resolve(fixture, 'src/import-recovery-bridge.js');
	const routeDir = resolve(fixture, 'src/routes/import-recovery');
	const route = resolve(routeDir, '+server.js');
	const original = readFileSync(hooks);
	const created = [state, bridge, route, hooks + '.next', state + '.next'];
	const fresh = scenario === 'fresh-process';
	const transitive = scenario.startsWith('transitive');
	if (!fresh) for (const file of [...created, routeDir]) assert.equal(existsSync(file), false, file + ' must not exist');
	const probe = globalThis.__uwsImportRecovery = { started: false, errors: [], windows: 0, imports: 0 };
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeError = console.error;
	console.error = (...args) => { probe.errors.push(args.map(String).join(' ')); nativeError(...args); };
	let server;
	let origin;
	let armed = false;
	const sockets = new Set();
	const block = "await new Promise((resolve, reject) => { globalThis.__uwsImportRecovery.started = true; globalThis.__uwsImportRecovery.reject = () => reject(new Error('Earlier import failed')); });\n";
	const shared = (pending = false) => (pending ? block : '') + "export const state = { id: crypto.randomUUID(), count: 0 };\n";
	const handler = (pending = false) => "import { state } from './import-recovery-bridge.js';\n" + (pending ? block : '') + `
const probe = globalThis.__uwsImportRecovery;
probe.imports++;
export function open(ws) { ws.send(JSON.stringify(state)); }
export function message(ws) { state.count++; ws.send(JSON.stringify(state)); }
export function authenticate() { return Response.json(state); }
`;
	async function until(check, label, timeout = 6000) {
		const end = Date.now() + timeout;
		let last;
		while (Date.now() < end) {
			try { const value = await check(); if (value) return value; } catch (error) { last = error; }
			await delay(20);
		}
		throw new Error(label + ' timed out' + (last ? ': ' + last.message : ''));
	}
	async function start() {
		server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
		await server.listen();
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	}
	function connect() {
		return new Promise((resolveResult, reject) => {
			const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
			sockets.add(ws);
			const timer = nativeSetTimeout(() => { ws.terminate(); reject(new Error('WebSocket timed out')); }, 4000);
			ws.once('unexpected-response', (_request, response) => {
				clearTimeout(timer);
				let body = '';
				response.on('data', data => { body += data; });
				response.once('end', () => resolveResult({ status: response.statusCode, body }));
			});
			ws.on('error', error => { clearTimeout(timer); reject(error); });
			ws.on('message', data => {
				const body = JSON.parse(data.toString());
				if (body.type !== 'welcome') { clearTimeout(timer); resolveResult({ status: 101, body, ws }); }
			});
		});
	}
	function auth() {
		return fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin, 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(4000) });
	}
	async function healthy() {
		const opened = await connect();
		assert.equal(opened.status, 101);
		const message = new Promise(resolve => opened.ws.once('message', data => resolve(JSON.parse(data.toString()))));
		opened.ws.send('increment');
		const updated = await message;
		assert.equal(updated.id, opened.body.id);
		assert.equal(updated.count, opened.body.count + 1);
		const http = await fetch(origin + '/import-recovery', { signal: AbortSignal.timeout(4000) });
		assert.equal(http.status, 200);
		assert.deepEqual(await http.json(), updated, 'HTTP and WebSocket must share their module state');
		const authenticated = await auth();
		assert.equal(authenticated.status, 200);
		assert.deepEqual(await authenticated.json(), updated, 'Authentication must use the active handler');
		opened.ws.terminate();
		return true;
	}
	async function blocked() {
		const opened = await connect();
		assert.equal(opened.status, 503);
		const response = await auth();
		assert.equal(response.status, 503);
		const text = await response.text();
		if (scenario === 'unresolved-import') {
			assert.match(opened.body, /never settles.*restart the dev process/);
			assert.match(text, /never settles.*restart the dev process/);
		}
		return { websocket: opened.body, authentication: text };
	}
	async function close() {
		for (const socket of sockets) socket.terminate();
		await server?.close();
		server = null;
	}
	try {
		if (!fresh) {
			mkdirSync(routeDir);
			writeFileSync(route, "import { state } from '../../import-recovery-state.js';\nexport function GET() { return Response.json(state); }\n");
			writeFileSync(bridge, "export { state } from './import-recovery-state.js';\n");
			writeFileSync(state, shared(transitive));
			writeFileSync(hooks, handler(!transitive));
		}
		await start();
		if (fresh) { await until(healthy, 'Fresh process recovery'); return; }
		await until(() => probe.started, 'Pending import');
		await delay(200);
		const edited = transitive ? state : hooks;
		if (scenario.endsWith('-recreate')) await close();
		if (scenario.endsWith('-overlap')) {
			writeFileSync(edited + '.next', edited === state ? shared() : handler());
			renameSync(edited + '.next', edited);
			await until(blocked, 'First replacement waiting for the earlier import');
			await delay(200);
		}
		if (scenario !== 'unresolved-import') {
			globalThis.setTimeout = (callback, milliseconds, ...args) => {
				if (armed && milliseconds === 1 && /[\\/]vite\.js:/.test(new Error().stack)) {
					armed = false;
					probe.windows++;
					probe.reject();
					// Complete the old rejection while the replacement waits to import.
					return nativeSetTimeout(callback, 40, ...args);
				}
				return nativeSetTimeout(callback, milliseconds, ...args);
			};
			armed = true;
		}
		writeFileSync(edited + '.next', (edited === state ? shared() : handler()) + '\n');
		renameSync(edited + '.next', edited);
		if (scenario.endsWith('-recreate')) await start();
		if (scenario === 'unresolved-import') {
			await delay(500);
			console.log('Unresolved import responses:', await blocked());
			await close();
			await start();
			await delay(100);
			console.log('Recreated server responses:', await blocked());
			assert.equal(probe.imports, 0, 'A pending Vite 5 import must not install callbacks');
			await close();
			const restarted = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--import-recovery-scenario', 'fresh-process'], { stdio: 'inherit', timeout: 20000 });
			assert.equal(restarted.status, 0, 'A fresh dev process must load the corrected source');
		} else {
			await until(() => probe.windows === 1, 'Rejection inside the replacement import delay');
			await until(() => probe.errors.some(message => message.includes('Earlier import failed')), 'Old rejection reported');
			await until(healthy, 'Recovery after cached rejection');
			assert.equal(probe.windows, 1);
			assert.equal(probe.imports, 1, 'Only the corrected handler may finish evaluating');
			await delay(200);
			await healthy();
		}
		console.log('PASS Vite ' + version + ' ' + scenario);
	} finally {
		globalThis.setTimeout = nativeSetTimeout;
		console.error = nativeError;
		await close();
		delete globalThis.__uwsImportRecovery;
		if (!fresh) {
			writeFileSync(hooks, original);
			for (const file of created) if (existsSync(file)) unlinkSync(file);
			if (existsSync(routeDir)) rmdirSync(routeDir);
		}
	}
}
