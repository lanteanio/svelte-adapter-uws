import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CATALOG_START,
	CATALOG_END,
	ENTRY_POINTS,
	STABILITY_LEVELS,
	catalogErrors,
	guideAnchorErrors,
	renderCatalog,
	replaceCatalog,
	simDocErrors,
	simExportNames
} from '../scripts/check-entry-points.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const simDts = readFileSync(new URL('../src/sim.d.ts', import.meta.url), 'utf8');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('public entry-point catalog', () => {
	it('owns every exact export-map key and renders the checked-in README block', () => {
		expect(catalogErrors(pkg.exports)).toEqual([]);
		expect(replaceCatalog(readme, renderCatalog(pkg))).toBe(readme);
		expect((readme.match(new RegExp(CATALOG_START, 'g')) ?? [])).toHaveLength(1);
		expect((readme.match(new RegExp(CATALOG_END, 'g')) ?? [])).toHaveLength(1);
	});

	it('rejects both a new unowned export and stale catalog metadata', () => {
		expect(catalogErrors({ ...pkg.exports, './new-surface': './src/new.js' }))
			.toContain('public export ./new-surface has no catalog owner');
		const withoutSafeUrl = { ...ENTRY_POINTS };
		delete withoutSafeUrl['./safe-url'];
		expect(catalogErrors(pkg.exports, withoutSafeUrl))
			.toContain('public export ./safe-url has no catalog owner');
	});

	it('constrains stability to the declared vocabulary and deprecation to real text', () => {
		expect(STABILITY_LEVELS).toEqual(['supported', 'experimental', 'deprecated']);
		const typo = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], stability: 'suported' } };
		expect(catalogErrors(pkg.exports, typo))
			.toContain("./safe-url: stability 'suported' is not one of supported | experimental | deprecated");
		const omitted = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], stability: undefined } };
		expect(catalogErrors(pkg.exports, omitted)).toContain('./safe-url: missing stability');
		const blankNote = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], deprecation: '   ' } };
		expect(catalogErrors(pkg.exports, blankNote)).toContain('./safe-url: missing deprecation');
		const freeText = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], stability: 'deprecated', deprecation: 'moved to ./safer-url in 0.7' } };
		expect(catalogErrors(pkg.exports, freeText)).toEqual([]);
	});

	it('requires every #anchor guide to resolve to a section that documents its own specifier', () => {
		expect(guideAnchorErrors(readme, pkg.name)).toEqual([]);
		// Retargeting a row at an unrelated (but existing) heading must fail:
		// check-links alone would still pass, because the anchor exists.
		const retargeted = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], guide: '[License](#license)' } };
		const errors = guideAnchorErrors(readme, pkg.name, retargeted);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('./safe-url: guide anchor #license');
		expect(errors[0]).toContain('never mentions svelte-adapter-uws/safe-url');
		// A dead anchor is named too, not silently skipped.
		const dead = { ...ENTRY_POINTS, './safe-url': { ...ENTRY_POINTS['./safe-url'], guide: '[Nowhere](#no-such-heading)' } };
		expect(guideAnchorErrors(readme, pkg.name, dead))
			.toContain('./safe-url: guide anchor #no-such-heading matches no README heading');
	});

	it('gives the formerly orphaned adapter entries direct runnable homes', () => {
		for (const specifier of [
			'svelte-adapter-uws/upgrade-response',
			'svelte-adapter-uws/safe-url',
			'svelte-adapter-uws/plugins/crdt/client',
			'svelte-adapter-uws/plugins/smooth/random',
			'svelte-adapter-uws/plugins/webhooks'
		]) {
			expect(readme).toContain('`' + specifier + '`');
			// The README's prettier-normalized fences use double quotes; hand-written
			// snippets may use single quotes. Accept either, require the import.
			const runnableImport = new RegExp(`from\\s+["']${escapeRegExp(specifier)}["']`);
			expect(readme).toMatch(runnableImport);
			// Non-vacuous: with every import of this specifier stripped, the same
			// assertion fails even though inline-code mentions survive.
			const stripped = readme.replace(new RegExp(`from\\s+["']${escapeRegExp(specifier)}["']`, 'g'), 'from "elsewhere"');
			expect(stripped).not.toMatch(runnableImport);
		}
	});

	it('requires a README home for every public sim export', () => {
		expect(simDocErrors(readme, simDts)).toEqual([]);
		expect(simExportNames(simDts)).toEqual(expect.arrayContaining([
			'runSim', 'createSeededRng', 'createScheduler', 'createFaultEngine',
			'createInMemoryApp', 'setRuntimeEnv', 'resetRuntimeEnv', 'resetProcessEpoch',
			'createInMemoryUwsHelpers', 'DEFAULT_SEED', 'FIXED_EPOCH'
		]));
		// A new export without a documented home must fail.
		const withPhantom = simDts + '\nexport function createPhantomHelper(): void;\n';
		expect(simDocErrors(readme, withPhantom).join('\n')).toContain('createPhantomHelper');
		// An @internal export is exempt.
		const withInternal = simDts + '\n/** @internal */\nexport function internalOnlyHook(): void;\n';
		expect(simDocErrors(readme, withInternal)).toEqual([]);
		// Deleting the README mention of a documented export must fail, even when
		// a longer name that contains it survives (word-bounded match).
		const withoutRng = readme.split('createSeededRng').join('createSeededRngRenamed');
		expect(simDocErrors(withoutRng, simDts).join('\n')).toContain('createSeededRng');
	});
});
