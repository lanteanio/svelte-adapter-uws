// The environment doctor's own tests.
//
// The defect it exists for is a run that goes green having proved nothing: the
// native addon is an OPTIONAL dependency and npm skips it silently, so the
// severity split below is the whole point of the script. Absence is a warning
// while nobody is treating the run as a gate, and a FAILURE the moment somebody
// is - so `uwsVerdict` under `required` is pinned here, not assumed.
//
// The platform verdicts cover the machines this one is not: the addon ships
// prebuilt binaries for a fixed set and has no source build to fall back on, so
// a Windows arm64 or a musl container has no path to a working install at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	compareVersions, nodeVerdict, npmVerdict, platformVerdict, uwsVerdict, exitCode
} from '../scripts/doctor.js';
import { requiredMode } from '../scripts/require-uws.js';

describe('doctor version comparison', () => {
	it('orders by numeric part, not lexically', () => {
		expect(compareVersions('22.9.0', '22.10.0')).toBeLessThan(0);
		expect(compareVersions('v22.23.2', '22.23.2')).toBe(0);
		expect(compareVersions('24.0.0', '22.23.2')).toBeGreaterThan(0);
	});

	it('treats a missing part as zero', () => {
		expect(compareVersions('2.38', '2.38.0')).toBe(0);
		expect(compareVersions('2.36', '2.38')).toBeLessThan(0);
	});
});

describe('doctor node verdict', () => {
	it('fails below the published engines floor', () => {
		const v = nodeVerdict('v20.19.0', '22.0.0', '22.23.2');
		expect(v.status).toBe('fail');
		expect(v.fix).toContain('22.23.2');
	});

	it('warns on a different major than the gate runs', () => {
		expect(nodeVerdict('v24.13.1', '22.0.0', '22.23.2').status).toBe('warn');
	});

	it('accepts the baseline major', () => {
		expect(nodeVerdict('v22.20.0', '22.0.0', '22.23.2').status).toBe('ok');
		expect(nodeVerdict('v22.23.2', '22.0.0', '22.23.2').status).toBe('ok');
	});
});

describe('doctor npm verdict', () => {
	// There is one baseline, `.nvmrc`, and a Node release bundles an npm. A
	// second pin naming a DIFFERENT npm would make the doctor warn on exactly
	// the setup the project tells contributors to adopt, so the question asked
	// here is the one that has a consequence: can the running npm write the
	// lockfile format this repository committed, or does the next install
	// rewrite the whole file?
	it('accepts an npm new enough to write the committed lockfile format', () => {
		expect(npmVerdict('9.0.0', 3).status).toBe('ok');
		expect(npmVerdict('10.9.8', 3).status).toBe('ok');
		expect(npmVerdict('11.8.0', 3).status).toBe('ok');
	});

	// The npm that Node 22.23.2 bundles is 10.9.8, which is what a contributor
	// following `.nvmrc` gets. It must not produce a warning.
	it('does not warn on the npm the pinned Node baseline bundles', () => {
		const v = npmVerdict('10.9.8', 3);
		expect(v.status).toBe('ok');
		expect(v.fix).toBeUndefined();
	});

	it('warns when the running npm would rewrite the lockfile into an older format', () => {
		const v = npmVerdict('8.19.4', 3);
		expect(v.status).toBe('warn');
		expect(v.fix).toContain('rewrites the whole file');
	});

	it('warns rather than passing silently on a lockfile format it does not know', () => {
		expect(npmVerdict('11.8.0', 4).status).toBe('warn');
	});

	it('says nothing useful when it was not run through npm', () => {
		expect(npmVerdict(null, 3).status).toBe('ok');
	});
});

describe('the switch that makes a run a gate', () => {
	it('is set by the flag, by REQUIRE_UWS and by CI, and by nothing else', () => {
		expect(requiredMode(['node', 'doctor.js', '--require-uws'], {})).toBe(true);
		expect(requiredMode([], { REQUIRE_UWS: '1' })).toBe(true);
		expect(requiredMode([], { CI: 'true' })).toBe(true);
		expect(requiredMode([], {})).toBe(false);
	});

	// A shell that exports CI='' to opt out has to be able to opt out, so the
	// value is matched exactly rather than for truthiness.
	it('treats an emptied CI as opted out', () => {
		expect(requiredMode([], { CI: '', REQUIRE_UWS: '' })).toBe(false);
		expect(requiredMode([], { REQUIRE_UWS: '0' })).toBe(false);
	});
});

