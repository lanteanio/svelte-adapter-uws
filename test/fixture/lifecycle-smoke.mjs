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
const scenarios = ['finite-import', 'finite-import-rejection', ...(!vite5 ? ['unresolved-import'] : []), ...(!vite5 && !kit3 ? ['unresolved-dependency'] : []), 'direct-import', 'direct-import-rejection', 'dependency-import', 'dependency-import-rejection', 'pending-recreate', 'pending-restart', ...(!kit3 ? ['pending-handler-switch'] : []), 'async-restart', 'platform-subscription-owner', 'platform-reset-guard', 'platform-reset-generation', 'platform-reset-global', 'platform-cleanup', 'platform-persistent', 'platform-persistent-shutdown', 'platform-persistent-current', 'platform-persistent-fixed', 'platform-persistent-nonextensible', 'platform-constrained-delete', 'platform-constrained-readonly', 'platform-constrained-cleanup', 'platform-constrained-setter', 'platform-constrained-fixed-setter', 'platform-constrained-add-setter', 'platform-constrained-remove-setter', 'platform-constrained-sealed-noop', 'platform-proto-resource', 'platform-foreign', 'platform-foreign-active', 'platform-init-throw', 'platform-throw', 'platform-timeout', 'platform-init-timeout', 'hung-init-save', 'hung-init-close', 'hung-init-restart', 'hung-shutdown-save', 'hung-shutdown-close', 'hung-shutdown-restart', ...(kit3 ? ['dependency-syntax', 'dependency-created', 'dependency-transitive-created'] : [])];
if (!scenario) {
	for (const name of scenarios) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture', fixture, '--scenario', name], { stdio: 'inherit', timeout: name === 'platform-reset-generation' ? 100000 : 75000 });
		assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message ?? ''));
	}
	const restart = spawnSync(process.execPath, [fileURLToPath(new URL('restart-smoke.mjs', import.meta.url)), '--fixture', fixture], { stdio: 'inherit', timeout: 90000 });
	assert.equal(restart.status, 0, 'Restart lifecycle failed: ' + (restart.error?.message ?? ''));
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
	function platformHandler(value, { passive = false } = {}) {
		return `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
const owner = crypto.randomUUID();
let captured;
let previousPublish;
let previousDepth;
const snapshot = () => ({ value, owner, depth: captured.platformDepth ?? null, poolOwner: captured.platformPool?.owner, poolClosed: captured.platformPool?.closed });
export async function init({ platform }) {
	captured = platform;
	probe.platform = platform;
	probe.inherited.push({ value, depth: platform.platformDepth, pool: platform.platformPool, handoff: platform.platformHandoff, marker: platform.platformMarker });
	${passive ? '' : `previousPublish = platform.publish;
	previousDepth = platform.platformDepth;
	platform.publish = (...args) => { probe.wrapperHits++; return previousPublish(...args); };
	platform.platformDepth = (previousDepth ?? 0) + 1;
	platform.platformPool = { owner, closed: false };
	probe.resources.push(platform.platformPool);
	platform.platformInitOnly = owner;
	Object.defineProperty(platform, 'platformMarker', { value: owner, enumerable: true, configurable: true });
	Object.defineProperty(platform, 'platformAccessor', { get: () => owner, enumerable: true, configurable: true });`}
	${value === 'first' && scenario === 'platform-init-throw' ? "throw new Error('Platform initialization failed');" : ''}
	${value === 'first' && scenario === 'platform-init-timeout' ? 'await new Promise(resolve => { probe.releaseInit = resolve; probe.releases.push(resolve); });' : ''}
	probe.events.push({ name: 'init:end', owner, value });
}
export async function shutdown({ platform }) {
	probe.events.push({ name: 'shutdown:start', owner, value });
	${value === 'first' && ['platform-foreign', 'platform-foreign-active', 'platform-timeout'].includes(scenario) ? 'await new Promise(resolve => { probe.releaseShutdown = resolve; probe.releases.push(resolve); });' : 'await new Promise(resolve => setTimeout(resolve, 40));'}
	${value === 'first' && scenario === 'platform-throw' ? "throw new Error('Platform cleanup failed');" : ''}
	${passive ? '' : `const pool = Object.getOwnPropertyDescriptor(platform, 'platformPool')?.value;
	if (pool) pool.closed = true;
	delete platform.platformPool;
	delete platform.platformInitOnly;
	delete platform.platformAccessor;
	platform.publish = previousPublish;
	if (previousDepth === undefined) delete platform.platformDepth;
	else platform.platformDepth = previousDepth;
	platform.platformHandoff = value;`}
	probe.events.push({ name: 'shutdown:end', owner, value });
}
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
	}
	function persistentPlatformHandler(value) {
		return `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
let captured;
const snapshot = () => ({ value, marker: captured.persistentMarker, counter: captured.persistentCounter });
export async function init({ platform }) {
	captured = platform;
	${['platform-persistent-current', 'platform-persistent-fixed', 'platform-persistent-nonextensible'].includes(scenario) ? "platform.persistentCounter = ['first', 'second', 'third', 'fourth'].indexOf(value) * 100;" : ''}
	platform.persistentCurrent = value;
	if (value !== 'first') await new Promise(resolve => { probe.releaseInit = resolve; probe.releases.push(resolve); });
	// This guard survives module reloads and is independent of the platform.
	if (!probe.wrapped) {
		probe.wrapped = true;
		const publish = platform.publish;
		${scenario === 'platform-persistent-fixed' ? "Object.defineProperty(platform, 'persistentCounter', { value: 0, writable: true, enumerable: true, configurable: false });" : 'platform.persistentCounter = 0;'}
		platform.publish = (...args) => {
			probe.wrapperHits++;
			platform.persistentCounter++;
			probe.reflection = {
				has: 'persistentCurrent' in platform,
				current: Object.getOwnPropertyDescriptor(platform, 'persistentCurrent')?.value,
				keys: Reflect.ownKeys(platform).includes('persistentCurrent')
			};
			return publish(...args);
		};
		platform.persistentMarker = 'installed once';
		${scenario === 'platform-persistent-nonextensible' ? 'Object.preventExtensions(platform);' : ''}
	}
	probe.events.push({ name: 'init:end', value });
}
${scenario === 'platform-persistent-shutdown' ? "export function shutdown() { probe.events.push({ name: 'shutdown:end', value }); }" : ''}
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
	}
	async function checkPersistentPlatform() {
		writeFileSync(route, `export function GET({ platform }) {
	const probe = globalThis[${JSON.stringify(key)}];
	probe.wrapperHits = 0;
	probe.reflection = null;
	platform.publish('lifecycle-proof', 'message');
	return Response.json({ hits: probe.wrapperHits, marker: platform.persistentMarker, counter: platform.persistentCounter, current: platform.persistentCurrent, reflection: probe.reflection });
}
`);
		let counter = 0;
		const nonextensible = scenario === 'platform-persistent-nonextensible';
		const checkHttp = async value => {
			const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200, await response.clone().text());
			assert.deepEqual(await response.json(), { hits: 1, marker: 'installed once', counter: ++counter, current: value, reflection: { has: true, current: value, keys: true } }, 'Timely init writes and retained functions must share current platform values');
		};
		// While a replacement init runs, routes see the platform without the
		// retired instance's init changes; a key the platform could not take
		// back stays.
		const checkReinitializing = async value => {
			const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200, await response.clone().text());
			assert.deepEqual(await response.json(), { hits: 0, counter, current: value, reflection: null, ...(nonextensible ? { marker: 'installed once' } : {}) }, 'A replacement init must start from the platform without the retired init changes');
		};
		const checkWebSocket = async value => {
			const { ws, body } = await connect();
			assert.deepEqual(body, { value, marker: 'installed once', counter });
			ws.terminate();
			const auth = await fetch(origin + '/__ws/auth', {
				method: 'POST', headers: { Origin: origin, 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(5000)
			});
			assert.equal(auth.status, 200);
			assert.deepEqual(await auth.json(), body);
		};
		writeFileSync(hooks, persistentPlatformHandler('first'));
		await start();
		await until(() => saw('init:end', 'first'), 'Initial platform setup');
		await checkHttp('first');
		await checkWebSocket('first');
		for (const value of ['second', 'third', 'fourth']) {
			probe.releaseInit = null;
			await save(hooks, persistentPlatformHandler(value));
			await until(() => probe.releaseInit, 'Paused replacement initialization');
			if (['platform-persistent-current', 'platform-persistent-fixed', 'platform-persistent-nonextensible'].includes(scenario)) counter = ['first', 'second', 'third', 'fourth'].indexOf(value) * 100;
			await checkReinitializing(value);
			probe.releaseInit();
			await until(() => saw('init:end', value), 'Replacement initialization');
			await checkHttp(value);
			await checkWebSocket(value);
		}
	}
	async function checkPrototypeResource() {
		const source = value => `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
export function init({ platform }) {
	if (value === 'first') {
		probe.pool = { closed: false };
		Object.defineProperty(platform, '__proto__', { value: probe.pool, writable: true, enumerable: true, configurable: true });
	}
	probe.events.push({ name: 'init:end', value });
}
export function shutdown({ platform }) {
	if (value !== 'first') return;
	probe.cleanupMatched = platform.__proto__ === probe.pool;
	if (probe.cleanupMatched) platform.__proto__.closed = true;
	delete platform.__proto__;
}
const snapshot = () => ({ value, matched: probe.cleanupMatched, closed: probe.pool.closed });
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
		writeFileSync(route, `export function GET() { const probe = globalThis[${JSON.stringify(key)}]; return Response.json({ value: 'second', matched: probe.cleanupMatched, closed: probe.pool.closed }); }
`);
		writeFileSync(hooks, source('first'));
		await start();
		await until(() => saw('init:end', 'first'), 'Initial own prototype-key resource');
		await save(hooks, source('second'));
		await until(() => saw('init:end', 'second'), 'Replacement after prototype-key cleanup');
		const expected = { value: 'second', matched: true, closed: true };
		const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), expected, 'An own prototype-key resource must reach its shutdown hook');
		const { ws, body } = await connect();
		assert.deepEqual(body, expected);
		ws.terminate();
		const auth = await fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
		assert.equal(auth.status, 200);
		assert.deepEqual(await auth.json(), expected);
		assert.equal(Object.hasOwn(globalThis.__uws_dev_platform, '__proto__'), false);
		assert.equal(Object.getPrototypeOf(globalThis.__uws_dev_platform), Object.prototype);
	}
	async function checkConstrainedPlatform() {
		const sealed = scenario === 'platform-constrained-sealed-noop';
		const readonly = scenario === 'platform-constrained-readonly' || sealed;
		const setter = scenario.endsWith('-setter');
		const setterAdded = scenario.endsWith('-add-setter');
		const setterRemoved = scenario.endsWith('-remove-setter');
		const fixed = (readonly && !sealed) || scenario === 'platform-constrained-fixed-setter';
		const cleanup = scenario === 'platform-constrained-cleanup';
		const source = value => `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
export function init({ platform }) {
	if (!probe.retained) {
		${fixed ? "Object.defineProperty(platform, 'constrainedCounter', { value: 1, writable: true, enumerable: true, configurable: false });" : setter ? `probe.oldValue = 1; Object.defineProperty(platform, 'constrainedCounter', { get: () => probe.oldValue, ${setterAdded ? '' : 'set: value => { probe.oldValue = value; },'} enumerable: true, configurable: true });` : 'platform.constrainedCounter = 1; platform.constrainedExtra = 1;'}
		${cleanup ? 'platform.constrainedPool = probe.pool = { closed: false };' : ''}
		probe.retained = platform;
		${fixed ? '' : sealed ? 'Object.seal(platform);' : 'Object.preventExtensions(platform);'}
	}
	probe.events.push({ name: 'init:end', value });
}
${cleanup ? "export function shutdown({ platform }) { if (value === 'first') { probe.pool.closed = true; delete platform.constrainedPool; probe.cleanupDeleted = platform.constrainedPool === undefined; } }" : ''}
function snapshot() {
	const platform = probe.retained;
	return ${readonly || setter ? "{ value: platform.constrainedCounter }" : "{ has: 'constrainedCounter' in platform, extraKeys: Reflect.ownKeys(platform).includes('constrainedExtra'), keys: Reflect.ownKeys(platform).includes('constrainedCounter'), own: Object.hasOwn(platform, 'constrainedCounter') }"};
}
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
		writeFileSync(route, `export function GET() {
	const probe = globalThis[${JSON.stringify(key)}];
	const platform = probe.retained;
	const shared = globalThis.__uws_dev_platform;
	${scenario === 'platform-constrained-fixed-setter' ? `let threw = false;
	try { Object.defineProperty(shared, 'constrainedCounter', { get: () => 100, configurable: true }); } catch (error) { if (!(error instanceof TypeError)) throw error; threw = true; }
	return Response.json({ threw, value: platform.constrainedCounter, descriptor: Object.getOwnPropertyDescriptor(platform, 'constrainedCounter') });` : setter ? `probe.currentValue = 100;
	Object.defineProperty(shared, 'constrainedCounter', { get: () => probe.currentValue, ${setterRemoved ? 'set: undefined,' : 'set(value) { probe.setterReceiver = this === platform; probe.currentValue = value; },'} enumerable: true, configurable: true });
	const before = platform.constrainedCounter;
	let threw = false;
	try { platform.constrainedCounter = 200; } catch (error) { if (!(error instanceof TypeError)) throw error; threw = true; }
	return Response.json({ before, value: platform.constrainedCounter, shared: shared.constrainedCounter, receiver: probe.setterReceiver ?? false, old: probe.oldValue ?? 1, threw });` : readonly ? `shared.constrainedCounter = 100;
	const before = platform.constrainedCounter;
	const noops = [];
	for (const descriptor of [{ enumerable: true }, { writable: true }]) { Object.defineProperty(platform, 'constrainedCounter', descriptor); noops.push(platform.constrainedCounter); }
	Object.defineProperty(platform, 'constrainedCounter', { writable: false });
	const descriptor = Object.getOwnPropertyDescriptor(platform, 'constrainedCounter');
	return Response.json({ before, value: platform.constrainedCounter, shared: shared.constrainedCounter, descriptor: descriptor.value, writable: descriptor.writable, noops });` : `delete shared.constrainedCounter; delete shared.constrainedExtra;
	${cleanup ? "delete shared.constrainedPool; Reflect.ownKeys(platform); probe.readded = Reflect.set(shared, 'constrainedPool', { closed: false });" : ''}
	return Response.json({ has: 'constrainedCounter' in platform, extraKeys: Reflect.ownKeys(platform).includes('constrainedExtra'), keys: Reflect.ownKeys(platform).includes('constrainedCounter'), own: Object.hasOwn(platform, 'constrainedCounter') });`}
}
`);
		writeFileSync(hooks, source('first'));
		await start();
		await until(() => saw('init:end', 'first'), 'Initial constrained platform setup');
		if (!cleanup) {
			await save(hooks, source('second'));
			await until(() => saw('init:end', 'second'), 'Replacement constrained platform setup');
		}
		const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), scenario === 'platform-constrained-fixed-setter'
			? { threw: true, value: 1, descriptor: { value: 1, writable: true, enumerable: true, configurable: false } } : setter
			? { before: 100, value: setterRemoved ? 100 : 200, shared: setterRemoved ? 100 : 200, receiver: !setterRemoved, old: 1, threw: setterRemoved } : readonly
			? { before: 100, value: 100, shared: 100, descriptor: 100, writable: false, noops: [100, 100] }
			: { has: false, extraKeys: false, keys: false, own: false });
		if (cleanup) {
			assert.equal(probe.readded, false, 'Deleted keys cannot be re-added to the shared nonextensible platform');
			await save(hooks, source('second'));
			await until(() => saw('init:end', 'second'), 'Replacement after constrained cleanup');
			assert.equal(probe.pool.closed, true, 'Cleanup can retain its resource explicitly after a shared deletion');
			assert.equal(probe.cleanupDeleted, true, 'Explicit cleanup deletion must preserve the absent shared property');
		}
		const expected = scenario === 'platform-constrained-fixed-setter' ? { value: 1 } : setter ? { value: setterRemoved ? 100 : 200 } : readonly ? { value: 100 } : { has: false, extraKeys: false, keys: false, own: false };
		const { ws, body } = await connect();
		assert.deepEqual(body, expected);
		ws.terminate();
		const auth = await fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
		assert.equal(auth.status, 200);
		assert.deepEqual(await auth.json(), expected);
	}
	async function platformState(expected) {
		const { ws, body } = await connect();
		assert.equal(body.value, expected);
		ws.terminate();
		const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200, await response.clone().text());
		const http = await response.json();
		assert.equal(http.depth, body.depth, 'HTTP and WebSocket must see the same platform depth');
		assert.equal(http.poolOwner, body.poolOwner);
		assert.equal(http.poolClosed, body.poolClosed);
		return { body, http };
	}
	async function checkPlatform() {
		probe.inherited = [];
		probe.wrapperHits = 0;
		probe.foreignHits = 0;
		writeFileSync(route, `export function GET({ platform }) {
	const probe = globalThis[${JSON.stringify(key)}];
	probe.wrapperHits = 0;
	probe.foreignHits = 0;
	platform.publish('lifecycle-proof', 'message');
	return Response.json({ hits: probe.wrapperHits, foreignHits: probe.foreignHits, depth: platform.platformDepth ?? null,
		poolOwner: platform.platformPool?.owner, poolClosed: platform.platformPool?.closed,
		initOnly: platform.platformInitOnly, accessor: platform.platformAccessor, handoff: platform.platformHandoff });
}
`);
		writeFileSync(hooks, platformHandler('first'));
		await start();
		if (scenario === 'platform-init-throw') {
			await until(() => saw('shutdown:end', 'first'), 'Failed initialization cleanup');
			await assert.rejects(connect());
			await save(hooks, platformHandler('second'));
			await until(() => saw('init:end', 'second'), 'Replacement after failed initialization');
			const current = await platformState('second');
			assert.equal(current.http.depth, 1);
			assert.equal(current.http.hits, 1);
			assert.equal(probe.inherited[1].pool, undefined);
			assert.equal(probe.inherited[1].marker, undefined, 'A failed init must not leave the properties its cleanup did not remove');
			assert.equal(current.http.handoff, 'first', 'Successful cleanup writes must survive failed initialization');
			assert.ok(probe.diagnostics.some(message => message.includes('Platform initialization failed')));
			return;
		}
		if (scenario === 'platform-init-timeout') {
			await until(() => probe.releaseInit, 'Paused initialization');
			await save(hooks, platformHandler('second'));
			await until(() => saw('init:end', 'second'), 'Replacement after init timeout', 38000);
			const current = await platformState('second');
			assert.equal(current.http.depth, 1, 'Timed-out init must replace the shared platform with fresh primitives');
			assert.equal(current.http.hits, 1);
			assert.equal(probe.inherited[1].pool, undefined);
			assert.ok(probe.diagnostics.some(message => message.includes('WebSocket init hook did not finish')));
			probe.releaseInit();
			await until(() => saw('shutdown:end', 'first'), 'Late init cleanup');
			assert.equal(probe.resources[0].closed, true);
			assert.equal(probe.resources[1].closed, false);
			const after = await platformState('second');
			assert.equal(after.http.depth, 1);
			assert.equal(after.http.hits, 1);
			assert.equal(after.http.handoff, undefined);
			return;
		}
		const first = await platformState('first');
		assert.equal(first.http.depth, 1);
		assert.equal(first.http.hits, 1);
		if (scenario === 'platform-cleanup') {
			for (const [previous, value] of [['first', 'second'], ['second', 'third'], ['third', 'fourth']]) {
				await save(hooks, platformHandler(value));
				await until(() => saw('init:end', value), 'Replacement platform initialization');
				const current = await platformState(value);
				assert.equal(current.http.depth, 1, 'Shutdown must restore the previous depth before the next init');
				assert.equal(current.http.hits, 1, 'Shutdown must remove the previous publish wrapper');
				assert.equal(current.http.handoff, previous, 'Successful shutdown writes must survive retirement');
				const inherited = probe.inherited.find(entry => entry.value === value);
				assert.equal(inherited.pool, undefined, 'The next init must not inherit a closed pool deleted by shutdown');
				assert.equal(inherited.marker, undefined, 'The next init must not inherit init changes that shutdown left in place');
				assert.equal(probe.resources.at(-2).closed, true);
			}
		} else {
			const foreign = scenario.startsWith('platform-foreign');
			const activeForeign = scenario === 'platform-foreign-active';
			const replaceShared = () => {
				const shared = globalThis.__uws_dev_platform;
				shared.publish = () => { probe.foreignHits++; return 0; };
				shared.platformDepth = 40;
				shared.platformPool = probe.foreignPool = { owner: 'foreign', closed: false };
				Object.defineProperty(shared, 'platformInitOnly', { value: 'foreign', writable: false, enumerable: false, configurable: false });
				Object.defineProperty(shared, 'platformAccessor', { get: () => 'foreign', enumerable: false, configurable: true });
				shared.platformHandoff = 'foreign';
			};
			if (activeForeign) {
				replaceShared();
				const active = await platformState('first');
				assert.equal(active.body.poolOwner, 'foreign', 'Active reads must see shared changes');
				assert.equal(Object.getOwnPropertyDescriptor(probe.platform, 'platformPool').value.owner, 'foreign');
				assert.equal('platformHandoff' in probe.platform, true);
				assert.ok(Reflect.ownKeys(probe.platform).includes('platformHandoff'));
			}
			await save(hooks, platformHandler('second', { passive: foreign }));
			if (foreign) {
				await until(() => probe.releaseShutdown, 'Paused shutdown');
				if (!activeForeign) replaceShared();
				probe.releaseShutdown();
			}
			await until(() => saw('init:end', 'second'), 'Replacement platform initialization', 38000);
			const current = await platformState('second');
			assert.equal(current.http.depth, foreign ? 40 : 1);
			assert.equal(current.http.hits, foreign ? 0 : 1, 'Retirement reverts init changes that cleanup did not undo');
			if (foreign) {
				assert.equal(current.http.foreignHits, 1);
				assert.equal(current.http.poolOwner, undefined, 'Cleanup deletes the actual shared pool');
				assert.equal(probe.foreignPool.closed, true, 'Ordinary cleanup sees the actual shared resource');
				assert.equal(probe.resources[0].closed, false, 'Application cleanup must retain a resource explicitly if another writer replaces it');
				assert.ok(probe.diagnostics.some(message => message.includes('Cannot delete property')));
				assert.equal(current.http.initOnly, 'foreign', 'Shutdown deletion must preserve a foreign descriptor');
				assert.equal(current.http.accessor, 'foreign', 'Shutdown must preserve a foreign accessor');
				assert.equal(current.http.handoff, 'foreign', 'A new shutdown write must not replace a foreign handoff');
				assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis.__uws_dev_platform, 'platformInitOnly'), { value: 'foreign', writable: false, enumerable: false, configurable: false });
				assert.equal(Object.getOwnPropertyDescriptor(globalThis.__uws_dev_platform, 'platformAccessor').enumerable, false);
			} else {
				assert.equal(probe.inherited[1].pool, undefined, 'A failed cleanup is reverted; a deadline starts a fresh platform');
				assert.equal(probe.inherited[1].marker, undefined);
				if (scenario === 'platform-throw') assert.equal(probe.resources[0].closed, false);
				assert.ok(probe.diagnostics.some(message => message.includes(scenario === 'platform-timeout' ? 'WebSocket shutdown hook did not finish' : 'Platform cleanup failed')));
			}
			if (scenario === 'platform-timeout') {
				probe.releaseShutdown();
				await until(() => saw('shutdown:end', 'first'), 'Late platform cleanup');
				assert.equal(probe.resources[0].closed, true, 'Late cleanup must retain the retired pool');
				assert.equal(probe.resources[1].closed, false, 'Late cleanup must not close the replacement pool');
				const after = await platformState('second');
				assert.equal(after.http.depth, 1);
				assert.equal(after.http.hits, 1);
				assert.equal(after.http.handoff, undefined, 'Late shutdown writes must stay isolated');
			}
		}
	}

	async function checkSubscriptionOwners() {
		probe.records = {};
		probe.decorations = { subscribe: 0, checkSubscribe: 0, unsubscribe: 0 };
		probe.gates = [];
		probe.unsubscribed = [];
		const source = value => `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
const synthetic = { getUserData: () => ({}) };
export async function init({ platform }) {
	const record = probe.records[value] = { platform };
	if (value === 'first') {
		for (const name of ['subscribe', 'checkSubscribe', 'unsubscribe']) {
			const native = platform[name];
			platform[name] = function(...args) { probe.decorations[name]++; return native.apply(this, args); };
		}
	}
	record.initGate = await platform.checkSubscribe(synthetic, 'init-owner');
	probe.events.push({ name: 'init:end', value });
}
export async function shutdown({ platform }) {
	probe.records[value].shutdownGate = await platform.checkSubscribe(synthetic, 'shutdown-owner');
}
export async function subscribe(ws, topic) {
	probe.gates.push({ value, topic });
	if (topic === 'await-owner') await new Promise(resolve => { probe.releaseGate = resolve; probe.releases.push(resolve); });
	return value === 'first' ? true : false;
}
export function unsubscribe(ws, topic) { probe.unsubscribed.push({ value, topic }); }
export async function open(ws, { platform }) {
	Object.assign(probe.records[value], { ws, wsPlatform: platform });
	const subscribed = await platform.subscribe(ws, 'owned-topic');
	ws.send(JSON.stringify({ value, subscribed }));
}
export async function close(ws, { platform }) {
	if (value !== 'first') return;
	await new Promise(resolve => { probe.releaseClose = resolve; probe.releases.push(resolve); });
	probe.oldCloseGate = await platform.checkSubscribe(ws, 'old-close');
	probe.oldCloseUnsubscribed = platform.unsubscribe(ws, 'owned-topic');
	probe.closeComplete = true;
}
export function authenticate({ platform }) {
	probe.records[value].auth = platform;
	return Response.json({ value });
}
`;
		writeFileSync(route, `export async function GET({ platform }) {
	const probe = globalThis[${JSON.stringify(key)}];
	const first = probe.records.first;
	const second = probe.records.second;
	const synthetic = { getUserData: () => ({}) };
	const detached = first.auth.checkSubscribe;
	return Response.json({
		staleReceiverNewSocket: await first.auth.checkSubscribe(second.ws, 'new-socket'),
		staleSubscribeNewSocket: await first.auth.subscribe(second.ws, 'denied-topic'),
		detachedNewSocket: await detached(second.ws, 'detached-new'),
		newReceiverOldSocket: await second.auth.checkSubscribe(first.ws, 'old-socket'),
		oldSynthetic: await first.auth.checkSubscribe(synthetic, 'synthetic-old'),
		newSynthetic: await second.auth.checkSubscribe(synthetic, 'synthetic-new'),
		httpCurrent: await platform.checkSubscribe(synthetic, 'http-current'),
		newSocketSubscribed: second.ws.isSubscribed('denied-topic'),
		shared: first.platform === second.platform && Object.getPrototypeOf(platform) === second.platform
	});
}
`);
		const authenticate = async value => {
			const response = await fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { value });
		};
		writeFileSync(hooks, source('first'));
		await start();
		await until(() => saw('init:end', 'first'), 'Initial subscription owner');
		const first = await connect();
		assert.deepEqual(first.body, { value: 'first', subscribed: null });
		await authenticate('first');
		const waiting = probe.records.first.auth.checkSubscribe(probe.records.first.ws, 'await-owner');
		await until(() => probe.releaseGate, 'Paused old authorization');
		await save(hooks, source('second'));
		await until(() => saw('init:end', 'second') && probe.releaseClose, 'Replacement and delayed old close');
		const second = await connect();
		assert.deepEqual(second.body, { value: 'second', subscribed: 'FORBIDDEN' });
		await authenticate('second');
		probe.releaseGate();
		assert.equal(await waiting, null, 'An awaiting gate must keep the owner selected before it awaited');
		probe.releaseClose();
		await until(() => probe.closeComplete, 'Old close ownership');
		assert.equal(probe.oldCloseGate, null);
		assert.equal(probe.oldCloseUnsubscribed, true);
		assert.deepEqual(probe.unsubscribed, [{ value: 'first', topic: 'owned-topic' }]);
		assert.equal(probe.records.first.initGate, null);
		assert.equal(probe.records.first.shutdownGate, null);
		assert.equal(probe.records.second.initGate, 'FORBIDDEN');
		const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(await response.json(), { staleReceiverNewSocket: 'FORBIDDEN', staleSubscribeNewSocket: 'FORBIDDEN', detachedNewSocket: 'FORBIDDEN', newReceiverOldSocket: null, oldSynthetic: null, newSynthetic: 'FORBIDDEN', httpCurrent: 'FORBIDDEN', newSocketSubscribed: false, shared: true });
		for (const name of Object.keys(probe.decorations)) assert.ok(probe.decorations[name] > 0, name + ' decoration must remain visible');
		assert.equal(probe.records.first.auth.subscribe, probe.records.second.wsPlatform.subscribe);
		second.ws.terminate();
	}

	async function checkResetPlatform() {
		probe.records = {};
		probe.wrapperHits = 0;
		const generation = scenario === 'platform-reset-generation';
		const otherPlugin = scenario === 'platform-reset-global';
		const source = value => `const probe = globalThis[${JSON.stringify(key)}];
const value = ${JSON.stringify(value)};
const resource = { value, closed: false };
let captured;
export async function init({ platform }) {
	captured = platform;
	probe.records[value] = { platform, resource };
	if (value === 'first') {
		platform.applicationPool = resource;
		Object.defineProperty(platform, 'applicationGetter', { get() { probe.getterReads = (probe.getterReads ?? 0) + 1; return resource; }, configurable: true });
		Object.defineProperty(platform, 'applicationFixed', { value: resource });
		Object.setPrototypeOf(platform, { applicationPrototype: resource });
	}
	if (!probe.wrapped) {
		probe.wrapped = true;
		const publish = platform.publish;
		platform.publish = (...args) => { probe.wrapperHits++; return publish(...args); };
		platform.applicationGuard = 'installed once';
	}
	platform.currentMarker = value;
	${generation && value === 'first' ? 'await new Promise(resolve => { probe.releaseInit = resolve; probe.releases.push(resolve); });' : ''}
	probe.events.push({ name: 'init:end', value });
}
export async function shutdown({ platform }) {
	probe.events.push({ name: 'shutdown:start', value });
	if (value === 'first') {
		await new Promise(resolve => { probe.releaseShutdown = resolve; probe.releases.push(resolve); });
		resource.closed = true;
		platform.applicationPool = resource;
		platform.currentMarker = 'late';
		platform.lateOnly = true;
	}
	probe.events.push({ name: 'shutdown:end', value });
}
const snapshot = () => ({ value, marker: captured.currentMarker, guard: captured.applicationGuard ?? null });
export function open(ws) { ws.send(JSON.stringify(snapshot())); }
export function authenticate() { return Response.json(snapshot()); }
`;
		writeFileSync(route, `export function GET({ platform }) {
	const probe = globalThis[${JSON.stringify(key)}];
	probe.wrapperHits = 0;
	platform.publish('lifecycle-proof', 'message');
	const shared = globalThis.__uws_dev_platform;
	return Response.json({ marker: platform.currentMarker, guard: platform.applicationGuard ?? null, hits: probe.wrapperHits,
		pool: 'applicationPool' in shared, getter: Object.hasOwn(shared, 'applicationGetter'), fixed: Object.hasOwn(shared, 'applicationFixed'),
		late: 'lateOnly' in shared, nativePrototype: Object.getPrototypeOf(shared) === Object.prototype });
}
`);
		writeFileSync(hooks, source('first'));
		await start();
		await until(() => generation ? probe.releaseInit : saw('init:end', 'first'), 'First platform generation');
		const expired = probe.records.first.platform;
		await save(hooks, source('second'));
		if (!generation) await until(() => probe.releaseShutdown, 'Paused shutdown before reset');
		const foreignResource = { closed: false };
		expired.applicationPool = foreignResource;
		let foreignPlatform;
		if (otherPlugin) {
			const { default: uws } = await import(pathToFileURL(resolve(fixture, 'node_modules/svelte-adapter-uws/vite.js')));
			uws();
			foreignPlatform = globalThis.__uws_dev_platform;
			foreignPlatform.currentMarker = 'another plugin';
		}
		await until(() => saw('init:end', 'second'), 'Fresh platform after actual deadline', 38000);
		const current = probe.records.second.platform;
		assert.notEqual(current, expired);
		assert.equal(Object.getPrototypeOf(current), Object.prototype);
		for (const key of ['applicationPool', 'applicationGetter', 'applicationFixed', 'applicationGuard', 'applicationPrototype']) assert.equal(key in current, false, 'Deadline reset must not copy custom state or closures');
		assert.equal(probe.getterReads, undefined, 'Reset must not evaluate application getters');
		assert.equal(foreignResource.closed, false);
		assert.equal(probe.wrapped, true, 'External once guards survive the exceptional reset');
		assert.ok(probe.diagnostics.some(message => message.includes('Dev platform state was reset') && message.includes('Restart the dev process')));
		const check = async value => {
			const { ws, body } = await connect();
			assert.deepEqual(body, { value, marker: value, guard: null });
			ws.terminate();
			const response = await fetch(origin + '/lifecycle-proof', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200, await response.clone().text());
			assert.deepEqual(await response.json(), { marker: otherPlugin ? 'another plugin' : value, guard: null, hits: 0, pool: false, getter: false, fixed: false, late: false, nativePrototype: true });
			const auth = await fetch(origin + '/__ws/auth', { method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000) });
			assert.equal(auth.status, 200);
			assert.deepEqual(await auth.json(), body);
		};
		await check('second');
		if (generation) {
			probe.releaseInit();
			await until(() => probe.releaseShutdown, 'Late init cleanup started');
			await save(hooks, source('third'));
			await until(() => saw('init:end', 'third'), 'Ordinary replacement during old cleanup');
			await until(() => probe.diagnostics.some(message => message.includes('WebSocket shutdown hook did not finish')), 'Late old cleanup deadline', 38000);
			assert.equal(probe.records.third.platform, current, 'A retired epoch deadline must not reset the newer epoch');
			assert.equal(globalThis.__uws_dev_platform, current);
			await check('third');
		}
		if (otherPlugin) assert.equal(globalThis.__uws_dev_platform, foreignPlatform, 'An older plugin deadline must not replace another plugin platform');
		probe.releaseShutdown();
		await until(() => saw('shutdown:end', 'first'), 'Late cleanup completion');
		assert.equal(probe.records.first.resource.closed, true);
		assert.equal(current.currentMarker, generation ? 'third' : 'second');
		assert.equal(current.lateOnly, undefined);
		await check(generation ? 'third' : 'second');
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
		if (scenario.startsWith('platform-')) {
			if (scenario === 'platform-subscription-owner') await checkSubscriptionOwners();
			else if (scenario.startsWith('platform-reset-')) await checkResetPlatform();
			else if (scenario === 'platform-proto-resource') await checkPrototypeResource();
			else if (scenario.startsWith('platform-constrained')) await checkConstrainedPlatform();
			else if (scenario.startsWith('platform-persistent')) await checkPersistentPlatform();
			else await checkPlatform();
			console.log('Platform lifecycle passed on Vite ' + version + ': ' + scenario);
			return;
		}
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
