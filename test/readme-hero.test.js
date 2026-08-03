import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const lines = readme.split(/\r?\n/);

describe('README outcome-first hero', () => {
	it('leads with the product outcome before feature detail or project history', () => {
		const firstContent = lines.filter(Boolean).slice(0, 3);

		expect(firstContent[0]).toBe('# svelte-adapter-uws');
		expect(firstContent[1]).toMatch(
			/^Run SvelteKit HTTP and realtime workloads on uWebSockets\.js with native TLS, built-in pub\/sub, and a reactive Svelte client\.$/
		);
		expect(firstContent[2]).toBe(
			'[Install the adapter](#installation) | [Serve your first HTTP route](#quick-start-http) | [Add realtime](#quick-start-websocket)'
		);
	});

	it('offers exactly three immediate, resolvable first-success actions', () => {
		const heroActions = lines.find((line) => line.startsWith('[Install the adapter]'));
		const links = [...heroActions.matchAll(/\[[^\]]+\]\((#[^)]+)\)/g)].map((match) => match[1]);
		const headings = new Set(
			lines
				.filter((line) => /^#{2,6} /.test(line))
				.map((line) =>
					`#${line
						.replace(/^#{2,6} /, '')
						.toLowerCase()
						.replace(/[^a-z0-9\s-]/g, '')
						.trim()
						.replace(/\s+/g, '-')}`
				)
		);

		expect(links).toEqual(['#installation', '#quick-start-http', '#quick-start-websocket']);
		for (const link of links) expect(headings).toContain(link);
	});

	it('keeps the origin story once, under a later explicit section', () => {
		const storyStart = "I've been loving Svelte and SvelteKit for a long time.";
		const storyMatches = readme.split(storyStart).length - 1;
		const storyIndex = readme.indexOf(storyStart);
		const sectionIndex = readme.indexOf('## Why this project exists');
		const quickStartIndex = readme.indexOf('## Quick start: HTTP');

		expect(storyMatches).toBe(1);
		expect(sectionIndex).toBeGreaterThan(quickStartIndex);
		expect(storyIndex).toBeGreaterThan(sectionIndex);
		expect(readme.slice(0, readme.indexOf('## What you get'))).not.toMatch(/\b(?:I|I've|my|myself)\b/);
	});
});
