import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { evaluatePreflight, runPreflight } from '../scripts/preflight.js';

const nativeVersion = '20.69.0';
const good = {
	pkg,
	nodeVersion: 'v22.23.2',
	platform: 'linux',
	arch: 'x64',
	libc: { name: 'glibc', version: '2.38' },
	nativeVersion,
	nativeError: null
};

describe('consumer native preflight', () => {
	it('accepts the documented minimum platform with the pinned addon', () => {
		expect(evaluatePreflight(good).every((result) => result.status === 'ok')).toBe(true);
	});

	it('fails at each Node, OS/arch/libc, and native prerequisite boundary', () => {
		expect(evaluatePreflight({ ...good, nodeVersion: 'v20.19.0' }).find((r) => r.name === 'node').status).toBe('fail');
		expect(evaluatePreflight({ ...good, arch: 'riscv64' }).find((r) => r.name === 'platform').status).toBe('fail');
		expect(evaluatePreflight({ ...good, libc: { name: 'musl', version: null } }).find((r) => r.name === 'platform').status).toBe('fail');
		expect(evaluatePreflight({ ...good, libc: null }).find((r) => r.name === 'platform').status).toBe('fail');
		expect(evaluatePreflight({ ...good, nativeVersion: null, nativeError: 'wrong ABI' }).find((r) => r.name === 'uWebSockets.js').status).toBe('fail');
		expect(evaluatePreflight({ ...good, nativeVersion: '20.67.0' }).find((r) => r.name === 'uWebSockets.js').status).toBe('fail');
	});

	it('prints one explicit success checkpoint only after every prerequisite passes', async () => {
		const lines = [];
		const result = await runPreflight({
			pkg,
			nodeVersion: good.nodeVersion,
			platform: good.platform,
			arch: good.arch,
			libc: good.libc,
			native: { nativeVersion, nativeError: null },
			log: (line) => lines.push(line),
			error: (line) => lines.push(line)
		});
		expect(result.ok).toBe(true);
		expect(lines.at(-1)).toBe('preflight OK - Node, platform/libc, and the pinned native addon are ready.');
		expect(lines.filter((line) => line.includes('preflight OK'))).toHaveLength(1);
	});

	it('returns a failing result and fix at the prerequisite instead of continuing', async () => {
		const lines = [];
		const result = await runPreflight({
			pkg,
			nodeVersion: good.nodeVersion,
			platform: good.platform,
			arch: good.arch,
			libc: good.libc,
			native: { nativeVersion: null, nativeError: 'module did not load' },
			log: (line) => lines.push(line),
			error: (line) => lines.push(line)
		});
		expect(result.ok).toBe(false);
		expect(lines.some((line) => line.includes('preflight FAILED at prerequisite boundary'))).toBe(true);
		expect(lines.some((line) => line.includes('npm install https://github.com/uNetworking'))).toBe(true);
		expect(lines.some((line) => line.includes('preflight OK'))).toBe(false);
	});

	it('ships the executable and every internal module it imports', () => {
		expect(pkg.bin).toEqual({ 'svelte-adapter-uws-preflight': './scripts/preflight.js' });
		for (const file of [
			'scripts/preflight.js',
			'scripts/doctor.js',
			'scripts/require-uws.js'
		]) {
			expect(pkg.files).toContain(file);
		}
	});
});
