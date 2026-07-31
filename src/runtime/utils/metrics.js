/**
 * Wrap a metric instrument so an emit can never throw into the caller, and so
 * the value is mirrored for cluster collection.
 *
 * CONTAINMENT. The admission and pressure paths emit from inside uWS native
 * callbacks and timer callbacks, where an exception would skip the HTTP
 * response, leak an in-flight admission slot, or kill the sampler. A registry
 * is operator config - trusted like the upgrade hook, and contained like it.
 * The first failure logs; repeats from the same instrument are silent so a
 * broken registry cannot flood the log once per rejection. Registration is
 * deliberately NOT contained: a registry that throws while creating an
 * instrument fails at startup, loudly, which is the right failure mode for
 * configuration.
 *
 * MIRRORING. Every value the runtime writes is also recorded here, keyed by
 * the adapter's own declared metric name. `platform.metricsSnapshot()` merges
 * those mirrors across worker threads rather than merging the registries'
 * rendered text, and the difference matters:
 *
 * - A registry may namespace its output (`createMetrics({ prefix })` is the
 *   documented way to do it). Text arrives as `app_open_fds` and no longer
 *   matches anything the manifest declares, so a merge keyed on rendered names
 *   silently degrades to per-worker passthrough - summing a process-wide
 *   descriptor count by the worker count, which is the exact failure the
 *   cluster merge exists to prevent.
 * - Exposition text is a lossy, evolving surface: exemplars, OpenMetrics
 *   quoted names, histogram family metadata and label ordering all have to be
 *   parsed correctly or a series is dropped, mis-valued, or duplicated into a
 *   document Prometheus rejects whole.
 * - The text is unbounded and contains whatever the app registered, including
 *   label values carrying topic names and user identifiers. Mirroring only
 *   what the adapter itself wrote keeps that off the thread boundary by
 *   construction.
 *
 * The mirror is per worker thread (module state), bounded by the manifest's
 * own metric and label cardinality, and costs one Map write per emit - emits
 * that already happen at most once per admission decision or once per pressure
 * sample.
 *
 * @module
 */

/**
 * name -> labelKey -> { labels, value }
 *
 * @type {Map<string, Map<string, { labels: Record<string, string>, value: number }>>}
 */
const mirror = new Map();

// Separator for the label-set key below. A label VALUE is arbitrary text, so a
// printable separator can be forged: `{a: 'x,b', c: 'y'}` and
// `{a: 'x', 'b,c': 'y'}` would key alike and two distinct series would silently
// merge into one wrong number. NUL cannot occur in a label a caller can supply.
//
// Built from a char code rather than embedded literally: a raw NUL byte in the
// source makes the whole file binary to git, and a file that cannot be diffed
// cannot be reviewed.
const LABEL_SEP = String.fromCharCode(0);

/**
 * Stable key for a label set. Sorted, so two emits that pass the same labels
 * in a different order are one series rather than two.
 *
 * @param {Record<string, string> | undefined} labels
 * @returns {string}
 */
function labelKey(labels) {
	if (labels === undefined || labels === null) return '';
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	let out = '';
	for (const k of keys) out += k + LABEL_SEP + String(labels[k]) + LABEL_SEP;
	return out;
}

/**
 * @param {string} name
 * @param {Record<string, string> | undefined} labels
 * @param {number} delta
 * @param {boolean} absolute Replace rather than accumulate (a gauge set).
 */
function record(name, labels, delta, absolute) {
	let series = mirror.get(name);
	if (series === undefined) mirror.set(name, (series = new Map()));
	const key = labelKey(labels);
	const existing = series.get(key);
	if (existing === undefined) {
		series.set(key, { labels: labels === undefined || labels === null ? {} : { ...labels }, value: delta });
	} else {
		existing.value = absolute ? delta : existing.value + delta;
	}
}

/**
 * This worker's mirrored values, as a structured-clone-friendly array. Only
 * the adapter's own metrics are here; an app's metrics live on its registry
 * and are never collected across the thread boundary.
 *
 * @returns {Array<{ name: string, labels: Record<string, string>, value: number }>}
 */
