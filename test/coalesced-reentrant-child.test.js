import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;
describeUWS('unbounded reentrant coalesced serialization', () => {
	it.each(['production', 'testing'].flatMap((surface) => ['same', 'new'].map((repeat) => ({ surface, repeat }))))('keeps serving on $surface when toJSON keeps queueing $repeat keys', async ({ surface, repeat }) => {
		expect(buildFixtureOnce('default')).toBe(true);
		const outcome = await new Promise((resolve) => {
			const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/coalesced-reentrant-child.mjs', import.meta.url)), surface, repeat], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			child.stdout.on('data', (chunk) => { output += chunk; });
			child.stderr.on('data', (chunk) => { output += chunk; });
			const timer = setTimeout(() => { child.kill(); }, 15000);
			child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error) }); });
			child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
		});
		expect(outcome.code, outcome.output).toBe(0);
		expect(outcome.output).toContain('REENTRANT_OK');
	}, 25000);
});
