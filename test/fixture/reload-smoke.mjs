import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureOption = process.argv.indexOf('--fixture');
const fixture = fixtureOption === -1 ? fileURLToPath(new URL('.', import.meta.url)) : resolve(process.argv[fixtureOption + 1]);
process.chdir(fixture);
const { createServer, version } = await import(pathToFileURL(resolve(fixture, 'node_modules/vite/dist/node/index.js')));
const { WebSocket } = await import(pathToFileURL(resolve(fixture, 'node_modules/ws/wrapper.mjs')));
const hooksPath = resolve(fixture, 'src/hooks.ws.js');
const originalHooks = readFileSync(hooksPath);
const sharedPath = resolve(fixture, 'src/reload-state.js');
const routeDir = resolve(fixture, 'src/routes/reload-proof');
const routePath = resolve(routeDir, '+server.js');
const pagePath = resolve(routeDir, '+page.svelte');
const createdPaths = [sharedPath, routePath, pagePath];
for (const file of [...createdPaths, routeDir, hooksPath + '.next', sharedPath + '.next', pagePath + '.next']) {
	assert.equal(existsSync(file), false, file + ' must not already exist');
}

function sharedSource(version) {
	return `import { randomUUID } from 'node:crypto';
export const shared = { id: randomUUID(), version: ${version}, count: 0 };
`;
}

function hooksSource(version) {
	return `import { randomUUID } from 'node:crypto';
import { shared } from './reload-state.js';
const id = randomUUID();
const lifecycle = globalThis.__kit2ReloadLifecycle ??= { events: [], active: new Set() };
let captured;
export async function init({ platform }) {
	await new Promise(resolve => setImmediate(resolve));
	captured = platform;
	lifecycle.active.add(id);
	lifecycle.events.push(['init', id]);
}
export async function shutdown() {
	await new Promise(resolve => setImmediate(resolve));
	lifecycle.active.delete(id);
	lifecycle.events.push(['shutdown', id]);
}
export function message(ws) {
	shared.count++;
	ws.send(JSON.stringify({ id, version: ${version}, initialized: Boolean(captured), shared: { ...shared }, active: [...lifecycle.active], events: lifecycle.events }));
}
`;
}

function save(file, source) {
	writeFileSync(file + '.next', source);
	renameSync(file + '.next', file);
}

async function until(check, label) {
	const deadline = Date.now() + 15000;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
			last = value;
		} catch (error) { last = error; }
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error(label + ' timed out: ' + String(last));
}

let server;
let origin;
const sockets = new Set();
const observed = new Map();
function observedChange(file) {
	observed.set(resolve(file), (observed.get(resolve(file)) ?? 0) + 1);
}

async function edited(file, source) {
	const previous = observed.get(file) ?? 0;
	save(file, source);
	await until(() => (observed.get(file) ?? 0) > previous, 'Vite hot update for ' + file).catch(error => {
		throw new Error(error.message + '\nObserved updates: ' + JSON.stringify([...observed]));
	});
}

