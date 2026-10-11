import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	NOT_PUBLISHED_MARKER,
	changelogHeadings,
	manifestReleases,
	validateReleaseLedger
} from '../scripts/check-release-ledger.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
const manifest = read('docs/release-manifest.md');
const changelog = read('CHANGELOG.md');
const currentVersion = JSON.parse(read('package.json')).version;

const failures = (manifestSource, changelogSource) => {
	const result = validateReleaseLedger(manifestSource, changelogSource, currentVersion);
	return Array.isArray(result) ? result : [];
};

describe('release ledger reconciliation', () => {
	it('binds every immutable identity field and rejects a removed historical row', () => {
		const row = manifestReleases(manifest).find(row => row.Version === '0.5.9');
		for (const field of ['npm integrity', 'npm shasum', 'Published UTC', 'Git head', 'Git tag', 'Target channel']) {
			const line = manifest.split('\n').find(line => line.startsWith('| svelte-adapter-uws | 0.5.9 '));
			const value = row[field];
			const replacement = field === 'npm integrity' ? 'sha512-' + 'A'.repeat(86) + '=='
				: field === 'Published UTC' ? '2026-10-02T19:34:04.058Z'
				: field === 'Git tag' ? 'svelte-adapter-uws@0.5.9'
				: field === 'Target channel' ? 'next' : 'a'.repeat(40);
			const mutant = manifest.replace(line, line.replace(value, replacement));
			expect(mutant).not.toBe(manifest);
			expect(failures(mutant, changelog).join('\n'), field).toContain('published identity differs from verified pin');
		}
		const without = manifest.split('\n').filter(line => !line.startsWith('| svelte-adapter-uws | 0.1.0 ')).join('\n');
		expect(failures(without, changelog).join('\n')).toContain('verified published identity is missing from manifest: 0.1.0');
	});

	it('reconciles the shipped manifest and changelog without the network', () => {
		expect(failures(manifest, changelog)).toEqual([]);
		const result = validateReleaseLedger(manifest, changelog, currentVersion);
		// The registry history is reconstructed in full: every published row
		// resolves to a dated heading or to the collective archive heading.
		expect(result.rows).toBeGreaterThanOrEqual(177);
		expect(result.rows).toBe(result.archived + changelogHeadings(changelog).headings.length - result.marked - 1);
	});

	it('keeps the current package version unpublished and unmarked', () => {
		expect(manifestReleases(manifest).some((row) => row.Version === currentVersion)).toBe(false);
		const current = changelogHeadings(changelog).headings.find(
			(heading) => heading.version === currentVersion
		);
		expect(current).toBeDefined();
		expect(current.marked).toBe(false);
	});

	it('rejects a published version whose changelog heading is gone', () => {
		const heading = '## [0.6.0-next.90] - 2026-08-01';
		const mutant = changelog.replace(heading, '<!-- heading removed -->');
		expect(mutant, 'mutant did not change the changelog').not.toBe(changelog);
		expect(failures(manifest, mutant)).toContainEqual(
			expect.stringContaining('no changelog heading: 0.6.0-next.90')
		);
	});

	it('rejects an unpublished heading that lost its not-published marker', () => {
		const marked = '## [0.6.0-next.57] - 2026-07-05\n\n' + NOT_PUBLISHED_MARKER;
		const mutant = changelog.replace(marked, '## [0.6.0-next.57] - 2026-07-05');
		expect(mutant, 'mutant did not change the changelog').not.toBe(changelog);
		expect(failures(manifest, mutant)).toContainEqual(
			expect.stringContaining('never accepted, without the not-published marker: 0.6.0-next.57')
		);
	});

	it('rejects the marker on a published version', () => {
		const heading = '## [0.6.0-next.91] - 2026-08-10';
		const mutant = changelog.replace(heading, heading + '\n\n' + NOT_PUBLISHED_MARKER);
		expect(mutant, 'mutant did not change the changelog').not.toBe(changelog);
		expect(failures(manifest, mutant)).toContainEqual(
			expect.stringContaining('published version carries the not-published marker: 0.6.0-next.91')
		);
	});

	it('rejects the marker on the current version, which the exemption forbids', () => {
		const heading = '## [' + currentVersion + '] - ';
		const index = changelog.indexOf(heading);
		expect(index).toBeGreaterThanOrEqual(0);
		const lineEnd = changelog.indexOf('\n', index);
		const mutant = changelog.slice(0, lineEnd) + '\n\n' + NOT_PUBLISHED_MARKER + changelog.slice(lineEnd);
		expect(mutant, 'mutant did not change the changelog').not.toBe(changelog);
		expect(failures(manifest, mutant)).toContainEqual(
			expect.stringContaining('current package version must not carry the not-published marker: ' + currentVersion)
		);
	});

	it('rejects a manifest row for the still-unpublished current version', () => {
		const row =
			'| svelte-adapter-uws | ' + currentVersion + ' | next | ' + 'f'.repeat(40) +
			' | legacy-none | sha512-' + 'A'.repeat(88) + ' | ' + 'a'.repeat(40) +
			' | 2026-08-16T00:00:00.000Z | Synthetic row for the mutation suite. |';
		const mutant = manifest.replace(
			'\n## Routing, corrections and rollback events',
			'\n' + row + '\n\n## Routing, corrections and rollback events'
		);
		expect(mutant, 'mutant did not change the manifest').not.toBe(manifest);
		expect(failures(mutant, changelog)).toContainEqual(
			expect.stringContaining('current package version has a manifest row while still unpublished: ' + currentVersion)
		);
	});

	it('rejects malformed manifest rows: bad timestamp, missing integrity, missing shasum', () => {
		const timestampMutant = manifest.replace('2026-05-23T00:42:45.631Z', '2026-05-23');
		expect(timestampMutant, 'timestamp mutant did not change the manifest').not.toBe(manifest);
		expect(failures(timestampMutant, changelog)).toContainEqual(
			expect.stringContaining('non-canonical Published UTC: svelte-adapter-uws@0.5.8')
		);

		const integrity = manifestReleases(manifest).find((row) => row.Version === '0.5.8')['npm integrity'];
		const integrityMutant = manifest.replace(integrity, 'none' + ' '.repeat(integrity.length - 4));
		expect(integrityMutant, 'integrity mutant did not change the manifest').not.toBe(manifest);
		expect(failures(integrityMutant, changelog)).toContainEqual(
			expect.stringContaining('missing or malformed npm integrity: svelte-adapter-uws@0.5.8')
		);

		const shasum = manifestReleases(manifest).find((row) => row.Version === '0.5.8')['npm shasum'];
		const shasumMutant = manifest.replace(' ' + shasum + ' ', ' ' + ' '.repeat(shasum.length) + ' ');
		expect(shasumMutant, 'shasum mutant did not change the manifest').not.toBe(manifest);
		expect(failures(shasumMutant, changelog)).toContainEqual(
			expect.stringContaining('missing or malformed npm shasum: svelte-adapter-uws@0.5.8')
		);
	});

	it('rejects a heading version the manifest never recorded at all', () => {
		// A four-digit prerelease number the line will never reach, so the
		// synthetic heading stays unrecorded however far the real next.N
		// counter advances - a rolling current+1 here went stale the moment
		// the next cycle opened its own heading.
		const mutant = changelog.replace(
			'## [0.6.0-next.91] - 2026-08-10',
			'## [0.6.0-next.9999] - 2026-08-10\n\nSynthetic entry.\n\n## [0.6.0-next.91] - 2026-08-10'
		);
		expect(mutant, 'mutant did not change the changelog').not.toBe(changelog);
		expect(failures(manifest, mutant)).toContainEqual(
			expect.stringContaining('never accepted, without the not-published marker: 0.6.0-next.9999')
		);
	});
});
