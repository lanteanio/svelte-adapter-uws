import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const fixture = new URL('.', import.meta.url);
const handler = new URL('./src/hooks.ws.js', fixture);
const config = new URL('./vite.config.js', fixture);
const libraryDirectory = new URL('./src/lib/', fixture);
const library = new URL('./src/lib/fallback-proof.js', fixture);
const originalHandler = readFileSync(handler);
const originalConfig = readFileSync(config);
const directoryExisted = existsSync(libraryDirectory);
assert.equal(existsSync(library), false, 'The fallback proof library must not already exist');
let libraryWritten = false;
let child;
let socket;
let output = '';
try {
	mkdirSync(libraryDirectory, { recursive: true });
	writeFileSync(library, 'export const answer = 42;\n', { flag: 'wx' });
	libraryWritten = true;
	writeFileSync(config, "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n");
	writeFileSync(handler, `import { answer } from '$lib/fallback-proof.js';
import { dev, building } from '$app/environment';
import { env as privateDynamic } from '$env/dynamic/private';
import { env as publicDynamic } from '$env/dynamic/public';
import { KIT2_FALLBACK_PRIVATE } from '$env/static/private';
import { PUBLIC_KIT2_FALLBACK } from '$env/static/public';
export function message(ws) {
	ws.send(JSON.stringify({ answer, dev, building,
		privateStatic: KIT2_FALLBACK_PRIVATE, publicStatic: PUBLIC_KIT2_FALLBACK,
		privateDynamic: privateDynamic.KIT2_FALLBACK_PRIVATE,
		publicDynamic: publicDynamic.PUBLIC_KIT2_FALLBACK,
		hidden: publicDynamic.KIT2_FALLBACK_PRIVATE ?? null }));
}
`);
	const built = spawnSync(process.execPath, [
		fileURLToPath(new URL('./node_modules/vite/bin/vite.js', fixture)), 'build'
	], { cwd: fileURLToPath(fixture), encoding: 'utf8', timeout: 120000, windowsHide: true,
		env: { ...process.env, KIT2_FALLBACK_PRIVATE: 'build-private', PUBLIC_KIT2_FALLBACK: 'build-public' } });
	assert.ifError(built.error);
	assert.equal(built.status, 0, built.stdout + built.stderr);
	assert.ok((built.stdout + built.stderr).includes('Add the Vite plugin to share modules'), 'The Vite plugin must not supply the handler');
	const reserve = createServer();
	reserve.listen(0, '127.0.0.1');
	await once(reserve, 'listening');
	const port = reserve.address().port;
	await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
	const origin = 'http://127.0.0.1:' + port;
	child = spawn(process.execPath, ['build/index.js'], {
		cwd: fileURLToPath(fixture), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, CLUSTER_WORKERS: '',
			KIT2_FALLBACK_PRIVATE: 'run-private', PUBLIC_KIT2_FALLBACK: 'run-public' }
	});
	child.stdout.on('data', data => { output += data; });
	child.stderr.on('data', data => { output += data; });
	let response;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(output);
		try { response = await fetch(origin, { signal: AbortSignal.timeout(1000) }); } catch {}
		if (response?.ok) break;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(response?.ok, 'Kit 2 did not become ready: ' + output);
	socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Origin: origin } });
	await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
	const reply = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
	socket.send(JSON.stringify({ type: 'fallback-proof' }));
	const [data] = await reply;
	assert.deepEqual(JSON.parse(data.toString()), {
		answer: 42, dev: false, building: false, privateStatic: 'build-private', publicStatic: 'build-public',
		privateDynamic: 'run-private', publicDynamic: 'run-public', hidden: null
	});
	console.log('Kit 2 fallback smoke passed: HTTP, WebSockets, $lib, and static/dynamic public/private environment aliases');
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
		writeFileSync(handler, originalHandler);
		writeFileSync(config, originalConfig);
		if (libraryWritten) unlinkSync(library);
		if (!directoryExisted && existsSync(libraryDirectory)) rmdirSync(libraryDirectory);
	}
}