describe('doctor platform verdict', () => {
	it('accepts the platforms the addon ships a binary for', () => {
		expect(platformVerdict('linux', 'x64', { name: 'glibc', version: '2.39' }).status).toBe('ok');
		expect(platformVerdict('darwin', 'arm64', null).status).toBe('ok');
		expect(platformVerdict('win32', 'x64', null).status).toBe('ok');
	});

	it('fails an arch with no prebuilt binary', () => {
		expect(platformVerdict('win32', 'arm64', null).status).toBe('fail');
		expect(platformVerdict('freebsd', 'x64', null).status).toBe('fail');
	});

	it('fails musl and a glibc older than the binary needs', () => {
		expect(platformVerdict('linux', 'x64', { name: 'musl', version: null }).status).toBe('fail');
		expect(platformVerdict('linux', 'x64', { name: 'glibc', version: '2.36' }).status).toBe('fail');
	});
});

describe('doctor native runtime verdict', () => {
	const pinned = 'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz';

	it('warns when the addon is absent and nothing demanded it', () => {
		const v = uwsVerdict({ version: null, error: 'Cannot find module', pinned, required: false });
		expect(v.status).toBe('warn');
		expect(v.fix).toContain('npm install ' + pinned);
	});

	it('fails when the addon is absent and the run is being treated as a gate', () => {
		expect(uwsVerdict({ version: null, error: null, pinned, required: true }).status).toBe('fail');
	});

	it('warns when the installed version is not the pinned one', () => {
		const v = uwsVerdict({ version: '20.67.0', pinned, error: null, required: false });
		expect(v.status).toBe('warn');
		expect(v.detail).toContain('pin is 20.69.0');
	});

	it('accepts the pinned version', () => {
		expect(uwsVerdict({ version: '20.69.0', pinned, error: null, required: true }).status).toBe('ok');
	});
});

describe('doctor exit code', () => {
	it('is non-zero if and only if something failed', () => {
		expect(exitCode([{ status: 'ok' }, { status: 'warn' }])).toBe(0);
		expect(exitCode([{ status: 'ok' }, { status: 'fail' }])).toBe(1);
	});

	// End to end, so the printed rows and the exit code cannot disagree: a
	// doctor that reports FAIL and exits 0 is worse than no doctor.
	it('exits non-zero exactly when it printed a failing row', () => {
		const script = fileURLToPath(new URL('../scripts/doctor.js', import.meta.url));
		const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
		const output = run.stdout + run.stderr;
		expect(output).toMatch(/^doctor: svelte-adapter-uws@/);
		expect(output).toMatch(/uWebSockets\.js/);
		expect(run.status).toBe(/^ {2}FAIL /m.test(output) ? 1 : 0);
	});
});

// The severity split above is decided in main(), from argv and the environment,
// and every verdict test hands `required` in by hand - so main()'s own
// computation could be replaced with a constant `false` and all of them would
// still pass while the hosted gate went green having loaded no addon at all.
//
// These drive the REAL command line with the addon made genuinely unloadable in
// the child process, which is what a silently skipped optional install looks
// like from inside. A preload refuses to resolve it; nothing else is faked, and
// the assertions are on the printed row and the exit status, which is what a
// workflow step reads.
describe('the doctor honours the switch on the real command line', () => {
	const script = fileURLToPath(new URL('../scripts/doctor.js', import.meta.url));
	/** @type {string} */
	let dir;
	/** @type {string} */
	let preload;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'doctor-no-addon-'));
		preload = join(dir, 'no-addon.cjs');
		writeFileSync(preload, [
			"const Module = require('node:module');",
			'const resolveFilename = Module._resolveFilename;',
			'Module._resolveFilename = function (request, ...rest) {',
			"\tif (request === 'uWebSockets.js') {",
			'\t\tconst error = new Error("Cannot find module \'uWebSockets.js\'");',
			"\t\terror.code = 'MODULE_NOT_FOUND';",
			'\t\tthrow error;',
			'\t}',
			'\treturn resolveFilename.call(this, request, ...rest);',
			'};',
			''
		].join('\n'));
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/**
	 * @param {string[]} args
	 * @param {Record<string, string>} env
	 */
	const runWithoutAddon = (args, env) => spawnSync(
		process.execPath, ['--require', preload, script, ...args],
		{ encoding: 'utf8', env: { ...process.env, REQUIRE_UWS: '', CI: '', ...env } }
	);

	it('warns and exits 0 when nothing is treating the run as a gate', () => {
		const run = runWithoutAddon([], {});
		const output = run.stdout + run.stderr;
		expect(output).not.toContain('native runtime required');
		expect(output).toMatch(/^ {2}WARN uWebSockets\.js/m);
		expect(run.status).toBe(0);
	});

	it.each([
		['the flag', ['--require-uws'], {}],
		['REQUIRE_UWS', [], { REQUIRE_UWS: '1' }],
		['CI', [], { CI: 'true' }]
	])('fails when %s demands the native runtime and it will not load', (_label, args, env) => {
		const run = runWithoutAddon(args, env);
		const output = run.stdout + run.stderr;
		expect(output).toContain('native runtime required');
		expect(output).toMatch(/^ {2}FAIL uWebSockets\.js/m);
		expect(run.status).toBe(1);
	});
});
