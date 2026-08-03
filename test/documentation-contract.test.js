import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	PATHS_END,
	PATHS_START,
	governedNativeRefs,
	renderPaths,
	replacePaths,
	validateDocumentationContract,
	validateManifest,
	validateReadme
} from '../scripts/check-documentation-contract.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const manifest = JSON.parse(read('docs/documentation.v1.json'));
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
const compatibilityCsv = read('docs/compatibility.v1.csv');
const nativeRefs = governedNativeRefs(pkg, compatibilityCsv);

describe('documentation entry-surface contract', () => {
	it('validates the packaged manifest and rendered README surface', () => {
		expect(validateDocumentationContract({ manifest, readme, pkg, compatibilityCsv })).toEqual([]);
		expect(renderPaths(manifest)).toContain('https://svelte-realtime.dev/docs/ecosystem/adapter');
	});

	it('rejects schema, ordering, ownership, and destination drift', () => {
		const changed = structuredClone(manifest);
		changed.paths[0].key = 'tutorial';
		changed.paths[3].destination = 'http://example.com/tutorial?copy=1';
		changed.paths[4].owner = 'README.md';
		const errors = validateManifest(changed, pkg);
		expect(errors).toContain('paths[0] key must be identity');
		expect(errors).toContain('tutorial: site destination must be a clean HTTPS svelte-realtime.dev route');
		expect(errors).toContain('how-to: site destinations must be owned by svelte-realtime.dev');
	});

	it('rejects stale, duplicated, and over-budget entry surfaces', () => {
		const stale = readme.replace('Serve the first HTTP route', 'Serve HTTP');
		expect(validateReadme(stale, manifest)).toContain(
			'README documentation paths block is stale; run node scripts/check-documentation-contract.js --write'
		);
		const duplicated = readme.replace(PATHS_END, PATHS_END + '\n' + PATHS_START);
		expect(validateReadme(duplicated, manifest)).toContain('README must contain exactly one documentation paths block');
		const crowded = readme.replace(PATHS_START, Array(80).fill('').join('\n') + PATHS_START);
		expect(validateReadme(crowded, manifest).some((error) => error.includes('documentation paths block ends on line'))).toBe(true);
	});

	it('enforces the readmeMaxLines ratchet against the whole README', () => {
		const readmeLines = readme.split(/\r?\n/).length;
		expect(manifest.readmeMaxLines).toBeGreaterThanOrEqual(readmeLines);
		const lowered = { ...manifest, readmeMaxLines: readmeLines - 1 };
		expect(
			validateReadme(readme, lowered).some((error) =>
				error.includes('readmeMaxLines ratchet is ' + lowered.readmeMaxLines)
			)
		).toBe(true);
		expect(validateManifest({ ...manifest, readmeMaxLines: 'many' }, pkg)).toContain('readmeMaxLines must be a positive integer');
		expect(validateManifest({ ...manifest, readmeMaxLines: 0 }, pkg)).toContain('readmeMaxLines must be a positive integer');
	});

	it('rejects native release facts copied outside the generated compatibility fixture', () => {
		const copied = readme + '\nCurrent native pin: v20.99.0\n';
		expect(validateReadme(copied, manifest)).toContain(
			'native compatibility fact outside generated compatibility block: v20.99.0'
		);
		// The guard is not pinned to one major: a future v21 pin copied
		// outside the block is drift on the day it happens.
		expect(validateReadme(readme + '\nUse v21.0.0 now.\n', manifest)).toContain(
			'native compatibility fact outside generated compatibility block: v21.0.0'
		);
		expect(
			validateReadme(
				readme + '\nhttps://github.com/uNetworking/uWebSockets.js/archive/refs/tags/' + 'v21.0.0.tar.gz\n',
				manifest
			)
		).toContain(
			'native compatibility fact outside generated compatibility block: uWebSockets.js/archive/refs/tags/v21.0.0'
		);
	});

	it('derives governed pins and rejects their bare major.minor drift form', () => {
		expect(nativeRefs).toContain('v20.69.0');
		expect(nativeRefs).toContain('v20.67.0');
		expect(governedNativeRefs(pkg)).toContain('v20.69.0');
		for (const bare of ['20.69', '20.69.0', '20.69.1', '20.67']) {
			expect(
				validateReadme(readme + '\nBuilt against ' + bare + ' binaries.\n', manifest, nativeRefs)
			).toContain('native compatibility fact outside generated compatibility block: ' + bare);
		}
		// Unrelated bare numbers stay unowned: only governed pins get the
		// no-v form, and word bounds keep 20.699 or 120.69 out.
		for (const control of ['22.0', '20.699', '120.69', '1.20']) {
			expect(
				validateReadme(readme + '\nSee note ' + control + ' for details.\n', manifest, nativeRefs)
			).toEqual([]);
		}
	});

	it('rewrites only the bounded generated block', () => {
		const corrupted = readme.replace('Learn the ecosystem end to end', 'Learn it');
		expect(replacePaths(corrupted, renderPaths(manifest))).toBe(readme);
	});
});
