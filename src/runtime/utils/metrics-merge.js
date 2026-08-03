// Merge several worker threads' mirrored metric values into one cluster-level
// Prometheus document.
//
// Every worker thread evaluates the metrics module independently, so each holds
// its own instrument objects, and every worker serves the same port - so a
// scrape reaches whichever worker the kernel or the acceptor happened to pick.
// Counters appear to jump backwards as consecutive scrapes land on different
// workers, gauges alias, and every rate() over them is noise. There is no
// per-worker port to scrape instead.
//
// What crosses the thread boundary is the VALUES THE ADAPTER ITSELF WROTE
// (src/runtime/utils/metrics.js mirrors every contained emit), not the
// registry's rendered exposition text. Merging text was tried and is wrong:
//
//   - The registry may namespace its output, which is the documented way to
//     use it. Prefixed text no longer matches any declared name, so the merge
//     degrades to per-worker passthrough and sums a process-wide descriptor
//     count by the worker count - the precise failure this exists to prevent,
//     with every completeness signal still reporting the document healthy.
//   - Exposition text is a lossy, evolving surface. Exemplars, OpenMetrics
//     quoted names, histogram family metadata and label ordering each have to
//     be parsed exactly right or a series is dropped, mis-valued, or emitted
//     twice into a document Prometheus rejects whole.
//   - The text is unbounded and carries whatever the app registered, including
//     label values holding topic names and user identifiers.
//
// Mirrored values have none of those properties: they are keyed by the
// adapter's own declared names, bounded by the manifest's cardinality, and
// contain only source-declared label vocabularies.

import { SIGNALS, SIGNALS_BY_NAME } from '../observability-manifest.js';
import { METRIC_REGISTRATIONS_SAMPLE } from './metrics.js';

// A required counter is complete once its factory registered: no mirrored
// value means a truthful zero-event family. A required gauge needs a numeric
// sample as well; registration alone cannot invent the connection count or
// heap ratio of a worker whose first sampler tick has not completed.
const REQUIRED_WORKER_SIGNALS = SIGNALS.filter((signal) =>
	signal.merged !== true && signal.optional !== true && signal.scope === 'worker'
);

/**
 * The bounded registration inventory carried by a current worker report.
 * `null` means the report predates the inventory protocol; an empty Set means
 * the marker was present but no adapter family had registered yet.
 *
 * @param {{ samples?: any[] }} report
 * @returns {Set<string> | null}
 */
function registeredFamilies(report) {
	if (!Array.isArray(report?.samples)) return null;
	const marker = report.samples.find((sample) =>
		sample !== null && typeof sample === 'object' && sample.name === METRIC_REGISTRATIONS_SAMPLE
	);
	if (marker === undefined) return null;
	return new Set(Array.isArray(marker.families) ? marker.families : []);
}

/**
 * Whether one real worker report contains the minimum data needed to call it
 * reporting. A report without the registration inventory cannot prove that
 * required zero-valued counters exist, so legacy marker-free reports fail
 * closed even when they contain numeric samples.
 *
 * @param {{ samples?: any[] }} report
 */
function reportIsComplete(report) {
	if (!Array.isArray(report?.samples) || report.samples.length === 0) return false;
	const registered = registeredFamilies(report);
	if (registered === null) return false;
	const sampled = new Set();
	for (const sample of report.samples) {
		if (sample !== null && typeof sample === 'object' &&
			SIGNALS_BY_NAME.has(sample.name) && typeof sample.value === 'number') {
			sampled.add(sample.name);
		}
	}
	return REQUIRED_WORKER_SIGNALS.every((signal) =>
		registered.has(signal.name) && (signal.type === 'counter' || sampled.has(signal.name))
	);
}

/**
 * Render a number in exposition format. Non-finite values are spelled out;
 * ordinary integers avoid exponent notation.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatValue(value) {
	if (Number.isNaN(value)) return 'NaN';
	if (value === Infinity) return '+Inf';
	if (value === -Infinity) return '-Inf';
	return String(value);
}

/**
 * Stable, sorted key for a label set, so the same labels emitted in a
 * different order are one series rather than two.
 *
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function seriesKey(labels) {
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	return keys.map((k) => k + '=' + labels[k]).join(',');
}

/**
 * Render a label block, or the empty string when unlabelled.
 *
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function renderLabels(labels) {
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	const parts = keys.map((k) => {
		const v = String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
		return `${k}="${v}"`;
	});
	return `{${parts.join(',')}}`;
}

/**
 * Render one cumulative histogram family.
 *
 * @param {string[]} out
 * @param {string} name
 * @param {Record<string, string>} labels
 * @param {readonly number[]} buckets
 * @param {readonly number[]} counts
 * @param {number} count
 * @param {number} sum
 */
