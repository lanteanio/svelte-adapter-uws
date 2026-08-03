import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uwsInstallSpec, uwsLoadErrorMessage, readAdapterPackageJson } from '../src/uws-load-hint.js';
import { pinnedRef, scanText } from '../scripts/check-uws-pin.js';

const githubSpec = (ref) => 'github:uNetworking/' + 'uWebSockets.js#' + ref;
const archiveSpec = (ref) => 'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/' + ref + '.tar.gz';

describe('uwsLoadErrorMessage', () => {
	it('derives the install hint from the package.json optionalDependencies pin', () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
		);
		const spec = pkg.optionalDependencies['uWebSockets.js'];
		expect(spec).toBeTruthy();
		const version = pinnedRef(pkg);
		expect(version).toBeTruthy();

		const msg = uwsLoadErrorMessage(pkg);
		// The hint must carry the CURRENT pinned version + spec, so a pin bump
		// can never leave this message pointing at a stale tag (the fixed bug).
		expect(msg).toContain(version);
		expect(msg).toContain(spec);
		// The HTTPS archive path does not require a Git client.
		expect(msg).not.toMatch(/\bgit\b/i);
		expect(msg).toContain('npm ls uWebSockets.js');
	});

	it('pins one HTTPS archive in the manifest and lockfile', () => {
		const pkg = readAdapterPackageJson();
		const lock = JSON.parse(
			readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8')
		);
		const pinned = archiveSpec('v20.69.0');
		expect(uwsInstallSpec(pkg)).toBe(pinned);
		expect(pkg.optionalDependencies['uWebSockets.js']).toBe(pinned);
		expect(lock.packages['node_modules/uWebSockets.js'].resolved).toBe(pinned);
		expect(lock.packages['node_modules/uWebSockets.js'].integrity).toMatch(/^sha512-/);
		expect(pkg.scripts.postinstall).toBe('node scripts/check-native-install.js');
		expect(pkg.files).toContain('scripts/check-native-install.js');
	});

	it('retains the native loader cause and the Linux libc floor', () => {
		const cause = new Error('/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38` not found');
		const message = uwsLoadErrorMessage(readAdapterPackageJson(), cause);
		expect(message).toContain(cause.message);
		expect(message).toContain('glibc >= 2.38');
	});

	it('reads the real optionalDependencies pin from the adapter package.json', () => {
		const pkg = readAdapterPackageJson();
		expect(pkg?.optionalDependencies?.['uWebSockets.js']).toContain('uWebSockets.js');
	});

	it('fails closed instead of recommending moving HEAD when the spec is absent', () => {
		for (const missing of [
			undefined,
			{ optionalDependencies: {} },
			{ optionalDependencies: { 'uWebSockets.js': 'uNetworking/uWebSockets.' + 'js' } },
			{ optionalDependencies: { 'uWebSockets.js': 'github:uNetworking/uWebSockets.' + 'js#' } }
		]) {
			const message = uwsLoadErrorMessage(missing);
			expect(message).not.toContain('npm install uNetworking/' + 'uWebSockets.js');
			expect(message).toContain('package metadata is available');
			expect(message).toContain('exact native-addon command from Version compatibility');
		}
	});

	it('strips the github: scheme so the hint is a valid npm install target', () => {
		const msg = uwsLoadErrorMessage({
			optionalDependencies: { 'uWebSockets.js': githubSpec('v99.99.99') }
		});
		expect(msg).toContain('npm install ' + githubSpec('v99.99.99').replace(/^github:/, ''));
		expect(msg).not.toContain('github:');
	});
});

// The pin guard's own tests. The single source of truth only helps where it is
// actually called; the drift that shipped twice was in text nobody re-derives -
// install blocks, a JSDoc example, a harness constant. A guard that reports the
// tree clean while being unable to see the reference it was written for is
// worse than no guard, so each rule it draws is pinned here.
//
// `spec()` builds the synthetic specs below so the assertions themselves do not
// read as stale install lines to the guard when it scans this file.
const spec = (ref) => `uNetworking/uWebSockets.js#${ref}`;

