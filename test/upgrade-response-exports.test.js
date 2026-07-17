// Runtime-vs-declaration export gate for the upgradeResponse helper.
//
// The bug this guards: the ./upgrade-response subpath pointed its types at
// index.d.ts (which declares a default adapter), and the package root declared
// a named upgradeResponse the runtime never exported - so both `import adapter
// from '.../upgrade-response'` and `import { upgradeResponse } from
// 'svelte-adapter-uws'` typechecked but were undefined at runtime. The helper
// now lives solely on the subpath, whose types match its runtime exactly, and
// the phantom root declaration is gone.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const pkg = JSON.parse(read('../package.json'));

describe('upgradeResponse export surface (runtime vs declaration)', () => {
	it('the ./upgrade-response subpath runtime exports only the named helper (no default)', async () => {
		const mod = await import('../src/upgrade-response.js');
		expect(typeof mod.upgradeResponse).toBe('function');
		expect(mod.default).toBeUndefined();
	});

	it('the package root runtime exports the adapter as default and does not export upgradeResponse', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.default).toBe('function');
		expect(mod.upgradeResponse).toBeUndefined();
	});

	it('the ./upgrade-response export maps its types to a dedicated declaration, not index.d.ts', () => {
		const sub = pkg.exports['./upgrade-response'];
		expect(sub.types).toBe('./src/upgrade-response.d.ts');
		expect(sub.default).toBe('./src/upgrade-response.js');
	});

	it('the dedicated declaration declares the named helper and no default export', () => {
		const dts = read('../src/upgrade-response.d.ts');
		expect(dts).toMatch(/export function upgradeResponse</);
		expect(dts).not.toMatch(/export default/);
	});

	it('the root declaration no longer re-exports upgradeResponse (only the subpath owns it)', () => {
		const dts = read('../src/index.d.ts');
		// index.d.ts may import the TYPE for its internal ReturnType<> reference, but
		// must not declare or re-export upgradeResponse as a root API surface.
		expect(dts).not.toMatch(/^export function upgradeResponse</m);
		expect(dts).not.toMatch(/export \{[^}]*\bupgradeResponse\b[^}]*\}/);
	});

	it('the helper wraps userData and headers with the __upgradeResponse marker', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		expect(upgradeResponse({ userId: 7 }, { 'x-session-version': '2' })).toEqual({
			__upgradeResponse: true,
			userData: { userId: 7 },
			headers: { 'x-session-version': '2' }
		});
	});
});
