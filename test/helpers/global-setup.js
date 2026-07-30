// Build the fixture variants a run will actually use, ONCE, before any test
// file starts.
//
// Several suites boot the real built runtime, and each called `buildFixtureOnce`
// itself. That is correct - the on-disk lock makes it safe across vitest's
// worker processes - but it is not FAST or quiet: with several variants and
// workers starting together, N processes arrive at one lock at once, every loser
// sleep-polls for the duration of somebody else's `vite build`, and a suite
// whose own timer is running while it waits can trip on a slow machine. Two
// files failed that way in a full parallel run and passed in isolation, which is
// the worst shape a test failure can have - it reads as a real defect.
//
// Doing the builds here removes the contention entirely rather than tuning
// around it: by the time any suite calls `buildFixtureOnce`, the stamp matches
// and the call is a digest check. Suites keep their own call, so running a single
// file directly still works.
//
// SCOPED TO THE RUN. Building all nine unconditionally made
// `npx vitest run test/env.test.js` pay nine serial `vite build`s on a cold tree
// before a single test executed, for a suite that boots no runtime at all. Since
// every suite still builds what it needs on demand, pre-building the wrong set
// costs only the contention this file exists to avoid - never correctness - so
// narrowing it by what the run selected is safe.

import { readFileSync, readdirSync } from 'node:fs';
import { FIXTURE_VARIANTS } from '../fixture/variants.js';
import { buildFixtureOnce } from './fixture-build.js';
import { hasUWS } from './real-runtime.js';

const testDir = new URL('../', import.meta.url);

/**
 * Positional file filters this run was given, if any.
 *
 * Only tokens that look like a path are taken, so a flag VALUE (`--reporter dot`)
 * is never mistaken for a filter. Getting this wrong in either direction is
 * harmless: too few pre-builds means a lazy build later, too many means the old
 * behaviour.
 *
 * @returns {string[]}
 */
function fileFilters() {
	return process.argv
		.slice(2)
		.filter((arg) => !arg.startsWith('-'))
		.filter((arg) => arg.endsWith('.js') || arg.includes('/') || arg.includes('\\'))
		.map((arg) => arg.replace(/\\/g, '/'));
}

/**
 * Which fixture variants a test file needs, read off its source.
 *
 * A suite names a variant explicitly (`variant: 'grant'`) or takes the default
 * by omitting it. Anything that never mentions the real-runtime helper needs no
 * build at all.
 *
 * @param {string} source
 * @returns {string[]}
 */
function variantsNeededBy(source) {
	if (!source.includes('real-runtime')) return [];
	const named = [...source.matchAll(/variant:\s*'([a-z]+)'/g)].map((m) => m[1]);
	// `startRealRuntime()` with no variant, or with only some calls naming one,
	// still boots `default`.
	const usesDefault = /startRealRuntime\(\s*\)/.test(source) ||
		/startRealRuntime\(\s*\{(?![^}]*variant:)/.test(source);
	return [...new Set(usesDefault ? ['default', ...named] : named)];
}

export default function setup() {
	// Without the native runtime every suite that needs a build is skipped, so
	// building would be pure cost. `real-runtime.js` already turns absence into a
	// hard failure under CI / REQUIRE_UWS, so this is only the local convenience
	// case.
	if (!hasUWS) return;

	const filters = fileFilters();
	/** @type {string[]} */
	let names;

	if (filters.length === 0) {
		names = Object.keys(FIXTURE_VARIANTS);
	} else {
		const needed = new Set();
		for (const file of readdirSync(testDir)) {
			if (!file.endsWith('.test.js')) continue;
			const rel = `test/${file}`;
			if (!filters.some((f) => rel.includes(f) || f.includes(file))) continue;
			for (const variant of variantsNeededBy(readFileSync(new URL(file, testDir), 'utf8'))) {
				needed.add(variant);
			}
		}
		// An unknown variant name would throw deeper in the build; drop anything
		// that is not a declared variant and let the suite report it properly.
		names = [...needed].filter((name) => name in FIXTURE_VARIANTS);
	}

	const failed = [];
	for (const name of names) {
		if (!buildFixtureOnce(name)) failed.push(name);
	}
	if (failed.length > 0) {
		// Fail the run rather than letting each suite discover it separately: one
		// clear message beats N copies of "fixture variant failed to build".
		throw new Error(
			`fixture variant(s) failed to build: ${failed.join(', ')}. ` +
			'The build output is above; in test/fixture, `npm install` is the usual missing step.'
		);
	}
}
