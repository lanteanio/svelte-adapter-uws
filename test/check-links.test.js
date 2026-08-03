// The documentation link checker's own tests.
//
// It exists because a dead anchor is invisible: GitHub renders it as an
// ordinary link and does nothing when it is clicked, so nothing short of
// clicking every link in a several-thousand-line README finds one.
//
// The slug cases below are the ones an approximation gets wrong, and getting
// them wrong in either direction makes the checker useless - a rule that
// collapses hyphen runs rejects a link that works today, and a rule that
// replaces punctuation instead of deleting it accepts one that does not.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
	slugify,
	anchorsOf,
	linksOf,
	checkLink,
	documentationFiles,
	packageFiles
} from '../scripts/check-links.js';

describe('heading slugs follow GitHub exactly', () => {
	it('lowercases and hyphenates spaces', () => {
		expect(slugify('Clone to green')).toBe('clone-to-green');
	});

	// Punctuation is DELETED, not replaced, so the spaces either side of a
	// removed word survive as two hyphens. This is a real heading in the README
	// and a checker that normalizes the pair reports its live link as dead.
	it('leaves the double hyphen a deleted word produces', () => {
		expect(slugify('Development, Preview & Production')).toBe('development-preview--production');
	});

	it('drops code spans, emphasis and link syntax but keeps the text', () => {
		expect(slugify('The `platform` API')).toBe('the-platform-api');
		expect(slugify('**Bold** and _thin_')).toBe('bold-and-thin');
		expect(slugify('See [the guide](x.md)')).toBe('see-the-guide');
	});

	it('uses rendered ATX text for closing hashes and HTML entities', () => {
		expect(slugify('Canonical setup ##')).toBe('canonical-setup');
		expect(slugify('Fish &amp; chips')).toBe('fish--chips');
	});

	it('keeps letters outside ASCII', () => {
		expect(slugify('Grundsätzliches zur Größe')).toBe('grundsätzliches-zur-größe');
	});
});

describe('collecting the anchors a document defines', () => {
	it('numbers repeated headings in document order', () => {
		const anchors = anchorsOf('# Options\n## Options\n### Options\n');
		expect([...anchors]).toEqual(['options', 'options-1', 'options-2']);
	});

	it('ignores a comment inside a fenced code block', () => {
		const anchors = anchorsOf('# Real\n\n```bash\n# Not a heading\n```\n');
		expect([...anchors]).toEqual(['real']);
	});

	it('accepts an explicit html anchor', () => {
		expect(anchorsOf('<a id="wire-format"></a>\n').has('wire-format')).toBe(true);
		expect(anchorsOf('<a name="legacy"></a>\n').has('legacy')).toBe(true);
	});
});

describe('collecting the links a document makes', () => {
	it('reads targets with their line numbers', () => {
		expect(linksOf('intro\n\nsee [x](#here) and [y](./MIGRATION.md)\n')).toEqual([
			{ line: 3, target: '#here' },
			{ line: 3, target: './MIGRATION.md' }
		]);
	});

	it('does not read a link written as an example inside a code span', () => {
		expect(linksOf('write `[label](#anchor)` to link\n')).toEqual([]);
	});

	it('ignores a link title', () => {
		expect(linksOf('[x](#here "the title")\n')).toEqual([{ line: 1, target: '#here' }]);
	});

	it('collects rendered reference, angle-destination, and raw HTML links', () => {
		const source = [
			'[reference][route]',
			'',
			'[route]: ./NOT-HERE.md',
			'[angle](<./NOT HERE.md>)',
			'<a href="./ALSO-NOT-HERE.md">HTML link</a>'
		].join('\n');
		expect(linksOf(source)).toEqual([
			{ line: 1, target: './NOT-HERE.md' },
			{ line: 4, target: './NOT%20HERE.md' },
			{ line: 5, target: './ALSO-NOT-HERE.md' }
		]);
	});
});

