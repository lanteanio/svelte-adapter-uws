import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;
const runner = fileURLToPath(new URL('./helpers/wire-codec-payload-runner.js', import.meta.url));

// The parent owns the deadline even if an invalid codec payload makes frame
// construction stop yielding, so a regression cannot wedge the suite itself.
function runIsolated(runtime, api) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [runner, runtime, api], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.stderr.on('data', (chunk) => { output += chunk; });
		let expired = false;
		const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 45000);
		child.once('error', (error) => { clearTimeout(deadline); reject(error); });
		child.once('close', (code) => {
			clearTimeout(deadline);
			resolve({ code, expired, output });
		});
	});
}

describeUWS('send and publish validate codec payloads before binary admission', () => {
	beforeAll(() => { expect(buildFixtureOnce()).toBe(true); }, 400000);

	// Each child starts at most 23 real connections, below the built runtime's
	// upgrade-rate limit, with independent state and a bounded failure deadline.
	const lanes = ['sendWire-stateful', 'sendWire-stateless', 'publishWire-stateful', 'publishWire-shared', 'publishWire-stateless', 'publishWireBatch-batch', 'publishWireBatch-entry', 'publishWireBatch-stateless'];
	const partial = new Set(['publishWire-stateful', 'publishWireBatch-batch', 'publishWireBatch-entry', 'publishWireBatch-stateless']);
	it.each(['built', 'testing'].flatMap(runtime => lanes.map(api => [runtime, api])))('rejects invalid payloads and preserves %s %s delivery', async (runtime, api) => {
		const result = await runIsolated(runtime, api);
		expect(result.expired, result.output).toBe(false);
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain('wire-codec-payload: ' + (partial.has(api) ? 22 : 21) + ' cases passed');
	}, 45000);
});
