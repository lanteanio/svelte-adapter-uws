import { it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

it('keeps the real SSR runner shared across HTTP and WebSocket reloads', async () => {
	try {
		await promisify(execFile)(process.execPath, [
			'--test', fileURLToPath(new URL('./vite-runner-hmr.mjs', import.meta.url))
		], { timeout: 30_000 });
	} catch (error) {
		throw new Error(`${error.stdout || ''}\n${error.stderr || ''}`, { cause: error });
	}
}, 35_000);
