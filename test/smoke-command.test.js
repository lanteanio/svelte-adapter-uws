import { describe, it, expect } from 'vitest';
import { runSmoke } from '../scripts/smoke.js';

let hasNative = true;
try {
	await import('uWebSockets.js');
} catch {
	hasNative = false;
}

const describeNative = hasNative ? describe : describe.skip;

describeNative('contributor smoke command', () => {
	it('proves a real liveness request and WebSocket subscribe/publish exchange', async () => {
		const lines = [];
		const result = await runSmoke({ log: (line) => lines.push(line) });

		expect(result.adapter).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.native).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.node).toMatch(/^v\d+/);
		expect(result.healthStatus).toBe(200);
		expect(result.event).toBe('smoke/checkpoint');
		expect(lines[0]).toContain('svelte-adapter-uws');
		expect(lines.at(-1)).toBe(
			'smoke OK: HTTP /healthz 200; WebSocket subscribe + publish delivered; teardown complete'
		);
	}, 15000);
});
