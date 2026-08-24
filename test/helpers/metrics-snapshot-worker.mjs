// Runs the BUILT runtime's metrics-snapshot module inside a real worker
// thread, with the spawning test acting as the primary on the other end of the
// real parentPort. The two failure paths this exists to drive live behind that
// port, and each is driven the way its registry entry says it is reached.
//
// metrics.primary-unreachable: the entry documents that a dead channel cannot
// produce this line (posting to a closed MessagePort is a silent no-op on
// current Node) and that the throw comes from an instrumented port. So the
// drive installs exactly that: a prototype-level wrapper of the shape trace
// injectors use, forwarding to the real postMessage with its own context
// piggybacked onto the message. That context carries a function, so the REAL
// postMessage throws a REAL DataCloneError from structured clone - nothing in
// the throw is stubbed - and the runtime's catch contains it.
//
// metrics.merge-failed: the entry documents that no deliverable report reaches
// the combine step malformed - the normalization guards drop or collapse every
// shape structured clone can carry - so the condition is the merge THROWING,
// not a bad message arriving. The drive makes the same call the worker's
// message dispatch makes when the primary delivers ('metrics-result' ->
// resolveMetricsSnapshot), handed the one thing that dispatch can never carry:
// a report whose read raises inside mergeSamples. What it pins is the entry's
// containment claim - the emitted event, the degraded local-only answer, and
// the shared in-flight promise settling at all.

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = (name) => pathToFileURL(path.join(workerData.buildDir, name)).href;
const snap = await import(base('handler/metrics-snapshot.js'));
const diagnostic = await import(base('diagnostic.js'));

/** @type {Array<{ event: string, severity: string, message: string, error: { name: string, message: string } | null }>} */
const events = [];
diagnostic.setOperationalEventSink((record) => {
	const attached = record.attributes?.error;
	events.push({
		event: record.event,
		severity: record.severity,
		message: record.message,
		error: attached ? { name: attached.name, message: attached.message } : null
	});
});

// Bound before any prototype patch below, so the harness's own reporting
// channel keeps the unwrapped function whatever the drives do to the port.
const originalPost = parentPort.postMessage.bind(parentPort);

parentPort.on('message', async (msg) => {
	if (msg.type === 'drive-unreachable') {
		// The instrumentation wrapper the entry's cause names: rewrap the port's
		// postMessage at the prototype (where instrumentation lands, covering
		// every port in the thread) to piggyback a context object. The context
		// holds a function, so the underlying REAL postMessage throws a real
		// DataCloneError - the throw is Node's structured clone refusing the
		// wrapper's payload, not an injected error.
		const proto = Object.getPrototypeOf(parentPort);
		const realPost = proto.postMessage;
		proto.postMessage = function (value, ...rest) {
			return realPost.call(this, { ...value, __trace: { onEnd: () => {} } }, ...rest);
		};
		try {
			const doc = await snap.metricsSnapshot();
			originalPost({ type: 'result', name: 'unreachable', doc, events: events.splice(0) });
		} finally {
			proto.postMessage = realPost;
		}
		return;
	}
	if (msg.type === 'drive-collect') {
		// A real request: the primary (the test) receives {type:
		// 'metrics-request', id} and answers with whatever reports it chooses
		// via 'deliver'. The resolved document goes back with the events that
		// fired on the way. Reaching the primary at all also pins the
		// unreachable entry's recovery claim once it runs after the wrapper
		// drive: the next scrape posts to the primary again, and arrives.
		const doc = await snap.metricsSnapshot();
		originalPost({ type: 'result', name: msg.name, doc, events: events.splice(0) });
		return;
	}
	if (msg.type === 'deliver-poison') {
		// The same call the worker dispatch makes for a delivered collection,
		// with a report no primary can deliver (structured clone would refuse
		// it at the sender): the merge itself throws, which is the entry's
		// condition, and everything downstream of the throw - the
		// emitted event, the degraded local-only answer, the promise settling
		// - is the production catch, unmocked.
		snap.resolveMetricsSnapshot(msg.id, [{ get samples() { throw new Error('__MERGE_POISON__'); } }], 2, 2);
		return;
	}
	if (msg.type === 'deliver-clean') {
		snap.resolveMetricsSnapshot(msg.id, [{ worker: 1, samples: [] }], 1, 1);
		return;
	}
	if (msg.type === 'deliver-reports') {
		// The primary (the test) built these reports on ITS side of the port,
		// so everything in msg.reports genuinely survived structured clone -
		// this is the branch that carries deliverable-but-hostile collections
		// across the real thread boundary into the same resolve call.
		snap.resolveMetricsSnapshot(msg.id, msg.reports, msg.expected, msg.reporting);
		return;
	}
});

originalPost({ type: 'ready' });
