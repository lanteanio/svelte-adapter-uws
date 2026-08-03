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

import {
	HTTP_DURATION_BUCKETS,
	UPGRADE_DURATION_BUCKETS,
	WS_MESSAGE_DURATION_BUCKETS,
	WS_CONNECTION_DURATION_BUCKETS
} from './transport-metrics.js';

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
 * @property {'counter' | 'gauge' | 'histogram'} type
 * @property {string[]} labels Declared label names; empty for unlabelled.
 * @property {Unit} unit
 * @property {'worker' | 'process'} scope Whether the value describes this
 *   worker thread alone, or a quantity shared by the whole process.
 * @property {AggregationLaw} aggregate
 * @property {string} help One line, rendered into a cluster snapshot.
 * @property {string} [formula] Canonical derived query, when this signal is
 *   intended to be combined with another rather than read directly.
 * @property {readonly number[] | null} buckets Explicit finite bounds for a
 *   histogram; null for counters and gauges.
 * @property {boolean} [optional] True when registration is conditional (a
 *   platform without the source, or an off-by-default audit), so consumers
 *   must tolerate its absence.
 * @property {boolean} [merged] True when the cluster merge writes the series
 *   itself rather than any worker registering it, so it exists only in a
 *   `metricsSnapshot()` document and never in a single worker's registry.
 * @property {1} schemaVersion Version of the shared observability contract.
 * @property {'operational'} dataClass Metrics and their labels never carry
 *   user identifiers, payloads, credentials, or arbitrary application data.
 * @property {Readonly<Record<string, LabelDomain>>} labelDomains A bounded
 *   domain declaration for every label.
 * @property {Readonly<{ local: string, snapshot: string }>} noData Explicit
 *   zero/absence behavior for local and cluster snapshot surfaces.
 * @property {Readonly<Record<string, number>> | null} valueDomain Exact
 *   integer mapping for enum gauges; null for ordinary numeric values.
 */

/**
 * @typedef {object} LabelDomain
 * @property {'enum' | 'pattern'} kind
 * @property {'operational'} dataClass
 * @property {readonly string[]} [values]
 * @property {string} [pattern]
 * @property {number} [maxDistinct]
 */

export const OBSERVABILITY_SCHEMA_VERSION = 1;

export const TELEMETRY_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'fatal']);

export const DATA_CLASSES = Object.freeze({
	operational: Object.freeze({
		personalData: false,
		defaultRetention: 'operator-policy',
		description: 'Bounded framework state with no user identifier or payload'
	}),
	pseudonymous: Object.freeze({
		personalData: true,
		defaultRetention: 'minimum-needed',
		description: 'Request or trace correlation identifiers'
	}),
	application: Object.freeze({
		personalData: true,
		defaultRetention: 'omit-unless-classified',
		description: 'Application-supplied attributes that require deployer classification'
	}),
	secret: Object.freeze({
		personalData: true,
		defaultRetention: 'prohibited',
		description: 'Credentials, cookies, authorization values, tokens, and payload secrets'
	})
});

export const NO_DATA_POLICIES = Object.freeze({
	registry_zero: 'A registered counter exists at zero before its first event.',
	zero_when_complete: 'A complete snapshot emits the registered counter family at zero.',
	last_sample: 'A local gauge exists only after the registry has a value.',
	incomplete_until_sampled: 'A required unsampled gauge makes the snapshot incomplete.',
	absent_when_unavailable: 'An optional platform signal is absent when its source is unavailable.',
	registry_histogram_zero: 'A supported histogram registers zero buckets, count, and sum before its first observation.',
	zero_when_registered: 'A complete snapshot emits a zero histogram only when every worker registered that optional family.',
	not_exposed: 'A merge-owned signal is not exposed by a worker registry.',
	always_present: 'A successful snapshot always writes this completeness signal.'
});

