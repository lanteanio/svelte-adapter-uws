// The commit a simulation corpus or swarm result was produced at.
//
// A seed alone does not reproduce a run: the sim's own contract is that a seed
// PLUS a commit is the whole bug report, which is why the reproducer stamps
// both. A corpus that records `gitCommit: null` keeps the seeds and drops half
// the report, and that is what a local bless produced for as long as the value
// came from an environment variable nobody exports outside CI.
//
// So the environment variable becomes an override rather than a requirement:
// set GIT_COMMIT to record a commit other than the working tree's HEAD (CI
// does this, where the checkout may be detached or synthesised), and otherwise
// the checkout answers for itself.
//
// This file lives under scripts/ on purpose. The determinism seam covers the
// runtime, where reading the clock, the environment or a subprocess would make
// a replay unfaithful; the blessing tools sit outside it by design and are
// documented as free to read both.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

/**
 * Resolve the commit to stamp on a corpus or swarm result.
 *
 * Null when there is no answer - an export-only tarball, a tree with no git, a
 * git that fails - because a recorded null is honest about not knowing, while
 * a guessed or partial value would be worse than the gap it fills.
 *
 * @returns {string | null} a full 40-character SHA, or null
 */
export function resolveGitCommit() {
	const fromEnv = process.env.GIT_COMMIT;
	if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
	try {
		// stderr is discarded: outside a checkout git writes a diagnostic and
		// exits non-zero, and that is an expected answer here, not a failure to
		// report. `execFileSync` without a shell, so nothing here interpolates.
		const out = execFileSync('git', ['rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		const sha = out.trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}
