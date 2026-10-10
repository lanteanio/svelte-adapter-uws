import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const cases = [
	['limit', 'consumed', 'chunked', '80000'],
	['auth', 'cancel', 'known', '10'], ['auth', 'cancel', 'known', '60000'],
	['auth', 'cancel', 'chunked', '10'], ['auth', 'reader', 'chunked', '10'],
	['auth', 'iterator', 'chunked', '10'], ['ssr', 'cancel', 'known', '10'],
	['ssr', 'cancel', 'known', '80000'], ['ssr', 'reader', 'known', '80000'],
	['ssr', 'iterator', 'chunked', '10'],
	...['revoked', 'prototype', 'native-prototype'].map(mode => ['throw', mode, '', ''])
];
(hasUWS ? describe : describe.skip)('request-body cancellation and arbitrary auth failures on native HTTP', () => {
	beforeAll(() => { expect(buildFixtureOnce('bodysafety')).toBe(true); }, 400000);
	it.each(cases)('keeps serving after %s %s %s %s', async (kind, mode, framing, length) => {
		const outcome = await new Promise(resolve => {
			const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/body-safety-child.mjs', import.meta.url)), kind, mode, framing, length], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			child.stdout.on('data', chunk => { output += chunk; });
			child.stderr.on('data', chunk => { output += chunk; });
			const timer = setTimeout(() => child.kill(), 12000);
			child.on('error', error => { clearTimeout(timer); resolve({ code: -1, output: String(error) }); });
			child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
		});
		expect(outcome.code, outcome.output).toBe(0);
		expect(outcome.output).toContain('BODY_SAFETY_OK');
	}, 15000);
});
