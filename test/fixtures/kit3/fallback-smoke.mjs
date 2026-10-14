import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url));
const handler = new URL('./src/socket.js', import.meta.url);
const original = readFileSync(handler);
const imports = [
	'$app/env', '$app/env/private', '$app/env/public', '$app/environment',
	'$env/dynamic/private', '$env/dynamic/public', '$env/static/private', '$env/static/public'
];
try {
	for (const id of imports) {
		writeFileSync(handler, `import * as environment from '${id}';
export function message(ws) { ws.send(JSON.stringify(environment)); }
`);
		const result = spawnSync(process.execPath, [executable, 'build', '--mode', 'fallback'], {
			cwd: fileURLToPath(new URL('.', import.meta.url)),
			encoding: 'utf8', timeout: 120000, windowsHide: true
		});
		assert.ifError(result.error);
		assert.notEqual(result.status, 0, `${id} without uws() must fail at build time`);
		assert.ok((result.stdout + result.stderr).includes(
			'SvelteKit 3 environment imports in WebSocket handlers require the Vite plugin. ' +
			"Add uws() from 'svelte-adapter-uws/vite' after sveltekit() in vite.config.js."
		), `${id} must explain how to enable SvelteKit environment imports`);
	}
} finally {
	writeFileSync(handler, original);
}
console.log('Kit 3 fallback smoke passed: actionable errors for all environment import forms');
