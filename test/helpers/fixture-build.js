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

/**
 * Digests already computed in THIS process, keyed by variant.
 *
 * The digest walks the whole adapter `src` tree plus the fixture's sources and
 * static files and hashes every byte, which is the right freshness key and the
 * wrong thing to repeat. Sources cannot change during a run - a run that edited
 * them mid-flight is already reporting on a tree that no longer exists - so one
 * walk per variant per worker is as correct as one per call and does not scale
 * with how many suites in that worker need the variant.
 *
 * @type {Map<string, string>}
 */
const digestByVariant = new Map();

function sourceDigest(variant) {
	const memo = digestByVariant.get(variant);
	if (memo !== undefined) return memo;
	const digest = computeSourceDigest(variant);
	digestByVariant.set(variant, digest);
	return digest;
}

function computeSourceDigest(variant) {
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

/**
 * Variants this process has already confirmed are on disk at the current source
 * state. A second call in the same worker is then a Set lookup rather than a
 * stat and a read.
 *
 * @type {Set<string>}
 */
const inPlace = new Set();

/**
 * Is a complete build for this variant already on disk at `digest`?
 *
 * Both halves matter: the stamp says WHICH sources produced the output, and
 * `index.js` says the output is actually there - a tree cleared for a rebuild
 * that never finished leaves neither, but a hand-deleted handler leaves the
 * stamp behind.
 *
 * @param {string} outDir @param {string} stampFile @param {string} digest
 */
function stampMatches(outDir, stampFile, digest) {
	try {
		return existsSync(join(fixtureDir, outDir, 'index.js')) && readFileSync(stampFile, 'utf8') === digest;
	} catch {
		return false; // no stamp yet
	}
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
	if (inPlace.has(variant)) return true;
	const digest = sourceDigest(variant);

	// FAST PATH, deliberately OUTSIDE the lock.
	//
	// The lock exists to serialize `vite build`, and the common case does not
	// build: global-setup produces every variant a run needs before any worker
	// starts, so almost every call here is a suite confirming what is already on
	// disk. Taking the lock to confirm it made a read-only check queue behind
	// every other read-only check, and a loser sleeps in 250 ms steps - so with
	// dozens of suites arriving together the confirmation cost was measured in
	// seconds, paid inside whichever test happened to ask first. That is a
	// timing artifact appearing in a suite that has nothing to do with building.
	//
	// The check is safe unlocked because it reads exactly what the locked one
	// reads, and the stamp is the LAST thing a build writes - only after the
	// build exited and a runnable handler was verified. A stamp that matches the
	// current digest therefore means a complete tree. The rebuild that would
	// invalidate it can only start when some process computes a DIFFERENT
	// digest, and every process digests the same unchanging sources, so a
	// matching reader and a rebuilding writer cannot coexist for one variant.
	if (stampMatches(outDir, stampFile, digest)) {
		inPlace.add(variant);
		return true;
	}

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
		// Re-check under the lock: between the fast path above and this line a
		// racer may have finished the very build this call was about to start.
		if (stampMatches(outDir, stampFile, digest)) {
			inPlace.add(variant);
			return true; // another suite already built this exact source state
		}
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
			inPlace.add(variant);
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