describe('check-uws-pin', () => {
	it('flags an install line naming a tag other than the pin', () => {
		const text = `Install the addon:\n\nnpm install ${spec('v20.60.0')}\n`;
		const found = scanText(text, 'v20.69.0');
		expect(found).toEqual([{ line: 3, ref: 'v20.60.0', stale: true }]);
	});

	it('canonicalizes the GitHub repository identity case-insensitively', () => {
		const lowercase = `npm install uNetworking/uwebsockets.js#${'v20.60.0'}\n`;
		expect(scanText(lowercase, 'v20.69.0')).toEqual([
			{ line: 1, ref: 'v20.60.0', stale: true }
		]);
	});

	it('canonicalizes npm-valid GitHub URL specs with an optional .git suffix', () => {
		for (const prefix of ['https://github.com/', 'git+https://github.com/']) {
			const text = `npm install ${prefix}uNetworking/uWebSockets.js.git#${'v20.60.0'}\n`;
			expect(scanText(text, 'v20.69.0')).toEqual([
				{ line: 1, ref: 'v20.60.0', stale: true }
			]);
		}
	});

	it('canonicalizes npm-valid GitHub SSH and scp specs with an optional .git suffix', () => {
		for (const nativeUrl of [
			'git+ssh://git@github.com/uNetworking/uWebSockets.' + 'js.git' + '#',
			'ssh://git@github.com/uNetworking/uWebSockets.' + 'js.git' + '#',
			'git@github.com:uNetworking/uWebSockets.' + 'js.git' + '#'
		]) {
			expect(scanText('npm install ' + nativeUrl + 'v20.60.0\n', 'v20.69.0')).toEqual([
				{ line: 1, ref: 'v20.60.0', stale: true }
			]);
		}
	});

	it('canonicalizes npm-normalized owners, queries, and semver selectors', () => {
		for (const nativeUrl of [
			'git+https://github.com/%75Networking/uWebSockets.' + 'js.git' + '#' + 'v20.60.0',
			'git+ssh://git@github.com/%75Networking/uWebSockets.' + 'js.git' + '#' + 'v20.60.0',
			'git+https://github.com/uNetworking/uWebSockets.' + 'js.git?x=1' + '#' + 'v20.60.0',
			'github:uNetworking/uWebSockets.' + 'js#semver:' + 'v20.60.0',
			'git+https://github.com/uNetworking/uWebSockets.' + 'js.git#semver:' + 'v20.60.0'
		]) {
			expect(scanText('npm install ' + nativeUrl + '\n', 'v20.69.0')).toEqual([
				{ line: 1, ref: 'v20.60.0', stale: true }
			]);
		}
	});

	it('accepts a reference that names the pin', () => {
		const text = `npm install ${spec('v20.69.0')}\n`;
		expect(scanText(text, 'v20.69.0').every((r) => r.stale)).toBe(false);
	});

	it('finds stale HTTPS archive install targets', () => {
		const text = 'npm install ' + archiveSpec('v20.60.0') + '\n';
		expect(scanText(text, 'v20.69.0')).toEqual([
			{ line: 1, ref: 'v20.60.0', stale: true }
		]);
	});

	it('leaves a bare version in prose alone', () => {
		// The line CHANGELOG.md and MIGRATION.md legitimately carry about the
		// past. Matching it would force history to be rewritten on every bump.
		const text = 'pinned `uWebSockets.js` to v20.67.0 (was v20.60.0); wins from v20.60 to v20.67\n';
		expect(scanText(text, 'v20.69.0')).toEqual([]);
	});

	it('does not honor a synthetic marker in any path', () => {
		const text = `const stale = '${spec('v20.60.0')}'; // uws-pin-allow: fixture\n`;
		expect(scanText(text, 'v20.69.0')).toEqual([
			{ line: 1, ref: 'v20.60.0', stale: true }
		]);
	});

	it('sees a dependency value and a branch ref, not only tags', () => {
		const text = `"uWebSockets.js": "github:${spec('v20.60.0')}"\n` + `"other": "${spec('master')}"\n`;
		expect(scanText(text, 'v20.69.0').map((r) => r.ref)).toEqual(['v20.60.0', 'master']);
	});

	it('does not read a template hole as a ref', () => {
		// Derived specs are the fix, not the defect: they can never be stale.
		expect(scanText('`uNetworking/uWebSockets.js#${tag}`\n', 'v20.69.0')).toEqual([]);
	});

	it('takes the expected ref from the same derivation the install hints use', () => {
		const pkg = readAdapterPackageJson();
		expect(pinnedRef(pkg)).toBe('v20.69.0');
		expect(uwsLoadErrorMessage(pkg)).toContain(pinnedRef(pkg));
	});

	it('reports no pin when the spec carries no ref', () => {
		expect(pinnedRef(undefined)).toBe(null);
		expect(pinnedRef({ optionalDependencies: { 'uWebSockets.js': 'uNetworking/uWebSockets.' + 'js' } })).toBe(null);
	});
});
