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
 * @param {Array<{ worker: string | number, samples: Array<{ name: string, labels: Record<string, string>, value: number }> }>} reports
 * @param {{ expected: number, reporting?: number, degraded?: boolean }} context
 *   The CONFIGURED worker count, how many answered, and whether the collection
 *   completed at all. `reporting` is passed rather than derived from
 *   `reports.length` because a worker with nothing mirrored answers correctly
 *   and contributes no series; conflating the two would show a permanent
 *   shortfall on any cluster running a compute worker.
 * @returns {string} Prometheus exposition text.
 */
export function mergeSamples(reports, context) {
	// name -> seriesKey -> { labels, values }
	/** @type {Map<string, Map<string, { labels: Record<string, string>, values: number[] }>>} */
	const collected = new Map();

	for (const report of reports) {
		if (report === null || report === undefined || !Array.isArray(report.samples)) continue;
		for (const sample of report.samples) {
			if (sample === null || typeof sample !== 'object') continue;
			if (!SIGNALS_BY_NAME.has(sample.name)) continue;
			const labels = sample.labels !== null && typeof sample.labels === 'object' ? sample.labels : {};
			const value = typeof sample.value === 'number' ? sample.value : NaN;
			let series = collected.get(sample.name);
			if (series === undefined) collected.set(sample.name, (series = new Map()));
			const key = seriesKey(labels);
			const existing = series.get(key);
			if (existing === undefined) series.set(key, { labels, values: [value] });
			else existing.values.push(value);
		}
	}

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
		if (context.degraded === true && signal.type === 'counter') continue;
		const series = collected.get(signal.name);
		if (series === undefined) continue;
		out.push(`# HELP ${signal.name} ${signal.help}`);
		out.push(`# TYPE ${signal.name} ${signal.type}`);
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
			value = typeof context.reporting === 'number' ? context.reporting : reports.length;
		} else value = context.degraded === true ? 1 : 0;
		out.push(`# HELP ${signal.name} ${signal.help}`);
		out.push(`# TYPE ${signal.name} ${signal.type}`);
		out.push(`${signal.name} ${formatValue(value)}`);
	}

	return out.join('\n') + '\n';
}