export const TELEMETRY_CONTRACT = Object.freeze({
	schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
	eventEnvelope: Object.freeze({
		fields: Object.freeze({
			schemaVersion: Object.freeze({ required: true, type: 'integer', dataClass: 'operational' }),
			occurredAt: Object.freeze({ required: true, type: 'rfc3339-utc', dataClass: 'operational' }),
			level: Object.freeze({ required: true, type: 'enum', values: TELEMETRY_LEVELS, dataClass: 'operational' }),
			event: Object.freeze({ required: true, type: 'dot-name', dataClass: 'operational' }),
			component: Object.freeze({ required: true, type: 'dot-name', dataClass: 'operational' }),
			dataClass: Object.freeze({ required: true, type: 'enum', values: Object.freeze(Object.keys(DATA_CLASSES)), dataClass: 'operational' }),
			requestId: Object.freeze({ required: false, type: 'printable-ascii-128', dataClass: 'pseudonymous' }),
			traceparent: Object.freeze({ required: false, type: 'w3c-traceparent', dataClass: 'pseudonymous' }),
			tracestate: Object.freeze({ required: false, type: 'w3c-tracestate', dataClass: 'pseudonymous' }),
			attributes: Object.freeze({ required: false, type: 'object', dataClass: 'application' })
		})
	}),
	correlation: Object.freeze({
		requestId: Object.freeze({ field: 'requestId', header: 'x-request-id', supported: true, dataClass: 'pseudonymous' }),
		traceparent: Object.freeze({ field: 'traceparent', header: 'traceparent', supported: true, dataClass: 'pseudonymous' }),
		tracestate: Object.freeze({ field: 'tracestate', header: 'tracestate', supported: true, dataClass: 'pseudonymous' })
	}),
	metrics: Object.freeze({
		namePrefix: 'canonical-unprefixed',
		dataClass: 'operational',
		labelCardinality: 'bounded',
		noDataPolicies: NO_DATA_POLICIES
	})
});

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
const SIGNAL_DEFINITIONS = [
	// - HTTP --------------------------------------------------------------
	{ name: 'http_requests_total', type: 'counter', labels: ['method', 'outcome'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Completed HTTP requests by bounded method and outcome' },
	{ name: 'http_request_duration_seconds', type: 'histogram', labels: ['method', 'outcome'], unit: 'seconds', scope: 'worker', aggregate: 'sum', buckets: HTTP_DURATION_BUCKETS, optional: true, help: 'HTTP request completion duration in seconds' },

	// - Admission ---------------------------------------------------------
	{ name: 'upgrade_admitted_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'WebSocket upgrades accepted' },
	{ name: 'upgrade_rejected_total', type: 'counter', labels: ['reason'], unit: null, scope: 'worker', aggregate: 'sum', help: 'WebSocket upgrades rejected before open' },
	{ name: 'upgrade_duration_seconds', type: 'histogram', labels: ['outcome'], unit: 'seconds', scope: 'worker', aggregate: 'sum', buckets: UPGRADE_DURATION_BUCKETS, optional: true, help: 'WebSocket upgrade decision duration in seconds' },
	{ name: 'upgrade_rate_map_evicted_total', type: 'counter', labels: ['door'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Rate-limit entries evicted at the map cap' },
	{ name: 'upgrade_inflight', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Upgrades currently between admission and open' },
	{ name: 'upgrade_deferred_depth', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Upgrade callbacks waiting in the bounded pacing queue' },
	// The oldest callback anywhere is the cluster's honest wait figure; summing
	// ages across workers would describe nothing a client experiences.
	{ name: 'upgrade_deferred_oldest_age_seconds', type: 'gauge', labels: [], unit: 'seconds', scope: 'worker', aggregate: 'max', help: 'Age of the oldest callback in the bounded upgrade pacing queue' },
	{ name: 'upgrade_deferred_rejected_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Upgrade callbacks shed because the bounded deferral queue was full' },
	{ name: 'ws_connection_headroom', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', optional: true, help: 'Remaining reserved-or-live WebSocket connection permits' },
	{ name: 'waiting_room_queue_depth', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Clients currently polling the waiting room' },

	// - Protection posture ------------------------------------------------
	{ name: 'protection_posture_transitions_total', type: 'counter', labels: ['from', 'to'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Protection posture level changes' },
	// Levels are ordered by severity (0 normal, 1 elevated, 2 siege), so the
	// cluster reads as the most-defensive posture any worker has engaged.
	{ name: 'protection_posture_state', type: 'gauge', labels: [], unit: 'enum', scope: 'worker', aggregate: 'max', help: 'Current protection posture (0 normal, 1 elevated, 2 siege)' },

	// - Connections and traffic -------------------------------------------
	{ name: 'ws_connections', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Live WebSocket connections' },
	{ name: 'ws_connection_duration_seconds', type: 'histogram', labels: ['outcome'], unit: 'seconds', scope: 'worker', aggregate: 'sum', buckets: WS_CONNECTION_DURATION_BUCKETS, optional: true, help: 'WebSocket connection lifetime in seconds' },
	{ name: 'ws_messages_total', type: 'counter', labels: ['kind', 'outcome'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Completed inbound WebSocket messages by kind and outcome' },
	{ name: 'ws_message_admission_rejected_total', type: 'counter', labels: ['reason', 'scope'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Application WebSocket messages shed by established-message admission' },
	{ name: 'ws_message_duration_seconds', type: 'histogram', labels: ['kind', 'outcome'], unit: 'seconds', scope: 'worker', aggregate: 'sum', buckets: WS_MESSAGE_DURATION_BUCKETS, optional: true, help: 'Inbound WebSocket message handling duration in seconds' },
	// Exported alongside `ws_connections` rather than as a precomputed ratio:
	// averaging a per-worker ratio is not the cluster ratio, whereas summing
	// the numerator and denominator separately lets the query compute it
	// correctly at any grouping.
	{ name: 'ws_subscriptions', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', formula: 'sum(ws_subscriptions) / sum(ws_connections)', help: 'Live topic subscriptions; divide by ws_connections for the subscriber ratio' },
	// Counts publish CALLS, never per-recipient deliveries: uWS fans out in
	// C++, and counting recipients would mean walking the subscriber set in
	// JS on every publish.
	{ name: 'ws_publishes_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Publish calls made (fan-out happens in C++; not per-recipient deliveries)' },
	{ name: 'ws_publish_outcomes_total', type: 'counter', labels: ['outcome'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Native publish calls by aggregate delivery outcome' },
	{ name: 'ws_backpressure_max_bytes', type: 'gauge', labels: [], unit: 'bytes', scope: 'worker', aggregate: 'max', help: 'Worst per-connection outbound buffered bytes over the sampled set' },
	{ name: 'ws_backpressure_connections', type: 'gauge', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Sampled connections holding a backpressured outbound queue' },
	{ name: 'ws_dropped_frames_total', type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum', help: 'Outbound WebSocket frames dropped by the native backpressure limit' },
	{ name: 'ws_dropped_bytes_total', type: 'counter', labels: [], unit: 'bytes', scope: 'worker', aggregate: 'sum', help: 'Outbound WebSocket payload bytes dropped by the native backpressure limit' },

	// - Pressure ----------------------------------------------------------
	{ name: 'pressure_saturation', type: 'gauge', labels: [], unit: 'ratio', scope: 'worker', aggregate: 'max', help: 'Worker saturation, 0 healthy to 1 at the configured thresholds' },
	{ name: 'pressure_reason', type: 'gauge', labels: [], unit: 'enum', scope: 'worker', aggregate: 'max', help: 'Pressure reason as a severity-ordered code (0 none to 6 memory)' },
	{ name: 'pressure_reason_transitions_total', type: 'counter', labels: ['from', 'to'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Pressure reason changes, including incidents and recoveries' },
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
	{ name: 'relay_spill_quarantines_total', type: 'counter', labels: ['reason'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Workers quarantined after a relay spill ceiling' },
	{ name: 'relay_spill_dropped_bytes_total', type: 'counter', labels: [], unit: 'bytes', scope: 'worker', aggregate: 'sum', help: 'Pending relay bytes discarded when a lagging worker was quarantined' },
	{ name: 'relay_spill_pending_age_seconds', type: 'gauge', labels: [], unit: 'seconds', scope: 'worker', aggregate: 'max', help: 'Worst oldest-pending age observed at relay spill quarantine' },

	// - Framework invariants ----------------------------------------------
	{ name: 'framework_assertion_violations_total', type: 'counter', labels: ['category', 'severity'], unit: null, scope: 'worker', aggregate: 'sum', help: 'Framework production-assertion violations by category and severity' },
	{ name: 'framework_resource_growth_suspected_total', type: 'counter', labels: ['resource'], unit: null, scope: 'worker', aggregate: 'sum', optional: true, help: 'Sustained resource-growth suspicions raised by the optional auditor' },

	// - The snapshot's own completeness -----------------------------------
	// Written by the merge itself, not by any worker. A merge that reached
	// fewer workers than it asked is a partial answer, and an operator has to
	// be able to see that rather than read a dip in every summed series as a
	// real drop in traffic.
	{ name: 'metrics_snapshot_workers_expected', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: 'Workers the cluster metrics snapshot asked for a report' },
	{ name: 'metrics_snapshot_workers_reporting', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: 'Workers with complete metric reports before the deadline' },
	// The expected/reporting pair cannot express a TOTAL failure: a worker
	// that never heard back does not know how many siblings it has, so those
	// two would agree with each other and the document would read as complete
	// while being one worker's view. This is the flag to alert on.
	{ name: 'metrics_snapshot_degraded', type: 'gauge', labels: [], unit: null, scope: 'process', aggregate: 'max', merged: true, help: '1 when the collection did not complete and this document is one worker, not the cluster' }
];

const LABEL_DOMAINS = Object.freeze({
	http_requests_total: Object.freeze({
		method: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'other']) }),
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['ok', 'client_error', 'server_error', 'aborted']) })
	}),
	http_request_duration_seconds: Object.freeze({
		method: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'other']) }),
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['ok', 'client_error', 'server_error', 'aborted']) })
	}),
	upgrade_rejected_total: Object.freeze({
		reason: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze([
			'auth_rate_limit', 'siege', 'cursor_lane', 'over_capacity', 'connection_capacity', 'duplicate_header',
			'ip_rate_limit', 'bad_origin', 'auth_timeout', 'auth_rejected', 'hook_error'
		]) })
	}),
	upgrade_rate_map_evicted_total: Object.freeze({
		door: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['auth', 'upgrade']) })
	}),
	upgrade_duration_seconds: Object.freeze({
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['admitted', 'rejected', 'aborted', 'error']) })
	}),
	ws_connection_duration_seconds: Object.freeze({
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['clean', 'abnormal']) })
	}),
	ws_messages_total: Object.freeze({
		kind: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['text', 'binary']) }),
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['ok', 'error']) })
	}),
	ws_message_admission_rejected_total: Object.freeze({
		reason: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['rate_limit', 'concurrency_limit', 'queue_full']) }),
		scope: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['connection', 'global']) })
	}),
	ws_message_duration_seconds: Object.freeze({
		kind: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['text', 'binary']) }),
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['ok', 'error']) })
	}),
	ws_publish_outcomes_total: Object.freeze({
		outcome: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['delivered', 'no_subscribers']) })
	}),
	protection_posture_transitions_total: Object.freeze({
		from: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['normal', 'elevated', 'siege']) }),
		to: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['normal', 'elevated', 'siege']) })
	}),
	pressure_reason_transitions_total: Object.freeze({
		from: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(Object.keys(PRESSURE_REASON_CODES)) }),
		to: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(Object.keys(PRESSURE_REASON_CODES)) })
	}),
	state_divergence_total: Object.freeze({
		role: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['majority', 'minority']) })
	}),
	relay_spill_quarantines_total: Object.freeze({
		reason: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['bytes', 'age']) })
	}),
	framework_assertion_violations_total: Object.freeze({
		category: Object.freeze({
			kind: 'pattern',
			dataClass: 'operational',
			pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
			maxDistinct: 64
		}),
		severity: Object.freeze({ kind: 'enum', dataClass: 'operational', values: Object.freeze(['soft', 'fatal']) })
	}),
	framework_resource_growth_suspected_total: Object.freeze({
		resource: Object.freeze({
			kind: 'enum',
			dataClass: 'operational',
			values: Object.freeze([
				'wsConnections', 'topicPublishStats', 'lastPublishWarnAt',
				'decodeCache', 'envelopePrefixCache', 'staticCache'
			])
		})
	})
});

