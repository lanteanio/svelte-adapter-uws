import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';
beforeAll(() => { expect(buildFixtureOnce('setupfailure')).toBe(true); }, 400000);
it.each(['platform', 'registration'])('contains an internal %s failure after the native upgrade', mode => {
	const env = { ...process.env };
	delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
	if (env.NODE_ENV === 'test') delete env.NODE_ENV;
	const output = execFileSync(process.execPath, [fileURLToPath(new URL('./helpers/setup-failure-child.mjs', import.meta.url)), mode], {
		env, encoding: 'utf8', timeout: 60000, windowsHide: true
	});
	expect(output).toContain('CONNECTION_SETUP_RECOVERED');
}, 65000);
