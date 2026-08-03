import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorsOf } from '../scripts/check-links.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const index = read('MIGRATION.md');
const oldGuide = read('docs/migrations/0.4-to-0.5.md');
const currentGuide = read('docs/migrations/0.5-to-0.6.md');
const ecosystem = read('docs/migrations/ecosystem-0.5-to-0.6.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

describe('versioned migration lifecycle', () => {
	it('keeps the generic URL as an index with explicit active and archive state', () => {
		expect(index).toMatch(/^# Migration index$/m);
		// Collapse column-alignment padding: the assertion is about the cell
		// CONTENT, and a byte-exact single-space expectation forbids the
		// ordinary aligned-table form of the same fact.
		const collapsed = index.replace(/ +\|/g, ' |');
		expect(collapsed).toContain('| 0.5.x | 0.6.x | Active prerelease transition |');
		expect(collapsed).toContain('| 0.4.x | 0.5.x | Archived; factual and link corrections only |');
		expect(index).toContain('./docs/migrations/0.5-to-0.6.md');
		expect(index).toContain('./docs/migrations/0.4-to-0.5.md');
		expect(index).toContain('./docs/migrations/ecosystem-0.5-to-0.6.md');
	});

	it('preserves the old guide and gives the current transition its own address', () => {
		expect(oldGuide).toMatch(/^# Migration guide: svelte-adapter-uws 0\.4\.x to 0\.5\.x$/m);
		expect(oldGuide).toContain('**Archive state:** complete');
		expect(oldGuide).toContain('## Critical (read first)');
		expect(oldGuide).toContain('## After upgrading');
		expect(currentGuide).toMatch(/^# Migration guide: svelte-adapter-uws 0\.5\.x to 0\.6\.x$/m);
		expect(currentGuide).toContain('**Lifecycle:** active prerelease transition');
		expect(currentGuide).toContain('Multi-worker publishes need one sequence authority');
		expect(currentGuide).toContain('Presence and cursor projection now fail closed');
		for (const heading of [
			'## Prerequisites and supported tuples',
			'## Required source edits',
			'## Default changes',
			'## Wire and storage compatibility',
			'## Promotion and rollback'
		]) expect(currentGuide).toContain(heading);
		expect(currentGuide).toContain('No existing adapter package subpath was renamed for 0.6');
		expect(currentGuide).toContain('npm test -- test/migration-rehearsal.test.js');
		const legacyAnchors = anchorsOf(oldGuide);
		const indexAnchors = anchorsOf(index);
		for (const anchor of legacyAnchors) {
			expect(indexAnchors.has(anchor), `missing legacy #${anchor}`).toBe(true);
			expect(index).toContain(`./docs/migrations/0.4-to-0.5.md#${anchor}`);
		}
	});

	it('publishes one dependency-ordered ecosystem route with canonical sibling links', () => {
		const adapter = ecosystem.indexOf('1. **svelte-adapter-uws**');
		const extensions = ecosystem.indexOf('2. **svelte-adapter-uws-extensions**');
		const realtime = ecosystem.indexOf('3. **svelte-realtime**');
		expect(adapter).toBeGreaterThan(0);
		expect(adapter).toBeLessThan(extensions);
		expect(extensions).toBeLessThan(realtime);
		expect(ecosystem).toContain('svelte-adapter-uws-extensions/blob/main/MIGRATION.md');
		expect(ecosystem).toContain('svelte-realtime/blob/main/MIGRATION.md');
		expect(ecosystem).toContain('## Prerequisites and evidence at each rung');
		expect(ecosystem).toContain('## Rollback order');
		expect(ecosystem).toContain('realtime application,\nextensions, adapter and its matching native addon');
	});

	it('links the lifecycle from the README and packages every permanent route', () => {
		for (const target of [
			'./MIGRATION.md',
			'./docs/migrations/0.4-to-0.5.md',
			'./docs/migrations/0.5-to-0.6.md',
			'./docs/migrations/ecosystem-0.5-to-0.6.md'
		]) expect(readme).toContain(target);
		expect(pkg.files).toContain('MIGRATION.md');
		expect(pkg.files).toContain('docs');
	});
});
