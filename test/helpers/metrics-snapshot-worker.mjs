// Runs the BUILT runtime's metrics-snapshot module inside a real worker
// thread, with the spawning test acting as the primary on the other end of the
// real parentPort. The two failure paths this exists to drive live behind that
// port: a snapshot request that cannot reach the primary, and a delivered
// collection whose merge throws. Neither can be reached from the main thread
// (the module short-circuits to the single-process path when parentPort is
// null), and neither can be reached through structured clone with well-formed
// data - which is the point: they are the containment for exactly the inputs
// the healthy protocol never produces.
//
// The faults are injected on the REAL objects the runtime calls:
// `parentPort.postMessage` is replaced on the worker's own port for one call
// (the shape a dead or torn-down channel presents), and the poisoned report is
// handed to the same `resolveMetricsSnapshot` the worker's message dispatch
// calls when the primary delivers. Everything downstream of the fault - the
// emitted event, the degraded local-only answer, the promise resolving at all
// - is the production code path, unmocked.

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = (name) => pathToFileURL(path.join(workerData.buildDir, name)).href;
const snap = await import(base('handler/metrics-snapshot.js'));
const diagnostic = await import(base('diagnostic.js'));

/** @type {Array<{ event: string, severity: string, message: string }>} */
const events = [];
diagnostic.setOperationalEventSink((record) => {
	events.push({ event: record.event, severity: record.severity, message: record.message });
});

const originalPost = parentPort.postMessage.bind(parentPort);

parentPort.on('message', async (msg) => {
	if (msg.type === 'drive-unreachable') {
		// The entry's condition: posting the snapshot request to the primary
		// throws, meaning this worker's message port is closed or unusable. A
		// genuinely closed port makes postMessage a silent no-op on current
		// Node, so the throw is injected on the port object itself, restored
		// after the one call the runtime makes.
		/** @type {any} */ (parentPort).postMessage = (m) => {
			if (m !== null && typeof m === 'object' && m.type === 'metrics-request') {
				/** @type {any} */ (parentPort).postMessage = originalPost;
				throw new Error('__METRICS_PORT_DEAD__');
			}
			return originalPost(m);
		};
		const doc = await snap.metricsSnapshot();
		originalPost({ type: 'result', name: 'unreachable', doc, events: events.splice(0) });
		return;
	}
	if (msg.type === 'drive-collect') {
		// A real request: the primary (the test) receives {type:
		// 'metrics-request', id} and answers with whatever reports it chooses
		// via 'deliver'. The resolved document goes back with the events that
		// fired on the way.
		const doc = await snap.metricsSnapshot();
		originalPost({ type: 'result', name: msg.name, doc, events: events.splice(0) });
		return;
	}
	if (msg.type === 'deliver-poison') {
		// The primary delivered a collection whose combination throws: the
		// report's `samples` member raises on first read, inside mergeSamples,
		// inside the runtime's own catch.
		snap.resolveMetricsSnapshot(msg.id, [{ get samples() { throw new Error('__MERGE_POISON__'); } }], 2, 2);
		return;
	}
	if (msg.type === 'deliver-clean') {
		snap.resolveMetricsSnapshot(msg.id, [{ worker: 1, samples: [] }], 1, 1);
		return;
	}
});

originalPost({ type: 'ready' });
