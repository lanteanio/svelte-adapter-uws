#!/usr/bin/env node
/**
 * `npm run doctor` - does a green run on this machine prove anything?
 *
 * The failure this exists for: uWebSockets.js is an OPTIONAL native dependency,
 * so package-manager scripts can be disabled or the platform binary can fail to
 * load. The install can otherwise look green while every
 * suite that boots the real built runtime over real sockets reported as skipped
 * - which in a summary is indistinguishable from a suite that ran and proved
 * something. The same shape appears one layer out: the test fixture is a
 * separate app with its own lockfile, and a root `npm ci` does not install it,
 * so those suites instead die inside a `vite build` whose output never names the
 * missing install.
 *
 * Every check answers one question and carries a severity:
 *
 *   - FAIL: the suite cannot run, or would run and report a result it has not
 *     earned. Exits 1.
 *   - WARN: one lane is unavailable and the rest stays honest - without the
 *     addon the pure suites still mean exactly what they say.
 *
 * `--require-uws` (or `REQUIRE_UWS=1`, or `CI`) promotes the addon warnings to
 * failures. That is the same rule test/helpers/real-runtime.js applies to the
 * suites themselves, so one switch makes both layers demand the real runtime
 * rather than skipping past it.
 *
 * Environment probes live in main(); the verdicts are pure functions so they can
 * be tested for the platforms this machine is not. The switch itself lives in
 * scripts/require-uws.js and is driven through the real command line by the
 * test suite, because a verdict function handed `required` by a test proves
 * nothing about whether main() ever computes it. Dependency-free, modeled on
 * the sibling check-* scripts.
 *
 * @module scripts/doctor
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { requiredMode } from './require-uws.js';
import { uwsInstallSpec } from '../src/uws-load-hint.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Platform/arch combinations the pinned addon ships a prebuilt binary for. It
 * publishes `uws_<platform>_<arch>_<abi>.node` files and nothing else - there is
 * no source build to fall back to - so anything absent here has no path to a
 * working install at all, which is worth saying before the fetch is attempted.
 */
const SUPPORTED = { linux: ['x64', 'arm64'], darwin: ['x64', 'arm64'], win32: ['x64'] };

// The prebuilt Linux binaries are linked against glibc; musl has no build, and
// an older glibc than this refuses to load the one it does have.
const GLIBC_FLOOR = '2.38';

/**
 * The oldest npm major that WRITES each package-lock format. An npm below the
 * entry for the committed lockfile rewrites the whole file into its own format
 * on the next install, which lands as a several-thousand-line diff that has
 * nothing to do with the change it arrives in.
 */
const LOCKFILE_WRITERS = { 1: 6, 2: 7, 3: 9 };

/** @typedef {{ name: string, status: 'ok' | 'warn' | 'fail', detail: string, fix?: string }} Verdict */

/**
 * Numeric parts of a version, tolerating a leading `v` and trailing labels.
 * @param {string} v
 * @returns {number[]}
 */
export function versionParts(v) {
	return String(v).replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);
}

/**
 * Compare two dotted versions. Returns <0, 0 or >0.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
	const x = versionParts(a);
	const y = versionParts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] || 0) - (y[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * Node itself: below the published floor is a failure, a different major from
 * the baseline the hosted gate runs is a warning (it is the version whose native
 * ABI the addon is proven against here).
 *
 * @param {string} running e.g. `v22.23.2`
 * @param {string} floor the `engines.node` minimum, e.g. `22.0.0`
 * @param {string} baseline the `.nvmrc` pin
 * @returns {Verdict}
 */
export function nodeVerdict(running, floor, baseline) {
	const detail = `${running} (engines >=${floor}, baseline ${baseline})`;
	if (compareVersions(running, floor) < 0) {
		return {
			name: 'node', status: 'fail', detail,
			fix: `install Node ${baseline} or newer (.nvmrc pins it; \`nvm use\` reads that file)`
		};
	}
	if (versionParts(running)[0] !== versionParts(baseline)[0]) {
		return {
			name: 'node', status: 'warn', detail,
			fix: `the hosted gate runs ${baseline}; a different major resolves a different native ABI, so a green run here is not the same evidence`
		};
	}
	return { name: 'node', status: 'ok', detail };
}

/**
 * The package manager.
 *
 * There is deliberately no second version pin for npm. `.nvmrc` is the one
 * baseline, and a Node release BUNDLES an npm, so pinning a second number that
 * nothing installs produces two baselines that disagree - and the doctor would
 * then warn on exactly the configuration the project tells people to adopt. A
 * warning that fires on a correct setup teaches the reader to skip doctor
 * output, which is the failure this whole script exists to close.
 *
 * What actually matters is not a version string but a capability: the committed
 * package-lock.json is written in a FORMAT, and an npm too old to write that
 * format rewrites the entire file on the next install. That is a question about
 * this tree, so it is asked of this tree.
 *
 * @param {string | null} running e.g. `10.9.8`, or null when doctor was not run through npm
 * @param {number} lockfileVersion the `lockfileVersion` of the committed package-lock.json
 * @returns {Verdict}
 */
