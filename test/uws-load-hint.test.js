import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uwsLoadErrorMessage, readAdapterPackageJson } from '../src/uws-load-hint.js';

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
			optionalDependencies: { 'uWebSockets.js': 'github:uNetworking/uWebSockets.js#v99.99.99' }
		});
		expect(msg).toContain('npm install uNetworking/uWebSockets.js#v99.99.99');
		expect(msg).not.toContain('github:');
	});
});