function noDataFor(signal) {
	if (signal.merged === true) {
		return Object.freeze({ local: 'not_exposed', snapshot: 'always_present' });
	}
	if (signal.type === 'histogram') {
		return Object.freeze({ local: 'registry_histogram_zero', snapshot: 'zero_when_registered' });
	}
	if (signal.optional === true) {
		return Object.freeze({ local: 'absent_when_unavailable', snapshot: 'absent_when_unavailable' });
	}
	if (signal.type === 'counter') {
		return Object.freeze({ local: 'registry_zero', snapshot: 'zero_when_complete' });
	}
	return Object.freeze({ local: 'last_sample', snapshot: 'incomplete_until_sampled' });
}

function completeSignal(signal) {
	const labelDomains = LABEL_DOMAINS[signal.name] ?? Object.freeze({});
	for (const label of signal.labels) {
		if (labelDomains[label] === undefined) {
			throw new Error(`observability manifest: ${signal.name} has no domain for label ${label}`);
		}
	}
	const valueDomain = signal.name === 'protection_posture_state'
		? Object.freeze({ normal: 0, elevated: 1, siege: 2 })
		: signal.name === 'pressure_reason'
			? PRESSURE_REASON_CODES
			: null;
	return Object.freeze({
		...signal,
		buckets: signal.buckets ?? null,
		schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
		dataClass: 'operational',
		labelDomains,
		noData: noDataFor(signal),
		valueDomain
	});
}

