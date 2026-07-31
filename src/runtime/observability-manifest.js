// The adapter's signal manifest: one machine-readable declaration of every
// metric the runtime registers.
//
// This exists because two of the facts a metric carries are not recoverable
// from its registration. A registration says `counter(name, help, labels)`;
// it cannot say what UNIT the number is in, nor how to combine the value
// across worker threads. Both were previously prose in two hand-maintained
// lists that had already drifted apart from each other and from the code.
//
// The aggregation law is the load-bearing field, and the reason this is a
// runtime module rather than a doc: every worker holds its own registry, and
// every worker serves the same port, so a scrape reaches an arbitrary one.
// `platform.metricsSnapshot()` collects every worker's mirrored values and
// merges them - and merging is only correct if each metric declares whether
// its values add up (two workers each holding 40 connections means 80) or
// describe the same underlying quantity (two workers each seeing 900 open
// file descriptors means 900, not 1800). `aggregate` is that declaration,
// executed by the merge rather than described next to it.
//
// `help` here is the one-line description rendered into a cluster snapshot
// document. The registration sites carry their own longer operator prose for
// the local scrape, and the README table carries the full explanation; the
// metrics contract test proves all of those surfaces name the same metrics
// with the same types and labels.

/**
 * How a metric's per-worker values combine into one cluster-level value.
 *
 * - `sum`: the workers hold disjoint parts of one whole (connections,
 *   admissions). Adding them is the cluster total.
 * - `max`: the workers report the same underlying quantity, or the useful
 *   cluster answer is the worst one (process file descriptors, saturation,
 *   the worst outbound queue). Adding them would multiply one truth by the
 *   worker count.
 * - `min`: freshness. The stalest worker is the honest cluster-level answer -
 *   a snapshot is only as current as its most-behind contributor.
 *
 * @typedef {'sum' | 'max' | 'min'} AggregationLaw
 */

/**
 * What the value is measured in. `null` is a dimensionless count.
 *
 * `enum` marks an integer that encodes a named state; its mapping is declared
 * on the entry that uses it, and the ordering is chosen so `max` selects the
 * most severe state across workers.
 *
 * @typedef {null | 'bytes' | 'seconds' | 'ratio' | 'percent' | 'enum'} Unit
 */

/**
 * @typedef {object} Signal
 * @property {string} name Metric name, unprefixed. A registry may namespace
 *   its own output; the cluster merge is unaffected, because it keys on the
 *   mirrored value under this name and never on rendered text.
 * @property {'counter' | 'gauge'} type
 * @property {string[]} labels Declared label names; empty for unlabelled.
 * @property {Unit} unit
 * @property {'worker' | 'process'} scope Whether the value describes this
 *   worker thread alone, or a quantity shared by the whole process.
 * @property {AggregationLaw} aggregate
 * @property {string} help One line, rendered into a cluster snapshot.
 * @property {boolean} [optional] True when registration is conditional (a
 *   platform without the source, or an off-by-default audit), so consumers
 *   must tolerate its absence.
 * @property {boolean} [merged] True when the cluster merge writes the series
 *   itself rather than any worker registering it, so it exists only in a
 *   `metricsSnapshot()` document and never in a single worker's registry.
 */

/**
 * Severity ranking for `pressure_reason`, ordered so that a cluster-level
 * `max` selects the worst reason any worker reported. The order mirrors the
 * precedence the sampler itself applies: memory exhaustion outranks a posture
 * that was engaged for capacity, which outranks the load signals.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const PRESSURE_REASON_CODES = Object.freeze({
	NONE: 0,
	SUBSCRIBERS: 1,
	PUBLISH_RATE: 2,
	PSI: 3,
	CPU_QUOTA: 4,
	CAPACITY: 5,
	MEMORY: 6
});

/**
 * Every metric the runtime registers on an operator-supplied registry.
 *
 * @type {readonly Signal[]}
 */
