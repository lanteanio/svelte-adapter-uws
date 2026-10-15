import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

const specificOnly = process.argv.includes('--specific-only');
const executable = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url));
const handler = new URL('./src/socket.js', import.meta.url);
const original = readFileSync(handler);
const manifest = new URL('./package.json', import.meta.url);
const originalManifest = readFileSync(manifest);
const library = new URL('./src/lib/fallback-smoke.js', import.meta.url);
let libraryWritten = false;
const wildcardDirectory = new URL('./src/fallback-wildcard/', import.meta.url);
const wildcardLibrary = new URL('fallback-smoke.js', wildcardDirectory);
const wildcardIndex = new URL('index.js', wildcardDirectory);
const exactLibrary = new URL('./src/fallback-exact.js', import.meta.url);
let wildcardDirectoryCreated = false;
let wildcardLibraryWritten = false;
let wildcardIndexWritten = false;
let exactLibraryWritten = false;

async function assertLibraryResponse(answer) {
	const reserve = createServer();
	reserve.listen(0, '127.0.0.1');
	await once(reserve, 'listening');
	const port = reserve.address().port;
	await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
	const origin = 'http://127.0.0.1:' + port;
	const child = spawn(process.execPath, ['build/index.js'], {
		cwd: fileURLToPath(new URL('.', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, CLUSTER_WORKERS: '',
			KIT3_MODULE_TOKEN: 'fixture-secret' }
	});
	let output = '';
	child.stdout.on('data', data => { output += data; });
	child.stderr.on('data', data => { output += data; });
	let socket;
	try {
		let response;
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) throw new Error(output);
			try { response = await fetch(origin, { signal: AbortSignal.timeout(1000) }); } catch {}
			if (response?.ok) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.ok(response?.ok, 'Kit 3 did not become ready: ' + output);
		assert.match(await response.text(), /SvelteKit 3 fixture/);
		socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
		await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
		const reply = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
		socket.send('library');
		const [data] = await reply;
		assert.equal(data.toString(), String(answer), 'The production WebSocket must use the selected library mapping');
	} finally {
		socket?.terminate();
		if (child.exitCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
			try { await exited; } finally { clearTimeout(timer); }
		}
	}
}

const imports = [
	'$app/env', '$app/env/private', '$app/env/public', '$app/environment',
	'$env/dynamic/private', '$env/dynamic/public', '$env/static/private', '$env/static/public',
	'$app/server', '$app/paths', '$app/state'
];
try {
	for (const id of process.argv.includes('--aliases-only') || specificOnly ? [] : imports) {
		writeFileSync(handler, `import * as environment from '${id}';
export function message(ws) { ws.send(JSON.stringify(environment)); }
`);
		const result = spawnSync(process.execPath, [executable, 'build', '--mode', 'fallback'], {
			cwd: fileURLToPath(new URL('.', import.meta.url)),
			encoding: 'utf8', timeout: 120000, windowsHide: true
		});
		assert.ifError(result.error);
		assert.ok(!(result.stdout + result.stderr).includes('adapter_config_kit_deprecated'),
			'Kit 3 adapters must read the flat builder configuration');
		assert.notEqual(result.status, 0, `${id} without uws() must fail at build time`);
		assert.ok((result.stdout + result.stderr).includes(
			'SvelteKit 3 virtual imports in WebSocket handlers require the Vite plugin. ' +
			"Add uws() from 'svelte-adapter-uws/vite' after sveltekit() in vite.config.js."
		), `${id} must explain how to enable SvelteKit environment imports`);
	}
	mkdirSync(new URL('./src/lib/', import.meta.url), { recursive: true });
	writeFileSync(library, 'export const answer = 42;\n', { flag: 'wx' });
	libraryWritten = true;
	mkdirSync(wildcardDirectory);
	wildcardDirectoryCreated = true;
	writeFileSync(wildcardLibrary, 'export const answer = 43;\n', { flag: 'wx' });
	wildcardLibraryWritten = true;
	writeFileSync(wildcardIndex, 'export const answer = 45;\n', { flag: 'wx' });
	wildcardIndexWritten = true;
	writeFileSync(exactLibrary, 'export const answer = 44;\n', { flag: 'wx' });
	exactLibraryWritten = true;
	const packageJson = JSON.parse(originalManifest.toString());
	packageJson.imports = { ...packageJson.imports, '#lib/*': './src/lib/*' };
	writeFileSync(manifest, JSON.stringify(packageJson, null, '\t') + '\n');
	for (const [id, succeeds, mode, answer] of [
		['$lib/fallback-smoke.js', false, 'fallback', 41],
		['#lib/fallback-smoke.js', true, 'fallback', 42],
		['$lib/fallback-smoke.js', true, 'fallback-alias', 42],
		['$lib/fallback-smoke.js', true, 'fallback-wildcard', 43],
		['$lib', false, 'fallback-wildcard', 0],
		['$lib', true, 'fallback-both', 44],
		['$lib/fallback-smoke.js', true, 'fallback-both', 43],
		['$lib/specific', true, 'fallback-specific', 44],
		['$lib', false, 'fallback-specific', 0],
		['$lib/fallback-smoke.js', false, 'fallback-specific', 0],
		['$lib/specific/fallback-smoke.js', true, 'fallback-specific-prefix', 43],
		['$lib/specific', true, 'fallback-specific-both', 44],
		['$lib/specific/fallback-smoke.js', true, 'fallback-specific-both', 43],
		['$lib/fallback-smoke.js', true, 'fallback-specific-both', 42]
	].filter(([, , mode]) => !specificOnly || mode.startsWith('fallback-specific'))) {
		writeFileSync(handler, `import { answer } from '${id}';
export function message(ws) { ws.send(String(answer)); }
`);
		const result = spawnSync(process.execPath, [executable, 'build', '--mode', mode], {
			cwd: fileURLToPath(new URL('.', import.meta.url)),
			encoding: 'utf8', timeout: 120000, windowsHide: true
		});
		assert.ifError(result.error);
		if (succeeds) {
			assert.equal(result.status, 0, result.stdout + result.stderr);
			await assertLibraryResponse(answer);
		} else {
			assert.notEqual(result.status, 0, '$lib must not silently resolve on Kit 3');
			assert.ok((result.stdout + result.stderr).includes('SvelteKit 3 does not provide $lib automatically. Declare #lib imports in package.json and use file extensions.'),
				'The removed alias must explain subpath imports');
		}
	}
} finally {
	writeFileSync(handler, original);
	writeFileSync(manifest, originalManifest);
	if (libraryWritten) rmSync(library, { force: true });
	if (wildcardLibraryWritten) rmSync(wildcardLibrary, { force: true });
	if (wildcardIndexWritten) rmSync(wildcardIndex, { force: true });
	if (exactLibraryWritten) rmSync(exactLibrary, { force: true });
	if (wildcardDirectoryCreated) rmdirSync(wildcardDirectory);
}
console.log('Kit 3 fallback smoke passed: actionable import errors; subpath and explicit aliases resolve over HTTP and WebSockets');
