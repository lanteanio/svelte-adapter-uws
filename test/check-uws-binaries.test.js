// The accepted-binaries guard's own tests.
//
// What it defends: the native addon ships prebuilt binaries built elsewhere.
// The HTTPS archive integrity and the installed file tree are both pinned here,
// and so is the record itself - a pin bumped
// without re-accepting the tree it resolves to is exactly the state this exists
// to make impossible.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acceptedSpec, digestFile, hashTree, refOf, compare } from '../scripts/check-uws-binaries.js';

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const accepted = JSON.parse(read('scripts/uws-accepted.json'));

describe('digesting a shipped file', () => {
	it('reads archive text bytes exactly', () => {
		expect(digestFile(Buffer.from('module.exports = 1;\r\nrequire("./x");\r\n')))
			.not.toBe(digestFile(Buffer.from('module.exports = 1;\nrequire("./x");\n')));
	});

	// Git never rewrites a file containing a NUL, and these are the bytes that
	// get dlopen'd, so they are compared exactly as they landed.
	it('reads a binary raw, so a single flipped byte shows', () => {
		const one = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x0d, 0x0a, 0x01]);
		const two = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x0d, 0x0a, 0x02]);
		expect(digestFile(one)).not.toBe(digestFile(two));
		// ...and a CRLF inside it is content, not a line ending to normalize.
		expect(digestFile(one)).not.toBe(digestFile(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x0a, 0x01])));
	});
});

describe('reading the pinned ref', () => {
	it('takes the archive tag or Git fragment of a legacy spec', () => {
		expect(refOf('https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz')).toBe('v20.69.0');
		expect(refOf('github:uNetworking/uWebSockets.js#v20.69.0')).toBe('v20.69.0');
		expect(refOf('git+ssh://git@github.com/uNetworking/uWebSockets.' + 'js.git#' + 'dddd8ffd')).toBe('dddd8ffd');
	});

	it('reports a spec with no ref rather than inventing one', () => {
		expect(refOf('github:uNetworking/uWebSockets.' + 'js')).toBe(null);
		expect(refOf(undefined)).toBe(null);
	});
});

describe('comparing the installed tree against the accepted one', () => {
	const base = {
		package: 'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/',
		ref: 'v20.69.0',
		integrity: 'sha512-accepted',
		upstreamSourceCommit: 'faf115275bb9c55edf739a06406849e42e89ec04',
		files: { 'uws.js': 'aaa', 'uws_linux_x64_137.node': 'bbb' }
	};
	const matching = {
		spec: acceptedSpec(base), integrity: base.integrity, files: { ...base.files }
	};

	it('passes an identical tree', () => {
		expect(compare(base, matching)).toEqual([]);
	});

	// The whole point: a retag serves different bytes under the same version.
	it('catches a binary whose content changed', () => {
		const problems = compare(base, {
			...matching, files: { ...base.files, 'uws_linux_x64_137.node': 'ccc' }
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('content differs: uws_linux_x64_137.node');
	});

	it('catches a file that appeared and one that vanished', () => {
		const problems = compare(base, { ...matching, files: { 'uws.js': 'aaa', 'extra.node': 'ddd' } });
		expect(problems.some((p) => p.includes('missing from the installed tree: uws_linux_x64_137.node'))).toBe(true);
		expect(problems.some((p) => p.includes('never accepted: extra.node'))).toBe(true);
	});

	it('catches a pin bumped without re-accepting the tree it resolves to', () => {
		const problems = compare(base, {
			...matching,
			spec: base.package + 'v20.70.0.tar.gz'
		});
		expect(problems[0]).toContain('A pin bump is a re-acceptance');
	});

	it('catches archive integrity nobody accepted', () => {
		const problems = compare(base, { ...matching, integrity: 'sha512-changed' });
		expect(problems[0]).toContain('archive bytes');
	});

	it('still reports the pin and integrity when nothing is installed', () => {
		expect(compare(base, { spec: matching.spec, integrity: base.integrity, files: null })).toEqual([]);
		expect(compare(base, { spec: 'other#v1', integrity: base.integrity, files: null })).toHaveLength(1);
	});
});

describe('the accepted record in this repository', () => {
	it('locks the HTTPS archive by npm integrity', () => {
		const spec = pkg.optionalDependencies['uWebSockets.js'];
		const locked = lock.packages['node_modules/uWebSockets.js'];
		expect(spec).toMatch(/^https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz$/);
		expect(locked.resolved).toBe(spec);
		expect(locked.integrity).toMatch(/^sha512-/);
		expect(accepted.integrity).toBe(locked.integrity);
	});

	it('accepts the pin the manifest actually declares', () => {
		expect(acceptedSpec(accepted)).toBe(pkg.optionalDependencies['uWebSockets.js']);
	});

	// The record is not itself an install spec, on purpose: the pin guard scans
	// tracked files for one and would report a stale record with advice to edit
	// it by hand, which is the one repair that must never be made here.
	it('is not a copy-pasteable install spec', () => {
		expect(read('scripts/uws-accepted.json')).not.toMatch(/uWebSockets\.js#/);
	});

	it('accepts the integrity the lockfile actually records', () => {
		expect(accepted.integrity).toBe(lock.packages['node_modules/uWebSockets.js'].integrity);
	});

	it('records a digest for every prebuilt binary, not just the loader', () => {
		const binaries = Object.keys(accepted.files).filter((f) => f.endsWith('.node'));
		expect(binaries.length).toBeGreaterThan(1);
		for (const digest of Object.values(accepted.files)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	// End to end against the real installed tree. Without the addon the script
	// reports a visible SKIP and exits 0, which is the local case; the hosted
	// gate runs it with CI set, where the same absence is a failure.
	it('agrees with the installed tree', () => {
		const script = fileURLToPath(new URL('../scripts/check-uws-binaries.js', import.meta.url));
		const run = spawnSync(process.execPath, [script], {
			encoding: 'utf8', env: { ...process.env, CI: '', REQUIRE_UWS: '' }
		});
		expect(run.stdout + run.stderr).toMatch(/byte for byte|SKIPPED/);
		expect(run.status).toBe(0);
	});
});

describe('hashing an installed package directory', () => {
	it('digests every file by name', () => {
		const dir = fileURLToPath(new URL('../scripts', import.meta.url));
		const tree = hashTree(dir);
		expect(tree['check-uws-binaries.js']).toMatch(/^[0-9a-f]{64}$/);
		// Sorted, so a regenerated record diffs as content rather than as order.
		expect(Object.keys(tree)).toEqual([...Object.keys(tree)].sort());
	});
});
