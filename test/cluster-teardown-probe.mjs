// Native worker-teardown probe for the clean worker-exit fix. Run as a subprocess
// by test/cluster-teardown.test.js (and standalone in Docker) with one arg:
//   node test/cluster-teardown-probe.mjs bare    -> a worker holding a uWS App
//        does a bare process.exit(0); on Linux this aborts the WHOLE process
//        (`uv_loop_close() while having open handles`) -> non-zero/SIGABRT.
//   node test/cluster-teardown-probe.mjs clean   -> the clean-exit discipline:
//        app.close() (drops the listen socket + accepted conns) + ONE real loop
//        turn (so uv's close callbacks complete) + process.exit(0) -> clean 0.
// The whole-process exit code is the assertion surface: 0 iff the worker tore
// down cleanly. Requires a loadable uWS binding (Linux/glibc>=2.38 in CI).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

if (isMainThread) {
	const mode = process.argv[2] === 'clean' ? 'clean' : 'bare';
	const w = new Worker(fileURLToPath(import.meta.url), { workerData: { mode } });
	// The worker's own exit code is irrelevant: what we measure is whether the
	// WHOLE process survives the worker teardown. If the bare path aborts, this
	// main thread never reaches a clean exit - the process dies with SIGABRT.
	w.on('exit', (code) => process.exit(code));
	w.on('error', () => process.exit(91));
} else {
	const uWS = (await import('uWebSockets.js')).default;
	const app = uWS.App();
	app.get('/*', (res) => res.end('ok'));
	app.listen('127.0.0.1', 0, (token) => {
		if (!token) { process.exit(97); return; }
		const port = uWS.us_socket_local_port(token);
		// Open one real accepted connection so the worker holds live socket poll
		// handles (listen socket + conn), matching the crash's precondition.
		const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
			res.resume();
			res.on('end', () => {
				if (workerData.mode === 'bare') {
					process.exit(0); // aborts the process on Linux (the crash)
				} else {
					app.close();               // drop listen socket + accepted conns
					setTimeout(() => process.exit(0), 0); // one loop turn, then exit
				}
			});
		});
		req.on('error', () => process.exit(96));
	});
}
