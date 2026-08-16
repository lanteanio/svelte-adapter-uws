// The root carries only files a tool or platform reads from the root. Everything
// else is a contract, and contracts live under docs/ so the root cannot collect
// them by default. Six root documents appeared in one batch before this guard
// existed; the canonicality decision now states the rule and this proves it.

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// README, CHANGELOG, CONTRIBUTING and SECURITY are read from the root by npm and
// GitHub. MIGRATION, PROTOCOL, and ROADMAP are the package contracts a
// consumer is told to open by name.
const ALLOWED_ROOT_MARKDOWN = [
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'MIGRATION.md',
	'PROTOCOL.md',
	'README.md',
	'ROADMAP.md',
	'SECURITY.md'
];

describe('root document placement', () => {
	it('keeps every other contract under docs/', () => {
		const found = readdirSync(ROOT, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name)
			.sort();
		expect(
			found,
			'a new root .md means a contract landed in the root. Put it under docs/ in ' +
			'lowercase kebab-case, or add it here with the convention that reads it from the root. ' +
			'See docs/decisions/documentation-canonicality.md.'
		).toEqual(ALLOWED_ROOT_MARKDOWN);
	});

	it('names every docs page in lowercase kebab-case', () => {
		const offenders = [];
		const walk = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const absolute = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					walk(absolute);
					continue;
				}
				if (!entry.name.endsWith('.md')) continue;
				// A directory index is conventionally uppercase.
				if (entry.name === 'README.md') continue;
				if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.md$/.test(entry.name)) {
					offenders.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
				}
			}
		};
		walk(path.join(ROOT, 'docs'));
		expect(offenders, 'docs pages are lowercase kebab-case; directory indexes are README.md').toEqual([]);
	});
});
