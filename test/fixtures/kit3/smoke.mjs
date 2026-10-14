import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';

async function freePort() {
	const server = createNetServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

function frame(socket, predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('WebSocket frame timed out')), 10000);
		function finish(error, value) {
			clearTimeout(timer);
			socket.off('message', message);
			socket.off('error', fail);
			socket.off('close', closed);
			if (error) reject(error); else resolve(value);
		}
		function message(data) {
			try {
				const value = JSON.parse(data.toString());
				if (predicate(value)) finish(null, value);
			} catch (error) { finish(error); }
		}
		const fail = error => finish(error);
		const closed = code => finish(new Error('WebSocket closed: ' + code));
		socket.on('message', message);
		socket.on('error', fail);
		socket.on('close', closed);
	});
}

// Keep the caller's fetch; Kit's dev runtime instruments global fetch for SSR.
const fetchHTTP = globalThis.fetch;
process.env.KIT3_MODULE_TOKEN = 'fixture-secret';
const mode = process.argv[2] || 'production';
assert.ok(['production', '--dev', '--dev-reload', '--dev-no-adapter', '--dev-wrapped-adapter',
	'entries', 'cluster', 'cluster-reuseport', 'instrumented'].includes(mode), 'Unknown smoke mode');
const dev = mode.startsWith('--dev');
const reload = mode === '--dev-reload';
const configMode = mode === '--dev-no-adapter' ? 'no-adapter'
	: mode === '--dev-wrapped-adapter' ? 'wrapped-adapter' : 'development';
const cluster = mode === 'cluster' || mode === 'cluster-reuseport';
const instrumentation = mode === 'instrumented' ? { instrumentation: 'fixture-secret' } : {};
const entries = mode === 'entries' || cluster ? ['start', 'release', 'ready'] : [];
const port = await freePort();
const origin = 'http://127.0.0.1:' + port;
let output = '';
let server;
let child;
let socket;
const route = new URL('./src/routes/counter/+server.js', import.meta.url);
const routeSave = new URL('./src/routes/counter/+server.js.next', import.meta.url);
let originalRoute;
try {
	if (dev) {
		const { createServer } = await import('vite');
		server = await createServer({ mode: configMode, server: { host: '127.0.0.1', port, strictPort: true } });
		await server.listen();
	} else {
		child = spawn(process.execPath, ['build/index.js'], {
			env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, CLUSTER_WORKERS: cluster ? '1' : '',
				CLUSTER_MODE: mode === 'cluster-reuseport' ? 'reuseport' : 'acceptor',
				KIT3_INIT_DELAY_MS: mode === 'cluster' ? '750' : '' },
			stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
		});
		child.stdout.on('data', data => { output += data; });
		child.stderr.on('data', data => { output += data; });
	}
	let response;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (child?.exitCode != null) throw new Error(output);
		try { response = await fetchHTTP(origin, { signal: AbortSignal.timeout(1000) }); } catch {}
		if (response?.ok) break;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(response?.ok, 'HTTP server did not become ready: ' + output);
	const html = await response.text();
	assert.match(html, /SvelteKit 3 fixture/);
	if (!dev) {
		const assetPath = html.match(/(?:\.?\/)?_kit3\/immutable\/[^"'<>\s]+/)?.[0];
		assert.ok(assetPath, 'SSR HTML references an asset under the configured application directory');
		const asset = await fetchHTTP(new URL(assetPath, origin), { signal: AbortSignal.timeout(5000) });
		assert.equal(asset.status, 200, 'The referenced immutable asset is served');
		assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
		assert.ok((await asset.arrayBuffer()).byteLength > 0, 'The immutable asset contains client code');
	}
	assert.deepEqual(await (await fetchHTTP(origin + '/counter')).json(), { messages: 0, entries, ...instrumentation },
		'Extra entries finish before HTTP readiness and share the route module graph');
	socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Origin: origin } });
	await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
	const lifecycleBefore = frame(socket, value => value.type === 'fixture-lifecycle');
	socket.send(JSON.stringify({ type: 'fixture-lifecycle' }));
	const before = await lifecycleBefore;
	assert.equal(before.initialized, true, 'The initial handler captured its platform in init');
	assert.deepEqual(before.active, [before.instance]);
	assert.deepEqual(before.events, [{ type: 'init', instance: before.instance }]);
	const subscribed = frame(socket, value => value.type === 'subscribed' && value.topic === 'kit3');
	socket.send(JSON.stringify({ type: 'subscribe', topic: 'kit3', ref: 'kit3-subscription' }));
	await subscribed;
	const delivered = frame(socket, value => value.topic === 'kit3' && value.event === 'roundtrip');
	socket.send(JSON.stringify({ type: 'fixture-publish', payload: { value: 42 } }));
	assert.deepEqual((await delivered).data, { value: 42 });
	assert.deepEqual(await (await fetchHTTP(origin + '/counter')).json(), { messages: 1, entries, ...instrumentation },
		'HTTP and WebSocket share one server module instance');
	if (reload) {
		const closed = once(socket, 'close', { signal: AbortSignal.timeout(10000) });
		originalRoute = await readFile(route, 'utf8');
		await writeFile(routeSave, originalRoute + '\n// Reload the route module.\n');
		await rename(routeSave, route);
		assert.equal((await closed)[0], 1012, 'A route-only SSR edit restarts the WebSocket handler');

		socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Origin: origin } });
		await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
		const lifecycleAfter = frame(socket, value => value.type === 'fixture-lifecycle');
		socket.send(JSON.stringify({ type: 'fixture-lifecycle' }));
		const after = await lifecycleAfter;
		assert.notEqual(after.instance, before.instance, 'The route edit created a fresh handler module');
		assert.equal(after.initialized, true, 'The reloaded handler captured its platform before accepting messages');
		assert.deepEqual(after.active, [after.instance], 'The old handler finished shutdown before the replacement became ready');
		assert.deepEqual(after.events, [
			{ type: 'init', instance: before.instance },
			{ type: 'shutdown', instance: before.instance },
			{ type: 'init', instance: after.instance }
		]);
		const resubscribed = frame(socket, value => value.type === 'subscribed' && value.topic === 'kit3');
		socket.send(JSON.stringify({ type: 'subscribe', topic: 'kit3', ref: 'kit3-after-reload' }));
		await resubscribed;
		const redelivered = frame(socket, value => value.topic === 'kit3' && value.event === 'roundtrip');
		socket.send(JSON.stringify({ type: 'fixture-publish', payload: { value: 43 } }));
		assert.deepEqual((await redelivered).data, { value: 43 }, 'The replacement uses its initialized platform');
		assert.deepEqual(await (await fetchHTTP(origin + '/counter')).json(), { messages: 1, entries: [] },
			'HTTP and the reloaded WebSocket handler share one fresh server module instance');
	}
	console.log('Kit 3 ' + mode + ' smoke passed: server initialization, HTTP, and WebSocket shared state');
} catch (error) {
	if (output) console.error(output);
	throw error;
} finally {
	socket?.terminate();
	try {
		await server?.close();
	} finally {
		if (originalRoute !== undefined) await writeFile(route, originalRoute);
		await unlink(routeSave).catch(error => { if (error.code !== 'ENOENT') throw error; });
	}
	if (child && child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
		try { await exited; } finally { clearTimeout(timer); }
	}
}