export const SIGNALS = Object.freeze([
	// - Admission ---------------------------------------------------------
	{ name: 'upgrade_admitted_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'WebSocket upgrades accepted' },
	{ name: 'upgrade_rejected_total', type: 'counter', labels: ['reason'], unit: null, scope: 'worker', aggregate: 'sum', help: 'WebSocket upgrades rejected before open' },
	{ name: 'upgrade_rate_map_evicted_total', type: 'counter', labels: ['door'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Rate-limit entries evicted at the map cap' },
	{ name: 'upgrade_inflight', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Upgrades currently between admission and open' },
	{ name: 'waiting_room_queue_depth', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Clients currently polling the waiting room' },

	// - Protection posture ------------------------------------------------
	{ name: 'protection_posture_transitions_total', type: 'counter', labels: ['from', 'to'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Protection posture level changes' },
	// Levels are ordered by severity (0 normal, 1 elevated, 2 siege), so the
	// cluster reads as the most-defensive posture any worker has engaged.
	{ name: 'protection_posture_state', type: 'gauge', labels: [], unit: 'enum', scope: 'worker', aggregate: 'max', help: 'Current protection posture (0 normal, 1 elevated, 2 siege)' },

	// - Connections and traffic -------------------------------------------
	{ name: 'ws_connections', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Live WebSocket connections' },
	// Exported alongside `ws_connections` rather than as a precomputed ratio:
	// averaging a per-worker ratio is not the cluster ratio, whereas summing
	// the numerator and denominator separately lets the query compute it
	// correctly at any grouping.
	{ name: 'ws_subscriptions', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Live topic subscriptions; divide by ws_connections for the subscriber ratio' },
	// Counts publish CALLS, never per-recipient deliveries: uWS fans out in
	// C++, and counting recipients would mean walking the subscriber set in
	// JS on every publish.
	{ name: 'ws_publishes_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Publish calls made (fan-out happens in C++; not per-recipient deliveries)' },
	{ name: 'ws_backpressure_max_bytes', type: 'gauge', labels: [], unit: 'bytes', scope: 'worker', aggregate: 'max', help: 'Worst per-connection outbound buffered bytes over the sampled set' },
	{ name: 'ws_backpressure_connections', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Sampled connections holding a backpressured outbound queue' },

	// - Pressure ----------------------------------------------------------
	{ name: 'pressure_saturation', type: 'gauge', labels: [], unit: 'ratio', scope: 'worker', aggregate: 'max', help: 'Worker saturation, 0 healthy to 1 at the configured thresholds' },
	{ name: 'pressure_reason', type: 'gauge', labels: [], unit: 'enum', scope: 'worker', aggregate: 'max', help: 'Pressure reason as a severity-ordered code (0 none to 6 memory)' },
	// The wall-clock time of the most recent pressure fold. A sampler that
	// wedges leaves every other gauge frozen at its last value with the
	// target still up; this is what makes that state queryable.
	{ name: 'pressure_sample_timestamp_seconds', type: 'gauge', labels: [], unit: 'seconds', scope: 'worker', aggregate: 'min', help: 'Unix time of the most recent pressure sample; alert on its age' },

	// - Memory and kernel signals -----------------------------------------
	// Resident memory is process-wide: worker threads share one address
	// space, so every worker reports the same number.
	{ name: 'resident_memory_bytes', type: 'gauge', labels: [], unit: 'bytes', scope: 'process', aggregate: 'max', help: 'Resident set size of the process' },
	// Heap is per-isolate, so each worker thread has its own. The worst
	// worker is the one that will hit the ceiling first.
	{ name: 'heap_used_ratio', type: 'gauge', labels: [], unit: 'ratio', scope: 'worker', aggregate: 'max', help: 'Used fraction of this worker isolate V8 heap' },
	{ name: 'psi_cpu_some_avg10', type: 'gauge', labels: [], unit: 'percent', scope: 'process', aggregate: 'max', optional: true, help: 'Kernel pressure-stall CPU some avg10' },
	{ name: 'psi_memory_full_avg10', type: 'gauge', labels: [], unit: 'percent', scope: 'process', aggregate: 'max', optional: true, help: 'Kernel pressure-stall memory full avg10' },
	{ name: 'psi_io_full_avg10', type: 'gauge', labels: [], unit: 'percent', scope: 'process', aggregate: 'max', optional: true, help: 'Kernel pressure-stall IO full avg10' },
	{ name: 'cpu_throttled_ratio', type: 'gauge', labels: [], unit: 'ratio', scope: 'process', aggregate: 'max', optional: true, help: 'Fraction of the window the cgroup CPU quota held the process suspended' },

	// - Descriptors -------------------------------------------------------
	// Worker threads share one process-wide descriptor table, so any worker's
	// reading is the whole-process truth and summing would multiply it.
	{ name: 'open_fds', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', optional: true, help: 'File descriptors currently open by the process' },
	{ name: 'fd_soft_limit', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', optional: true, help: 'Soft file-descriptor limit; new sockets fail with EMFILE at this count' },

	// - Cluster integrity -------------------------------------------------
	{ name: 'state_divergence_total', type: 'counter', labels: ['role'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Cross-worker state hash divergence detections' },
	{ name: 'relay_gap_frames_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Relayed frames proven lost to this worker' },

	// - Framework invariants ----------------------------------------------
	{ name: 'framework_assertion_violations_total', type: 'counter', labels: ['category', 'severity'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Framework invariant violations' },
	{ name: 'framework_resource_growth_suspected_total', type: 'counter', labels: ['resource'], unit: null, scope: 'worker', aggregate: 'sum', optional: true, help: 'Sustained resource-growth suspicions raised by the optional auditor' },

	// - The snapshot's own completeness -----------------------------------
	// Written by the merge itself, not by any worker. A merge that reached
	// fewer workers than it asked is a partial answer, and an operator has to
	// be able to see that rather than read a dip in every summed series as a
	// real drop in traffic.
	{ name: 'metrics_snapshot_workers_expected', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: 'Workers the cluster metrics snapshot asked for a report' },
	{ name: 'metrics_snapshot_workers_reporting', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: 'Workers that answered before the deadline' },
	// The expected/reporting pair cannot express a TOTAL failure: a worker
	// that never heard back does not know how many siblings it has, so those
	// two would agree with each other and the document would read as complete
	// while being one worker's view. This is the flag to alert on.
	{ name: 'metrics_snapshot_degraded', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: '1 when the collection did not complete and this document is one worker, not the cluster' }
]);

/** @type {ReadonlyMap<string, Signal>} */
export const SIGNALS_BY_NAME = new Map(SIGNALS.map((s) => [s.name, s]));

/**
 * The aggregation law for a metric name, or `null` when the name is not one
 * of the adapter's own.
 *
 * @param {string} name
 * @returns {AggregationLaw | null}
 */
export function aggregationFor(name) {
	return SIGNALS_BY_NAME.get(name)?.aggregate ?? null;
}
