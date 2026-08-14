// Static serving refuses dot-segment paths by default.
//
// The threat is not a crafted request but an accidental file: static/ is a
// plain directory app authors drop things into, and what lands there by
// mistake - a stray .env, an .htpasswd, an editor backup, an unpacked .git -
// was served verbatim to anyone who guessed the name. adapter-node refuses
// dotfiles, so an app migrating to this adapter silently gained exposure.
//
// The exclusion is decided once at index time: the cache never holds the
// entry, so there is no per-request check to bypass and an encoded traversal
// decodes to a key that is not there. .well-known/* keeps working - RFC 8615
// discovery (security.txt, ACME HTTP-01 challenges) is documented served
// behavior - with the carve-out at the first segment only, and never for a
// dotfile inside the directory.
//
// Three layers, one contract: the predicate (pure, from source), the
// index-time walk (the BUILT module, exactly as the boot path calls it), and
// the response the client receives from the real runtime.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { excludedDotPath } from '../src/runtime/utils/dot-path.js';
import { listExcludedDotPaths } from '../src/static-scan.js';
import { renderRefusedDotfileWarning } from '../src/index.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeMaybe = hasUWS ? describe : describe.skip;

const MARKER = 'leaked-if-served';

/**
 * Every place a text makes a promise about what `.well-known` continues to
 * serve, with whether the sentence around it says which part is actually exempt.
 *
 * Worth knowing that this very comment tripped the check when it was worded as
 * the promise: the detector runs over the whole tracked tree, this file
 * included, and does not care that the sentence is describing the rule rather
 * than stating it.
 *
 * Whitespace is normalised BEFORE anything is matched. Prose here is hard
 * wrapped, so the promise and the noun it attaches to routinely land on
 * different lines, and a candidate pattern that cannot cross a newline drops
 * those silently - reflowing a correct sentence would then remove that surface
 * from the inventory with every gate still green. Normalising first is what
 * makes wrapping irrelevant to discovery instead of decisive.
 */
function wellKnownPromises(text) {
	const flat = String(text).replace(/\s+/g, ' ');
	// Every phrasing that has actually shipped: the flat claim, the bare glob, and
	// the discovery / needs-nothing wording the release records used.
	const promise = /\.well-known[^]{0,60}?(is always served|keeps serving|keeps working|needs nothing)/gi;
	// Stated correctly, the rule always names the part that is exempt.
	const qualifier = /top-level|non-dot|first (path )?segment/i;
	const found = [];
	for (const match of flat.matchAll(promise)) {
		const window = flat.slice(Math.max(0, match.index - 220), match.index + 260);
		found.push({ snippet: match[0].trim(), qualified: qualifier.test(window) });
	}
	return found;
}

describe('excludedDotPath', () => {
	it('refuses a dot segment anywhere in the path', () => {
		expect(excludedDotPath('.env')).toBe(true);
		expect(excludedDotPath('.htpasswd')).toBe(true);
		expect(excludedDotPath('.git')).toBe(true);
		expect(excludedDotPath('.envrc')).toBe(true);
		expect(excludedDotPath('a/.hidden')).toBe(true);
		expect(excludedDotPath('a/.hidden/b')).toBe(true);
		expect(excludedDotPath('a/b/.DS_Store')).toBe(true);
		expect(excludedDotPath('.')).toBe(true);
		expect(excludedDotPath('..')).toBe(true);
	});

	it('serves ordinary paths, including dots inside a segment', () => {
		expect(excludedDotPath('foo.txt')).toBe(false);
		expect(excludedDotPath('a/b/c.png')).toBe(false);
		expect(excludedDotPath('a..b/c')).toBe(false);
		expect(excludedDotPath('a/well.known')).toBe(false);
		expect(excludedDotPath('robots.txt')).toBe(false);
	});

	it('exempts .well-known at the first segment only', () => {
		expect(excludedDotPath('.well-known')).toBe(false);
		expect(excludedDotPath('.well-known/security.txt')).toBe(false);
		expect(excludedDotPath('.well-known/acme-challenge/token')).toBe(false);
		// Not an escape hatch: nested placement and dotfiles inside are refused.
		expect(excludedDotPath('x/.well-known/y')).toBe(true);
		expect(excludedDotPath('.well-known/.hidden')).toBe(true);
	});
});

