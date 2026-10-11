import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resizeReadmeManifest, validateGrowthRecords, validateReadmeGrowth } from '../scripts/readme-ratchet.js';
import { describe, expect, it } from 'vitest';
import {
	main,
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
		// These mutants append lines, and the size ratchet sits AT the README's
		// current length, so they would trip it incidentally. This test is about
		// which version facts are owned, not about size: relax the one pin that
		// is not under test so a control case can still assert no errors at all.
		const unsized = { ...manifest, readmeMaxLines: Number.MAX_SAFE_INTEGER };
		expect(nativeRefs).toContain('v20.69.0');
		expect(governedNativeRefs(pkg)).toContain('v20.69.0');
		// The stable row's pin is governed on its own, not only through the
		// package: give it a ref the package does not carry.
		const olderStable = compatibilityCsv.replace('.js#v20.69.0', '.js#v20.67.0');
		expect(olderStable).not.toBe(compatibilityCsv);
		expect(governedNativeRefs(pkg, olderStable)).toContain('v20.67.0');
		for (const bare of ['20.69', '20.69.0', '20.69.1']) {
			expect(
				validateReadme(readme + '\nBuilt against ' + bare + ' binaries.\n', unsized, nativeRefs)
			).toContain('native compatibility fact outside generated compatibility block: ' + bare);
		}
		// Unrelated bare numbers stay unowned: only governed pins get the
		// no-v form, and word bounds keep 20.699 or 120.69 out.
		for (const control of ['22.0', '20.699', '120.69', '1.20']) {
			expect(
				validateReadme(readme + '\nSee note ' + control + ' for details.\n', unsized, nativeRefs)
			).toEqual([]);
		}
	});

	// A ratchet with headroom is a cap: the first pin carried 434 spare lines
	// and had absorbed 77 lines of growth before anyone noticed. Pinned AT the
	// current length, the next added line has to be paid for deliberately.
	it('keeps the size ratchet binding rather than slack', () => {
		const lines = readme.split(/\r?\n/).length;
		expect(manifest.readmeMaxLines, 'the pin must sit at the README length, not above it')
			.toBe(lines);
		expect(validateReadme(readme, manifest, nativeRefs)).toEqual([]);
		const grown = readme.replace(/\n$/, '\nOne more line.\n');
		expect(validateReadme(grown, manifest, nativeRefs).join('\n'))
			.toContain('the readmeMaxLines ratchet is ' + manifest.readmeMaxLines);
	});

	it('rewrites only the bounded generated block', () => {
		const corrupted = readme.replace('Learn the ecosystem end to end', 'Learn it');
		expect(replacePaths(corrupted, renderPaths(manifest))).toBe(readme);
	});
});

it('records only explicit increases while automatically tightening the limit', () => {
	const baseline = { readmeMaxLines: 20, readmeGrowth: [] };
	expect(() => resizeReadmeManifest(baseline, baseline, 21, false)).toThrow('accepted README growth record');
	const accepted = resizeReadmeManifest(baseline, baseline, 21, true);
	expect(accepted.readmeGrowth).toEqual([{ from: 20, to: 21 }]);
	expect(validateReadmeGrowth(accepted, baseline)).toEqual([]);
	expect(resizeReadmeManifest(accepted, baseline, 21, false)).toEqual(accepted);
	expect(resizeReadmeManifest(baseline, baseline, 19, false).readmeMaxLines).toBe(19);
	expect(validateGrowthRecords({ readmeGrowth: [{ from: 20, to: 20 }] })).not.toEqual([]);
	expect(validateReadmeGrowth({ ...accepted, readmeGrowth: [{ from: 19, to: 21 }] }, baseline).join('\n')).toContain('accepted README growth record');
	expect(validateReadmeGrowth({ readmeMaxLines: 20, readmeGrowth: [] }, accepted).join('\n')).toContain('cannot be edited or removed');
	expect(validateReadmeGrowth({ readmeMaxLines: 20 }, baseline).join('\n')).toContain('cannot be edited or removed');
});

it('rejects unrecorded working and committed growth through the real documentation gate', () => {
	const directory = mkdtempSync(join(tmpdir(), 'adapter-readme-'));
	mkdirSync(join(directory, 'docs'));
	mkdirSync(join(directory, '.empty-hooks'));
	const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(directory, '.empty-hooks')}`, '-c', 'user.name=Documentation test', '-c', 'user.email=docs@example.invalid', ...args], { cwd: directory, stdio: 'pipe' });
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
	const manifest = JSON.parse(readFileSync(new URL('../docs/documentation.v1.json', import.meta.url), 'utf8'));
	manifest.readmeMaxLines = readme.split('\n').length;
	manifest.readmeGrowth = [];
	const save = value => writeFileSync(join(directory, 'docs/documentation.v1.json'), JSON.stringify(value, null, 2) + '\n');
	const run = options => main({ directory, log() {}, ...options });
	try {
		for (const file of ['package.json', 'docs/compatibility.v1.csv']) writeFileSync(join(directory, file), readFileSync(new URL('../' + file, import.meta.url)));
		writeFileSync(join(directory, 'README.md'), readme);
		save(manifest);
		git('init', '-q'); git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Record documentation limit');
		writeFileSync(join(directory, 'README.md'), readme + '\n');
		save({ ...manifest, readmeMaxLines: manifest.readmeMaxLines + 1 });
		expect(() => run()).toThrow('accepted README growth record');
		expect(() => run({ write: true })).toThrow('accepted README growth record');
		run({ write: true, acceptReadmeGrowth: true });
		run();
		const accepted = JSON.parse(readFileSync(join(directory, 'docs/documentation.v1.json'), 'utf8'));
		expect(accepted.readmeGrowth).toEqual([{ from: manifest.readmeMaxLines, to: manifest.readmeMaxLines + 1 }]);
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Accept documentation growth');
		run();
		writeFileSync(join(directory, 'README.md'), readme + '\n\n');
		save({ ...accepted, readmeMaxLines: accepted.readmeMaxLines + 1 });
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Raise limit without acceptance');
		git('commit', '--allow-empty', '-qm', 'Unrelated change');
		expect(() => run()).toThrow('accepted README growth record');
		save({ ...accepted, readmeMaxLines: accepted.readmeMaxLines + 1, entryBudgetLines: accepted.entryBudgetLines + 1 });
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Change routing budget');
		expect(() => run()).toThrow('accepted README growth record');
	} finally {
		const target = resolve(directory);
		if (!target.startsWith(resolve(tmpdir()) + '/') && !target.startsWith(resolve(tmpdir()) + '\\')) throw new Error('Fixture escaped temp directory');
		if (!basename(target).startsWith('adapter-readme-')) throw new Error('Unexpected fixture directory');
		rmSync(target, { recursive: true, force: true });
	}
}, 600_000);
