import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	buildManifest,
	coverageOf,
	inventoryMarkdown,
	packageImportProblems,
	syntaxProblem,
	validateManifest
} from '../scripts/check-doc-code.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const README = read('README.md');
const MANIFEST = JSON.parse(read('docs/code-blocks.v1.json'));
const PACKAGE = JSON.parse(read('package.json'));

describe('README code-block contract', () => {
	it('classifies every real README fence and compiles every compiler channel', () => {
		expect(validateManifest(MANIFEST, { 'README.md': README })).toEqual([]);
		const coverage = coverageOf(MANIFEST);
		expect(coverage.total).toBe(inventoryMarkdown(README).length);
		expect(coverage.total).toBeGreaterThan(200);
		expect(coverage.classifications.syntax).toBeGreaterThan(100);
		expect(coverage.classifications.executed).toBeGreaterThan(0);
	}, 60000);

	it('fails closed when a fence is added, changed, or moved under another section', () => {
		const added = README + '\n## Unreviewed\n\n```js\nexport const missed = true;\n```\n';
		expect(validateManifest(MANIFEST, { 'README.md': added })
			.some((error) => error.includes('unclassified js fence'))).toBe(true);

		const changed = README.replace('const r = await runSim(', 'const r = await runSimBROKEN(');
		expect(validateManifest(MANIFEST, { 'README.md': changed }).length).toBeGreaterThan(0);
	}, 60000);

	it('refuses a manifest whose recorded lines drifted, without any fence changing', () => {
		// A prose-only insert above a fence changes no content, so every
		// fingerprint still matches and only positions move. That used to pass
		// this gate and fail packed-readme-examples minutes later with a message
		// naming neither the cause nor the fix.
		const shifted = README.replace('\n## ', '\n<!-- prose -->\n\n## ');
		expect(shifted).not.toBe(README);

		const errors = validateManifest(MANIFEST, { 'README.md': shifted });
		expect(errors.some((error) => error.includes('line is stale'))).toBe(true);
		// The failure has to carry its own fix; that is the whole complaint.
		expect(errors.some((error) => error.includes('node scripts/check-doc-code.js --write'))).toBe(true);
		// Content is untouched, so nothing may be reported as reclassified.
		expect(errors.some((error) => error.includes('unclassified'))).toBe(false);
	}, 60000);

	it('distinguishes standalone syntax, intentional fragments, and manual commands', () => {
		const marker = '<!-- doc-code: fragment reason="deliberate excerpt" -->';
		const source = [
			'# Samples',
			'```js',
			'export const valid = config.value;',
			'```',
			marker,
			'```js',
			'const = broken;',
			'```',
			'```bash',
			'npm test',
			'```'
		].join('\n');
		const manifest = buildManifest({ 'README.md': source });
		expect(manifest.blocks.map((block) => block.classification))
			.toEqual(['syntax', 'fragment', 'command']);
		expect(validateManifest(manifest, { 'README.md': source })).toEqual([]);

		// An unmarked parse failure fails closed instead of inventing a fragment.
		const unmarked = source.replace(marker + '\n', '');
		expect(() => buildManifest({ 'README.md': unmarked }))
			.toThrow(/deliberate excerpt needs <!-- doc-code: fragment/);
	});

	it('uses the language compiler rather than accepting malformed code as metadata', () => {
		expect(syntaxProblem({ language: 'js', content: 'export const ok = 1;' })).toBeNull();
		expect(syntaxProblem({ language: 'js', content: 'export const = 1;' })).not.toBeNull();
		expect(syntaxProblem({ language: 'ts', content: 'const value: number = 1;' })).toBeNull();
		expect(syntaxProblem({ language: 'svelte', content: '<button>{label}</button>' })).toBeNull();
		expect(syntaxProblem({ language: 'json', content: '{"ok":true}' })).toBeNull();
		expect(syntaxProblem({ language: 'yaml', content: 'ok: true\n' })).toBeNull();
	});

	it('rejects README imports that are not present on the packaged declaration', () => {
		expect(packageImportProblems({
			language: 'js',
			content: "import { createLock } from 'svelte-adapter-uws/plugins/lock';\n"
		})).toEqual([]);
		expect(packageImportProblems({
			language: 'js',
			content: "import { withLock } from 'svelte-adapter-uws/plugins/lock';\n"
		})).toContain('svelte-adapter-uws/plugins/lock has no declared export withLock');
	});

	it('runs in normal, docs, test, and publication gates', () => {
		expect(PACKAGE.scripts['check:docs-code']).toBe('node scripts/check-doc-code.js');
		expect(PACKAGE.scripts.check).toContain('node scripts/check-doc-code.js');
		expect(PACKAGE.scripts['verify:docs']).toContain('node scripts/check-doc-code.js');
		expect(PACKAGE.scripts.pretest).toBe('npm run check');
		expect(PACKAGE.scripts.prepublishOnly).toContain('npm run check');
	});
});