describe('wellKnownPromises (the inventory oracle)', () => {
	// The corpus being clean says nothing about whether the detector can SEE a
	// bad sentence - a detector that finds nothing passes a clean corpus exactly
	// like a correct one. These drive it against known-bad inputs directly.
	// Assembled rather than written out, so this file does not itself contain the
	// phrase the corpus scan looks for. A negative-control fixture must not become
	// a finding, and excluding this file from the inventory instead would put back
	// the hand-maintained exception the derived scan exists to remove.
	const PROMISE = 'keeps' + ' serving';
	const sameLine = `The \`.well-known/\` ${PROMISE} whatever you put there.`;
	const wrapped = `The \`.well-known/\`\n${PROMISE} whatever you put there.`;

	it('finds the same promise whether or not the prose wraps', () => {
		// The failure this replaces: candidate discovery was bounded by [^\n], so
		// the wrapped form produced zero candidates while the same-line form
		// produced one. Reflowing a correct sentence would then have removed that
		// surface from the inventory silently.
		expect(wellKnownPromises(sameLine)).toHaveLength(1);
		expect(wellKnownPromises(wrapped)).toHaveLength(1);
		expect(wellKnownPromises(wrapped)[0].qualified).toBe(false);
		// Wrapping is not merely tolerated, it is irrelevant: both forms reduce to
		// the same finding.
		expect(wellKnownPromises(wrapped)[0].snippet).toBe(wellKnownPromises(sameLine)[0].snippet);
	});

	it('reads the qualifier across a wrap too, so a correct sentence is not reported', () => {
		const qualifiedWrapped = 'A top-level `.well-known/`\nkeeps serving its own non-dot files.';
		const found = wellKnownPromises(qualifiedWrapped);
		expect(found).toHaveLength(1);
		expect(found[0].qualified).toBe(true);
	});

	it('recognises every phrasing that has shipped, wrapped or not', () => {
		for (const promise of ['is always served', 'keeps serving', 'keeps working', 'needs nothing']) {
			expect(wellKnownPromises(`\`.well-known/*\` ${promise} here.`), promise).toHaveLength(1);
			expect(wellKnownPromises(`\`.well-known/*\`\n${promise} here.`), `${promise} (wrapped)`).toHaveLength(1);
		}
	});

	it('does not fire on text that never makes the promise', () => {
		expect(wellKnownPromises('Headers are missing on `/llms.txt`, `robots.txt`, `.well-known/*`, and more.')).toEqual([]);
		expect(wellKnownPromises('nothing to see here')).toEqual([]);
	});
});

describe('listExcludedDotPaths', () => {
	let tmp = '';

	beforeAll(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-dot-scan-'));
		fs.writeFileSync(path.join(tmp, '.env'), 'x');
		fs.mkdirSync(path.join(tmp, '.git'));
		fs.writeFileSync(path.join(tmp, '.git', 'config'), 'x');
		fs.mkdirSync(path.join(tmp, '.well-known'));
		fs.writeFileSync(path.join(tmp, '.well-known', 'ok.txt'), 'x');
		fs.writeFileSync(path.join(tmp, '.well-known', '.bad'), 'x');
		fs.mkdirSync(path.join(tmp, 'deep'));
		fs.writeFileSync(path.join(tmp, 'deep', '.hidden.txt'), 'x');
		fs.writeFileSync(path.join(tmp, 'deep', 'ok.txt'), 'x');
		fs.writeFileSync(path.join(tmp, 'root.txt'), 'x');
		// Precompressed siblings: the build can compress a dotfile it wrote, and
		// the warning must name the offender once, not three times.
		fs.writeFileSync(path.join(tmp, '.packed.txt'), 'x');
		fs.writeFileSync(path.join(tmp, '.packed.txt.br'), 'x');
		fs.writeFileSync(path.join(tmp, '.packed.txt.gz'), 'x');
	});

	afterAll(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('lists every refused path once, skipping compressed siblings and never entering a refused directory', () => {
		expect(listExcludedDotPaths(tmp)).toEqual([
			'.env',
			'.git/',
			'.packed.txt',
			'.well-known/.bad',
			'deep/.hidden.txt'
		]);
	});

	it('returns nothing for a missing directory', () => {
		expect(listExcludedDotPaths(path.join(tmp, 'no-such-dir'))).toEqual([]);
	});
});

