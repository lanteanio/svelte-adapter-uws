import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const fixtureIndex = process.argv.indexOf('--fixture');
const fixture = fixtureIndex < 0 ? fileURLToPath(new URL('.', import.meta.url)) : resolve(process.argv[fixtureIndex + 1]);
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex < 0 ? null : process.argv[scenarioIndex + 1];
const kit3 = existsSync(resolve(fixture, 'src/socket.js'));
const vite5 = JSON.parse(readFileSync(resolve(fixture, 'node_modules/vite/package.json'))).version.startsWith('5.');
const scenarios = ['finite-import', 'finite-import-rejection', ...(!vite5 ? ['unresolved-import'] : []), ...(!vite5 && !kit3 ? ['unresolved-dependency'] : []), 'direct-import', 'direct-import-rejection', 'dependency-import', 'dependency-import-rejection', 'pending-recreate', 'pending-restart', ...(!kit3 ? ['pending-handler-switch'] : []), 'async-restart', 'hung-init-save', 'hung-init-close', 'hung-init-restart', 'hung-shutdown-save', 'hung-shutdown-close', 'hung-shutdown-restart', ...(kit3 ? ['dependency-syntax', 'dependency-created', 'dependency-transitive-created'] : [])];
if (!scenario) {
	for (const name of scenarios) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture', fixture, '--scenario', name], { stdio: 'inherit', timeout: 75000 });
		assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message ?? ''));
	}
} else {
	assert.ok(scenarios.includes(scenario), 'Unknown lifecycle scenario');
	await run();
}

