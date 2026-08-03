// The formatting contract must be enforceable, and .editorconfig must describe
// the tree it governs.
//
// The previous contract test only grepped .editorconfig for its own strings, so
// it passed while the file declared two-space JSON against a tree whose
// package.json, both `--write` generator outputs and three fixture manifests
// are tab-indented. A declaration nothing reads is decoration; these assertions
// are about the checker being able to REFUSE.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
	findOffenses,
	globToRegExp,
	indentRunIsValid,
	parseEditorConfig,
	propertiesFor
} from '../scripts/check-formatting.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
const sections = parseEditorConfig(read('.editorconfig'));

describe('the tree conforms to its own formatting declaration', () => {
	it('has no offenses, over a file list large enough to mean something', () => {
		const { offenses, count } = findOffenses();
		expect(offenses).toEqual([]);
		// A pass over an empty or truncated list would report success having
		// read nothing at all.
		expect(count).toBeGreaterThan(500);
	});
});

describe('the declaration matches the files it governs', () => {
	// The exact contradiction that shipped: these are tab-indented in the tree
	// and two of them are rewritten by `--write` generators that emit tabs.
	for (const file of [
		'package.json',
		'scripts/uws-accepted.json',
		'docs/documentation.v1.json',
		'docs/code-blocks.v1.json'
	]) {
		it(`${file} is declared tab-indented, matching its bytes`, () => {
			expect(propertiesFor(sections, file).indent_style).toBe('tab');
			const body = read(file);
			expect(body.split('\n').some((line) => line.startsWith('\t')), `${file} is not tab-indented`).toBe(true);
			expect(body.split('\n').some((line) => /^ +[^ *]/.test(line)), `${file} has space-indented lines`).toBe(false);
		});
	}

	// The other family: byte-compared data where reindenting is a diff against
	// the fixture itself.
	for (const file of ['protocol.schema.json', 'test-vectors/frames.json', 'test/dst-goldens/adapter-single.golden.json']) {
		it(`${file} is declared space-indented, matching its bytes`, () => {
			expect(propertiesFor(sections, file).indent_style).toBe('space');
			expect(read(file).split('\n').some((line) => line.startsWith('\t')), `${file} has tab-indented lines`).toBe(false);
		});
	}

	it('JavaScript is tab-indented by default', () => {
		expect(propertiesFor(sections, 'src/runtime/handler.js').indent_style).toBe('tab');
	});

	it('the declared capacity-kit exception is a real exception, not a blanket one', () => {
		// It is carved out per file, so a NEW space-indented JavaScript file
		// elsewhere is still an offense rather than quietly permitted.
		expect(propertiesFor(sections, 'scripts/check-capacity-kit.js').indent_style).toBe('space');
		expect(propertiesFor(sections, 'scripts/check-links.js').indent_style).toBe('tab');
	});
});

describe('the checker can refuse', () => {
	// Each of these is a defect the gate exists to catch. A checker that cannot
	// fail is worse than no checker, because it reads as coverage.
	it('rejects a space indent where tabs are declared', () => {
		expect(indentRunIsValid('    ', 'const x = 1;', 'tab')).toBe(false);
	});

	it('rejects a tab indent where spaces are declared', () => {
		expect(indentRunIsValid('\t', '"key": 1', 'space')).toBe(false);
	});

	it('allows alignment spaces AFTER a tab indent', () => {
		// A wrapped argument list or continued string. Rejecting these produced
		// the self-contradicting message "indent starts with a tab, declared tab".
		expect(indentRunIsValid('\t\t\t  ', "'continued string'", 'tab')).toBe(true);
	});

	it('allows a block-comment continuation at column zero', () => {
		expect(indentRunIsValid(' ', '* @typedef {...}', 'tab')).toBe(true);
		// ...but only for the comment star, not for code.
		expect(indentRunIsValid(' ', 'const x = 1;', 'tab')).toBe(false);
	});
});

describe('editorconfig globs resolve the way the cascade needs', () => {
	it('a bare pattern matches at any depth, so [*.json] is every JSON file', () => {
		expect(globToRegExp('*.json').test('test/fixtures/svelte4/package.json')).toBe(true);
	});

	it('a pattern with a separator is anchored to the repository root', () => {
		expect(globToRegExp('test-vectors/*.json').test('test-vectors/frames.json')).toBe(true);
		expect(globToRegExp('test-vectors/*.json').test('other/test-vectors/frames.json')).toBe(false);
	});

	it('* does not cross a directory separator', () => {
		expect(globToRegExp('docs/capacity/v1/*.json').test('docs/capacity/v1/deep/result.schema.json')).toBe(false);
	});

	it('brace alternation selects any listed extension', () => {
		expect(globToRegExp('*.{yml,yaml}').test('.github/workflows/release.yml')).toBe(true);
		expect(globToRegExp('*.{yml,yaml}').test('README.md')).toBe(false);
	});

	it('later sections win, which is what the JSON carve-outs rely on', () => {
		// [*.json] declares tab; the specific section after it declares space.
		expect(propertiesFor(sections, 'test-vectors/frames.json').indent_style).toBe('space');
	});
});
