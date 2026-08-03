// Shared, cross-process-safe fixture build. Several integration suites boot the
// REAL built runtime from test/fixture, and vitest runs test files in separate
// worker processes - two `vite build`s racing in the same directory corrupt
// each other's output (.svelte-kit/ and build/ are shared). This serializes the
// build behind an on-disk lock and reuses a finished build when the sources it
// embeds are unchanged, so N suites cost one build.
//
// Freshness is source-keyed, not time-keyed: the stamp records a digest over
// the relative paths and CONTENTS of the adapter runtime sources, fixture app
// sources, and manifests. Content matters here: absolute paths and mtimes differ
// on every clean CI checkout, so a timestamp-keyed stamp can never validate a
// restored build cache. Any source edit - including a test harness swapping the
// runtime under test - changes the digest and forces a rebuild. (Deliberately
// NOT covered: node_modules contents, so a manually patched dependency without
// a manifest change reuses a build - delete test/fixture/build* to force one.)

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { variantOut } from '../fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('../fixture', import.meta.url));
const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
// ONE lock for the whole fixture, not one per variant: two `vite build`s in the
// same cwd corrupt each other's .svelte-kit/ regardless of where their output
// goes, so variants serialize behind the same lock and only the stamp is
// per-variant.
const lockDir = join(fixtureDir, '.build-lock');

function digestTree(hash, dir, prefix) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	// Sort for a stable digest across platforms/readdir orders.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		// Skip EVERY variant's output dir (build, build-grant, ...), not just the
		// default one - a build output must never feed its own digest.
		if (entry.name === 'node_modules' || entry.name.startsWith('build') || entry.name === '.svelte-kit' || entry.name === '.build-lock') continue;
		const full = join(dir, entry.name);
		const relative = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			digestTree(hash, full, relative);
		} else if (entry.isFile()) {
			hash.update(`file:${relative}\0`);
			hash.update(readFileSync(full));
			hash.update('\0');
		}
	}
}

function digestFile(hash, label, file) {
	hash.update(`file:${label}\0`);
	hash.update(readFileSync(file));
	hash.update('\0');
}

function sourceDigest(variant) {
	const hash = createHash('sha256');
	// The variant name and the table that maps it to an adapter config both
	// change what gets baked into the handler, so both key the digest.
	hash.update(`variant:${variant}\0`);
	digestFile(hash, 'fixture/variants.js', join(fixtureDir, 'variants.js'));
	digestTree(hash, srcDir, 'adapter/src');
	digestTree(hash, join(fixtureDir, 'src'), 'fixture/src');
	digestTree(hash, join(fixtureDir, 'static'), 'fixture/static');
	digestFile(hash, 'fixture/svelte.config.js', join(fixtureDir, 'svelte.config.js'));
	digestFile(hash, 'fixture/vite.config.js', join(fixtureDir, 'vite.config.js'));
	// Manifests, so a dependency bump (uWebSockets.js, @sveltejs/kit) or a
	// fixture dep change invalidates the build too.
	digestFile(hash, 'fixture/package.json', join(fixtureDir, 'package.json'));
	digestFile(hash, 'package.json', fileURLToPath(new URL('../../package.json', import.meta.url)));
	try {
		digestFile(hash, 'fixture/package-lock.json', join(fixtureDir, 'package-lock.json'));
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
 *
 * @param {string} [variant] which build-time adapter configuration to produce
 *   (see test/fixture/variants.js). Each variant has its own output directory
 *   and its own stamp, so variants coexist and do not rebuild over each other.
 */
export function buildFixtureOnce(variant = 'default') {
	const outDir = variantOut(variant);
	const stampFile = join(fixtureDir, outDir, '.build-stamp');
	const digest = sourceDigest(variant);
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
			if (existsSync(join(fixtureDir, outDir, 'index.js')) && readFileSync(stampFile, 'utf8') === digest) {
				return true; // another suite already built this exact source state
			}
		} catch { /* no stamp yet - build below */ }
		// Clear this variant's output BEFORE building. Reaching here means the
		// digest changed, so whatever sits on disk was produced by different
		// sources - and a build that exits 0 without emitting a handler would
		// otherwise leave it there for the suites to boot. That is not
		// hypothetical: an adapter misconfiguration lets adapter-auto succeed
		// while writing no runnable output, and the check meant to catch exactly
		// that passed against the PREVIOUS build. Only this variant's directory
		// goes; each variant owns its own, and the lock serializes them.
		rmSync(join(fixtureDir, outDir), { recursive: true, force: true });
		try {
			execSync('npx vite build', {
				cwd: fixtureDir,
				stdio: 'pipe',
				timeout: 180000,
				env: { ...process.env, FIXTURE_VARIANT: variant }
			});
			// Exit code 0 is not the contract - a runnable handler is. Requiring
			// one here is what turns a no-output build into a failure instead of
			// a silent fall-through onto stale artifacts.
			if (!existsSync(join(fixtureDir, outDir, 'index.js'))) {
				console.error(
					`[fixture-build] variant "${variant}" exited 0 but produced no ` +
					`${outDir}/index.js - the adapter wrote no runnable handler. Check that ` +
					'the fixture config still selects this adapter for this variant.'
				);
				return false;
			}
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
		} catch (err) {
			// Surface what Vite actually said. `stdio: 'pipe'` keeps a passing
			// build quiet, but swallowing the failure too left callers with only
			// `fixture variant "x" failed to build` and nothing to act on - which
			// is the entire diagnostic on a CI runner, where nobody can re-run it
			// by hand.
			const out = [err?.stdout, err?.stderr]
				.map((buf) => (buf ? buf.toString() : ''))
				.filter(Boolean)
				.join('\n')
				.trim();
			console.error(
				`[fixture-build] variant "${variant}" failed to build` +
				(out ? `:\n${out}` : ` (no output; ${err?.message || 'unknown error'})`)
			);
			return false;
		}
	} finally {
		try { rmdirSync(lockDir); } catch { /* already reclaimed */ }
	}
}
