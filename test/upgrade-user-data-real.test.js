import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';

beforeAll(() => { expect(buildFixtureOnce('reusedata')).toBe(true); }, 400000);
for (const surface of ['production', 'testing', 'vite']) {
	describe(`reused upgrade data on ${surface}`, () => {
		it.each(['direct', 'spread'])('opens fresh connection state from a %s return without killing the worker', mode => {
			const env = { ...process.env };
			delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
			if (env.NODE_ENV === 'test') delete env.NODE_ENV;
			const output = execFileSync(process.execPath, [fileURLToPath(new URL('./helpers/upgrade-user-data-child.mjs', import.meta.url)), surface, mode], {
				env, encoding: 'utf8', timeout: 60000, windowsHide: true
			});
			expect(output).toContain('USER_DATA_COPY_OK');
		}, 65000);
	});
}