async function run() {
	process.chdir(fixture);
	const { createServer, version } = await import(pathToFileURL(resolve(fixture, 'node_modules/vite/dist/node/index.js')));
	const { WebSocket } = await import(pathToFileURL(resolve(fixture, 'node_modules/ws/wrapper.mjs')));
	const hooks = resolve(fixture, 'src', kit3 ? 'socket.js' : 'hooks.ws.js');
	const config = resolve(fixture, 'vite.config.js');
	const dependency = resolve(fixture, 'src/lifecycle-proof-state.js');
	const missing = resolve(fixture, 'src/lifecycle-proof-missing.js');
	const alternate = resolve(fixture, 'src/lifecycle-proof-alternate.js');
	const routeDir = resolve(fixture, 'src/routes/lifecycle-proof');
	const route = resolve(routeDir, '+server.js');
	const originalHooks = readFileSync(hooks);
	const originalConfig = readFileSync(config);
	const created = [dependency, missing, alternate, route, hooks + '.next', dependency + '.next', config + '.next'];
	for (const file of [...created, routeDir]) assert.equal(existsSync(file), false, file + ' must not exist');
	const key = '__uwsLifecycleProof';
	const probe = globalThis[key] = { events: [], active: new Set(), edits: 0, releases: [], diagnostics: [], resources: [] };
	const sockets = new Set();
	const originalError = console.error;
	console.error = (...args) => { probe.diagnostics.push(args.map(String).join(' ')); originalError(...args); };
	let server;
	let origin;
	let listenPort;

	const blockImport = rejecting => 'await new Promise((resolve, reject) => { const probe = globalThis[' + JSON.stringify(key) + ']; probe.releaseImport = ' + (rejecting ? "() => reject(new Error('Earlier import failed'))" : 'resolve') + '; probe.releases.push(probe.releaseImport); });\n';
	const stateSource = (value, pending = false, rejecting = false) => (pending ? blockImport(rejecting) : '') + 'export const state = { id: crypto.randomUUID(), count: 0, value: ' + JSON.stringify(value) + ' };\n';
	function handler(value, { pendingImport = false, rejectImport = false, pendingInit = false, pendingShutdown = false, shutdownDelay = 0 } = {}) {
		return `import { state } from './lifecycle-proof-state.js';
const probe = globalThis[${JSON.stringify(key)}];
const owner = crypto.randomUUID();
const value = ${JSON.stringify(value)};
const event = name => probe.events.push({ name, owner, value, time: performance.now() });
event('load');
${pendingImport ? blockImport(rejectImport) + "event('import:end');" : ''}
let initialized = false;
let captured;
const snapshot = () => ({ owner, value, initialized, state, resourceOwner: captured?.ownedResource?.owner, resourceClosed: captured?.ownedResource?.closed });
export async function init({ platform }) {
	event('init:start');
	${pendingInit ? "await new Promise(resolve => { probe.releaseInit = resolve; probe.releases.push(resolve); });" : ''}
	if (probe.lock) throw new Error('The old handler still owns the lifecycle lock');
	probe.lock = owner;
	const resource = { owner, closed: false };
	platform.ownedResource = resource;
	${scenario === 'hung-shutdown-save' ? (value === 'first'
		? "platform.retiredOnly = owner; Object.defineProperty(platform, 'oldMarker', { value: owner, enumerable: true });"
		: "delete platform.retiredOnly; Object.defineProperty(platform, 'newMarker', { value: owner, enumerable: true });") : ''}
	probe.resources.push(resource);
	captured = platform;
	initialized = true;
	probe.active.add(owner);
	event('init:end');
}
export async function shutdown({ platform }) {
	event('shutdown:start');
	${pendingShutdown ? "await new Promise(resolve => { probe.releaseShutdown = resolve; probe.releases.push(resolve); });" : ''}
	await new Promise(resolve => setTimeout(resolve, ${shutdownDelay}));
	${scenario === 'hung-shutdown-save' && value === 'first' ? `
	probe.reflection = {
		keys: Reflect.ownKeys(platform), hasOld: 'retiredOnly' in platform, hasNew: 'newMarker' in platform,
		oldDescriptor: Object.getOwnPropertyDescriptor(platform, 'oldMarker'),
		newDescriptor: Object.getOwnPropertyDescriptor(platform, 'newMarker')
	};
	const resource = Object.getOwnPropertyDescriptor(platform, 'ownedResource')?.value;
	if (resource) resource.closed = true;` : 'if (platform.ownedResource) platform.ownedResource.closed = true;'}
	if (probe.lock === owner) probe.lock = null;
	probe.active.delete(owner);
	event('shutdown:end');
}
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function message(ws) { state.count++; ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
	}
	async function until(check, label, timeout = 10000) {
		const deadline = Date.now() + timeout;
		let last;
		while (Date.now() < deadline) {
			try { const result = await check(); if (result) return result; } catch (error) { last = error; }
			await delay(20);
		}
		throw new Error(label + ' timed out' + (last ? ': ' + last.message : ''));
	}
	async function bounded(promise, label, timeout = 38000) {
		let timer;
		try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout); })]); }
		finally { clearTimeout(timer); }
	}
	async function save(file, text, observe = true) {
		const before = probe.edits;
		writeFileSync(file + '.next', text);
		renameSync(file + '.next', file);
		if (observe) await until(() => probe.edits > before, 'Observed save');
	}
	async function start() {
		if (!listenPort) {
			const reservation = createNetServer();
			await new Promise((resolve, reject) => {
				reservation.once('error', reject);
				reservation.listen(0, '127.0.0.1', resolve);
			});
			listenPort = reservation.address().port;
			await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
		}
		server = await createServer({
			server: { host: '127.0.0.1', port: listenPort, strictPort: true },
			plugins: [{ name: 'observe-lifecycle-proof', enforce: 'post',
				handleHotUpdate() { probe.edits++; }, hotUpdate: { order: 'post', handler() { probe.edits++; } }
			}]
		});
		await server.listen();
		await until(() => Object.entries(server.watcher.getWatched()).some(([directory, files]) => resolve(directory) === resolve(fixture, 'src') && files.includes(basename(hooks))), 'Handler watcher registration');
		await delay(150);
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	}
	function connect() {
		const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
		sockets.add(ws);
		ws.on('error', () => {});
		return bounded(new Promise((resolveResult, reject) => {
			ws.once('unexpected-response', (_request, response) => {
				response.resume();
				reject(new Error('WebSocket admission returned ' + response.statusCode));
			});
			ws.once('error', reject);
			ws.on('message', data => {
				const body = JSON.parse(data.toString());
				if (body.type !== 'welcome') resolveResult({ ws, body });
			});
		}), 'WebSocket admission', 5000).finally(() => { if (ws.readyState !== WebSocket.OPEN) ws.terminate(); });
	}
	async function healthy(expected) {
		const { ws, body } = await connect();
		assert.equal(body.value, expected);
		assert.equal(body.initialized, true);
		assert.equal(body.resourceOwner, body.owner, 'The active handler must see its own initialized resource');
		assert.equal(body.resourceClosed, false, 'Old cleanup must not close the replacement resource');
		const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), body.state, 'HTTP and WebSocket must share one state object');
		const auth = await fetch(origin + '/__ws/auth', {
			method: 'POST', headers: { Origin: origin, 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(5000)
		});
		assert.equal(auth.status, 200);
		assert.deepEqual(await auth.json(), body);
		ws.terminate();
		return body;
	}
	async function eventuallyHealthy(expected, timeout = 12000) {
		return until(() => healthy(expected), 'Healthy handler ' + expected, timeout);
	}
	const saw = (name, value) => probe.events.some(event => event.name === name && event.value === value);
	async function close() {
		for (const socket of sockets) socket.terminate();
		await bounded(server?.close(), 'Server close');
		server = null;
	}
	async function restart() {
		for (const socket of sockets) socket.terminate();
		await bounded(server.restart(), 'Server restart');
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	}
	try {
		mkdirSync(routeDir);
		writeFileSync(route, "import { state } from '../../lifecycle-proof-state.js';\nexport function GET() { return Response.json(state); }\n");
		writeFileSync(dependency, stateSource('shared'));
		if (scenario === 'dependency-syntax') writeFileSync(dependency, 'export const state = { ;\n');
		if (scenario === 'dependency-created') unlinkSync(dependency);
		if (scenario === 'dependency-transitive-created') writeFileSync(dependency, "export { state } from './lifecycle-proof-missing.js';\n");
		const pendingImport = scenario.startsWith('finite-import') || scenario.startsWith('pending-') || scenario === 'unresolved-import';
		const pendingInit = scenario.startsWith('hung-init');
		const pendingShutdown = scenario.startsWith('hung-shutdown');
		writeFileSync(hooks, handler('first', { pendingImport, rejectImport: scenario.endsWith('-rejection'), pendingInit, pendingShutdown, shutdownDelay: scenario === 'async-restart' ? 300 : 0 }));
		await start();
		if (['dependency-syntax', 'dependency-created', 'dependency-transitive-created'].includes(scenario)) {
			await assert.rejects(connect());
			await save(scenario === 'dependency-transitive-created' ? missing : dependency, stateSource('fixed'), false);
			const current = await eventuallyHealthy('first');
			assert.equal(current.state.value, 'fixed');
		} else if (scenario === 'unresolved-dependency') {
			const first = await healthy('first');
			await save(dependency, stateSource('pending', true));
			await until(() => probe.releaseImport, 'Unresolved dependency import');
			await delay(150);
			await save(dependency, stateSource('fixed'));
			await until(() => probe.events.some(event => event.name === 'init:end' && event.owner !== first.owner), 'Replacement initialization without the old dependency', 3000);
			const current = await healthy('first');
			assert.equal(current.state.value, 'fixed');
			await delay(1500);
			assert.equal((await healthy('first')).state.id, current.state.id, 'The replacement graph must stay shared while the old dependency is unresolved');
		} else if (scenario === 'unresolved-import') {
			await until(() => probe.releaseImport, 'Unresolved startup import');
			await delay(150);
			await save(hooks, handler('second'));
			await until(() => saw('init:end', 'second'), 'Replacement initialization without the old import', 3000);
			await healthy('second');
			assert.equal(saw('init:start', 'first'), false);
		} else if (scenario.startsWith('finite-import')) {
			await until(() => probe.releaseImport, 'Pending startup import');
			await delay(150);
			await save(hooks, handler('second'));
			probe.releaseImport();
			await eventuallyHealthy('second');
			assert.equal(saw('init:start', 'first'), false, 'The superseded import must never initialize');
			await delay(150);
			await save(hooks, handler('third'));
			await eventuallyHealthy('third');
		} else if (scenario.startsWith('direct-import') || scenario.startsWith('dependency-import')) {
			await healthy('first');
			const dependencyEdit = scenario.startsWith('dependency-import');
			await save(dependencyEdit ? dependency : hooks, dependencyEdit
				? stateSource('pending', true, scenario.endsWith('-rejection'))
				: handler('second', { pendingImport: true, rejectImport: scenario.endsWith('-rejection') }));
			await until(() => probe.releaseImport, 'Pending replacement import');
			await delay(150);
			await save(dependencyEdit ? dependency : hooks, dependencyEdit ? stateSource('fixed') : handler('third'));
			probe.releaseImport();
			const current = await eventuallyHealthy(dependencyEdit ? 'first' : 'third');
			if (dependencyEdit) assert.equal(current.state.value, 'fixed');
			await delay(150);
			await save(hooks, handler('fourth'));
			await eventuallyHealthy('fourth');
		} else if (scenario === 'pending-restart' || scenario === 'pending-handler-switch') {
			await until(() => probe.releaseImport, 'Pending startup import');
			const release = probe.releaseImport;
			await server.watcher.close();
			if (scenario === 'pending-handler-switch') {
				writeFileSync(alternate, handler('second'));
				assert.ok(originalConfig.toString().includes('uws()'));
				writeFileSync(config, originalConfig.toString().replace('uws()', "uws({ handler: './src/lifecycle-proof-alternate.js' })"));
			} else writeFileSync(hooks, handler('second'));
			await restart();
			release();
			await eventuallyHealthy('second');
		} else if (scenario === 'pending-recreate') {
			await until(() => probe.releaseImport, 'Pending startup import');
			const release = probe.releaseImport;
			await close();
			writeFileSync(hooks, handler('second'));
			await start();
			release();
			await eventuallyHealthy('second');
			await close();
			writeFileSync(hooks, handler('third'));
			await start();
			await eventuallyHealthy('third');
		} else if (scenario === 'async-restart') {
			const first = await healthy('first');
			await save(config, originalConfig.toString() + '\n// Restart lifecycle configuration.\n', false);
			await until(() => probe.events.some(event => event.name === 'init:end' && event.owner !== first.owner), 'Configuration restart initialization');
			const current = await eventuallyHealthy('first');
			assert.notEqual(current.owner, first.owner);
			const shutdown = probe.events.findIndex(event => event.name === 'shutdown:end' && event.owner === first.owner);
			const init = probe.events.findIndex(event => event.name === 'init:start' && event.owner === current.owner);
			assert.ok(shutdown >= 0 && init > shutdown, 'Replacement init must await the previous asynchronous shutdown');
		} else {
			await until(() => saw('init:start', 'first'), 'Initial initialization');
			if (pendingShutdown) await healthy('first');
			if (scenario.endsWith('-save')) {
				// A hung hook may retain external resources; this test tracks ordering separately.
				if (pendingShutdown) probe.lock = null;
				await save(hooks, handler('second'));
				await eventuallyHealthy('second', 38000);
			} else if (scenario.endsWith('-restart')) {
				await server.watcher.close();
				writeFileSync(hooks, handler('second'));
				if (pendingShutdown) probe.lock = null;
				await restart();
				await eventuallyHealthy('second');
			} else {
				await close();
			}
			if (scenario === 'hung-shutdown-save') {
				probe.releaseShutdown();
				await until(() => saw('shutdown:end', 'first'), 'Late shutdown cleanup');
				const oldOwner = probe.events.find(event => event.name === 'init:start' && event.value === 'first').owner;
				assert.equal(probe.resources.find(resource => resource.owner === oldOwner)?.closed, true, 'Reflected cleanup must close the retired resource');
				assert.ok(probe.reflection.keys.includes('oldMarker'));
				assert.equal(probe.reflection.keys.includes('newMarker'), false, 'Retired ownKeys must exclude replacement properties');
				assert.equal(probe.reflection.hasOld, true);
				assert.equal(probe.reflection.hasNew, false);
				assert.equal(probe.reflection.oldDescriptor.value, oldOwner);
				assert.equal(probe.reflection.oldDescriptor.configurable, false);
				assert.equal(probe.reflection.newDescriptor, undefined);
				await healthy('second');
			}
			if (pendingInit) {
				// A late completion is cleaned up and cannot replace the current owner.
				const currentLock = probe.lock;
				probe.lock = null;
				probe.releaseInit();
				await until(() => saw('shutdown:end', 'first'), 'Late initialization cleanup');
				const oldOwner = probe.events.find(event => event.name === 'init:start' && event.value === 'first').owner;
				assert.equal(probe.resources.find(resource => resource.owner === oldOwner)?.closed, true, 'Late init writes must remain available to its own cleanup');
				probe.lock = currentLock;
				if (server) await eventuallyHealthy('second');
			}
		}
		if (scenario.startsWith('hung-')) {
			const hook = pendingInit ? 'init' : 'shutdown';
			assert.ok(probe.diagnostics.some(message => message.includes('WebSocket ' + hook + ' hook did not finish')), 'An abandoned hook must have an actionable diagnostic');
		}
		console.log('Lifecycle recovery passed on Vite ' + version + ': ' + scenario);
	} catch (error) {
		console.error('Lifecycle events:', JSON.stringify(probe.events));
		throw error;
	} finally {
		for (const release of probe.releases) release();
		try { await close(); } finally {
			writeFileSync(hooks, originalHooks);
			writeFileSync(config, originalConfig);
			for (const file of created) if (existsSync(file)) unlinkSync(file);
			if (existsSync(routeDir)) rmdirSync(routeDir);
			console.error = originalError;
			delete globalThis[key];
		}
	}
}
