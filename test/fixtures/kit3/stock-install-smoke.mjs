import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kit2 = process.argv.includes('--kit2');
const fixture = fileURLToPath(new URL(kit2 ? '../kit2-vite8/' : '.', import.meta.url));
const adapter = path.resolve(fixture, '../../..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this test with npm run smoke:stock');
const consumerRoot = path.resolve(process.env.UWS_TEST_CONSUMER_ROOT || path.join(homedir(), 'Git', '__harness', 'svelte-adapter-uws-stock'));
mkdirSync(consumerRoot, { recursive: true });
const temporary = mkdtempSync(path.join(consumerRoot, kit2 ? 'kit2-stock-' : 'kit3-stock-'));
const consumer = path.join(temporary, 'consumer');
const diagnostic = "Add uws() from 'svelte-adapter-uws/vite' after sveltekit() in vite.config.js.";
function run(args, cwd = consumer) {
	const result = spawnSync(process.execPath, args, {
		cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024, windowsHide: true
	});
	assert.ifError(result.error);
	return result;
}
function succeed(args, cwd) {
	const result = run(args, cwd);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
}
try {
	const packed = JSON.parse(succeed([npmCli, 'pack', '--json', '--pack-destination', temporary], adapter))[0];
	cpSync(fixture, consumer, { recursive: true, filter: (source) =>
		!['node_modules', '.svelte-kit', 'build'].includes(path.relative(fixture, source).split(path.sep)[0]) });
	cpSync(path.join(temporary, packed.filename), path.join(consumer, 'adapter.tgz'));
	const manifest = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
	const lock = JSON.parse(readFileSync(path.join(fixture, 'package-lock.json'), 'utf8'));
	delete manifest.devDependencies.esbuild;
	delete lock.packages[''].devDependencies.esbuild;
	for (const name of Object.keys(lock.packages)) {
		if (name === 'node_modules/esbuild' || name.startsWith('node_modules/@esbuild/')) delete lock.packages[name];
	}
	manifest.dependencies['svelte-adapter-uws'] = 'file:adapter.tgz';
	lock.packages[''].dependencies['svelte-adapter-uws'] = 'file:adapter.tgz';
	lock.packages['node_modules/svelte-adapter-uws'].resolved = 'file:adapter.tgz';
	lock.packages['node_modules/svelte-adapter-uws'].integrity = packed.integrity;
	for (const [name, value] of [['package.json', manifest], ['package-lock.json', lock]]) {
		writeFileSync(path.join(consumer, name), JSON.stringify(value, null, '\t') + '\n');
	}
	succeed([npmCli, 'ci', '--install-links', '--strict-peer-deps', '--no-audit', '--no-fund']);
	const installed = path.join(consumer, 'node_modules/svelte-adapter-uws');
	assert.equal(realpathSync(installed), installed, 'The consumer must use its packed adapter, not a repository link');
	for (const scope of [consumer, installed]) {
		const require = createRequire(path.join(scope, 'package.json'));
		assert.throws(() => require.resolve('esbuild'), { code: 'MODULE_NOT_FOUND' },
			'esbuild must be absent, including ancestor directories');
	}
	const handler = path.join(consumer, kit2 ? 'src/hooks.ws.js' : 'src/socket.js');
	const original = readFileSync(handler);
	const vite = path.join(consumer, 'node_modules/vite/bin/vite.js');
	for (const [name, source] of [
		['plain', 'export function message(ws) { ws.send("plain"); }\n'],
		['environment', "import * as environment from '" + (kit2 ? '$env/dynamic/private' : '$app/env/private') + "';\nexport function message(ws) { ws.send(JSON.stringify(environment)); }\n"]
	]) {
		writeFileSync(handler, source);
		const result = run([vite, 'build', '--mode', 'fallback']);
		assert.notEqual(result.status, 0, name + ' handlers without esbuild or uws() must fail');
		assert.ok((result.stdout + result.stderr).includes(diagnostic),
			name + ' handlers must explain how to add the Vite plugin\n' + result.stdout + result.stderr);
		assert.ok(!(result.stdout + result.stderr).includes('adapter_config_kit_deprecated'),
			'Kit 3 adapters must read the flat builder configuration');
	}
	writeFileSync(handler, original);
	succeed([npmCli, 'run', 'build']);
	succeed([npmCli, 'run', 'smoke']);
	console.log('Kit ' + (kit2 ? '2' : '3') + ' stock install passed: strict peers, no esbuild, actionable fallback errors, production HTTP and WebSockets');
} finally {
	assert.equal(path.dirname(temporary), consumerRoot, 'Only remove the owned consumer directory');
	rmSync(temporary, { recursive: true, force: true });
}