async function httpState() {
	const response = await fetch(origin + '/reload-proof', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
	assert.equal(response.status, 200, await response.clone().text());
	return response.json();
}

async function page(version) {
	return until(async () => {
		const response = await fetch(origin + '/reload-proof', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
		return response.ok && (await response.text()).includes('Reload page ' + version);
	}, 'rendered page version ' + version);
}

async function connect() {
	const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
	sockets.add(ws);
	ws.on('error', () => {});
	ws.closed = null;
	ws.on('close', code => { ws.closed = code; });
	await once(ws, 'open', { signal: AbortSignal.timeout(10000) });
	return ws;
}

async function ping(ws) {
	assert.equal(ws.readyState, WebSocket.OPEN, 'The current WebSocket must remain open');
	const reply = new Promise((resolveReply, reject) => {
		const timer = setTimeout(() => finish(new Error('WebSocket reply timed out')), 5000);
		function finish(error, value) {
			clearTimeout(timer);
			ws.off('message', message);
			ws.off('error', fail);
			ws.off('close', closed);
			if (error) reject(error); else resolveReply(value);
		}
		function message(data) {
			try { finish(null, JSON.parse(data.toString())); } catch (error) { finish(error); }
		}
		const fail = error => finish(error);
		const closed = code => finish(new Error('WebSocket closed during reply: ' + code));
		ws.on('message', message);
		ws.on('error', fail);
		ws.on('close', closed);
	});
	ws.send('ping');
	return reply;
}

function initialized(state) {
	assert.equal(state.initialized, true, 'The active handler must have completed init');
	assert.deepEqual(state.active, [state.id], 'Only the current handler may own active resources');
}

function replaced(previous, current) {
	initialized(current);
	assert.notEqual(current.id, previous.id, 'The changed handler must be reevaluated');
	assert.deepEqual(current.events.slice(previous.events.length), [
		['shutdown', previous.id], ['init', current.id]
	], 'Each edit must shut down its old handler before initializing one replacement');
}

try {
	mkdirSync(routeDir);
	writeFileSync(sharedPath, sharedSource(1));
	writeFileSync(hooksPath, hooksSource(1));
	writeFileSync(routePath, `import { shared } from '../../reload-state.js';
export function GET() { return Response.json({ ...shared }); }
`);
	writeFileSync(pagePath, '<h1>Reload page 1</h1>\n');
	server = await createServer({
		server: { host: '127.0.0.1', port: 0 },
		plugins: [{
			name: 'fixture-observe-hot-updates',
			enforce: 'post',
			handleHotUpdate({ file }) { observedChange(file); },
			hotUpdate: { order: 'post', handler({ file }) { observedChange(file); } }
		}]
	});
	await server.listen();
	origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	await page(1);
	await httpState();
	let ws = await connect();
	let current = await ping(ws);
	initialized(current);
	assert.deepEqual(current.events, [['init', current.id]], 'Startup must initialize exactly one handler');
	assert.deepEqual(await httpState(), current.shared, 'HTTP and WebSocket must initially share state');

	if (!process.argv.includes('--unrelated-only')) {
		const previous = current;
		await edited(sharedPath, sharedSource(2));
		await until(() => ws.closed === 1012, 'old handler WebSocket close');
		ws = await connect();
		current = await ping(ws);
		replaced(previous, current);
		assert.equal(current.shared.version, 2);
		assert.deepEqual(await httpState(), current.shared, 'HTTP and WebSocket must share the same module after a dependency edit');
		console.log('Kit 2 shared-module reload passed on Vite ' + version);
	}

	if (!process.argv.includes('--shared-only')) {
		const previous = current;
		await edited(hooksPath, hooksSource(2));
		await until(() => ws.closed === 1012, 'direct handler edit WebSocket close');
		ws = await connect();
		current = await ping(ws);
		replaced(previous, current);
		assert.equal(current.version, 2);
		for (let revision = 2; revision <= 3; revision++) {
			await edited(pagePath, '<h1>Reload page ' + revision + '</h1>\n');
			await page(revision);
			// Exercise requests through the completed page update and deferred reload work.
			// A live connection and unchanged lifecycle are the oracle, not a timer alone.
			const deadline = Date.now() + 250;
			do {
				const state = await ping(ws);
				initialized(state);
				assert.equal(state.id, current.id, 'An unrelated page must retain the handler instance');
				assert.deepEqual(state.events, current.events, 'An unrelated page must not run shutdown or init');
				assert.deepEqual(await httpState(), state.shared);
			} while (Date.now() < deadline);
		}
		console.log('Kit 2 unrelated-page reload passed on Vite ' + version);
	}
} catch (error) {
	console.error('Handler lifecycle:', globalThis.__kit2ReloadLifecycle?.events);
	throw error;
} finally {
	for (const ws of sockets) ws.terminate();
	try { await server?.close(); } finally {
		writeFileSync(hooksPath, originalHooks);
		for (const file of [...createdPaths, hooksPath + '.next', sharedPath + '.next', pagePath + '.next']) {
			if (existsSync(file)) unlinkSync(file);
		}
		if (existsSync(routeDir)) rmdirSync(routeDir);
		delete globalThis.__kit2ReloadLifecycle;
	}
}