export function npmVerdict(running, lockfileVersion) {
	if (running === null) {
		return { name: 'npm', status: 'ok', detail: `not run through npm (lockfile v${lockfileVersion})` };
	}
	const detail = `${running} (lockfile v${lockfileVersion})`;
	const floor = LOCKFILE_WRITERS[lockfileVersion];
	if (floor === undefined) {
		return {
			name: 'npm', status: 'warn', detail,
			fix: `package-lock.json is format v${lockfileVersion}, which is newer than any npm this check knows about; update scripts/doctor.js rather than trusting the silence`
		};
	}
	if (versionParts(running)[0] < floor) {
		return {
			name: 'npm', status: 'warn', detail,
			fix: `package-lock.json is format v${lockfileVersion} and npm ${floor} or newer writes it; npm ${versionParts(running)[0]} rewrites the whole file in its own format on the next install`
		};
	}
	return { name: 'npm', status: 'ok', detail };
}

/**
 * Whether the addon has a prebuilt binary for this machine at all.
 *
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 * @param {{ name: string, version: string | null } | null} libc detected C library, Linux only
 * @returns {Verdict}
 */
export function platformVerdict(platform, arch, libc) {
	const detail = `${platform}/${arch}${libc ? ` ${libc.name}${libc.version ? ' ' + libc.version : ''}` : ''}`;
	const arches = SUPPORTED[platform];
	if (!arches || !arches.includes(arch)) {
		return {
			name: 'platform', status: 'fail', detail,
			fix: `the addon ships prebuilt binaries only for ${Object.entries(SUPPORTED).map(([p, a]) => `${p}/${a.join(',')}`).join(' ')}`
		};
	}
	if (libc && libc.name === 'musl') {
		return { name: 'platform', status: 'fail', detail, fix: 'musl has no prebuilt binary; use a glibc image' };
	}
	if (libc && libc.name === 'glibc' && libc.version && compareVersions(libc.version, GLIBC_FLOOR) < 0) {
		return {
			name: 'platform', status: 'fail', detail,
			fix: `the prebuilt binary needs glibc >= ${GLIBC_FLOOR}; this is ${libc.version}`
		};
	}
	return { name: 'platform', status: 'ok', detail };
}

/**
 * The native addon. Absent it, the real-runtime suites skip and report PASSED
 * with zero assertions, so absence is a warning only while nobody is treating
 * the run as a gate - and a failure the moment somebody is.
 *
 * @param {{ version: string | null, error: string | null, pinned: string, required: boolean }} state
 * @returns {Verdict}
 */
export function uwsVerdict({ version, error, pinned, required }) {
	if (version === null) {
		return {
			name: 'uWebSockets.js', status: required ? 'fail' : 'warn',
			detail: `not loadable${error ? ` (${error})` : ''}`,
			fix: `npm install ${pinned} - until then every real-runtime suite SKIPS and the run reports PASSED having proved nothing`
		};
	}
	const want = (pinned.match(/v(\d+\.\d+\.\d+)(?:\.tar\.gz)?$/) || [])[1] || '';
	if (want && version !== want) {
		return {
			name: 'uWebSockets.js', status: 'warn', detail: `${version} installed, pin is ${want}`,
			fix: 'npm install - the installed binary is not the one this tree is tested against'
		};
	}
	return { name: 'uWebSockets.js', status: 'ok', detail: version };
}

/**
 * Process exit code for a set of verdicts: any failure is a non-zero exit.
 * @param {Verdict[]} results
 * @returns {number}
 */
export function exitCode(results) {
	return results.some((r) => r.status === 'fail') ? 1 : 0;
}

/** The C library this Linux build is linked against, or null off Linux. */
function detectLibc() {
	if (process.platform !== 'linux') return null;
	try {
		const header = process.report.getReport().header;
		return header.glibcVersionRuntime
			? { name: 'glibc', version: String(header.glibcVersionRuntime) }
			: { name: 'musl', version: null };
	} catch {
		return null;
	}
}

/** Can this process accept a TCP connection at all? Every socket suite needs it. */
function canListen() {
	return new Promise((done) => {
		const server = createServer();
		server.once('error', () => done(false));
		server.listen(0, '127.0.0.1', () => server.close(() => done(true)));
	});
}

