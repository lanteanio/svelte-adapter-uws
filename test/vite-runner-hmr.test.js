import { it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

it('keeps the real SSR runner shared across HTTP and WebSocket reloads', async () => {
	const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'uws-hmr-parent-'));
	try {
		await promisify(execFile)(process.execPath, [
			'--test', fileURLToPath(new URL('./vite-runner-hmr.mjs', import.meta.url))
		], { timeout: 60_000, env: { ...process.env, UWS_HMR_TEST_ROOT: fixtureRoot } });
	} catch (error) {
		throw new Error(`${error.stdout || ''}\n${error.stderr || ''}`, { cause: error });
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
}, 65_000);