describe('resolving one link', () => {
	const docs = new Map([
		['README.md', { anchors: new Set(['cross-origin-and-native-app-usage']) }],
		['MIGRATION.md', { anchors: new Set(['upgrading']) }]
	]);

	it('accepts an anchor the document defines', () => {
		expect(checkLink('README.md', '#cross-origin-and-native-app-usage', docs)).toBe(null);
	});

	// The defect this was written for: a section renamed, the link left behind.
	it('rejects an anchor no heading produces', () => {
		expect(checkLink('README.md', '#origin-validation', docs)).toContain('no heading in README.md');
	});

	it('follows an anchor into another document', () => {
		expect(checkLink('README.md', './MIGRATION.md#upgrading', docs)).toBe(null);
		expect(checkLink('README.md', './MIGRATION.md#gone', docs)).toContain('no heading in MIGRATION.md');
	});

	it('rejects a relative path that does not exist', () => {
		expect(checkLink('README.md', './NOT-HERE.md', docs)).toContain('no such file');
		expect(checkLink('README.md', './PROTOCOL.md', docs)).toBe(null);
	});

	it('rejects repository escape and wrong-case paths before anchor lookup', () => {
		expect(checkLink('README.md', '../svelte-adapter-uws/README.md', docs))
			.toContain('path leaves repository');
		expect(checkLink('README.md', './migration.md#definitely-missing', docs))
			.toContain('exact case');
	});

	it('rejects a relative target omitted from the package surface', () => {
		const packagedDocs = new Set(['README.md']);
		const packagedFiles = new Set(['README.md']);
		expect(checkLink('README.md', './MIGRATION.md', docs, { packagedDocs, packagedFiles }))
			.toContain('target omitted from package');
	});

	it('applies missing/package checks to rendered reference and angle destinations', () => {
		const packagedDocs = new Set(['README.md']);
		const packagedFiles = new Set(['README.md']);
		const [reference, angle] = linksOf([
			'[reference][route]',
			'[angle](<./MIGRATION.md>)',
			'',
			'[route]: ./MIGRATION.md'
		].join('\n'));
		expect(checkLink('README.md', reference.target, docs, { packagedDocs, packagedFiles }))
			.toContain('target omitted from package');
		expect(checkLink('README.md', angle.target, docs, { packagedDocs, packagedFiles }))
			.toContain('target omitted from package');
	});

	it('leaves external links alone rather than fetching them', () => {
		expect(checkLink('README.md', 'https://svti.me/smooth', docs)).toBe(null);
		expect(checkLink('README.md', 'mailto:someone@example.com', docs)).toBe(null);
		expect(checkLink('README.md', '//example.com/x', docs)).toBe(null);
	});

	it('decodes a percent-escaped anchor before looking it up', () => {
		const encoded = new Map([['README.md', { anchors: new Set(['größe']) }]]);
		expect(checkLink('README.md', '#gr%C3%B6%C3%9Fe', encoded)).toBe(null);
	});
});

describe('the owned documentation surface', () => {
	it('includes tracked, packaged, policy, observability, vector, and historical docs', () => {
		expect(documentationFiles()).toEqual(expect.arrayContaining([
			'CHANGELOG.md',
			'docs/release-manifest.md',
			'docs/releasing.md',
			'SECURITY.md',
			'examples/observability/queries.md',
			'examples/observability/runbook.md',
			'test-vectors/README.md'
		]));
	});

	it('matches the Markdown inventory npm will actually package', () => {
		const npmCli = process.env.npm_execpath;
		expect(npmCli).toBeTruthy();
		const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: fileURLToPath(new URL('..', import.meta.url)),
			encoding: 'utf8',
			windowsHide: true
		}));
		const actual = packed[0].files.map((file) => file.path)
			.filter((relative) => relative.toLowerCase().endsWith('.md')).sort();
		const declared = packageFiles().filter((relative) => relative.toLowerCase().endsWith('.md'));
		expect(actual).toEqual(declared);
	});

	it('has no dead ordinary links or anchors', () => {
		const packagedFiles = new Set(packageFiles());
		const packagedDocs = new Set([...packagedFiles].filter((rel) => rel.endsWith('.md')));
		const docs = new Map(documentationFiles().map((rel) => {
			const text = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
			return [rel, { text, anchors: anchorsOf(text) }];
		}));
		const broken = [];
		for (const [rel, doc] of docs) {
			for (const link of linksOf(doc.text)) {
				const failure = checkLink(rel, link.target, docs, { packagedDocs, packagedFiles });
				if (failure) broken.push(`${rel}:${link.line} ${link.target}: ${failure}`);
			}
		}
		expect(broken).toEqual([]);
	});
});
