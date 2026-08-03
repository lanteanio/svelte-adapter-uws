import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { slugify } from '../scripts/check-links.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const toc = /## Table of contents\s*\n([\s\S]*?)\n---/.exec(readme)?.[1];

if (!toc) throw new Error('README.md has no bounded table of contents');

const tocAnchors = new Set(
	[...toc.matchAll(/\]\(#([^)]+)\)/g)].map((match) => decodeURIComponent(match[1]))
);

describe('README table of contents', () => {
	it('links every major section after the table of contents', () => {
		const documentAfterToc = readme.slice(readme.indexOf(toc) + toc.length);
		const majorSections = [...documentAfterToc.matchAll(/^## (?!#)(.+)$/gm)].map((match) => ({
			heading: match[1],
			anchor: slugify(match[1])
		}));

		expect(majorSections.length).toBeGreaterThan(0);
		for (const section of majorSections) {
			expect(tocAnchors, `${section.heading} is missing from the README table of contents`)
				.toContain(section.anchor);
		}
	});

	it.each([
		'Verifying a received webhook (`svelte-adapter-uws/plugins/webhooks`)',
		'Sending a webhook (`deliverWebhook` and the delivery controls)',
		'Authorization model',
		'Smooth (prediction and reconciliation)',
		'CRDT documents (replicas, sync, persistence)',
		'Test harness for WebSocket handlers',
		'Deterministic simulation',
		'Resource-leak harness'
	])('links the public subsection %s', (heading) => {
		expect(tocAnchors).toContain(slugify(heading));
	});
});
