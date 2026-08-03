// Generated build output must never enter the committable set.
//
// Kit's output was ignored by two PATH-SPECIFIC rules, so the moment a third
// fixture app was added it committed 84 build artifacts and the only thing
// standing between that and a release was a reviewer noticing by eye. The
// ignore rule is now about the DIRECTORY rather than the two places that
// happened to exist when it was written, and this is the guard that says so -
// because the next fixture will be added by someone who never read that rule.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

// Exact path SEGMENTS, so `test/fixture/build-grant` (an ignored variant output
// directory) is not confused with a `build` directory, and a source file that
// merely has one of these words in its name is not an offender.
const GENERATED_DIRECTORIES = ['.svelte-kit', 'node_modules', 'build', 'dist', 'coverage'];

function trackedFiles() {
	return execFileSync('git', ['ls-files', '-z'], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	}).split('\0').filter(Boolean);
}

describe('no generated output is tracked', () => {
	const tracked = trackedFiles();

	it('reads a real file list, so an empty result cannot pass vacuously', () => {
		// Without this, a `git ls-files` that failed or returned nothing would
		// make every assertion below pass while checking nothing at all.
		expect(tracked.length).toBeGreaterThan(500);
	});

	for (const directory of GENERATED_DIRECTORIES) {
		it(`no tracked file sits under a ${directory} directory`, () => {
			const offenders = tracked.filter((file) => file.split('/').includes(directory));
			expect(
				offenders,
				`${offenders.length} generated file(s) are committed. Add the directory to ` +
				`.gitignore and untrack them with: git rm -r --cached <path>`
			).toEqual([]);
		});
	}
});
