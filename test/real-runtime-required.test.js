import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

// Force only the native binding lookup to fail in a fresh process. The normal
// test process has uWS installed, so deleting or renaming its shared dependency
// would be both racy and destructive; intercepting Module._load gives the
// helper the exact MODULE_NOT_FOUND branch without touching the worktree.
const FORCE_MISSING = `
const Module = require('node:module');
const load = Module._load;
Module._load = function (request) {
	if (request === 'uWebSockets.js') {
		const error = new Error('forced missing');
		error.code = 'MODULE_NOT_FOUND';
		throw error;
	}
	return load.apply(this, arguments);
};
import('./test/helpers/real-runtime.js')
	.then((mod) => console.log(JSON.stringify({ hasUWS: mod.hasUWS })))
	.catch((error) => {
		console.error(error.message);
		process.exitCode = 23;
	});
`;

function runWithMissingUWS(env) {
	return spawnSync(process.execPath, ['-e', FORCE_MISSING], {
		cwd: root,
		encoding: 'utf8',
		env: {
			...process.env,
			CI: '',
			REQUIRE_UWS: '',
			...env
		}
	});
}

describe('the real-runtime native dependency gate', () => {
	it('keeps a missing optional binding permissive for a local pure-suite run', () => {
		const result = runWithMissingUWS({});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ hasUWS: false });
	});

	it.each([
		['REQUIRE_UWS', { REQUIRE_UWS: '1' }],
		['CI', { CI: 'true' }]
	])('fails loudly under %s instead of silently skipping', (_label, env) => {
		const result = runWithMissingUWS(env);
		expect(result.status).toBe(23);
		expect(result.stderr).toContain('every real-runtime suite would skip');
		expect(result.stderr).toContain('PASSED with zero assertions');
	});
});
