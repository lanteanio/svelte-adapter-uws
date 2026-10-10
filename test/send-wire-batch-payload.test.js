import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;
const runner = fileURLToPath(new URL('./helpers/send-wire-batch-payload-runner.js', import.meta.url));

// The parent owns the deadline even if an invalid codec payload makes frame
// construction stop yielding, so a regression cannot wedge the suite itself.
function runIsolated(runtime) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [runner, runtime], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.stderr.on('data', (chunk) => { output += chunk; });
		let expired = false;
		const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 20000);
		child.once('error', (error) => { clearTimeout(deadline); reject(error); });
		child.once('close', (code) => {
			clearTimeout(deadline);
			resolve({ code, expired, output });
		});
	});
}

describeUWS('sendWireBatch validates codec payloads before binary admission', () => {
	beforeAll(() => { expect(buildFixtureOnce()).toBe(true); }, 400000);

	it.each(['built', 'testing'])('rejects invalid payloads and preserves delivery on %s runtime', async (runtime) => {
		const result = await runIsolated(runtime);
		expect(result.expired, result.output).toBe(false);
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain('send-wire-batch-payload: 41 cases passed');
	}, 30000);
});
