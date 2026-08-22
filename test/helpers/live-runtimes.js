// The set of real runtimes currently listening in this worker.
//
// Deliberately its own module with no imports: it is pulled in by a setup file,
// which runs for EVERY test file including the ones that never boot a server,
// and `real-runtime.js` loads the native addon at module scope. A registry that
// dragged that in would make a pure unit file pay for a native library it does
// not use.
//
// WHAT THIS EXISTS FOR. A suite that boots inside a test - `server = await
// startRealRuntime(...)` in the `it` body - loses the reference when the test's
// budget expires mid-boot: the boot completes, but the assignment never runs,
// so the suite's own `afterEach` has nothing to stop. The listener stays up and
// the NEXT test sees its members too. That is how one slow boot turned into an
// assertion about duplicate roster entries in an authorization test - a failure
// that reads exactly like a real defect, in a file that is fine.
//
// The registry closes it by making cleanup the harness's job rather than the
// caller's: a runtime that appears during a test and is still listening when it
// ends gets stopped, whether or not the test managed to keep hold of it.

/** @type {Set<{ stop: () => Promise<void> }>} */
const live = new Set();

/** @param {{ stop: () => Promise<void> }} runtime */
export function registerRuntime(runtime) {
	live.add(runtime);
}

/** @param {{ stop: () => Promise<void> }} runtime */
export function forgetRuntime(runtime) {
	live.delete(runtime);
}

/** Runtimes listening right now - the snapshot a test starts from. */
export function snapshotRuntimes() {
	return new Set(live);
}

/**
 * Stop every runtime that appeared since `snapshot` and is still listening.
 *
 * A runtime the test stopped itself is already out of the set, so the normal
 * path sweeps nothing. Runtimes booted before the snapshot - the `beforeAll`
 * pattern, which is most suites - are never touched.
 *
 * @param {Set<{ stop: () => Promise<void> }>} snapshot
 * @returns {Promise<number>} how many had to be stopped
 */
export async function stopRuntimesSince(snapshot) {
	const leaked = [...live].filter((runtime) => !snapshot.has(runtime));
	for (const runtime of leaked) {
		try { await runtime.stop(); } catch { /* already down */ }
		live.delete(runtime);
	}
	return leaked.length;
}
