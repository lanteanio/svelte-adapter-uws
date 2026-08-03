import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	checkMigrationFreshness,
	computeMigrationSurfaceDigest,
	digestSurfaceEntries,
	migrationSurfaceMarker,
	migrationSurfacePaths,
	normalizeSurfaceText,
	publicPackageSurface,
	replaceMigrationSurfaceMarker,
	surfaceEntries,
	versionIndependentCompatibilitySurface
} from '../scripts/check-migration-freshness.js';
import {
	parseCompatibility,
	uwsRefFromSpec
} from '../scripts/check-compatibility.js';

const guide = readFileSync(new URL('../docs/migrations/0.5-to-0.6.md', import.meta.url), 'utf8');
const compatibilityCsv = readFileSync(new URL('../docs/compatibility.v1.csv', import.meta.url), 'utf8');

describe('migration freshness follows public surface and schema changes', () => {
	it('binds the active guide to the current selected surface', () => {
		const result = checkMigrationFreshness();
		expect(result.updated).toBe(false);
		expect(result.actual).toBe(computeMigrationSurfaceDigest());
		expect(result.count).toBe(surfaceEntries().length);
	});

	it('covers declarations, export/runtime prerequisites, schemas, wire code, and codecs', () => {
		const paths = migrationSurfacePaths();
		for (const required of [
			'docs/compatibility.v1.csv',
			'protocol.schema.json',
			'src/index.d.ts',
			'src/index.js',
			'src/observability.generated.d.ts',
			'src/runtime/observability-manifest.js',
			'src/runtime/wire.js',
			'src/plugins/presence/codec.js',
			'src/plugins/cursor/codec.js',
			'src/vite.js'
		]) expect(paths).toContain(required);
		expect(paths.filter((path) => path.endsWith('.d.ts')).length).toBeGreaterThan(30);
	});

	it('changes the digest for every selected entry and ignores only line-ending form', () => {
		const entries = surfaceEntries();
		const baseline = digestSurfaceEntries(entries);
		for (const target of [
			'protocol.schema.json',
			'src/index.d.ts',
			'src/runtime/wire.js',
			'src/plugins/presence/codec.js',
			'package.json#public-migration-surface'
		]) {
			const changed = entries.map((entry) => entry.path === target
				? { ...entry, content: entry.content + '\nconsumer-visible-change' }
				: entry);
			expect(digestSurfaceEntries(changed), target).not.toBe(baseline);
		}
		expect(normalizeSurfaceText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
		expect(digestSurfaceEntries([{ path: 'x', content: 'a\r\nb\r' }]))
			.toBe(digestSurfaceEntries([{ path: 'x', content: 'a\nb\n' }]));
	});

	it('projects migration-relevant package fields without coupling freshness to scripts or time', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		const baseline = publicPackageSurface(pkg);
		const unrelated = publicPackageSurface({ ...pkg, version: '99.0.0', scripts: { changed: 'yes' } });
		expect(unrelated).toEqual(baseline);
		const changed = publicPackageSurface({ ...pkg, engines: { node: '>=99' } });
		expect(changed).not.toEqual(baseline);
	});

	it('a release bump alone is not a freshness input, but series/pin changes are', () => {
		// check-compatibility forces the current row's adapter_version to equal
		// the package version, so a raw-CSV digest flipped on every
		// chore(release) bump and trained reflexive --write re-stamps.
		const projected = versionIndependentCompatibilitySurface(compatibilityCsv);
		expect(projected).not.toContain('adapter_version');
		// Derive every probe from the manifest itself: a literal version here
		// would silently no-op (or fail) on the next release bump - the exact
		// event this projection exists to make a non-event.
		const currentRow = parseCompatibility(compatibilityCsv).find((row) => row.current === 'true');
		const bumped = compatibilityCsv.replace(currentRow.adapter_version, currentRow.adapter_version + '9');
		expect(bumped).not.toBe(compatibilityCsv);
		expect(versionIndependentCompatibilitySurface(bumped)).toBe(projected);
		// The digest still moves for the columns a migration guide is about.
		const currentRef = uwsRefFromSpec(currentRow.uwebsockets);
		const movedPin = compatibilityCsv.replace(currentRef, 'v99.99.0');
		expect(movedPin).not.toBe(compatibilityCsv);
		expect(versionIndependentCompatibilitySurface(movedPin)).not.toBe(projected);
		const movedSeries = compatibilityCsv.replace(
			',' + currentRow.realtime + ',' + currentRow.extensions + ',',
			',9.9.x,' + currentRow.extensions + ','
		);
		expect(movedSeries).not.toBe(compatibilityCsv);
		expect(versionIndependentCompatibilitySurface(movedSeries)).not.toBe(projected);
		// A restructured CSV (no adapter_version column) digests as itself, so
		// structural change cannot hide behind the projection.
		expect(versionIndependentCompatibilitySurface('a,b\n1,2\n')).toBe('a,b\n1,2\n');
		// And the composed surface actually carries the projection.
		const entry = surfaceEntries().find((candidate) =>
			candidate.path.startsWith('docs/compatibility.v1.csv'));
		expect(entry.path).toBe('docs/compatibility.v1.csv#version-independent');
		expect(entry.content).toBe(projected);
	});

	it('binds the guide tuple table to the compatibility manifest', () => {
		// The prerequisites table duplicates manifest facts by design (a guide
		// must be readable offline); this is what keeps the copies honest.
		const rows = parseCompatibility(compatibilityCsv);
		const stable = rows.find((row) => row.channel === 'stable');
		const current = rows.find((row) => row.current === 'true');
		const tableRow = (label) => {
			const match = guide.split('\n').find((line) => line.startsWith('| ' + label));
			expect(match, `guide tuple table row "${label}" not found`).toBeTruthy();
			return match.split('|').map((cell) => cell.trim());
		};
		const rollback = tableRow('Rollback baseline');
		expect(rollback[2]).toContain(stable.adapter_version);
		expect(rollback[3]).toContain(stable.realtime);
		expect(rollback[4]).toContain(stable.extensions);
		expect(rollback[5]).toContain(uwsRefFromSpec(stable.uwebsockets));
		const upgrade = tableRow('Upgrade candidate');
		expect(upgrade[2]).toContain(current.adapter);
		expect(upgrade[3]).toContain(current.realtime);
		expect(upgrade[4]).toContain(current.extensions);
		expect(upgrade[5]).toContain(uwsRefFromSpec(current.uwebsockets));
	});

	it('updates exactly one marker and rejects missing or duplicated authority', () => {
		const digest = 'a'.repeat(64);
		const updated = replaceMigrationSurfaceMarker(guide, digest);
		expect(migrationSurfaceMarker(updated)).toBe(digest);
		expect(updated.replace(digest, migrationSurfaceMarker(guide))).toBe(guide);
		expect(() => migrationSurfaceMarker(guide + '\n' + guide.match(/<!-- migration-surface:[^>]+-->/)[0]))
			.toThrow('exactly one');
		expect(() => migrationSurfaceMarker('# no marker\n')).toThrow('exactly one');
	});
});
