import { readFileSync } from 'node:fs';
import { inc } from 'semver';
import { describe, expect, it } from 'vitest';
import { anchorsOf, packageFiles, slugify } from '../scripts/check-links.js';
import {
	newestReleaseVersion,
	releasePagePath,
	releasePageTarget,
	renderReleasePage,
	validateReleasePages,
	validateReleaseRouteLinks,
	validateReleaseSummary
} from '../scripts/check-release-notes.js';

const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const NEWEST_VERSION = newestReleaseVersion(CHANGELOG);
const RELEASE_PAGE = readFileSync(new URL('../' + releasePagePath(CHANGELOG), import.meta.url), 'utf8');

function summaryEntry(kind) {
	return [
		`- **${kind}: the mutation fixture.** The synthetic release fixture keeps one bounded consumer outcome in front of its engineering detail so the mutation suite can prove that coverage is required per existing section and never demanded for a section the release does not contain.`,
		'  - **Affects:** Nobody; this entry exists only inside the mutation suite.',
		'  - **Action:** None.',
		'  - **Requires:** Nothing.',
		'  - **Compatibility:** Unchanged.',
		`  - **Detail:** [${kind} engineering detail](#${kind.toLowerCase()}).`
	].join('\n');
}

function syntheticChangelog(version, entryKinds, sections) {
	const parts = [
		'# Changelog',
		'',
		`## [${version}] - 2026-08-02`,
		'',
		'<!-- consumer-release-summary:start -->',
		'### Consumer summary',
		'',
		entryKinds.map(summaryEntry).join('\n\n'),
		'',
		'<!-- consumer-release-summary:end -->',
		''
	];
	for (const [kind, bullets] of Object.entries(sections)) {
		parts.push(`### ${kind}`, '', ...bullets, '');
	}
	return parts.join('\n');
}

