import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Drives `node scripts/check-release-notes.js` itself, in a private copy of the
// files it reads, so the release-page directory can be put into states the real
// tree must never be in. The script resolves everything from its own location.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHANGELOG = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const [CURRENT, EARLIER] = [...CHANGELOG.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/gm)]
	.slice(0, 2)
	.map((match) => match[1] + '.md');
// Each run imports markdown-it and parses the whole changelog, and a case runs
// the script up to four times.
const RUN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 180_000;

let tree;
let releases;
let link;

beforeAll(() => {
	// The real path: the script runs main() only when its own URL equals the
	// path it was started with, which a symlinked temp directory would break.
	tree = realpathSync(mkdtempSync(join(tmpdir(), 'release-pages-cli-')));
	releases = join(tree, 'docs', 'releases');
	mkdirSync(join(tree, 'scripts'));
	mkdirSync(releases, { recursive: true });
	for (const file of ['scripts/check-release-notes.js', 'scripts/check-links.js', 'CHANGELOG.md', 'package.json', 'README.md', 'MIGRATION.md']) {
		copyFileSync(join(REPO, file), join(tree, file));
	}
	copyFileSync(join(REPO, 'docs', 'releases', CURRENT), join(releases, CURRENT));
	const target = join(tree, 'node_modules');
	symlinkSync(join(REPO, 'node_modules'), target, process.platform === 'win32' ? 'junction' : 'dir');
	link = target;
});

afterAll(() => {
	// Remove the link itself first, so deleting the tree can never walk into the
	// repository's node_modules. If the link cannot be removed, the tree stays.
	if (link) {
		try { rmdirSync(link); } catch { unlinkSync(link); }
	}
	if (tree) rmSync(tree, { recursive: true, force: true });
});

function run(...args) {
	const result = spawnSync(process.execPath, [join(tree, 'scripts', 'check-release-notes.js'), ...args], {
		encoding: 'utf8',
		timeout: RUN_TIMEOUT_MS
	});
	return { status: result.status, out: result.stdout + result.stderr };
}

describe('check-release-notes release directory', () => {
	it('passes when the directory holds only the current page', () => {
		const { status, out } = run();
		expect(out).toMatch(/; 1 release page\(s\) pin /);
		expect(status).toBe(0);
	}, CASE_TIMEOUT_MS);

	it('refuses an earlier release page and removes it on --write', () => {
		writeFileSync(join(releases, EARLIER), 'page');
		const refused = run();
		expect(refused.status).toBe(1);
		expect(refused.out).toContain('earlier release page(s) ' + EARLIER);

		const written = run('--write');
		expect(written.out).toContain('removed docs/releases/' + EARLIER);
		expect(written.status).toBe(0);
		expect(existsSync(join(releases, EARLIER))).toBe(false);
		expect(existsSync(join(releases, CURRENT))).toBe(true);
		expect(run().status).toBe(0);
	}, CASE_TIMEOUT_MS);

	it('refuses an entry that is not a release page file and never deletes it', () => {
		for (const [name, make] of [
			['notes.txt', (path) => writeFileSync(path, 'notes')],
			[EARLIER, (path) => mkdirSync(path)]
		]) {
			const path = join(releases, name);
			make(path);
			try {
				for (const args of [[], ['--write']]) {
					const { status, out } = run(...args);
					expect(out, name).toContain('docs/releases holds ' + name + ', which is not a release page');
					expect(status, name).toBe(1);
					expect(existsSync(path), name).toBe(true);
				}
			} finally {
				rmSync(path, { recursive: true, force: true });
			}
		}
	}, CASE_TIMEOUT_MS);

	it('ignores .DS_Store, which npm never packs', () => {
		const litter = join(releases, '.DS_Store');
		writeFileSync(litter, 'finder');
		try {
			for (const args of [[], ['--write']]) {
				const { status, out } = run(...args);
				expect(out).toMatch(/; 1 release page\(s\) pin /);
				expect(status).toBe(0);
				expect(existsSync(litter)).toBe(true);
			}
		} finally {
			rmSync(litter, { force: true });
		}
	}, CASE_TIMEOUT_MS);

	it('refuses a page that names no dated release and never deletes it', () => {
		const draft = join(releases, '9.9.9.md');
		writeFileSync(draft, 'draft');
		try {
			for (const args of [[], ['--write']]) {
				const { status, out } = run(...args);
				expect(out).toContain('does not match any dated CHANGELOG release');
				expect(status).toBe(1);
				expect(existsSync(draft)).toBe(true);
			}
		} finally {
			rmSync(draft, { force: true });
		}
	}, CASE_TIMEOUT_MS);
});
