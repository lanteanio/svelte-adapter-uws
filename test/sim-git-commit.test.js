// The sim's bug-report contract is a seed PLUS the commit it ran against; a
// corpus that records `gitCommit: null` keeps the seeds and drops half of it.
// Nothing gates on the field - `checkSimGoldens` never reads it, and the
// cross-adapter comparison is per-seed fingerprints only - so without a case
// here the regression is invisible: a bless from a shell that happens not to
// export GIT_COMMIT silently writes null again and every other gate stays green.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveGitCommit } from '../scripts/sim-git-commit.js';

const CORPORA = [
	'test/dst-goldens/adapter-single.golden.json',
	'test/dst-goldens/adapter-cluster.golden.json'
];

describe('sim corpora record the commit they were blessed at', () => {
	for (const path of CORPORA) {
		it(`${path} carries a resolvable commit, not null`, () => {
			const corpus = JSON.parse(readFileSync(path, 'utf8'));
			expect(
				corpus.gitCommit,
				'a corpus blessed without a commit keeps the seeds and drops half the bug report'
			).toMatch(/^[0-9a-f]{40}$/);
		});
	}
});

describe('resolveGitCommit', () => {
	it('prefers an explicit GIT_COMMIT, so CI can pin a revision the checkout does not have', () => {
		const previous = process.env.GIT_COMMIT;
		process.env.GIT_COMMIT = 'deadbeef';
		try {
			expect(resolveGitCommit()).toBe('deadbeef');
		} finally {
			if (previous === undefined) delete process.env.GIT_COMMIT;
			else process.env.GIT_COMMIT = previous;
		}
	});

	it('falls back to the checkout HEAD, which is what makes a local bless traceable', () => {
		const previous = process.env.GIT_COMMIT;
		delete process.env.GIT_COMMIT;
		try {
			const resolved = resolveGitCommit();
			// Compared against git read independently, not against the same call:
			// an assertion that only checked the SHAPE would pass on any 40 hex
			// characters, including a stale or wrong commit.
			const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
			expect(resolved).toBe(head);
		} finally {
			if (previous !== undefined) process.env.GIT_COMMIT = previous;
		}
	});

	it('treats a blank GIT_COMMIT as unset rather than recording an empty string', () => {
		const previous = process.env.GIT_COMMIT;
		process.env.GIT_COMMIT = '   ';
		try {
			expect(resolveGitCommit()).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			if (previous === undefined) delete process.env.GIT_COMMIT;
			else process.env.GIT_COMMIT = previous;
		}
	});
});
