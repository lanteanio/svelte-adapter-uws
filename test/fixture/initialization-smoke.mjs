import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const fixture = new URL('.', import.meta.url);
const configPath = new URL('./svelte.config.js', fixture);
const originalConfig = readFileSync(configPath, 'utf8');
const proofRoute = new URL('./src/routes/initialization-proof/', fixture);
const created = new Map([
	['./initialization.vite.config.js', `import { fileURLToPath } from 'node:url';
import config from './vite.config.js';
let ssr = false;
export default {
	...config,
	build: { ...config.build, target: 'esnext' },
	plugins: [...config.plugins, {
		name: 'fixture-initialization-entries',
		configResolved(resolved) { ssr = Boolean(resolved.build.ssr); },
		buildStart() {
			if (!ssr) return;
			for (const [name, entry] of [
				['__kit2-a.js', './src/initialization-start.js'],
				['__kit2-b.js', './src/initialization-release.js']
			]) this.emitFile({ type: 'chunk', id: fileURLToPath(new URL(entry, import.meta.url)), fileName: name });
		}
	}]
};
`],
	['./src/instrumentation.server.js', `globalThis.__kit2Instrumentation = 'ready';\n`],
	['./src/initialization-start.js', `if (globalThis.__kit2Instrumentation !== 'ready') throw new Error('Instrumentation did not run before the entrypoint');
globalThis.__kit2Entries = ['start'];
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('Extra entries did not run as static siblings')), 5000);
	globalThis.__kit2Release = () => { clearTimeout(timer); resolve(); };
});
globalThis.__kit2Entries.push('ready');
`],
	['./src/initialization-release.js', `globalThis.__kit2Entries.push('release');
globalThis.__kit2Release();
`],
	['./src/routes/initialization-proof/+server.js', `export function GET() {
	return Response.json({ entries: globalThis.__kit2Entries ?? null, instrumentation: globalThis.__kit2Instrumentation ?? null });
}
`]
]);
for (const name of created.keys()) assert.equal(existsSync(new URL(name, fixture)), false, name + ' must not already exist');
assert.equal(existsSync(proofRoute), false, 'The generated route must not already exist');
assert.ok(originalConfig.includes('export default {'), 'The fixture config has an object export');

let child;
let socket;
let output = '';
try {
	mkdirSync(proofRoute);
	for (const [name, source] of created) writeFileSync(new URL(name, fixture), source);
	writeFileSync(configPath, originalConfig.replace('export default {', 'const config = {') + `
config.kit.experimental = { ...config.kit.experimental, instrumentation: { server: true } };
export default config;
`);
	const built = spawnSync(process.execPath, [
		fileURLToPath(new URL('./node_modules/vite/bin/vite.js', fixture)),
		'build', '--config', 'initialization.vite.config.js'
	], { cwd: fileURLToPath(fixture), encoding: 'utf8', timeout: 120000, windowsHide: true });
	assert.ifError(built.error);
	assert.equal(built.status, 0, built.stdout + built.stderr);
	const reserve = createServer();
	reserve.listen(0, '127.0.0.1');
	await once(reserve, 'listening');
	const port = reserve.address().port;
	await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
	const origin = 'http://127.0.0.1:' + port;
	child = spawn(process.execPath, ['build/index.js'], {
		cwd: fileURLToPath(fixture),
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, CLUSTER_WORKERS: '' },
		stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
	});
	child.stdout.on('data', data => { output += data; });
	child.stderr.on('data', data => { output += data; });
	let response;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(output);
		try { response = await fetch(origin + '/initialization-proof', { signal: AbortSignal.timeout(1000) }); } catch {}
		if (response?.ok) break;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(response?.ok, 'Kit 2 did not become ready: ' + output);
	assert.deepEqual(await response.json(), { entries: ['start', 'release', 'ready'], instrumentation: 'ready' });
	socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Origin: origin } });
	await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
	const echoed = new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('Kit 2 WebSocket echo timed out')), 5000);
		function finish(error, value) {
			clearTimeout(timer);
			socket.off('message', message);
			socket.off('error', fail);
			socket.off('close', close);
			if (error) reject(error); else resolve(value);
		}
		function message(data) {
			try {
				const value = JSON.parse(data.toString());
				if (value.event === 'echo') finish(null, value.data);
			} catch (error) { finish(error); }
		}
		const fail = error => finish(error);
		const close = code => finish(new Error('Kit 2 WebSocket closed: ' + code));
		socket.on('message', message);
		socket.on('error', fail);
		socket.on('close', close);
	});
	socket.send(JSON.stringify({ type: 'echo', payload: { value: 42 } }));
	assert.deepEqual(await echoed, { value: 42 });
	console.log('Kit 2 initialization smoke passed: generated entries, instrumentation, HTTP, and WebSocket I/O');
} finally {
	socket?.terminate();
	try {
		if (child && child.exitCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
			try { await exited; } finally { clearTimeout(timer); }
		}
	} finally {
		writeFileSync(configPath, originalConfig);
		for (const name of created.keys()) {
			const path = new URL(name, fixture);
			if (existsSync(path)) unlinkSync(path);
		}
		if (existsSync(proofRoute)) rmdirSync(proofRoute);
	}
}
