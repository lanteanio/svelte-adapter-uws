import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
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
assert.ok(['production', '--dev', 'entries', 'cluster', 'instrumented'].includes(mode), 'Unknown smoke mode');
const dev = mode === '--dev';
const cluster = mode === 'cluster';
const instrumentation = mode === 'instrumented' ? { instrumentation: 'fixture-secret' } : {};
const entries = mode === 'entries' || cluster ? ['start', 'release', 'ready'] : [];
const port = await freePort();
const origin = 'http://127.0.0.1:' + port;
let output = '';
let server;
let child;
let socket;
try {
	if (dev) {
		const { createServer } = await import('vite');
		server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } });
		await server.listen();
	} else {
		child = spawn(process.execPath, ['build/index.js'], {
			env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, CLUSTER_WORKERS: cluster ? '1' : '' },
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
	const subscribed = frame(socket, value => value.type === 'subscribed' && value.topic === 'kit3');
	socket.send(JSON.stringify({ type: 'subscribe', topic: 'kit3', ref: 'kit3-subscription' }));
	await subscribed;
	const delivered = frame(socket, value => value.topic === 'kit3' && value.event === 'roundtrip');
	socket.send(JSON.stringify({ type: 'fixture-publish', payload: { value: 42 } }));
	assert.deepEqual((await delivered).data, { value: 42 });
	assert.deepEqual(await (await fetchHTTP(origin + '/counter')).json(), { messages: 1, entries, ...instrumentation },
		'HTTP and WebSocket share one server module instance');
	console.log('Kit 3 ' + mode + ' smoke passed: server initialization, HTTP, and WebSocket shared state');
} finally {
	socket?.terminate();
	await server?.close();
	if (child && child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
		try { await exited; } finally { clearTimeout(timer); }
	}
}
