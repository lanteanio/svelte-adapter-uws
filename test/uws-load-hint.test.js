import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uwsLoadErrorMessage, readAdapterPackageJson } from '../src/uws-load-hint.js';
import { scanText, pinnedRef } from '../scripts/check-uws-pin.js';

describe('uwsLoadErrorMessage', () => {
	it('derives the install hint from the package.json optionalDependencies pin', () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
		);
		const spec = pkg.optionalDependencies['uWebSockets.js'];
		expect(spec).toBeTruthy();
		const version = spec.split('#')[1];
		expect(version).toBeTruthy();

		const msg = uwsLoadErrorMessage(pkg);
		// The hint must carry the CURRENT pinned version + spec, so a pin bump
		// can never leave this message pointing at a stale tag (the fixed bug).
		expect(msg).toContain(version);
		expect(msg).toContain(spec.replace(/^github:/, ''));
		// And it names the real-world causes.
		expect(msg).toMatch(/\bgit\b/);
		expect(msg).toContain('npm ls uWebSockets.js');
	});

	it('reads the real optionalDependencies pin from the adapter package.json', () => {
		const pkg = readAdapterPackageJson();
		expect(pkg?.optionalDependencies?.['uWebSockets.js']).toContain('uWebSockets.js');
	});

	it('falls back to an unpinned hint when the spec is absent', () => {
		expect(uwsLoadErrorMessage(undefined)).toContain('npm install uNetworking/uWebSockets.js');
		expect(uwsLoadErrorMessage({ optionalDependencies: {} })).toContain(
			'npm install uNetworking/uWebSockets.js'
		);
	});

	it('strips the github: scheme so the hint is a valid npm install target', () => {
		const msg = uwsLoadErrorMessage({
			optionalDependencies: { 'uWebSockets.js': 'github:uNetworking/uWebSockets.js#v99.99.99' } // uws-pin-allow: synthetic spec, not an install instruction
		});
		expect(msg).toContain('npm install uNetworking/uWebSockets.js#v99.99.99'); // uws-pin-allow: synthetic spec, not an install instruction
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
		expect(found).toEqual([{ line: 3, ref: 'v20.60.0', stale: true, allowed: false }]);
	});

	it('accepts a reference that names the pin', () => {
		const text = `npm install ${spec('v20.69.0')}\n`;
		expect(scanText(text, 'v20.69.0').every((r) => r.stale)).toBe(false);
	});

	it('leaves a bare version in prose alone', () => {
		// The line CHANGELOG.md and MIGRATION.md legitimately carry about the
		// past. Matching it would force history to be rewritten on every bump.
		const text = 'pinned `uWebSockets.js` to v20.67.0 (was v20.60.0); wins from v20.60 to v20.67\n';
		expect(scanText(text, 'v20.69.0')).toEqual([]);
	});

	it('reports a line marked with the opt-out as exempt, not as clean', () => {
		// The marker must not make the reference vanish: the count still sees it,
		// so a marker sprayed over real drift is visible in the summary.
		const text = `const stale = '${spec('v20.60.0')}'; // uws-pin-allow: fixture\n`;
		expect(scanText(text, 'v20.69.0')).toEqual([
			{ line: 1, ref: 'v20.60.0', stale: true, allowed: true }
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
		expect(pinnedRef(pkg)).toBe(pkg.optionalDependencies['uWebSockets.js'].split('#')[1]);
		expect(uwsLoadErrorMessage(pkg)).toContain(pinnedRef(pkg));
	});

	it('reports no pin when the spec carries no ref', () => {
		expect(pinnedRef(undefined)).toBe(null);
		expect(pinnedRef({ optionalDependencies: { 'uWebSockets.js': 'uNetworking/uWebSockets.js' } })).toBe(null);
	});
});
