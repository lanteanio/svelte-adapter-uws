// Stop any real runtime a test booted and did not manage to stop.
//
// A setup file rather than a rule for suite authors, for the same reason
// restore-globals.js is one: the case it covers is a test that did not reach
// its own teardown, so asking the test to clean up cannot work. When a boot
// runs past the test's budget the assignment that would have captured the
// server never executes, the suite's `afterEach` sees `null`, and a listener
// survives into the next test - where its connections read as extra members and
// the failure looks like a defect in whatever that test asserts.
//
// Scoped to runtimes that appeared DURING the test. The common pattern - boot
// once in `beforeAll`, share it across the file - is untouched, because those
// runtimes are already in the snapshot taken before the test began.

import { beforeEach, afterEach } from 'vitest';
import { snapshotRuntimes, stopRuntimesSince } from './live-runtimes.js';

/** @type {Set<{ stop: () => Promise<void> }>} */
let beforeTest = new Set();

beforeEach(() => {
	beforeTest = snapshotRuntimes();
});

afterEach(async () => {
	const stopped = await stopRuntimesSince(beforeTest);
	if (stopped > 0) {
		// Worth saying out loud: reaching here means a test booted a server and
		// lost it, which is nearly always a budget that did not fit a loaded
		// boot. The sweep keeps that from becoming a failure in the NEXT test,
		// and the line is what points at the real one.
		console.warn(
			`[real-runtime] stopped ${stopped} runtime(s) the test did not - a boot that outlived its budget ` +
			'leaves the caller without the reference, so the harness cleaned up. The test that timed out is the defect.'
		);
	}
});
