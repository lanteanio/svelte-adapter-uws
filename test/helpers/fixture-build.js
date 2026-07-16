// Shared, cross-process-safe fixture build. Several integration suites boot the
// REAL built runtime from test/fixture, and vitest runs test files in separate
// worker processes - two `vite build`s racing in the same directory corrupt
// each other's output (.svelte-kit/ and build/ are shared). This serializes the
// build behind an on-disk lock and reuses a finished build when the sources it
// embeds are unchanged, so N suites cost one build.
//
// Freshness is source-keyed, not time-keyed: the stamp records a digest over
// the adapter runtime sources, the fixture app sources, and both manifests
// (path + mtime + size of every file). Any source edit - including a test
// harness swapping the runtime under test - changes the digest and forces a
// rebuild. (Deliberately NOT covered: node_modules contents, so a manually
// patched dependency without a manifest change reuses a build - delete
// test/fixture/build to force one.)

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const fixtureDir = fileURLToPath(new URL('../fixture', import.meta.url));
const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
const lockDir = join(fixtureDir, '.build-lock');
const stampFile = join(fixtureDir, 'build', '.build-stamp');

function digestTree(hash, dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	// Sort for a stable digest across platforms/readdir orders.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.svelte-kit' || entry.name === '.build-lock') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			digestTree(hash, full);
		} else if (entry.isFile()) {
			const s = statSync(full);
			hash.update(full);
			hash.update(String(s.mtimeMs));
			hash.update(String(s.size));
		}
	}
}

function sourceDigest() {
	const hash = createHash('sha256');
	digestTree(hash, srcDir);
	digestTree(hash, join(fixtureDir, 'src'));
	digestTree(hash, join(fixtureDir, 'static'));
	hash.update(readFileSync(join(fixtureDir, 'svelte.config.js'), 'utf8'));
	hash.update(readFileSync(join(fixtureDir, 'vite.config.js'), 'utf8'));
	// Manifests, so a dependency bump (uWebSockets.js, @sveltejs/kit) or a
	// fixture dep change invalidates the build too.
	hash.update(readFileSync(join(fixtureDir, 'package.json'), 'utf8'));
	hash.update(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
	try {
		hash.update(readFileSync(join(fixtureDir, 'package-lock.json'), 'utf8'));
	} catch { /* no lockfile - the manifests still key the digest */ }
	return hash.digest('hex');
}

const sleepSync = (ms) => {
	const buf = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buf, 0, 0, ms);
};

/**
 * Build the fixture exactly once per source state, safely across concurrent
 * vitest worker processes. Returns true when a matching build is in place
 * (fresh or just built), false when the build itself failed. Throws only on a
 * lock that never frees (a crashed holder after the stale window is reclaimed,
 * so this is effectively unreachable).
 */
export function buildFixtureOnce() {
	const digest = sourceDigest();
	const deadline = Date.now() + 300000;
	// Acquire: mkdir is atomic across processes. A holder that died without
	// unlocking is reclaimed after the stale window - 240s against the build's
	// own 180s execSync timeout, so a LIVE holder cannot be reclaimed on a
	// healthy machine. Residual (accepted): across a suspend/resume the holder's
	// parent-side timers pause with the machine, so a racer whose clock kept
	// running can reclaim a live lock and two builds briefly overlap; the
	// lock-integrity check before stamping (below) keeps a possibly-torn tree
	// from being stamped as valid in that case.
	for (;;) {
		try {
			mkdirSync(lockDir);
			break;
		} catch {
			try {
				if (Date.now() - statSync(lockDir).mtimeMs > 240000) {
					rmdirSync(lockDir);
					continue;
				}
			} catch { /* freed between the check and the stat - retry */ }
			if (Date.now() > deadline) throw new Error('fixture build lock never freed');
			sleepSync(250);
		}
	}
	const acquiredAt = Date.now();
	try {
		try {
			if (existsSync(join(fixtureDir, 'build', 'index.js')) && readFileSync(stampFile, 'utf8') === digest) {
				return true; // another suite already built this exact source state
			}
		} catch { /* no stamp yet - build below */ }
		try {
			execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe', timeout: 180000 });
			// Stamp only when OUR lock survived the whole build: a missing lock dir,
			// or one whose mtime moved past our acquire, means a racer reclaimed it
			// mid-build (the suspend/resume residual above) and another build may
			// have interleaved with ours - leave the tree unstamped so the next
			// caller rebuilds cleanly instead of trusting a possibly-torn output.
			let lockIntact = false;
			try {
				lockIntact = statSync(lockDir).mtimeMs <= acquiredAt + 5000;
			} catch { /* lock gone - reclaimed */ }
			if (lockIntact) writeFileSync(stampFile, digest);
			return true;
		} catch {
			return false;
		}
	} finally {
		try { rmdirSync(lockDir); } catch { /* already reclaimed */ }
	}
}
