import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	loadSvelte4Profile,
	renderSvelte4Support,
	validateSvelte4Profile
} from '../scripts/check-svelte-support.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');

describe('locked Svelte 4 support profile', () => {
	it('keeps exact fixture metadata, lock, public row, and CI execution together', () => {
		const profile = loadSvelte4Profile();
		expect(validateSvelte4Profile(
			profile,
			read('README.md'),
			read('.github/workflows/test.yml')
		)).toEqual([]);
	});

	it('renders the setup commands and rejects a floating claimed corner', () => {
		const profile = loadSvelte4Profile();
		const rendered = renderSvelte4Support(profile);
		expect(rendered).toContain('| Locked Svelte 4 | `4.2.20` | `2.70.2` |');
		expect(rendered).toContain('npm ci --install-links');
		const floating = {
			...profile,
			pkg: {
				...profile.pkg,
				dependencies: { ...profile.pkg.dependencies, svelte: '^4.0.0' }
			}
		};
		expect(validateSvelte4Profile(
			floating,
			read('README.md'),
			read('.github/workflows/test.yml')
		)).toContain('svelte must be an exact x.y.z version');
	});
});
