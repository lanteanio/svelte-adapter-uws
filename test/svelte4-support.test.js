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

	// The fixture installs this checkout as a packed dependency, so its lock
	// carries a second copy of the adapter's own manifest. Nothing compared them,
	// and the lock had drifted: it required markdown-it and semver, which moved to
	// devDependencies, so the published Svelte 4 corner installed two packages no
	// consumer receives.
	const packedKey = 'node_modules/svelte-adapter-uws';
	const withPacked = (profile, patch) => ({
		...profile,
		lock: {
			...profile.lock,
			packages: {
				...profile.lock.packages,
				[packedKey]: { ...profile.lock.packages[packedKey], ...patch }
			}
		}
	});

	it('rejects a packed lock entry requiring a dependency the adapter does not declare', () => {
		const profile = loadSvelte4Profile();
		const drifted = withPacked(profile, {
			dependencies: {
				...profile.lock.packages[packedKey].dependencies,
				'markdown-it': '^15.0.0'
			}
		});
		const errors = validateSvelte4Profile(
			drifted, read('README.md'), read('.github/workflows/test.yml')
		);
		expect(errors.some((error) =>
			error.startsWith('packed adapter lock dependencies disagrees with the root manifest')
		)).toBe(true);
	});

	it('rejects a packed lock entry left behind at a previous adapter version', () => {
		const profile = loadSvelte4Profile();
		const stale = withPacked(profile, { version: '0.0.0-stale' });
		const errors = validateSvelte4Profile(
			stale, read('README.md'), read('.github/workflows/test.yml')
		);
		expect(errors.some((error) =>
			error.startsWith('packed adapter lock version 0.0.0-stale disagrees with the root manifest')
		)).toBe(true);
	});

	// CI and the published reproduce sequence are two spellings of first success.
	// The preflight is what stops an unmet native prerequisite at the boundary, so
	// presence is not enough - a preflight after the build has already missed it.
	it('publishes the preflight between install and the first check', () => {
		const rendered = renderSvelte4Support(loadSvelte4Profile());
		const install = rendered.indexOf('npm ci --install-links');
		const preflight = rendered.indexOf('npm exec -- svelte-adapter-uws-preflight');
		const check = rendered.indexOf('npm run check');
		expect(preflight).toBeGreaterThan(install);
		expect(check).toBeGreaterThan(preflight);
	});

	it('rejects a CI job that drops the newcomer preflight', () => {
		const workflow = read('.github/workflows/test.yml')
			.replace('run: npm exec -- svelte-adapter-uws-preflight', 'run: echo nothing');
		expect(validateSvelte4Profile(loadSvelte4Profile(), read('README.md'), workflow))
			.toContain('the Svelte 4 CI job is missing the step: npm exec -- svelte-adapter-uws-preflight');
	});

	it('rejects a CI job that runs the preflight after the checks it guards', () => {
		const original = read('.github/workflows/test.yml');
		const step = '        run: npm exec -- svelte-adapter-uws-preflight\n';
		const moved = original.replace(step, '') + step;
		expect(validateSvelte4Profile(loadSvelte4Profile(), read('README.md'), moved))
			.toContain('the Svelte 4 CI job runs npm run check before npm exec -- svelte-adapter-uws-preflight');
	});

	it('refuses to measure the position of a step that appears twice', () => {
		const original = read('.github/workflows/test.yml');
		const duplicated = original + '\n        run: npm run smoke\n';
		expect(validateSvelte4Profile(loadSvelte4Profile(), read('README.md'), duplicated))
			.toContain('the Svelte 4 CI job repeats the step npm run smoke, so its position cannot be checked');
	});
});