function renderHistogram(out, name, labels, buckets, counts, count, sum) {
	for (let i = 0; i < buckets.length; i++) {
		out.push(`${name}_bucket${renderLabels({ ...labels, le: formatValue(buckets[i]) })} ${formatValue(counts[i])}`);
	}
	out.push(`${name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${formatValue(count)}`);
	out.push(`${name}_sum${renderLabels(labels)} ${formatValue(sum)}`);
	out.push(`${name}_count${renderLabels(labels)} ${formatValue(count)}`);
}

/**
 * Combine values under one aggregation law, ignoring NaN contributions unless
 * every contribution is NaN.
 *
 * @param {number[]} values
 * @param {'sum' | 'max' | 'min'} law
 * @returns {number}
 */
function combine(values, law) {
	const real = values.filter((v) => !Number.isNaN(v));
	if (real.length === 0) return NaN;
	if (law === 'sum') return real.reduce((a, b) => a + b, 0);
	if (law === 'max') return real.reduce((a, b) => (b > a ? b : a));
	return real.reduce((a, b) => (b < a ? b : a));
}

/**
 * Merge per-worker mirrored samples into one exposition document.
 *
 * Only names the manifest declares are merged. A sample carrying any other
 * name cannot occur through the adapter's own emit path, and is dropped rather
 * than guessed at - the merge never invents an aggregation law.
 *
 * @param {Array<{ worker: string | number, samples: any[] }>} reports
 * @param {{ expected: number, reporting?: number, degraded?: boolean }} context
 *   The CONFIGURED worker count, how many answered IPC, and whether the
 *   collection completed at all. The rendered reporting count discounts an
 *   answered worker whose required factories/gauge samples are incomplete.
 * @returns {string} Prometheus exposition text.
 */
