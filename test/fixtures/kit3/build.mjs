import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
	fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url)),
	'build', ...process.argv.slice(2)
], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 120000, windowsHide: true });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'The Kit 3 application must build successfully');
assert.ok(!(result.stdout + result.stderr).includes('adapter_config_kit_deprecated'),
	'Kit 3 adapters must read the flat builder configuration');
