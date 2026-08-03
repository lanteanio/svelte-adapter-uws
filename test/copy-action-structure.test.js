import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const markdownRenderer = new MarkdownIt({ html: true, linkify: true, typographer: false });
const PROSE_ELEMENTS = new Set(['article', 'aside', 'blockquote', 'dd', 'div', 'dt', 'li', 'p', 'section']);
const NON_PROSE_ELEMENTS = new Set(['code', 'pre', 'script', 'style', 'table', 'template']);

function between(markdown, start, end) {
	const from = markdown.indexOf(start);
	const to = markdown.indexOf(end, from + start.length);
	if (from < 0 || to <= from) throw new Error(`missing bounded section: ${start}`);
	return markdown.slice(from + start.length, to);
}

function proseUnits(markdown) {
	const root = parseFragment(markdownRenderer.render(markdown));
	const units = [];

	function text(node) {
		if (node.nodeName === '#text') return node.value;
		return (node.childNodes ?? []).map(text).join(' ');
	}

	function visit(node) {
		if (NON_PROSE_ELEMENTS.has(node.tagName)) return;
		const children = node.childNodes ?? [];
		const hasNestedUnit = children.some((child) => PROSE_ELEMENTS.has(child.tagName));
		if (PROSE_ELEMENTS.has(node.tagName) && !hasNestedUnit) {
			const value = text(node).replace(/\s+/g, ' ').trim();
			if (value) units.push(value);
			return;
		}
		for (const child of children) visit(child);
	}

	visit(root);
	return units;
}

function words(unit) {
	// proseUnits returns text extracted from rendered HTML, so Markdown link
	// syntax is already resolved; count plain whitespace-separated words.
	return unit.split(/\s+/).filter(Boolean).length;
}

const JOB = /^(?:Decision|Required action|Why|Example|Limits|Evidence|Mechanics|Accessibility):/;

function structureFailures(markdown) {
	const units = proseUnits(markdown);
	const failures = units
		.filter((unit) => words(unit) > 80)
		.map((unit) => `over 80 words: ${unit}`);
	if (units.length > 0 && !/^(?:Decision|Required action):/.test(units[0])) {
		failures.push(`action is not first: ${units[0]}`);
	}
	for (const unit of units) {
		if (!JOB.test(unit)) failures.push(`missing job label: ${unit}`);
	}
	return failures;
}

const sections = [
	between(README, '#### Smooth remote cursors (`smooth`)', '#### Server API'),
	between(README, '### Smooth (prediction and reconciliation)', '### CRDT documents')
];

describe('critical smoothing copy has one visible job per prose unit', () => {
	it('keeps every rendered prose unit labeled, action-first, and within 80 words', () => {
		for (const section of sections) {
			expect(structureFailures(section)).toEqual([]);
		}
	});

	it('keeps mechanics after an explicit decision or required action', () => {
		for (const section of sections) {
			const units = proseUnits(section);
			const action = units.findIndex((unit) => /^(?:Decision|Required action):/.test(unit));
			const mechanics = units.findIndex((unit) => /^Mechanics:/.test(unit));
			expect(action).toBeGreaterThanOrEqual(0);
			expect(mechanics).toBeGreaterThan(action);
		}
	});

	it('detects buried actions and oversized prose while ignoring fenced examples', () => {
		const buried = 'Context arrives before the action.\n\n**Required action:** Act now.';
		const oversized = '**Decision:** ' + 'word '.repeat(81);
		const fenced = '**Decision:** Keep this short.\n\n```text\n' + 'word '.repeat(100) + '\n```';
		const html = '<p>Context arrives before the action.</p>\n\n**Required action:** Act now.';
		expect(structureFailures(buried)).toContain('action is not first: Context arrives before the action.');
		expect(structureFailures(buried)).toContain('missing job label: Context arrives before the action.');
		expect(structureFailures(oversized)[0]).toMatch(/^over 80 words:/);
		expect(structureFailures(fenced)).toEqual([]);
		expect(structureFailures(html)).toContain('missing job label: Context arrives before the action.');
	});

	it('keeps prediction safety actions separate and explicit', () => {
		const prediction = sections[1];
		expect(prediction).toContain('**Required action:** Send commands, never client-authored state.');
		expect(prediction).toContain('**Required action:** Guard one-shot side effects');
		expect(prediction).toContain('**Required action:** Monitor both `onOverflow(cb)` and `onStall(cb)`.');
		expect(prediction).toContain('**Required action:** Send discrete effects through');
	});
});
