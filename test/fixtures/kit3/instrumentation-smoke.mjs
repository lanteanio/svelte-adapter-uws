import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const instrumentation = new URL('./src/instrumentation.server.js', import.meta.url);
assert.equal(existsSync(instrumentation), false, 'Instrumentation fixture must start without instrumentation');
const source = `import { KIT3_MODULE_TOKEN } from '$app/env/private';
if (KIT3_MODULE_TOKEN !== 'fixture-secret') throw new Error('Instrumentation evaluated before environment initialization');
globalThis.__kit3InstrumentationToken = KIT3_MODULE_TOKEN;
`;
try {
	writeFileSync(instrumentation, source);
	for (const args of [
		[fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url)), 'build'],
		[fileURLToPath(new URL('./smoke.mjs', import.meta.url)), 'instrumented']
	]) {
		const result = spawnSync(process.execPath, args, {
			cwd: fileURLToPath(new URL('.', import.meta.url)),
			env: { ...process.env, KIT3_MODULE_TOKEN: 'fixture-secret' },
			encoding: 'utf8', timeout: 120000, windowsHide: true
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	}
	console.log('Kit 3 instrumentation smoke passed: relocated environment initialization and real HTTP/WebSocket traffic');
} finally {
	unlinkSync(instrumentation);
}
