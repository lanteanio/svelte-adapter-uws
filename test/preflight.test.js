import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
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

	it('ships every executable it declares, and every internal module they import', () => {
		expect(pkg.bin['svelte-adapter-uws-preflight']).toBe('./scripts/preflight.js');
		for (const file of [
			'scripts/preflight.js',
			'scripts/doctor.js',
			'scripts/require-uws.js'
		]) {
			expect(pkg.files).toContain(file);
		}

		/** Whether `files` publishes a path, directly or through a directory. */
		const publishes = (relative) => pkg.files.some((entry) =>
			entry === relative || relative.startsWith(entry.replace(/\/$/, '') + '/'));

		// Every declared bin, not only the first one written: a bin that is
		// not published, or whose internal imports are not, is a
		// module-not-found the moment a consumer runs it - and that is
		// invisible here until someone runs the published package.
		for (const [name, target] of Object.entries(pkg.bin)) {
			const relativeTarget = target.replace(/^\.\//, '');
			expect(publishes(relativeTarget), `bin ${name} -> ${relativeTarget} is not published`).toBe(true);

			// The file list must be derived from what each bin actually
			// imports, not from a hand-kept list.
			const source = readFileSync(new URL(`../${relativeTarget}`, import.meta.url), 'utf8');
			const localImports = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
			const binDirectory = posix.dirname(relativeTarget);
			for (const specifier of localImports) {
				// Normalize against the bin's OWN directory: an import may
				// climb out of it (../src/...), and a bin nested deeper than
				// scripts/ resolves its siblings from where it actually sits.
				const relative = posix.normalize(posix.join(binDirectory, specifier));
				expect(publishes(relative), `${relative} is imported by bin ${name} but not published`).toBe(true);
			}
		}

		// The preflight bin in particular is expected to have internal
		// imports; a version of it with none would mean the diagnosis moved
		// somewhere this check no longer follows.
		const preflightSource = readFileSync(new URL('../scripts/preflight.js', import.meta.url), 'utf8');
		expect([...preflightSource.matchAll(/from\s+'(\.[^']+)'/g)].length).toBeGreaterThan(0);
	});

	it('runs as a real spawned process, not a silently skipped module', async () => {
		// The CLI guard compares argv[1] to import.meta.url. Before it
		// resolved symlinks, the POSIX node_modules/.bin link made the
		// published bin a no-op that exited 0 having checked nothing - so a
		// CI step or a documented stop-condition built on it always passed.
		// Only spawning it proves the guard fires.
		const { execFileSync } = await import('node:child_process');
		const script = fileURLToPath(new URL('../scripts/preflight.js', import.meta.url));
		let output = '';
		let status = 0;
		try {
			output = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 120000 });
		} catch (error) {
			output = String(error.stdout || '') + String(error.stderr || '');
			status = error.status ?? 1;
		}
		// Either verdict is legitimate here (the native addon may be absent);
		// what must never happen is silent success with no report at all.
		expect(output, 'the bin produced no preflight report, so its CLI guard did not fire').toMatch(/preflight/i);
		expect([0, 1]).toContain(status);
	}, 130000);
});