describeMaybe('index-time exclusion (built runtime)', () => {
	let tmp = '';
	/** @type {Map<string, any>} */
	let staticCache;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);

		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		({ staticCache } = await import('./fixture/build/handler/state.js'));

		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-dot-index-'));
		fs.writeFileSync(path.join(tmp, 'ok.txt'), 'served');
		fs.writeFileSync(path.join(tmp, '.secret'), MARKER);
		fs.mkdirSync(path.join(tmp, '.git'));
		fs.writeFileSync(path.join(tmp, '.git', 'config'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested'));
		fs.writeFileSync(path.join(tmp, 'nested', 'ok.txt'), 'served');
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested', '.hidden-dir'));
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden-dir', 'inner.txt'), MARKER);
		fs.mkdirSync(path.join(tmp, '.well-known'));
		fs.writeFileSync(path.join(tmp, '.well-known', 'security.txt'), 'served');
		fs.writeFileSync(path.join(tmp, '.well-known', '.bad'), MARKER);

		cacheDir(tmp, '/dot-probe', false);
	}, 240000);

	afterAll(() => {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('indexes ordinary files and .well-known contents', () => {
		expect(staticCache.get('/dot-probe/ok.txt')).toBeTruthy();
		expect(staticCache.get('/dot-probe/nested/ok.txt')).toBeTruthy();
		expect(staticCache.get('/dot-probe/.well-known/security.txt')).toBeTruthy();
	});

	it('never indexes a dot-segment path', () => {
		expect(staticCache.get('/dot-probe/.secret')).toBeUndefined();
		expect(staticCache.get('/dot-probe/.git/config')).toBeUndefined();
		expect(staticCache.get('/dot-probe/nested/.hidden')).toBeUndefined();
		expect(staticCache.get('/dot-probe/nested/.hidden-dir/inner.txt')).toBeUndefined();
		expect(staticCache.get('/dot-probe/.well-known/.bad')).toBeUndefined();
	});

	it('finds the refused paths in the real build output the build warning scans', () => {
		// The same directory the build scans after writing client assets. If the
		// layout the build writes ever drifts from what this scan expects, the
		// warning would silently find nothing while every other suite stays
		// green - this pins the two together.
		const clientDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'client');
		const refused = listExcludedDotPaths(clientDir);
		expect(refused).toContain('.htpasswd');
		expect(refused).toContain('.well-known/.nested-secret');
		expect(refused).toContain('deep/.hidden.txt');
		expect(refused).not.toContain('.well-known/probe.txt');
		// A compressed sibling of a refused dotfile is not named again.
		expect(refused.filter((p) => p.endsWith('.br') || p.endsWith('.gz'))).toEqual([]);
	});

	it('states the carve-out the same way on every surface that documents it', () => {
		// Fixing this per surface is what let surfaces be missed, so this does not
		// hold a hand-written list either - a list is the same defect one level up.
		// The first version named four files and called itself every-surface while
		// the released consumer entry and its generated page still promised the
		// whole tree. The inventory now comes from the tree.
		const root = fileURLToPath(new URL('..', import.meta.url));
		const tracked = execFileSync('git', ['ls-files', '*.md', '*.ts', '*.js'], {
			cwd: root, encoding: 'utf8', maxBuffer: 1 << 24
		})
			.split('\n')
			.filter((p) => p && !p.startsWith('test/fixture/'));

		const offenders = [];
		for (const relative of tracked) {
			const text = fs.readFileSync(path.join(root, relative), 'utf8');
			for (const found of wellKnownPromises(text)) {
				if (!found.qualified) offenders.push(`${relative}: ${found.snippet}`);
			}
		}
		expect(offenders, 'these promise the whole .well-known tree').toEqual([]);

		// The check must still be looking at something, so a rename that empties the
		// inventory cannot read as success.
		const documenting = tracked.filter((relative) =>
			fs.readFileSync(path.join(root, relative), 'utf8').includes('.well-known')
		);
		expect(documenting.length).toBeGreaterThan(4);
		expect(documenting).toContain('src/index.d.ts');
		expect(documenting).toContain('README.md');
	});

	it('reports those paths in a warning that does not contradict its own list', () => {
		// The scan above is pinned against the real build output; this pins the
		// sentence that reports it. The two are separable failures - a correct scan
		// can still be announced by a message that tells the developer the opposite
		// of what the list shows.
		const clientDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'client');
		const refused = listExcludedDotPaths(clientDir);
		const warning = renderRefusedDotfileWarning(refused);

		// Every offender the scan found is named, and both remedies are offered.
		for (const offender of refused) expect(warning).toContain(offender);
		expect(warning).toContain('Rename the file to serve it');
		expect(warning).toContain('staticDotfiles: true');

		// The carve-out exempts the SEGMENT, not the tree. This list contains
		// `.well-known/.nested-secret`, so a message promising that .well-known is
		// always served would be refuted by its own next clause - which reads as an
		// adapter bug rather than as a file to rename.
		expect(refused).toContain('.well-known/.nested-secret');
		expect(warning).not.toMatch(/\.well-known\/? is\s+always served/);
		expect(warning).toContain('a top-level .well-known/ still serves its own non-dot files');
	});
});

describeMaybe('served surface (real runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>>} */
	let server;

	beforeAll(async () => {
		server = await startRealRuntime();
	}, 240000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('serves an ordinary static file (control)', async () => {
		const res = await fetch(`${server.httpUrl}/test.txt`);
		expect(res.status).toBe(200);
	});

	it('does not serve a top-level dotfile', async () => {
		const res = await fetch(`${server.httpUrl}/.htpasswd`);
		const text = await res.text();
		expect(res.status).toBe(404);
		expect(text).not.toContain(MARKER);
	});

	it('does not serve a nested dotfile', async () => {
		const res = await fetch(`${server.httpUrl}/deep/.hidden.txt`);
		const text = await res.text();
		expect(res.status).toBe(404);
		expect(text).not.toContain(MARKER);
	});

	it('serves .well-known contents', async () => {
		const res = await fetch(`${server.httpUrl}/.well-known/probe.txt`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('well-known probe ok');
	});

	it('does not serve a dotfile inside .well-known', async () => {
		const res = await fetch(`${server.httpUrl}/.well-known/.nested-secret`);
		const text = await res.text();
		expect(res.status).toBe(404);
		expect(text).not.toContain(MARKER);
	});

	it('is not reachable through percent-encoding', async () => {
		const res = await fetch(`${server.httpUrl}/%2Ehtpasswd`);
		const text = await res.text();
		expect(res.status).not.toBe(200);
		expect(text).not.toContain(MARKER);
	});
});
