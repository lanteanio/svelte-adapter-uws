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
import { fileURLToPath } from 'node:url';
import { excludedDotPath } from '../src/runtime/utils/dot-path.js';
import { listExcludedDotPaths } from '../src/static-scan.js';
import { renderRefusedDotfileWarning } from '../src/index.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeMaybe = hasUWS ? describe : describe.skip;

const MARKER = 'leaked-if-served';

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
		// Three surfaces describe this rule: the build warning, the README, and the
		// PUBLIC DECLARATION an IDE shows on hover. Correcting the first two left
		// the third still promising `.well-known/*` is always served and then
		// refusing a dotfile inside it a few lines later - the same contradiction,
		// on the copy a consumer is most likely to read. A per-surface fix is what
		// let that happen, so the rule is checked across all of them at once.
		const root = fileURLToPath(new URL('..', import.meta.url));
		const surfaces = [
			'src/index.d.ts',
			'README.md',
			'src/index.js',
			'docs/migrations/0.5-to-0.6.md'
		];
		// Both forms of the same overpromise: the flat claim, and the `/*` glob
		// that says the whole tree keeps serving when only the segment is exempt.
		const retracts = /\.well-known\/\*?`? (is\s+always served|keeps serving)(?! its own non-dot)|except\s+`?\.well-known\/\*/;
		for (const relative of surfaces) {
			const text = fs.readFileSync(path.join(root, relative), 'utf8');
			expect(text, `${relative} promises more than the carve-out delivers`).not.toMatch(retracts);
			// And each one still has to describe the carve-out, so the check cannot
			// be satisfied by deleting the explanation.
			expect(text, `${relative} should still document the carve-out`).toMatch(/\.well-known/);
		}
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
