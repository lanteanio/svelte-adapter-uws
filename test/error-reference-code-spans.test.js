// Each message prefix in docs/errors.md renders as exactly that prefix.
//
// The reference quotes every prefix in three places - its index-table row, the
// indexed-console-lines bullet, and its own detail section - as an inline code
// span. A prefix that itself contains backticks closed that span early and the
// rest spilled out as prose (and could break the table cell). The generator now
// fences each span longer than the longest backtick run inside it. This parses
// the committed reference with a real CommonMark renderer rather than trusting
// the string it was built from.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = readFileSync(path.join(ROOT, 'docs/errors.md'), 'utf8');
const md = new MarkdownIt();

/** The code spans markdown-it finds in one markdown line, in order. */
function codeSpans(line) {
	const spans = [];
	for (const token of md.parse(line, {})) {
		for (const child of token.children || []) {
			if (child.type === 'code_inline') spans.push(child.content);
		}
	}
	return spans;
}

describe('message prefixes in the error reference', () => {
	const withPrefix = ADAPTER_ERROR_REGISTRY.filter((entry) => typeof entry.messagePrefix === 'string');

	it('covers entries whose prefix carries backticks, so the case can fail', () => {
		expect(withPrefix.some((entry) => entry.messagePrefix.includes('`'))).toBe(true);
	});

	it('renders each prefix exactly in its detail section', () => {
		for (const entry of withPrefix) {
			const line = reference.split('\n').find((l) => l.startsWith('- **Message prefix:** ') &&
				reference.indexOf(l) > reference.indexOf('<a id="' + entry.anchor + '"></a>'));
			expect(line, entry.id).toBeTruthy();
			expect(codeSpans(line), entry.id).toEqual([entry.messagePrefix]);
		}
	});

	it('renders each prefix exactly in the index table and the console bullets', () => {
		const lines = reference.split('\n');
		const from = lines.findIndex((l) => l.startsWith('Indexed console lines'));
		expect(from, 'the console-lines section moved').toBeGreaterThan(-1);
		const to = lines.findIndex((l, i) => i > from && l.startsWith('#'));
		const consoleSection = lines.slice(from, to);
		for (const entry of withPrefix) {
			const tableRow = lines.find((l) => l.startsWith('| [' + entry.id + '](#'));
			expect(tableRow, entry.id).toBeTruthy();
			// Rendered as a whole table so the cell boundaries are the renderer's.
			const table = md.render('| a | b | c |\n|---|---|---|\n' + tableRow);
			const cells = [...table.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
			expect(cells, entry.id + ' keeps three cells').toHaveLength(3);
			const decoded = cells[2].replace(/^<code>|<\/code>$/g, '')
				.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
			expect(decoded, entry.id).toBe(entry.messagePrefix);

			if (entry.emission !== 'console') continue;
			const bullet = consoleSection.find((l) => l.endsWith(' - [' + entry.id + '](#' + entry.anchor + ')'));
			expect(bullet, entry.id + ' has a console bullet').toBeTruthy();
			expect(codeSpans(bullet), entry.id).toEqual([entry.messagePrefix]);
		}
	});
});