export function mergeSamples(reports, context) {
	// name -> seriesKey -> { labels, values }
	/** @type {Map<string, Map<string, { labels: Record<string, string>, values: number[] }>>} */
	const collected = new Map();
	/** @type {Map<string, Map<string, {
	 *   labels: Record<string, string>,
	 *   values: Array<{ buckets: number[], counts: number[], count: number, sum: number }>
	 * }>>} */
	const histogramCollected = new Map();

	for (const report of reports) {
		if (report === null || report === undefined || !Array.isArray(report.samples)) continue;
		for (const sample of report.samples) {
			if (sample === null || typeof sample !== 'object') continue;
			const signal = SIGNALS_BY_NAME.get(sample.name);
			if (signal === undefined) continue;
			const labels = sample.labels !== null && typeof sample.labels === 'object' ? sample.labels : {};
			if (signal.type === 'histogram') {
				const histogram = sample.histogram;
				if (histogram === null || typeof histogram !== 'object' ||
					!Array.isArray(histogram.buckets) || !Array.isArray(histogram.counts) ||
					histogram.buckets.length !== signal.buckets.length ||
					histogram.counts.length !== signal.buckets.length ||
					!histogram.buckets.every((bound, index) => bound === signal.buckets[index]) ||
					!histogram.counts.every((value, index) =>
						Number.isInteger(value) && value >= 0 &&
						(index === 0 || value >= histogram.counts[index - 1])) ||
					!Number.isInteger(histogram.count) || histogram.count < 0 ||
					histogram.counts.some((value) => value > histogram.count) ||
					!Number.isFinite(histogram.sum) || histogram.sum < 0) continue;
				let series = histogramCollected.get(sample.name);
				if (series === undefined) histogramCollected.set(sample.name, (series = new Map()));
				const key = seriesKey(labels);
				const existing = series.get(key);
				const value = {
					buckets: histogram.buckets,
					counts: histogram.counts,
					count: histogram.count,
					sum: histogram.sum
				};
				if (existing === undefined) series.set(key, { labels, values: [value] });
				else existing.values.push(value);
				continue;
			}
			const value = typeof sample.value === 'number' ? sample.value : NaN;
			let series = collected.get(sample.name);
			if (series === undefined) collected.set(sample.name, (series = new Map()));
			const key = seriesKey(labels);
			const existing = series.get(key);
			if (existing === undefined) series.set(key, { labels, values: [value] });
			else existing.values.push(value);
		}
	}

	// `context.reporting` says how many workers answered IPC. A worker that
	// answered before its metric factories or first gauge sample finished is not
	// reporting a complete metrics document. Count those separately here so a
	// restart/partial initialization can never yield expected=reporting while
	// silently omitting required worker-scoped families.
	const answered = typeof context.reporting === 'number' ? context.reporting : reports.length;
	const currentWorkerReports = reports.filter((report) =>
		report !== null && typeof report === 'object' && typeof report.worker === 'number'
	);
	const completeCurrentWorkers = currentWorkerReports.filter(reportIsComplete).length;
	const reporting = Math.max(0, answered - (currentWorkerReports.length - completeCurrentWorkers));
	const currentRegistrations = currentWorkerReports.map(registeredFamilies);
	// Registration is enough to prove a counter that has never been incremented
	// is a truthful zero. Use that fact only for a complete, non-degraded current
	// roster: an incomplete report must stay visibly incomplete rather than
	// letting another worker's inventory fabricate a healthy-looking family.
	const healthyRegistrationEvidence = context.degraded !== true &&
		context.expected > 0 && reporting === context.expected &&
		currentWorkerReports.length === context.expected &&
		currentRegistrations.every((families) => families !== null);

	const out = [];
	// Manifest order, so two scrapes are diffable and the document is stable.
	for (const signal of SIGNALS) {
		if (signal.merged === true) continue;
		// A DEGRADED document is one worker's view of an N-worker cluster, so its
		// counters are a fraction of the cluster's. Emitting them would publish a
		// smaller value for a series that only ever grows, and Prometheus reads
		// that as a counter reset - charging the recovery as traffic that never
		// happened. Omitting the family instead leaves a gap, which is read as
		// staleness and leaves rate() intact. The gauges are still useful and are
		// still emitted; `metrics_snapshot_degraded` says what this document is.
		if (context.degraded === true && (signal.type === 'counter' || signal.type === 'histogram')) continue;
		if (signal.type === 'histogram') {
			const series = histogramCollected.get(signal.name);
			const registeredZeroFamily = series === undefined &&
				healthyRegistrationEvidence && currentRegistrations.every((families) =>
					/** @type {Set<string>} */ (families).has(signal.name)
				);
			if (series === undefined && !registeredZeroFamily) continue;
			out.push(`# HELP ${signal.name} ${signal.help}`);
			out.push(`# TYPE ${signal.name} histogram`);
			if (series === undefined) {
				if (signal.labels.length === 0) {
					renderHistogram(out, signal.name, {}, signal.buckets, signal.buckets.map(() => 0), 0, 0);
				}
				continue;
			}
			for (const key of [...series.keys()].sort()) {
				const entry = series.get(key);
				const counts = signal.buckets.map((_bound, index) =>
					entry.values.reduce((total, value) => total + value.counts[index], 0)
				);
				const count = entry.values.reduce((total, value) => total + value.count, 0);
				const sum = entry.values.reduce((total, value) => total + value.sum, 0);
				renderHistogram(out, signal.name, entry.labels, signal.buckets, counts, count, sum);
			}
			continue;
		}
		const series = collected.get(signal.name);
		const registeredZeroFamily = series === undefined && signal.type === 'counter' &&
			signal.optional !== true && signal.scope === 'worker' &&
			healthyRegistrationEvidence && currentRegistrations.every((families) =>
				/** @type {Set<string>} */ (families).has(signal.name)
			);
		if (series === undefined && !registeredZeroFamily) continue;
		out.push(`# HELP ${signal.name} ${signal.help}`);
		out.push(`# TYPE ${signal.name} ${signal.type}`);
		if (series === undefined) {
			// An unlabelled counter has exactly one knowable zero series. For a
			// labelled family the factory proves the FAMILY exists, but no label
			// values exist until the first event; render its metadata without
			// inventing a synthetic label combination that would persist forever.
			if (signal.labels.length === 0) out.push(`${signal.name} 0`);
			continue;
		}
		for (const key of [...series.keys()].sort()) {
			const entry = /** @type {{ labels: Record<string, string>, values: number[] }} */ (series.get(key));
			out.push(`${signal.name}${renderLabels(entry.labels)} ${formatValue(combine(entry.values, signal.aggregate))}`);
		}
	}

	// The merge's own completeness, always present. A scrape that reached fewer
	// workers than it asked must not read as a real drop in every summed series.
	for (const signal of SIGNALS) {
		if (signal.merged !== true) continue;
		let value;
		if (signal.name === 'metrics_snapshot_workers_expected') value = context.expected;
		else if (signal.name === 'metrics_snapshot_workers_reporting') {
			value = reporting;
		} else value = context.degraded === true ? 1 : 0;
		out.push(`# HELP ${signal.name} ${signal.help}`);
		out.push(`# TYPE ${signal.name} ${signal.type}`);
		out.push(`${signal.name} ${formatValue(value)}`);
	}

	return out.join('\n') + '\n';
}
