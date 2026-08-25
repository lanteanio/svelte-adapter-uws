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
// not a bad message arriving, and the entry names what is left: a defect in the
// merge, or a rewrapped runtime built-in underneath it. Both drives therefore
// make the same call the worker's message dispatch makes when the primary
// delivers ('metrics-result' -> resolveMetricsSnapshot) with an ORDINARY
// deliverable report, and rewrap a built-in the combine reaches. A report the
// sender's structured clone would refuse is not usable here: it cannot cross
// the boundary, so handing one in would show the catch running and nothing
// about what reaches it. What the pair pins is the entry's containment claim -
// the emitted event, the degraded local-only answer, and the shared in-flight
// promise settling at all, including when the fallback merge throws too and
// the only thing left to settle with is an empty document.

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

// Stack of the last injected merge fault, shipped back with the result so a
// case can assert WHERE the throw came from and not merely that one happened.
let poisonStack = null;

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
		originalPost({ type: 'result', name: msg.name, doc, events: events.splice(0), poisonStack });
		poisonStack = null;
		return;
	}
	if (msg.type === 'deliver-poison') {
		// The entry names its own condition precisely: not bad input, which the
		// normalization drops, but "a defect in the merge itself or a rewrapped
		// runtime built-in underneath it". So the fault is injected as exactly
		// that - a built-in the merge calls on its way into the per-report loop
		// is rewrapped to throw - and the REPORT is an ordinary deliverable one
		// that merges cleanly on every other run. A report the sender's
		// structured clone would refuse could not model this: it cannot cross
		// the thread boundary, so it can only reach the catch by being handed
		// in on this side, which proves the catch runs and nothing about the
		// condition that reaches it.
		//
		// The built-in has to be one the COMBINE calls and the resolve path does
		// not, or the fault lands before the combine is even entered and the
		// drive proves nothing about it: `resolveMetricsSnapshot` normalizes its
		// own `reports` argument with `Array.isArray` while evaluating the
		// arguments to `mergeSamples`, so rewrapping that one is caught by the
		// same catch without the merge ever running. `Object.getPrototypeOf` is
		// reached only from the label normalizer inside the per-sample loop,
		// which is why the report below carries a labelled sample.
		//
		// ONE-SHOT: it restores itself before throwing, so the catch's own
		// recovery - building and rendering the degraded local-only document -
		// runs against the real built-in. Holding the swap open instead is the
		// other half of the entry's promise and has its own case below.
		const realGetProto = Object.getPrototypeOf;
		Object.getPrototypeOf = () => {
			Object.getPrototypeOf = realGetProto;
			const err = new Error('__MERGE_POISON__');
			// Where it threw travels back with the result. Restoring before the
			// throw is what lets the catch recover cleanly, and it is also what
			// would let a later edit relocate this fault into the resolve path
			// and still produce the same event, the same message and the same
			// degraded document - green, and no longer about the combine. The
			// throwing frame is the only thing that tells those apart.
			poisonStack = err.stack;
			throw err;
		};
		try {
			// TWO reports and a 2/2 pair: the answer's own
			// `metrics_snapshot_workers_expected` is hardcoded to 1 by the
			// local-only fallback, so reading 1 back proves the fallback built
			// it rather than the delivered context.
			const sample = { name: 'ws_connections', value: 7, labels: {} };
			snap.resolveMetricsSnapshot(msg.id, [{ worker: 1, samples: [sample] }, { worker: 2, samples: [sample] }], 2, 2);
		} finally {
			Object.getPrototypeOf = realGetProto;
		}
		return;
	}
	if (msg.type === 'deliver-poison-sustained') {
		// A fault that does NOT clear itself, which is what a rewrapped built-in
		// actually looks like. `Array.isArray` is the right one to hold open
		// here precisely because it is reached everywhere the answer could come
		// from: the resolve path's own argument normalization, the combine, and
		// the fallback that would otherwise render a local-only document. With
		// no document constructible, the runtime falls through to its last
		// resort and settles the shared in-flight promise with an empty one.
		//
		// The first throw here is therefore the resolve path's normalization,
		// not the combine - unlike the case above, whose whole point is WHERE
		// it threw. What this case claims is only that the promise settles when
		// nothing can build an answer, so the throwing frame does not matter to
		// it and is not asserted.
		//
		// Settling is the claim. Every concurrent scrape on this worker awaits
		// that one promise, so a catch that stopped resolving would hang all of
		// them indefinitely instead of degrading a single interval.
		const realIsArray = Array.isArray;
		Array.isArray = () => { throw new Error('__MERGE_POISON_SUSTAINED__'); };
		try {
			snap.resolveMetricsSnapshot(msg.id, [{ worker: 1, samples: [{ name: 'ws_connections', value: 7, labels: {} }] }], 1, 1);
		} finally {
			Array.isArray = realIsArray;
		}
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
