import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scenario = process.argv[2];
if (!scenario) {
	for (const name of ['startup', 'direct-success', 'direct-rejection', 'dependency-success', 'dependency-rejection', 'startup-restart', 'direct-restart', 'dependency-restart', 'dependency-handler-switch', 'healthy']) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit', timeout: 30000 });
		assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message ?? ''));
	}
} else {
	await runScenario();
}

async function runScenario() {
	const { createServer, version } = await import('vite');
	const { default: WebSocket } = await import('ws');
	assert.ok(version.startsWith('5.'), 'This fixture must exercise Vite 5');
	const root = new URL('.', import.meta.url);
	process.chdir(fileURLToPath(root));
	const hooks = new URL('src/hooks.ws.js', root);
	const dependency = new URL('src/pending-import-state.js', root);
	const routeDir = new URL('src/routes/pending-import-proof/', root);
	const route = new URL('+server.js', routeDir);
	const original = readFileSync(hooks);
	const config = new URL('vite.config.js', root);
	const originalConfig = readFileSync(config);
	const alternate = new URL('src/pending-import-alternate.js', root);
	for (const file of [dependency, routeDir, alternate, new URL(hooks.href + '.next'), new URL(dependency.href + '.next')]) {
		assert.equal(existsSync(file), false, fileURLToPath(file) + ' must not already exist');
	}
	const probe = globalThis.__legacyImportProbe = { events: [], active: new Set(), edits: 0 };
	const clients = [];
	let server;
	let origin;
	let active;
	const isDependency = scenario.startsWith('dependency');
	const rejecting = scenario.endsWith('rejection');
	const startingBlocked = scenario.startsWith('startup');
	const switchHandler = scenario.endsWith('handler-switch');
	const restartFirst = scenario.endsWith('restart') || switchHandler;
	const restartMessage = 'Stop and rerun the dev command';

	function blockedSource() {
		return 'const probe = globalThis.__legacyImportProbe;\n' +
			'try { await new Promise((resolve, reject) => { probe.release = ' +
			(rejecting ? "() => reject(new Error('Previous import failed'))" : 'resolve') +
			'; }); } finally { probe.finished = true; }\n';
	}
	function stateSource(value, blocked = false) {
		return (blocked ? blockedSource() : '') +
			'export const state = { id: crypto.randomUUID(), count: 0, value: ' + JSON.stringify(value) + ' };\n';
	}
	function handlerSource(value, blocked = false) {
		return "import { state } from './pending-import-state.js';\n" + (blocked ? blockedSource() : '') +
			'const owner = crypto.randomUUID();\n' +
			'const lifecycle = globalThis.__legacyImportProbe;\n' +
			'const snapshot = () => ({ owner, state, value: ' + JSON.stringify(value) + ' });\n' +
			"export function init() { lifecycle.active.add(owner); lifecycle.events.push(['init', owner]); }\n" +
			"export function shutdown() { lifecycle.active.delete(owner); lifecycle.events.push(['shutdown', owner]); }\n" +
			'export function open(ws) { ws.send(JSON.stringify(snapshot())); }\n' +
			'export function message(ws) { state.count++; ws.send(JSON.stringify(snapshot())); }\n' +
			'export function authenticate() { return Response.json(snapshot()); }\n';
	}
	async function until(check, label) {
		const deadline = Date.now() + 5000;
		while (!check()) {
			assert.ok(Date.now() < deadline, label + ' timed out');
			await delay(20);
		}
	}
	async function save(file, source) {
		const before = probe.edits;
		writeFileSync(new URL(file.href + '.next'), source);
		renameSync(new URL(file.href + '.next'), file);
		await until(() => probe.edits > before, 'Observed file edit');
	}
	function websocket(targetOrigin = origin) {
		const ws = new WebSocket(targetOrigin.replace('http:', 'ws:') + '/ws', { headers: { Origin: targetOrigin } });
		clients.push(ws);
		ws.on('error', () => {});
		let settled = false;
		let closeCode;
		ws.on('close', code => { closeCode = code; });
		const result = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('WebSocket admission timed out')), 3000);
			function finish(value) { clearTimeout(timer); settled = true; resolve(value); }
			ws.once('unexpected-response', (_request, response) => {
				let body = '';
				response.on('data', chunk => { body += chunk; });
				response.on('end', () => finish({ status: response.statusCode, body }));
			});
			ws.on('message', message => {
				const value = JSON.parse(message.toString());
				if (value.type !== 'welcome') finish({ status: 101, body: value });
			});
			ws.once('error', reject);
		});
		result.catch(() => {});
		return { ws, result, get settled() { return settled; }, get closeCode() { return closeCode; } };
	}
	function authenticate() {
		let settled = false;
		const result = fetch(origin + '/__ws/auth', {
			method: 'POST', headers: { Origin: origin, 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000)
		}).then(async response => {
			settled = true;
			return { status: response.status, body: await response.text() };
		});
		result.catch(() => {});
		return { result, get settled() { return settled; } };
	}
	async function rejectedRequests(socket = websocket(), auth = authenticate()) {
		const results = await Promise.all([socket.result, auth.result]);
		for (const result of results) {
			assert.equal(result.status, 503);
			assert.ok(result.body.includes(restartMessage), result.body);
		}
	}
	async function start() {
		server = await createServer({
			server: { host: '127.0.0.1', port: 0 },
			plugins: [{ name: 'observe-pending-import-edits', enforce: 'post', handleHotUpdate() { probe.edits++; } }]
		});
		await server.listen();
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	}

	async function restart() {
		let timer;
		try {
			await Promise.race([server.restart(), new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('In-process restart timed out')), 7000);
			})]);
		} finally { clearTimeout(timer); }
		origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	}
	async function healthy() {
		const socket = websocket();
		const result = await socket.result;
		assert.equal(result.status, 101);
		const response = await fetch(origin + '/pending-import-proof');
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), result.body.state);
		const changed = once(socket.ws, 'message');
		socket.ws.send('increment');
		const updated = JSON.parse((await changed)[0].toString());
		assert.equal(updated.state.count, result.body.state.count + 1);
		assert.deepEqual(await (await fetch(origin + '/pending-import-proof')).json(), updated.state);
		return socket;
	}

	async function unaffectedApplication() {
		const { default: uws } = await import('svelte-adapter-uws/vite');
		const otherRoot = mkdtempSync(new URL('pending-import-other-', root));
		let otherServer;
		try {
			writeFileSync(otherRoot + '/state.js', 'export const state = { id: crypto.randomUUID(), count: 0 };\n');
			writeFileSync(otherRoot + '/hooks.ws.js', "import { state } from './state.js';\nexport function open(ws) { ws.send(JSON.stringify(state)); }\nexport function message(ws) { state.count++; ws.send(JSON.stringify(state)); }\n");
			otherServer = await createServer({
				root: otherRoot, configFile: false, cacheDir: otherRoot + '/cache',
				server: { host: '127.0.0.1', port: 0 },
				plugins: [uws({ handler: './hooks.ws.js' }), {
					name: 'unaffected-app-state',
					configureServer(vite) {
						vite.middlewares.use('/state', async (_request, response, next) => {
							try { response.end(JSON.stringify((await vite.ssrLoadModule(otherRoot + '/state.js')).state)); }
							catch (error) { next(error); }
						});
					}
				}]
			});
			await otherServer.listen();
			const otherOrigin = 'http://127.0.0.1:' + otherServer.httpServer.address().port;
			const socket = websocket(otherOrigin);
			const initial = await socket.result;
			assert.equal(initial.status, 101, 'Another application must remain available');
			assert.deepEqual(await (await fetch(otherOrigin + '/state')).json(), initial.body);
			const received = once(socket.ws, 'message');
			socket.ws.send('increment');
			const updated = JSON.parse((await received)[0].toString());
			assert.equal(updated.count, initial.body.count + 1);
			assert.deepEqual(await (await fetch(otherOrigin + '/state')).json(), updated);
			socket.ws.terminate();
		} finally {
			await otherServer?.close();
			assert.ok(otherRoot.startsWith(fileURLToPath(root)), 'Cleanup stays within this fixture');
			rmSync(otherRoot, { recursive: true, force: true });
		}
	}

	try {
		mkdirSync(routeDir);
		writeFileSync(route, "import { state } from '../../pending-import-state.js';\nexport function GET() { return Response.json(state); }\n");
		writeFileSync(dependency, stateSource('initial'));
		writeFileSync(hooks, handlerSource('initial', startingBlocked));
		await start();
		if (scenario === 'healthy') {
			await healthy();
			await restart();
			await healthy();
			await server.close();
			await start();
			await healthy();
			console.log('Healthy HTTP and WebSocket state survives restart and close/recreate');
			return;
		}
		if (!startingBlocked) {
			active = await healthy();
			await save(isDependency ? dependency : hooks, isDependency ? stateSource('old', true) : handlerSource('old', true));
		}
		await until(() => typeof probe.release === 'function', 'Pending module evaluation');
		const socket = websocket();
		const auth = authenticate();
		await delay(150);
		assert.equal(socket.settled, false, 'The early WebSocket must be waiting for import');
		assert.equal(auth.settled, false, 'The early authentication request must be waiting for import');
		if (switchHandler) {
			// Config restart can select a different entry while its shared dependency is pending.
			await server.watcher.close();
			writeFileSync(alternate, handlerSource('alternate'));
			writeFileSync(config, originalConfig.toString().replace('uws()', "uws({ handler: './src/pending-import-alternate.js' })"));
		}
		if (restartFirst) await restart();
		else await save(isDependency ? dependency : hooks, isDependency ? stateSource('new') : handlerSource('new'));
		if (restartFirst) {
			// Restart can close the old listener's sockets before it writes an HTTP response.
			for (const result of await Promise.allSettled([socket.result, auth.result])) {
				if (result.status === 'fulfilled') {
					assert.equal(result.value.status, 503);
					assert.ok(result.value.body.includes(restartMessage));
				}
				else assert.doesNotMatch(String(result.reason), /timeout|timed out/i);
			}
		} else await rejectedRequests(socket, auth);
		await rejectedRequests();
		await until(() => probe.active.size === 0, 'Active handler shutdown');
		if (active) {
			await until(() => active.ws.readyState === WebSocket.CLOSED, 'Old connection retirement');
			assert.equal(active.closeCode, 1012);
			assert.equal(probe.events.filter(([event]) => event === 'shutdown').length, 1);
		}
		probe.release();
		await until(() => probe.finished, 'Late import completion');
		await rejectedRequests();
		await delay(150);
		await save(isDependency ? dependency : hooks, isDependency ? stateSource('another') : handlerSource('another'));
		await rejectedRequests();
		assert.equal(probe.events.filter(([event]) => event === 'init').length, startingBlocked ? 0 : 1);
		await restart();
		await rejectedRequests();
		if (switchHandler) await unaffectedApplication();
		console.log('Vite 5 pending import fails closed through late completion, saves, and server restart: ' + scenario);
	} finally {
		probe.release?.();
		for (const client of clients) client.terminate();
		try { await server?.close(); } finally {
			writeFileSync(hooks, original);
			writeFileSync(config, originalConfig);
			for (const file of [dependency, route, alternate, new URL(hooks.href + '.next'), new URL(dependency.href + '.next')]) {
				if (existsSync(file)) unlinkSync(file);
			}
			if (existsSync(routeDir)) rmdirSync(routeDir);
			delete globalThis.__legacyImportProbe;
		}
	}
}
