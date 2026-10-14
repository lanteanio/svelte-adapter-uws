import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
	'--test', fileURLToPath(new URL('../../vite-runner-hmr.mjs', import.meta.url))
], {
	env: { ...process.env, VITE_HMR_ENTRY: import.meta.resolve('vite') },
	stdio: 'inherit', timeout: 60000, windowsHide: true
});
assert.ifError(result.error);
assert.equal(result.status, 0, 'The locked Vite runner preserves shared state across reloads');
