// Put the browser-shaped globals back after every test FILE.
//
// A client suite needs `globalThis.WebSocket` and `globalThis.window` to exist,
// and the natural spelling is a bare assignment at module scope. Eighteen suites
// do exactly that and fourteen never undo it. With file parallelism on - the
// project default - each file gets its own globals, so nothing shows. Serial mode
// (`--no-file-parallelism`) shares ONE context across all 169 files, and a mock
// left installed there is inherited by whatever runs next.
//
// That is what the long-standing serial failure was. `test/cursor-worker-wire.test.js`
// drives the cursor controller in-process, and the controller constructs
// `new WebSocket(url, [subprotocol])` itself (src/plugins/cursor/cursor-worker.js):
// handed somebody's MockWebSocket it opened a socket that never reached the
// server, and five tests died on timeouts that pointed straight at the cursor
// code. Confirmed by reading `globalThis.WebSocket.name` inside the failing
// suite - `MockWebSocket` on every failing run, `WebSocket` on every passing one.
//
// It reproduced on roughly half of serial runs because vitest orders files by
// their CACHED DURATIONS, so whether a stomping suite happened to run first
// varied between runs. That is why several rounds recorded it as unexplained and
// as "no longer reproduces".
//
// WHY A SETUP FILE RATHER THAN FIXING EACH SUITE. A setup file is evaluated
// before the test file it serves, so the snapshot below is taken while the
// globals are still pristine, and the restore cannot be forgotten by a suite
// added later. Asking eighteen authors to remember a teardown is how this
// happened in the first place.

import { afterAll } from 'vitest';

// Names a test file is known to install, plus the rest of the browser shims a
// client suite reaches for. Snapshotting a name that is absent is harmless: it
// is recorded as absent and deleted again on the way out.
const BROWSER_GLOBALS = [
	'WebSocket',
	'window',
	'document',
	'navigator',
	'localStorage',
	'sessionStorage',
	'devicePixelRatio',
	'requestAnimationFrame',
	'cancelAnimationFrame'
];

/** @type {Array<[string, boolean, unknown]>} */
const pristine = BROWSER_GLOBALS.map((key) => [
	key,
	key in globalThis,
	/** @type {any} */ (globalThis)[key]
]);

afterAll(() => {
	for (const [key, existed, value] of pristine) {
		if (existed) {
			if (/** @type {any} */ (globalThis)[key] !== value) {
				/** @type {any} */ (globalThis)[key] = value;
			}
		} else if (key in globalThis) {
			delete /** @type {any} */ (globalThis)[key];
		}
	}
});