describe('consumer release summary', () => {
	it('keeps the newest release action-first, grouped, and completely enumerated', () => {
		const entries = validateReleaseSummary(CHANGELOG);
		const newest = CHANGELOG.slice(CHANGELOG.indexOf('## [' + NEWEST_VERSION + ']'));
		const nextRelease = newest.indexOf('\n## [', 1);
		const body = nextRelease === -1 ? newest : newest.slice(0, nextRelease);

		// Derived, not frozen: a hardcoded kind list only records what was
		// written the day it was pinned and turns every legitimate new entry
		// into a false failure. These three properties are what the frozen
		// list was actually protecting.
		//
		// 1. Every entry is enumerated - the validator cannot silently skip a
		//    lead it failed to parse.
		const summary = body.slice(
			body.indexOf('<!-- consumer-release-summary:start -->'),
			body.indexOf('<!-- consumer-release-summary:end -->')
		);
		const leads = [...summary.matchAll(/^- \*\*(Added|Changed|Fixed|Removed|Deprecated|Security):/gm)]
			.map((match) => match[1]);
		expect(entries.map(({ kind }) => kind)).toEqual(leads);

		// 2. Kinds are CONTIGUOUS in Keep-a-Changelog order. A consumer must
		//    not read Changed, then Fixed, then Changed again - which is
		//    exactly what happens when a new entry is appended to the end
		//    instead of joining its group, and nothing else catches it.
		const ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
		const ranks = leads.map((kind) => ORDER.indexOf(kind));
		expect(ranks, 'summary entries must be grouped in Keep-a-Changelog order')
			.toEqual([...ranks].sort((a, b) => a - b));

		// 3. Coverage matches the engineering sections that exist.
		const sections = [...body.matchAll(/^### (Added|Changed|Fixed|Removed|Deprecated|Security)$/gm)]
			.map((match) => match[1]);
		expect(new Set(leads)).toEqual(new Set(sections));
	});

	it('rejects short or multi-sentence outcome blocks', () => {
		const short = CHANGELOG.replace(
			'Structured compatibility, migration, protocol, observability, contribution, security, and release surfaces now ship with executable drift checks, giving consumers one route to supported version tuples, production signals, incident guidance, and upgrade evidence instead of requiring source-code or CI archaeology.',
			'The contracts are easier to find.'
		);
		const twoSentences = CHANGELOG.replace('CI archaeology.', 'CI archaeology. Consumers benefit.');
		expect(() => validateReleaseSummary(short)).toThrow(/expected 40-60/);
		expect(() => validateReleaseSummary(twoSentences)).toThrow(/one outcome sentence/);
	});

	it('rejects missing, reordered, or misrouted decision fields', () => {
		const reordered = CHANGELOG.replace(
			'  - **Affects:** Package consumers, operators, contributors, and release maintainers.\n  - **Action:**',
			'  - **Action:** Package consumers, operators, contributors, and release maintainers.\n  - **Affects:**'
		);
		const missing = CHANGELOG.replace('  - **Requires:** No runtime option;', '  - **Prerequisite:** No runtime option;');
		const misrouted = CHANGELOG.replace('[Changed engineering detail](#changed)', '[Changed engineering detail](#fixed)');
		expect(() => validateReleaseSummary(reordered)).toThrow(/in order/);
		expect(() => validateReleaseSummary(missing)).toThrow(/in order/);
		expect(() => validateReleaseSummary(misrouted)).toThrow(/link to #changed/);
	});

	it('rejects bypass prose, duplicate markers, and missing category coverage', () => {
		const prose = CHANGELOG.replace('### Consumer summary\n', '### Consumer summary\n\nRead the engineering story first.\n');
		const duplicate = CHANGELOG.replace(
			'<!-- consumer-release-summary:start -->',
			'<!-- consumer-release-summary:start -->\n<!-- consumer-release-summary:start -->'
		);
		// The real newest release HAS a `### Changed` engineering section, so
		// removing its Changed coverage must fail; a release without that
		// section is exercised by the section-coverage test below.
		// EVERY Changed entry must be relabeled, or a surviving one still
		// supplies the coverage and the mutant silently stops mutating.
		const noChanged = CHANGELOG
			.replaceAll('- **Changed: ', '- **Added: ')
			.replaceAll('[Changed engineering detail](#changed).', '[Added engineering detail](#added).');
		const hidden = CHANGELOG.replace('### Consumer summary', '### Consumer summary\n\n<div hidden>');
		expect(() => validateReleaseSummary(prose)).toThrow(/prose outside an entry/);
		expect(() => validateReleaseSummary(duplicate)).toThrow(/one consumer summary marker pair/);
		expect(() => validateReleaseSummary(noChanged)).toThrow(/missing Changed coverage/);
		expect(() => validateReleaseSummary(hidden)).toThrow(/cannot hide content in raw HTML/);
	});

	it('requires coverage only for the engineering sections that exist', () => {
		const fixedOnly = syntheticChangelog(NEWEST_VERSION, ['Fixed'], {
			Fixed: ['- One fixed engineering bullet.']
		});
		expect(validateReleaseSummary(fixedOnly)).toHaveLength(1);
		const uncoveredChanged = syntheticChangelog(NEWEST_VERSION, ['Fixed'], {
			Fixed: ['- One fixed engineering bullet.'],
			Changed: ['- One changed engineering bullet.']
		});
		expect(() => validateReleaseSummary(uncoveredChanged)).toThrow(/missing Changed coverage/);
		const sectionless = syntheticChangelog(NEWEST_VERSION, ['Changed', 'Fixed'], {
			Changed: ['- One changed engineering bullet.']
		});
		expect(() => validateReleaseSummary(sectionless)).toThrow(/links to missing Fixed detail/);
	});

	it('bounds engineering bullet length for releases after the frozen baseline', () => {
		const oversized = '- ' + 'x'.repeat(2100);
		// 0.6.0-next.91 is the pinned grandfather baseline inside the checker:
		// history up to it stays unbounded, everything after it is bound.
		const grandfathered = syntheticChangelog('0.6.0-next.91', ['Fixed'], { Fixed: [oversized] });
		expect(validateReleaseSummary(grandfathered, '0.6.0-next.91')).toHaveLength(1);
		const next = inc(NEWEST_VERSION, 'prerelease');
		const bounded = syntheticChangelog(next, ['Fixed'], { Fixed: ['- ' + 'x'.repeat(1998)] });
		expect(validateReleaseSummary(bounded, next)).toHaveLength(1);
		const oversizedNext = syntheticChangelog(next, ['Fixed'], { Fixed: [oversized] });
		expect(() => validateReleaseSummary(oversizedNext, next)).toThrow(/bound each bullet to 2000/);
		const continuation = ['- ' + 'y'.repeat(900), '  ' + 'y'.repeat(900), '  ' + 'y'.repeat(900)].join('\n');
		const oversizedContinuation = syntheticChangelog(next, ['Fixed'], { Fixed: [continuation] });
		expect(() => validateReleaseSummary(oversizedContinuation, next)).toThrow(/bound each bullet to 2000/);
	});

	it('pins generated detail links to the version-heading anchor', () => {
		const heading = CHANGELOG.replace(/\r\n/g, '\n').match(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/m)[0];
		const anchor = slugify(heading.slice(3));
		expect(anchorsOf(CHANGELOG).has(anchor)).toBe(true);
		const page = renderReleasePage(CHANGELOG);
		expect(page).toContain(`](../../CHANGELOG.md#${anchor})`);
		expect(page).not.toContain('](../../CHANGELOG.md#added)');
		expect(RELEASE_PAGE.replace(/\r\n/g, '\n')).toContain(`](../../CHANGELOG.md#${anchor})`);
	});

	it('validates every archived release page against its own version anchor', () => {
		const archive = validateReleasePages(CHANGELOG);
		expect(archive.pages).toBeGreaterThanOrEqual(1);
		expect(archive.links).toBeGreaterThanOrEqual(1);
		const fileFirst = new Map([[NEWEST_VERSION + '.md', 'See [detail](../../CHANGELOG.md#added).']]);
		expect(() => validateReleasePages(CHANGELOG, fileFirst)).toThrow(/must pin the release's own anchor/);
		const orphan = new Map([['9.9.9.md', 'orphan page']]);
		expect(() => validateReleasePages(CHANGELOG, orphan)).toThrow(/does not match any dated CHANGELOG release/);
	});

	it('requires README.md and MIGRATION.md to carry the current-release link', () => {
		const link = './' + releasePagePath(NEWEST_VERSION);
		expect(validateReleaseRouteLinks(CHANGELOG)).toBe(link);
		const stale = { 'README.md': 'stale map', 'MIGRATION.md': 'stale map' };
		expect(() => validateReleaseRouteLinks(CHANGELOG, stale))
			.toThrow(/README\.md and MIGRATION\.md must contain the current-release link/);
	});

	it('does not rewrite or govern immutable historical narrative', () => {
		const historical = CHANGELOG.replace(
			'## [0.6.0-next.90] - 2026-08-01',
			'## [0.6.0-next.90] - 2026-08-01\n\nA historical paragraph can retain its original narrative shape.'
		);
		// The count is whatever the newest release legitimately carries; what
		// this pins is that editing HISTORY does not change it.
		const governed = validateReleaseSummary(CHANGELOG).length;
		expect(validateReleaseSummary(historical)).toHaveLength(governed);
		const grouped = CHANGELOG.replace('## [0.3.9] and earlier', '## [0.3.9-archive.1] and earlier');
		expect(validateReleaseSummary(grouped)).toHaveLength(governed);
	});

	it('binds the newest release to a safe exact package SemVer and real date', () => {
		const heading = '## [0.6.0-next.91] - 2026-08-01';
		const mismatch = CHANGELOG.replace(heading, '## [9.9.9] - 2026-08-01');
		expect(() => validateReleaseSummary(mismatch)).toThrow(/does not match package\.json version/);

		for (const date of ['2026-99-99', '2026-02-29']) {
			const invalidDate = CHANGELOG.replace(heading, '## [0.6.0-next.91] - ' + date);
			expect(() => validateReleaseSummary(invalidDate), date).toThrow(/real calendar date/);
		}

		for (const version of [
			'..\\..\\README',
			'../../README',
			'%2e%2e%2fREADME',
			'..%5c..%5cREADME',
			'0.6.0-next.91?overwrite',
			'0.6.0-next.91#fragment',
			'v0.6.0-next.91'
		]) {
			const unsafe = CHANGELOG.replace(heading, '## [' + version + '] - 2026-08-01');
			expect(() => releasePagePath(unsafe), version).toThrow(/safe exact SemVer|does not match/);
		}
	});

	it('rejects duplicate or malformed dated release headings', () => {
		const duplicate = CHANGELOG.replace(
			'## [0.6.0-next.90] - 2026-08-01',
			'## [0.6.0-next.91] - 2026-08-01\n\nDuplicate current version.\n\n' +
				'## [0.6.0-next.90] - 2026-08-01'
		);
		const malformed = CHANGELOG.replace(
			'## [0.6.0-next.90] - 2026-08-01',
			'## [0.6.0-next.90] 2026-08-01'
		);
		const duplicateArchive = CHANGELOG.replace(
			'## [0.3.9] and earlier',
			'## [0.3.9] and earlier\n\n## [0.3.9] and earlier'
		);
		expect(() => validateReleaseSummary(duplicate)).toThrow(/duplicate release version/);
		expect(() => validateReleaseSummary(malformed)).toThrow(/malformed release heading/);
		expect(() => validateReleaseSummary(duplicateArchive)).toThrow(/duplicate release version/);
	});

	it('generates the versioned consumer page from the same structured entry', () => {
		expect(NEWEST_VERSION).toBe(newestReleaseVersion());
		const route = releasePagePath(NEWEST_VERSION);
		expect(route).toBe(`docs/releases/${NEWEST_VERSION}.md`);
		expect(releasePagePath(CHANGELOG)).toBe(route);
		expect(() => releasePagePath('../../README')).toThrow(/safe exact SemVer/);
		const resolved = releasePageTarget(CHANGELOG);
		expect(resolved.relative).toBe(route);
		expect(resolved.target.pathname.replaceAll('\\', '/').endsWith('/' + route)).toBe(true);
		expect(RELEASE_PAGE.replace(/\r\n/g, '\n')).toBe(renderReleasePage(CHANGELOG));
		expect(RELEASE_PAGE).toContain('[migration index](../../MIGRATION.md)');
		expect(RELEASE_PAGE).toContain('[complete changelog](../../CHANGELOG.md)');
	});

	it('ships the complete changelog and generated versioned release route', () => {
		const packed = new Set(packageFiles());
		expect(packed.has('CHANGELOG.md')).toBe(true);
		expect(packed.has(releasePagePath(CHANGELOG))).toBe(true);
	});
});
