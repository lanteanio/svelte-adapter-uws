import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url));
const result = spawnSync(process.execPath, [executable, 'build', '--mode', 'fallback'], {
	cwd: fileURLToPath(new URL('.', import.meta.url)),
	encoding: 'utf8',
	timeout: 120000,
	windowsHide: true
});
assert.ifError(result.error);
assert.notEqual(result.status, 0, 'Building a Kit 3 private environment handler without uws() must fail');
assert.match(result.stdout + result.stderr,
	/SvelteKit 3 \$app\/env imports in WebSocket handlers require the Vite plugin\. Add uws\(\) from 'svelte-adapter-uws\/vite' after sveltekit\(\) in vite\.config\.js\./,
	'The unsupported fallback must explain how to enable private environment imports');
console.log('Kit 3 fallback smoke passed: actionable private environment import error');