export function readMetricMirror() {
	const out = [];
	for (const [name, series] of mirror) {
		for (const entry of series.values()) {
			out.push({ name, labels: entry.labels, value: entry.value });
		}
	}
	return out;
}

/** Drop every mirrored value. For tests and for a harness that rebuilds a server. */
export function resetMetricMirror() {
	mirror.clear();
}

/**
 * Wrap a registry so every instrument it hands out also mirrors its values
 * under the name it was registered with.
 *
 * Wrapping the REGISTRY rather than each instrument is what keeps the metric
 * name in exactly one place per metric: the factory call already carries it, so
 * nothing at the ~20 registration sites changes, and the static contract test
 * that reads those literal names keeps working unmodified.
 *
 * The returned object is not the app's registry - `platform.metrics` still
 * exposes the real one, so an app's own scrape route is untouched.
 *
 * @param {any} registry
 * @returns {any}
 */
export function mirrorRegistry(registry) {
	if (registry == null) return registry;
	// A non-object cannot carry factories. Return null rather than the value:
	// optional chaining short-circuits only on nullish, so handing back a string
	// or a number would let `METRICS?.counter(...)` reach `.counter` on it and
	// throw at module evaluation in every worker - a boot kill naming neither
	// metrics nor the option that caused it. The build does no shape validation
	// (it forwards whatever the module default-exports), so this is reachable
	// configuration, and null is the shape the whole runtime already treats as
	// "no registry configured".
	if (typeof registry !== 'object' && typeof registry !== 'function') {
		console.error('[ws] the `metrics` module must default-export a registry object; got ' +
			typeof registry + '. Metrics are disabled.');
		return null;
	}
	/**
	 * @param {string} kind
	 * @param {(name: string, instrument: any) => any} shape
	 */
	const factory = (kind, shape) => (/** @type {any[]} */ ...args) => {
		const name = args[0];
		const instrument = typeof registry[kind] === 'function' ? registry[kind](...args) : undefined;
		if (typeof name !== 'string') return instrument;
		return shape(name, instrument);
	};
	// A PLAIN object carrying only the three factories, never a prototype chain
	// onto the caller's registry. `Object.create(registry)` plus assignment
	// throws in strict mode when the registry froze itself or defined `counter`
	// as a getter - `export default Object.freeze(createMetrics(...))` is an
	// entirely reasonable instinct, and it would have killed every worker at
	// module evaluation with a TypeError naming neither metrics nor the option
	// that caused it. This object is used for REGISTRATION only; `platform.metrics`
	// still exposes the operator's own registry untouched.
	/** @type {any} */
	const wrapped = {};
	wrapped.counter = factory('counter', (name, instrument) => ({
		inc(/** @type {any} */ labels, /** @type {any} */ value) {
			record(name, labels, typeof value === 'number' ? value : 1, false);
			instrument?.inc(labels, value);
		}
	}));
	wrapped.gauge = factory('gauge', (name, instrument) => ({
		set(/** @type {any} */ value) {
			if (typeof value === 'number') record(name, undefined, value, true);
			instrument?.set(value);
		}
	}));
	if (typeof registry.histogram === 'function') {
		wrapped.histogram = factory('histogram', (name, instrument) => ({
			observe(/** @type {any} */ labels, /** @type {any} */ value) {
				instrument?.observe(labels, value);
			}
		}));
	}
	return wrapped;
}

/**
 * @param {{ [method: string]: any } | null | undefined} instrument
 * @returns {any}
 */
export function containMetricInstrument(instrument) {
	if (instrument == null) return undefined;
	let warned = false;
	/** @param {Function} fn */
	const contain = (fn) => function (/** @type {any} */ a, /** @type {any} */ b) {
		try {
			fn.call(instrument, a, b);
		} catch (err) {
			if (!warned) {
				warned = true;
				console.error('[ws] metrics instrument threw; suppressing further errors from it:', err);
			}
		}
	};
	/** @type {any} */
	const wrapped = {};
	for (const method of ['inc', 'dec', 'set', 'observe']) {
		if (typeof instrument[method] === 'function') wrapped[method] = contain(instrument[method]);
	}
	return wrapped;
}