/** npm's own version, from the user agent npm sets when it runs a script. */
function runningNpm() {
	const ua = process.env.npm_config_user_agent;
	const m = ua && /(?:^|\s)npm\/(\S+)/.exec(ua);
	return m ? m[1] : null;
}

async function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
	const required = requiredMode(process.argv, process.env);

	console.log(`doctor: ${pkg.name}@${pkg.version}${required ? ' (native runtime required)' : ''}`);

	/** @type {Verdict[]} */
	const results = [];

	const floor = (pkg.engines && pkg.engines.node || '>=0').replace(/[^0-9.]/g, '');
	const baseline = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
	results.push(nodeVerdict(process.version, floor, baseline));
	results.push(npmVerdict(runningNpm(), lock.lockfileVersion));
	results.push(platformVerdict(process.platform, process.arch, detectLibc()));

	const rootDeps = existsSync(join(root, 'node_modules', 'vitest'));
	results.push(rootDeps
		? { name: 'dependencies', status: 'ok', detail: 'node_modules present' }
		: { name: 'dependencies', status: 'fail', detail: 'node_modules missing or incomplete', fix: 'npm ci' });

	// Load the module rather than resolve it: the failure worth catching is the
	// one where the package installed but its binary does not dlopen on this
	// ABI. Its manifest is read off the resolved path because the package
	// exports no `./package.json` subpath.
	let version = null;
	let error = null;
	try {
		const req = createRequire(import.meta.url);
		req('uWebSockets.js');
		version = JSON.parse(readFileSync(join(dirname(req.resolve('uWebSockets.js')), 'package.json'), 'utf8')).version;
	} catch (e) {
		error = String(e && e.message || e).split('\n')[0];
	}
	const pinned = uwsInstallSpec(pkg) || '';
	results.push(uwsVerdict({ version, error, pinned, required }));

	// The fixture is a separate app with a separate lockfile. When the addon IS
	// present the real-runtime suites will try to build it, so a missing install
	// is a failure rather than a warning: the run would go red anyway, several
	// minutes later, with a raw Vite error.
	const fixtureDeps = existsSync(join(root, 'test', 'fixture', 'node_modules', 'svelte-adapter-uws'));
	results.push(fixtureDeps
		? { name: 'fixture', status: 'ok', detail: 'test/fixture dependencies installed' }
		: {
			name: 'fixture', status: version !== null ? 'fail' : 'warn',
			detail: 'test/fixture/node_modules missing',
			fix: 'npm run bootstrap - a root install does not install the fixture, and the real-runtime suites build it'
		});

	results.push(await canListen()
		? { name: 'sockets', status: 'ok', detail: 'can listen on 127.0.0.1' }
		: { name: 'sockets', status: 'fail', detail: 'cannot bind a loopback listener', fix: 'every runtime suite drives a real socket; a sandbox that blocks listening fails all of them' });

	// Not hosted anywhere, so nobody but the person running it will notice it is
	// unavailable - which is exactly why it is reported rather than assumed.
	try {
		const { chromium } = await import('@playwright/test');
		const exe = chromium.executablePath();
		results.push(existsSync(exe)
			? { name: 'playwright', status: 'ok', detail: 'chromium installed' }
			: { name: 'playwright', status: 'warn', detail: 'chromium not installed', fix: 'npx playwright install chromium - needed by `npm run test:e2e`, which no workflow runs' });
	} catch {
		results.push({ name: 'playwright', status: 'warn', detail: 'not installed', fix: 'npm ci - `npm run test:e2e` needs it' });
	}

	const width = results.reduce((w, r) => Math.max(w, r.name.length), 0);
	for (const r of results) {
		const label = r.status === 'ok' ? 'OK  ' : r.status === 'warn' ? 'WARN' : 'FAIL';
		const line = `  ${label} ${r.name.padEnd(width)}  ${r.detail}`;
		(r.status === 'fail' ? console.error : console.log)(line);
		if (r.fix && r.status !== 'ok') (r.status === 'fail' ? console.error : console.log)(`       ${' '.repeat(width)}  fix: ${r.fix}`);
	}

	const failed = results.filter((r) => r.status === 'fail');
	const warned = results.filter((r) => r.status === 'warn');
	if (failed.length) {
		console.error(`\ndoctor FAILED (${failed.length} blocking, ${warned.length} warning(s)): ${failed.map((r) => r.name).join(', ')}`);
	} else if (warned.length) {
		console.log(`  ${warned.length} warning(s), nothing blocking.${required ? '' : ' Add --require-uws to demand the native runtime.'}`);
	} else {
		console.log('  OK - this machine can run every lane.');
	}
	process.exit(exitCode(results));
}

// Importable for its own test suite; only the CLI invocation probes the machine.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
