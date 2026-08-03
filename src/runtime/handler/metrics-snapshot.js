// Cluster-wide metrics collection: the worker side of the snapshot round trip.
//
// Each worker thread holds its own registry, and every worker serves the same
// port, so an ordinary scrape route reads whichever worker took the request.
// This asks the primary to collect every live worker's mirrored values and
// merges them under the signal manifest's per-metric aggregation law.
//
// What crosses the boundary is the values the adapter itself wrote (the mirror
// in utils/metrics.js), never a registry's rendered exposition text - see the
// header of utils/metrics-merge.js for why that distinction is the whole
// design. It also means `serialize()` is NOT required for this to work: a
// registry that cannot render text still gets a correct cluster snapshot.
//
// Single-process deployments take the same path minus the round trip, so the
// document an operator scrapes has the same shape whether or not clustering is
// on - turning CLUSTER_WORKERS on does not change the dashboard.

import { parentPort, threadId } from 'node:worker_threads';
import { metricsRegistry } from '../metrics-bridge.js';
import { mergeSamples } from '../utils/metrics-merge.js';
import { readMetricMirror } from '../utils/metrics.js';
import { randomUuid, setTimer, clearTimer } from '../runtime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

/** Requests this worker is waiting on, keyed by correlation id. */
const pending = new Map();

/**
 * The in-flight collection, if any. Two simultaneous scrapes on this worker
 * want the same answer, so they share one. Note this is only a local
 * convenience: the cluster-wide bound on concurrent collections is enforced by
 * the primary, because this guard is per worker thread and N workers would
 * otherwise admit N collections at once.
 *
 * @type {Promise<string> | null}
 */
let inFlight = null;

/** Clamp so a caller cannot pin a collection open, or make one that never waits. */
const MIN_TIMEOUT_MS = 50;
// A snapshot that takes longer than a default Prometheus scrape timeout is of
// no use to the thing asking for it, and a long ceiling is what would let one
// caller's generous deadline become every concurrent caller's wait.
const MAX_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * This worker's mirrored values for a collection request. Structured and
 * bounded by the manifest's own cardinality; contains only the adapter's own
 * metrics with their source-declared label vocabularies.
 *
 * @returns {Array<{ name: string, labels: Record<string, string>, value: number }>}
 */
export function collectLocalMetrics() {
	try {
		return readMetricMirror();
	} catch (err) {
		// The mirror is ours and cannot normally throw; a worker asked for a
		// report must never die because of one. It shows up as a gap between
		// expected and reporting.
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.metrics',
			event: 'metrics.mirror-read-failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The metrics mirror read failed during cluster collection; this worker reports as a gap between expected and reporting.',
			attributes: { error: diagnosticError(err) }
		});
		return [];
	}
}

/** One worker's own document, used for the single-process and degraded paths. */
function localOnly(degraded) {
	return mergeSamples(
		[{ worker: threadId, samples: collectLocalMetrics() }],
		{ expected: 1, degraded }
	);
}

/**
 * Primary delivered the collected reports for one request.
 *
 * @param {string} id
 * @param {unknown} reports
 * @param {unknown} expected
 */
export function resolveMetricsSnapshot(id, reports, expected, reporting) {
	const entry = pending.get(id);
	if (entry === undefined) return;
	pending.delete(id);
	clearTimer(entry.timer);
	// The pending entry and its timer are already gone, so anything that throws
	// past this point would leave the promise unsettled forever - and because
	// the route awaits it through `inFlight`, EVERY later scrape on this worker
	// would hang on the same dead promise. Resolve unconditionally.
	try {
		entry.resolve(mergeSamples(
			Array.isArray(reports) ? reports : [],
			{
				expected: typeof expected === 'number' && expected >= 0 ? expected : 0,
				reporting: typeof reporting === 'number' && reporting >= 0 ? reporting : undefined,
				degraded: !Array.isArray(reports)
			}
		));
	} catch (err) {
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.metrics',
			event: 'metrics.merge-failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The cluster metrics merge failed; this scrape answers with the local worker only.',
			attributes: { error: diagnosticError(err) }
		});
		try {
			entry.resolve(localOnly(true));
		} catch {
			entry.resolve('');
		}
	}
}

/**
 * Collect and merge every worker's metrics.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string | null>} Prometheus text, or `null` when no metrics
 *   registry is configured.
 */
export function metricsSnapshot(options) {
	if (metricsRegistry == null) return Promise.resolve(null);

	// Single process: nothing to collect from, but the same merge runs so the
	// output shape does not depend on the deployment mode.
	if (parentPort === null) return Promise.resolve(localOnly(false));

	if (inFlight !== null) return inFlight;

	const raw = options?.timeoutMs;
	const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS,
		typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_TIMEOUT_MS));

	const id = randomUuid();
	const promise = new Promise((resolve) => {
		const timer = setTimer(() => {
			// Deadline: answer with this worker alone rather than hanging a
			// scrape. `metrics_snapshot_degraded` is what says so - the
			// expected/reporting pair cannot, because a worker that never heard
			// back does not know how many siblings it has.
			pending.delete(id);
			resolve(localOnly(true));
		}, timeoutMs);
		// Never hold the event loop open for a scrape: a collection in flight
		// must not delay process exit during a graceful shutdown.
		if (typeof timer?.unref === 'function') timer.unref();
		pending.set(id, { resolve, timer });
		try {
			parentPort.postMessage({ type: 'metrics-request', id, timeoutMs });
		} catch (err) {
			pending.delete(id);
			clearTimer(timer);
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.metrics',
				event: 'metrics.primary-unreachable',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The metrics snapshot request could not reach the primary; this scrape answers degraded with the local worker only.',
				attributes: { error: diagnosticError(err) }
			});
			resolve(localOnly(true));
		}
	});
	inFlight = promise.finally(() => { inFlight = null; });
	return inFlight;
}