export const SIGNALS = Object.freeze(SIGNAL_DEFINITIONS.map(completeSignal));

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

/**
 * Validate a candidate observability contract without mutating it.
 *
 * Exported so sibling packages and release tooling can fail closed on schema
 * drift instead of copying a partial list of fields.
 *
 * @param {readonly Signal[]} [signals]
 * @param {typeof TELEMETRY_CONTRACT} [contract]
 * @returns {string[]}
 */
export function validateObservabilityContract(
	signals = SIGNALS,
	contract = TELEMETRY_CONTRACT
) {
	const errors = [];
	if (contract?.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
		errors.push('contract schemaVersion must match OBSERVABILITY_SCHEMA_VERSION');
	}
	const fields = contract?.eventEnvelope?.fields;
	for (const name of ['schemaVersion', 'occurredAt', 'level', 'event', 'component', 'dataClass']) {
		if (fields?.[name]?.required !== true) errors.push(`event field ${name} must be required`);
	}
	for (const [name, field] of Object.entries(fields ?? {})) {
		if (!Object.hasOwn(DATA_CLASSES, field.dataClass)) {
			errors.push(`event field ${name} has an unknown data class`);
		}
	}
	if (JSON.stringify(fields?.level?.values) !== JSON.stringify(TELEMETRY_LEVELS)) {
		errors.push('event level domain must exactly match TELEMETRY_LEVELS');
	}
	for (const name of ['requestId', 'traceparent', 'tracestate']) {
		if (contract?.correlation?.[name]?.field !== name) {
			errors.push(`correlation field ${name} is missing or renamed`);
		}
		if (contract?.correlation?.[name]?.dataClass !== 'pseudonymous' ||
			typeof contract?.correlation?.[name]?.supported !== 'boolean') {
			errors.push(`correlation field ${name} needs pseudonymous classification and support truth`);
		}
	}
	if (contract?.metrics?.dataClass !== 'operational' ||
		contract?.metrics?.labelCardinality !== 'bounded' ||
		contract?.metrics?.namePrefix !== 'canonical-unprefixed') {
		errors.push('metric contract must remain operational, bounded, and canonical-unprefixed');
	}
	const names = new Set();
	const policies = new Set(Object.keys(NO_DATA_POLICIES));
	for (const signal of signals) {
		if (names.has(signal.name)) errors.push(`${signal.name}: duplicate metric name`);
		names.add(signal.name);
		// Structural legality and naming convention. These are the rules a
		// sibling package is most likely to break when declaring its own
		// signals - a millisecond-valued name or an averaged counter merges
		// into a document that silently reads 1000x or divides a count - so
		// the exported validator has to carry them, not only this repo's test.
		if (!['counter', 'gauge', 'histogram'].includes(signal.type)) {
			errors.push(`${signal.name}: unknown type ${signal.type}`);
		}
		if (!['sum', 'max', 'min'].includes(signal.aggregate)) {
			errors.push(`${signal.name}: unknown aggregation law ${signal.aggregate}`);
		}
		if (!['worker', 'process'].includes(signal.scope)) {
			errors.push(`${signal.name}: unknown scope ${signal.scope}`);
		}
		// A process-wide reading is the same number on every worker, so adding
		// them up multiplies one truth by the worker count.
		if (signal.scope === 'process' && signal.aggregate === 'sum') {
			errors.push(`${signal.name}: process-scoped values must not sum across workers`);
		}
		// A counter only ever accumulates, so summing is the only law that
		// preserves what it counted; the same holds for histogram buckets.
		if (signal.type === 'counter' && signal.aggregate !== 'sum') {
			errors.push(`${signal.name}: counters must sum across workers, not ${signal.aggregate}`);
		}
		if (signal.type === 'histogram' && signal.aggregate !== 'sum') {
			errors.push(`${signal.name}: histograms must sum across workers, not ${signal.aggregate}`);
		}
		if (signal.name.endsWith('_total') !== (signal.type === 'counter')) {
			errors.push(`${signal.name}: the _total suffix and the counter type must agree`);
		}
		if (signal.unit === 'bytes' && !(signal.type === 'counter'
			? signal.name.endsWith('_bytes_total')
			: signal.name.endsWith('_bytes'))) {
			errors.push(`${signal.name}: byte-valued metrics end in _bytes (before _total for counters)`);
		}
		if (signal.unit === 'seconds' && !signal.name.endsWith('_seconds')) {
			errors.push(`${signal.name}: second-valued metrics end in _seconds`);
		}
		// The house convention is no millisecond-valued metric at all - a
		// mixed-unit metric set is how a dashboard silently reads 1000x.
		if (/_ms$|_milliseconds$/.test(signal.name)) {
			errors.push(`${signal.name}: durations are seconds, never milliseconds`);
		}
		if (signal.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
			errors.push(`${signal.name}: schemaVersion mismatch`);
		}
		if (signal.dataClass !== 'operational') {
			errors.push(`${signal.name}: metrics must use the operational data class`);
		}
		if (!policies.has(signal.noData?.local) || !policies.has(signal.noData?.snapshot)) {
			errors.push(`${signal.name}: unknown or missing no-data policy`);
		}
		const domainNames = Object.keys(signal.labelDomains ?? {}).sort();
		const labelNames = [...signal.labels].sort();
		if (JSON.stringify(domainNames) !== JSON.stringify(labelNames)) {
			errors.push(`${signal.name}: labelDomains must exactly match labels`);
		}
		for (const label of signal.labels) {
			const domain = signal.labelDomains?.[label];
			if (domain?.dataClass !== 'operational') {
				errors.push(`${signal.name}.${label}: label data class must be operational`);
			}
			if (domain?.kind === 'enum') {
				if (!Array.isArray(domain.values) || domain.values.length === 0 ||
					new Set(domain.values).size !== domain.values.length ||
					domain.values.some((value) => typeof value !== 'string' || value.length === 0)) {
					errors.push(`${signal.name}.${label}: enum domain must be unique non-empty strings`);
				}
			} else if (domain?.kind === 'pattern') {
				if (typeof domain.pattern !== 'string' || !(domain.maxDistinct > 0)) {
					errors.push(`${signal.name}.${label}: pattern domain needs a pattern and positive cap`);
				}
			} else {
				errors.push(`${signal.name}.${label}: unknown label domain kind`);
			}
		}
		if (signal.unit === 'enum') {
			if (signal.valueDomain === null || Object.keys(signal.valueDomain).length === 0) {
				errors.push(`${signal.name}: enum signal needs a valueDomain`);
			}
		} else if (signal.valueDomain !== null) {
			errors.push(`${signal.name}: non-enum signal must not declare a valueDomain`);
		}
		if (signal.type === 'histogram') {
			if (signal.unit !== 'seconds') errors.push(`${signal.name}: duration histogram must use seconds`);
			if (!Array.isArray(signal.buckets) || signal.buckets.length === 0 ||
				signal.buckets.some((value, index) =>
					typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
					(index > 0 && value <= signal.buckets[index - 1]))) {
				errors.push(`${signal.name}: histogram buckets must be finite, positive, and strictly increasing`);
			}
		} else if (signal.buckets !== null) {
			errors.push(`${signal.name}: non-histogram signal must not declare buckets`);
		}
	}
	return errors;
}
