// Contract: merging several workers' mirrored values must apply each metric's
// DECLARED aggregation law, and must never merge anything it does not declare.
//
// This is the correctness core of the cluster metrics snapshot. Every worker
// thread holds its own registry and they all serve one port, so a scrape reads
// an arbitrary worker; the merge is what turns that into the cluster's actual
// numbers. Getting a law wrong is silent and expensive in exactly one
// direction: summing a process-wide reading (open file descriptors, resident
// memory) multiplies one truth by the worker count, and a dashboard built on it
// reports a headroom problem that does not exist - or hides one that does.
//
// The values merged here are the ones the ADAPTER WROTE, mirrored at the
// registry wrapper, never a registry's rendered exposition text. That is not an
// implementation detail: a registry is documented to namespace its output, and
// a merge keyed on rendered names silently stops recognising every metric the
// moment someone sets a prefix.

import { describe, it, expect, beforeEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mergeSamples, formatValue } from '../src/runtime/utils/metrics-merge.js';
import { createMetricsCollections } from '../src/runtime/metrics-collector.js';
import { mirrorRegistry, containMetricInstrument, readMetricMirror, resetMetricMirror } from '../src/runtime/utils/metrics.js';
import { SIGNALS, SIGNALS_BY_NAME, aggregationFor } from '../src/runtime/observability-manifest.js';

/** Pull one series' value out of a merged document. */
function value(text, series) {
	const line = text.split('\n').find((l) => l.startsWith(series + ' ') || l.startsWith(series + '{'));
	if (line === undefined) return undefined;
	return line.slice(line.lastIndexOf(' ') + 1);
}

/** Every sample line for a metric name, in document order. */
function lines(text, name) {
	return text.split('\n').filter((l) => l.startsWith(name + ' ') || l.startsWith(name + '{'));
}

/** One worker's report. */
function report(worker, samples) {
	return { worker, samples: samples.map(([name, value, labels]) => ({ name, labels: labels ?? {}, value })) };
}

describe('the mirror records what the adapter writes', () => {
	beforeEach(() => resetMetricMirror());

	/** A minimal registry that satisfies the documented contract. */
	function fakeRegistry(prefix = '') {
		const seen = [];
		return {
			seen,
			counter: (name, help, labelNames) => {
				seen.push(prefix + name);
				return { inc() {} };
			},
			gauge: (name) => {
				seen.push(prefix + name);
				return { set() {} };
			}
		};
	}

	it('accumulates counters and replaces gauges, keyed by the declared name', () => {
		const registry = mirrorRegistry(fakeRegistry());
		const c = containMetricInstrument(registry.counter('upgrade_admitted_total', 'h'));
		const g = containMetricInstrument(registry.gauge('ws_connections', 'h'));
		c.inc({});
		c.inc({}, 4);
		g.set(10);
		g.set(7);
		const mirror = readMetricMirror();
		expect(mirror).toContainEqual({ name: 'upgrade_admitted_total', labels: {}, value: 5 });
		expect(mirror).toContainEqual({ name: 'ws_connections', labels: {}, value: 7 });
	});

	it('keeps a labelled counter split by its label set', () => {
		const registry = mirrorRegistry(fakeRegistry());
		const c = containMetricInstrument(registry.counter('upgrade_rejected_total', 'h', ['reason']));
		c.inc({ reason: 'siege' });
		c.inc({ reason: 'siege' }, 2);
		c.inc({ reason: 'bad_origin' });
		const mirror = readMetricMirror().filter((s) => s.name === 'upgrade_rejected_total');
		expect(mirror).toContainEqual({ name: 'upgrade_rejected_total', labels: { reason: 'siege' }, value: 3 });
		expect(mirror).toContainEqual({ name: 'upgrade_rejected_total', labels: { reason: 'bad_origin' }, value: 1 });
	});

	it('mirrors under the ADAPTER name even when the registry namespaces its own output', () => {
		// The failure this design exists to prevent. `createMetrics({ prefix })`
		// is the documented way to namespace, and it renames at registration. A
		// merge keyed on the registry's rendered names would stop recognising
		// every adapter metric the moment a prefix is set - and would then sum
		// open_fds across workers, which is the exact regression the law forbids.
		const inner = fakeRegistry('app_');
		const registry = mirrorRegistry(inner);
		containMetricInstrument(registry.gauge('open_fds', 'h')).set(900);
		expect(inner.seen).toContain('app_open_fds');
		expect(readMetricMirror()).toEqual([{ name: 'open_fds', labels: {}, value: 900 }]);
	});

	it('still records the value when the underlying registry throws on emit', () => {
		const registry = mirrorRegistry({
			counter: () => ({ inc() { throw new Error('registry is broken'); } }),
			gauge: () => ({ set() { throw new Error('registry is broken'); } })
		});
		const c = containMetricInstrument(registry.counter('upgrade_admitted_total', 'h'));
		expect(() => c.inc({}, 3)).not.toThrow();
		expect(readMetricMirror()).toEqual([{ name: 'upgrade_admitted_total', labels: {}, value: 3 }]);
	});

	it('passes a null registry through untouched, so metrics stay opt-in', () => {
		expect(mirrorRegistry(null)).toBeNull();
		expect(containMetricInstrument(undefined)).toBeUndefined();
		expect(readMetricMirror()).toEqual([]);
	});
});

describe('cluster merge applies the declared aggregation law', () => {
	it('sums counters across workers', () => {
		const merged = mergeSamples([
			report(1, [['upgrade_admitted_total', 10]]),
			report(2, [['upgrade_admitted_total', 32]])
		], { expected: 2, reporting: 2 });
		expect(value(merged, 'upgrade_admitted_total')).toBe('42');
	});

	it('sums per-worker gauges', () => {
		const merged = mergeSamples([
			report(1, [['ws_connections', 40]]),
			report(2, [['ws_connections', 40]])
		], { expected: 2, reporting: 2 });
		expect(value(merged, 'ws_connections')).toBe('80');
	});

	it('does NOT sum a process-wide reading every worker reports identically', () => {
		// Four workers each see the same 900 open descriptors because they share
		// one process fd table. Summing reads 3600 against a soft limit of 1024
		// and pages someone for a limit that is not being approached.
		const merged = mergeSamples([1, 2, 3, 4].map((w) =>
			report(w, [['open_fds', 900], ['fd_soft_limit', 1024]])
		), { expected: 4, reporting: 4 });
		expect(value(merged, 'open_fds')).toBe('900');
		expect(value(merged, 'fd_soft_limit')).toBe('1024');
	});

	it('takes the worst worker for saturation and posture', () => {
		const merged = mergeSamples([
			report(1, [['pressure_saturation', 0.1], ['protection_posture_state', 0]]),
			report(2, [['pressure_saturation', 0.9], ['protection_posture_state', 2]])
		], { expected: 2, reporting: 2 });
		expect(value(merged, 'pressure_saturation')).toBe('0.9');
		expect(value(merged, 'protection_posture_state')).toBe('2');
	});

	it('takes the STALEST sample timestamp, not the freshest', () => {
		// A snapshot is only as current as its most-behind contributor. Taking
		// the newest would hide a worker whose sampler has wedged behind a
		// sibling that is still ticking.
		const merged = mergeSamples([
			report(1, [['pressure_sample_timestamp_seconds', 1000]]),
			report(2, [['pressure_sample_timestamp_seconds', 700]])
		], { expected: 2, reporting: 2 });
		expect(value(merged, 'pressure_sample_timestamp_seconds')).toBe('700');
	});

	it('groups a labelled series by its label set and sums each independently', () => {
		const merged = mergeSamples([
			report(1, [['upgrade_rejected_total', 2, { reason: 'siege' }], ['upgrade_rejected_total', 1, { reason: 'bad_origin' }]]),
			report(2, [['upgrade_rejected_total', 5, { reason: 'siege' }]])
		], { expected: 2, reporting: 2 });
		expect(value(merged, 'upgrade_rejected_total{reason="bad_origin"}')).toBe('1');
		expect(value(merged, 'upgrade_rejected_total{reason="siege"}')).toBe('7');
	});

	it('treats the same labels in a different order as ONE series', () => {
		// Two workers can emit the same label set in different key order. Keying
		// on raw text would file them as two series with the same label set,
		// which Prometheus rejects as a duplicate sample - losing the whole
		// scrape, not just the metric.
		const merged = mergeSamples([
			report(1, [['protection_posture_transitions_total', 1, { from: 'normal', to: 'elevated' }]]),
			report(2, [['protection_posture_transitions_total', 2, { to: 'elevated', from: 'normal' }]])
		], { expected: 2, reporting: 2 });
		expect(lines(merged, 'protection_posture_transitions_total')).toEqual([
			'protection_posture_transitions_total{from="normal",to="elevated"} 3'
		]);
	});

	it('emits HELP and TYPE once per metric, from the manifest', () => {
		const merged = mergeSamples([report(1, [['ws_connections', 1]])], { expected: 1, reporting: 1 });
		expect(merged).toContain('# TYPE ws_connections gauge');
		expect(merged.split('\n').filter((l) => l.startsWith('# HELP ws_connections'))).toHaveLength(1);
		expect(merged).toContain('# HELP ws_connections ' + SIGNALS_BY_NAME.get('ws_connections').help);
	});

	it('ignores a NaN contribution unless every worker reports NaN', () => {
		const partial = mergeSamples([
			report(1, [['ws_connections', NaN]]),
			report(2, [['ws_connections', 7]])
		], { expected: 2, reporting: 2 });
		expect(value(partial, 'ws_connections')).toBe('7');
		const all = mergeSamples([
			report(1, [['ws_connections', NaN]]),
			report(2, [['ws_connections', NaN]])
		], { expected: 2, reporting: 2 });
		expect(value(all, 'ws_connections')).toBe('NaN');
	});

	it('spells non-finite values the way the exposition format does', () => {
		expect(formatValue(Infinity)).toBe('+Inf');
		expect(formatValue(-Infinity)).toBe('-Inf');
		expect(formatValue(NaN)).toBe('NaN');
		expect(formatValue(4294967296)).toBe('4294967296');
	});

	it('emits declared signals in manifest order, so two scrapes are diffable', () => {
		const merged = mergeSamples([
			report(1, [['ws_connections', 1], ['upgrade_admitted_total', 1], ['open_fds', 5]])
		], { expected: 1, reporting: 1 });
		const order = merged.split('\n')
			.filter((l) => l !== '' && !l.startsWith('#'))
			.map((l) => l.split(/[\s{]/)[0]);
		const manifestOrder = SIGNALS.map((s) => s.name);
		const seen = order.filter((n) => manifestOrder.includes(n));
		expect(seen).toEqual([...seen].sort((a, b) => manifestOrder.indexOf(a) - manifestOrder.indexOf(b)));
	});

	it('escapes a label value rather than emitting a document that reparses', () => {
		const merged = mergeSamples([
			report(1, [['upgrade_rejected_total', 1, { reason: 'a"b\\c\nd' }]])
		], { expected: 1, reporting: 1 });
		expect(lines(merged, 'upgrade_rejected_total')).toEqual([
			'upgrade_rejected_total{reason="a\\"b\\\\c\\nd"} 1'
		]);
	});
});

describe('the merge never touches what it does not declare', () => {
	it('drops a series the manifest does not declare rather than guessing a law', () => {
		// An app's metric means something the adapter cannot know. Guessing
		// "sum" because a name ends in _total would be a silent wrong answer;
		// app metrics stay on platform.metrics, per worker, where they are true.
		expect(aggregationFor('my_app_thing_total')).toBeNull();
		const merged = mergeSamples([
			report(1, [['my_app_thing_total', 5], ['ws_connections', 1]]),
			report(2, [['my_app_thing_total', 5], ['ws_connections', 1]])
		], { expected: 2, reporting: 2 });
		expect(merged).not.toContain('my_app_thing_total');
		expect(value(merged, 'ws_connections')).toBe('2');
	});

	it('cannot be made to forge a declared series from a foreign name', () => {
		const merged = mergeSamples([
			report(1, [['ws_connections\nws_connections', 999]])
		], { expected: 1, reporting: 1 });
		expect(merged).not.toContain('999');
	});

	it('survives a malformed report without throwing', () => {
		// A wedged route is worse than a wrong number: the promise is awaited by
		// the scrape, so anything that throws past the resolve point hangs every
		// later scrape on the same worker.
		const merged = mergeSamples([
			null,
			{ worker: 1 },
			{ worker: 2, samples: 'nonsense' },
			{ worker: 3, samples: [null, { name: 'ws_connections' }, { name: 'ws_connections', labels: null, value: 4 }] }
		], { expected: 4, reporting: 4 });
		// The sample with no `value` reads NaN and is skipped by the combine, so
		// the well-formed one still lands: a malformed neighbour degrades to a
		// missing contribution, never to a poisoned total.
		expect(value(merged, 'ws_connections')).toBe('4');
		expect(merged.endsWith('\n')).toBe(true);
	});
});

describe('cluster merge reports its own completeness', () => {
	it('states expected and reporting on every document', () => {
		const merged = mergeSamples([
			report(1, [['ws_connections', 1]]),
			report(2, [['ws_connections', 1]])
		], { expected: 3, reporting: 2 });
		expect(value(merged, 'metrics_snapshot_workers_expected')).toBe('3');
		expect(value(merged, 'metrics_snapshot_workers_reporting')).toBe('2');
		// The summed series is understated by the missing worker, which is
		// exactly why the two counts must ship alongside it.
		expect(value(merged, 'ws_connections')).toBe('2');
	});

	it('counts a worker that answered with nothing as having answered', () => {
		// A compute worker mirrors no traffic metrics, and a worker still
		// warming up has nothing yet. Deriving `reporting` from the number of
		// contributing reports would show a permanent shortfall on any cluster
		// running one, training the operator to ignore the signal.
		const merged = mergeSamples([report(1, [['ws_connections', 5]])], { expected: 2, reporting: 2 });
		expect(value(merged, 'metrics_snapshot_workers_reporting')).toBe('2');
		expect(value(merged, 'metrics_snapshot_degraded')).toBe('0');
	});

	it('flags a collection that never completed, which the expected/reporting pair cannot express', () => {
		// A worker whose collection failed does not know how many siblings it
		// has, so it can only report itself. If it claimed expected=1/reporting=1
		// with no other signal, an operator alerting on `reporting < expected`
		// would see a healthy-looking document that is one worker's view of an
		// N-worker cluster - the loudest possible failure, silently.
		const degraded = mergeSamples([report(4, [['ws_connections', 10]])], { expected: 1, reporting: 1, degraded: true });
		expect(value(degraded, 'metrics_snapshot_degraded')).toBe('1');
		expect(value(degraded, 'metrics_snapshot_workers_expected')).toBe('1');
		expect(value(degraded, 'metrics_snapshot_workers_reporting')).toBe('1');
	});

	it('omits counter families entirely from a degraded document', () => {
		// A degraded document is one worker's view of an N-worker cluster, so its
		// counters are a fraction of the cluster's. Publishing a SMALLER value for
		// a series that only grows is read by Prometheus as a counter reset, and
		// the recovery is then charged as traffic that never happened. A gap is
		// read as staleness instead and leaves rate() intact. Gauges still ship -
		// they are per-worker readings and remain meaningful on their own.
		const degraded = mergeSamples(
			[report(4, [['upgrade_admitted_total', 500], ['ws_connections', 10]])],
			{ expected: 1, reporting: 1, degraded: true }
		);
		expect(degraded).not.toContain('upgrade_admitted_total');
		expect(value(degraded, 'ws_connections')).toBe('10');
		expect(value(degraded, 'metrics_snapshot_degraded')).toBe('1');
	});

	it('produces a valid document with no reports at all', () => {
		const merged = mergeSamples([], { expected: 0, reporting: 0 });
		expect(value(merged, 'metrics_snapshot_workers_reporting')).toBe('0');
		expect(merged.endsWith('\n')).toBe(true);
	});

	it('never emits a merge-only series from a worker report', () => {
		// A worker's registry could contain these names (an app may register
		// anything). Emitting them from both the declared loop and the
		// completeness block would put the same series in twice, and Prometheus
		// rejects a document with a duplicate sample - losing the whole scrape.
		const merged = mergeSamples([
			report(1, [['metrics_snapshot_degraded', 1], ['metrics_snapshot_workers_expected', 99]])
		], { expected: 1, reporting: 1 });
		expect(lines(merged, 'metrics_snapshot_degraded')).toEqual(['metrics_snapshot_degraded 0']);
		expect(lines(merged, 'metrics_snapshot_workers_expected')).toEqual(['metrics_snapshot_workers_expected 1']);
	});
});

describe('the worker identity the primary cleans up with', () => {
	it('proves worker.threadId is unusable in an exit handler', () => {
		// Why src/runtime/index.js stamps threadId into `meta` at spawn instead of
		// reading it off the Worker when it dies.
		//
		// Node nulls the worker handle before emitting 'exit', so `worker.threadId`
		// degrades to -1 there. Every id-keyed cleanup in that handler - the carried
		// counter totals, the state-hash detector's forget(), the exit log line -
		// would silently address a worker that never existed. The carry mechanism
		// became dead code in production while its unit tests, which call retire()
		// with a literal, all passed.
		//
		// This drives a REAL worker rather than asserting the workaround, so it
		// keeps testing Node's behaviour: if a future Node stops degrading the id,
		// this fails and the stamped copy can go.
		return new Promise((resolve, reject) => {
			const worker = new Worker('setTimeout(() => process.exit(0), 1);', { eval: true });
			const atSpawn = worker.threadId;
			worker.on('error', reject);
			worker.on('exit', () => {
				try {
					expect(atSpawn).toBeGreaterThan(0);
					expect(
						worker.threadId,
						'Node no longer degrades worker.threadId after exit - the stamped meta.threadId copy in ' +
						'src/runtime/index.js can be removed, and this test with it'
					).toBe(-1);
					resolve();
				} catch (err) {
					reject(err);
				}
			});
		});
	});
});

describe('primary-side collection bookkeeping', () => {
	it('completes once every asked worker has answered', () => {
		const c = createMetricsCollections();
		c.begin('requester', 'id-1', [1, 2]);
		expect(c.note('id-1', 1, [{ name: 'ws_connections', labels: {}, value: 1 }])).toBe(false);
		expect(c.note('id-1', 2, [{ name: 'ws_connections', labels: {}, value: 2 }])).toBe(true);
		const entry = c.take();
		expect(entry?.reports).toHaveLength(2);
		expect(entry?.answered).toBe(2);
	});

	it('runs ONE collection cluster-wide; later requesters join it', () => {
		// The bound that actually matters. A per-worker guard lets N workers each
		// start a collection that fans out to all N - N squared serializations
		// and messages, from N concurrent hits on a scrape route the README's own
		// example leaves unauthenticated, landing on the thread that also relays
		// every cross-worker publish.
		const c = createMetricsCollections();
		expect(c.begin('worker-a', 'id-a', [1, 2, 3])).not.toBeNull();
		expect(c.begin('worker-b', 'id-b', [1, 2, 3])).toBeNull();
		expect(c.join('worker-b', 'id-b')).toBe(true);
		expect(c.join('worker-c', 'id-c')).toBe(true);
		const entry = c.take();
		expect(entry?.requesters.map((r) => r.id)).toEqual(['id-a', 'id-b', 'id-c']);
		// Each joiner minted its own correlation id and will not recognise
		// anyone else's, so every one of them must be answered.
		expect(entry?.requesters).toHaveLength(3);
	});

	it('does not add the same correlation id twice', () => {
		const c = createMetricsCollections();
		c.begin('worker-a', 'id-a', [1]);
		c.join('worker-a', 'id-a');
		expect(c.take()?.requesters).toHaveLength(1);
	});

	it('counts an empty report as answered but contributes no series', () => {
		const c = createMetricsCollections();
		c.begin('requester', 'id', [1, 2]);
		c.note('id', 1, []);
		expect(c.note('id', 2, [{ name: 'ws_connections', labels: {}, value: 2 }])).toBe(true);
		const entry = c.take();
		expect(entry?.reports).toHaveLength(1);
		expect(entry?.answered).toBe(2);
	});

	it('treats a worker that cannot be reached as one that will not answer', () => {
		const c = createMetricsCollections();
		c.begin('requester', 'id', [1, 2]);
		c.note('id', 1, [{ name: 'ws_connections', labels: {}, value: 1 }]);
		expect(c.missed(2)).toBe(true);
	});

	it('carries an exited worker\'s counter totals so the cluster sum never drops', () => {
		// Worker restarts are routine - the restart supervisor exists to make
		// them so. A respawned worker starts its counters at zero, and without a
		// carry the cluster sum falls by what it had accumulated; Prometheus
		// reads a decreasing counter as a reset and rate() spikes. Monotonicity
		// is the actual contract of a counter, so it is kept rather than
		// documented away.
		const c = createMetricsCollections();
		c.begin('r', 'id-1', [1, 2]);
		c.note('id-1', 1, [{ name: 'upgrade_admitted_total', labels: {}, value: 100 }]);
		c.note('id-1', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 50 }]);
		c.take();
		const before = mergeSamples([
			{ worker: 1, samples: [{ name: 'upgrade_admitted_total', labels: {}, value: 100 }] },
			{ worker: 2, samples: [{ name: 'upgrade_admitted_total', labels: {}, value: 50 }] }
		], { expected: 2, reporting: 2 });
		expect(value(before, 'upgrade_admitted_total')).toBe('150');

		c.retire(1);
		c.begin('r', 'id-2', [3, 2]);
		// Worker 1 respawned as thread 3 and has counted nothing yet.
		c.note('id-2', 3, [{ name: 'upgrade_admitted_total', labels: {}, value: 0 }]);
		c.note('id-2', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 60 }]);
		const entry = c.take();
		const after = mergeSamples(
			[...entry.reports, c.retiredReport()].filter(Boolean),
			{ expected: 2, reporting: 2 }
		);
		expect(value(after, 'upgrade_admitted_total')).toBe('160');
		expect(Number(value(after, 'upgrade_admitted_total'))).toBeGreaterThanOrEqual(Number(value(before, 'upgrade_admitted_total')));
	});

	it('stays monotonic when a worker dies INSIDE the collection window', () => {
		// Node delivers a worker's `message` before its `exit`, so a worker that
		// dies mid-collection has already been pushed into the open reports when
		// retire() runs. Folding its totals into the carried set as well counts
		// them twice for that scrape and once forever after: the series spikes
		// and then falls back - a decrease, which is the counter reset the carry
		// exists to prevent. It has to be counted exactly once.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		c.note('c1', 1, [{ name: 'upgrade_admitted_total', labels: {}, value: 100 }]);
		c.note('c1', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 50 }]);
		c.take();
		const first = mergeSamples([
			{ worker: 1, samples: [{ name: 'upgrade_admitted_total', labels: {}, value: 100 }] },
			{ worker: 2, samples: [{ name: 'upgrade_admitted_total', labels: {}, value: 50 }] }
		], { expected: 2, reporting: 2 });
		expect(value(first, 'upgrade_admitted_total')).toBe('150');

		// Scrape 2: worker 1 reports, then dies before the collection completes.
		c.begin('r', 'c2', [1, 2]);
		c.note('c2', 1, [{ name: 'upgrade_admitted_total', labels: {}, value: 100 }]);
		c.retire(1);
		c.note('c2', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 50 }]);
		const mid = c.take();
		const second = mergeSamples(
			[...mid.reports, c.retiredReport()].filter(Boolean), { expected: 2, reporting: 2 }
		);
		expect(value(second, 'upgrade_admitted_total')).toBe('150');

		// Scrape 3: the replacement thread has counted nothing yet.
		c.begin('r', 'c3', [3, 2]);
		c.note('c3', 3, [{ name: 'upgrade_admitted_total', labels: {}, value: 0 }]);
		c.note('c3', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 55 }]);
		const late = c.take();
		const third = mergeSamples(
			[...late.reports, c.retiredReport()].filter(Boolean), { expected: 2, reporting: 2 }
		);
		expect(value(third, 'upgrade_admitted_total')).toBe('155');

		const series = [first, second, third].map((d) => Number(value(d, 'upgrade_admitted_total')));
		expect(series).toEqual([...series].sort((a, b) => a - b));
	});

	it('rejects a stale report from a collection that already finished', () => {
		// A worker blocked past the deadline drains its queued collect requests
		// late. Absorbed into whichever collection is open, it is counted twice,
		// drives `pending` to zero early, and drops the workers that had not yet
		// answered - while `answered` still equals `expected`, so the document
		// reads healthy while double-counting one worker and omitting another.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		c.note('c1', 1, [{ name: 'ws_connections', labels: {}, value: 10 }]);
		c.take(); // deadline fired with worker 2 still owed

		c.begin('r', 'c2', [1, 2]);
		expect(c.note('c1', 2, [{ name: 'ws_connections', labels: {}, value: 99 }])).toBe(false);
		const entry = c.active();
		expect(entry.answered).toBe(0);
		expect(entry.pending).toBe(2);
		expect(entry.reports).toEqual([]);
	});

	it('rejects a second report from the same worker in one collection', () => {
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		expect(c.note('c1', 1, [{ name: 'ws_connections', labels: {}, value: 10 }])).toBe(false);
		expect(c.note('c1', 1, [{ name: 'ws_connections', labels: {}, value: 10 }])).toBe(false);
		const entry = c.active();
		expect(entry.answered).toBe(1);
		expect(entry.reports).toHaveLength(1);
	});

	it('carries counters only - a dead worker contributes no gauge', () => {
		const c = createMetricsCollections();
		c.begin('r', 'id', [1]);
		c.note('id', 1, [
			{ name: 'upgrade_admitted_total', labels: {}, value: 7 },
			{ name: 'ws_connections', labels: {}, value: 40 }
		]);
		c.take();
		c.retire(1);
		const carried = c.retiredReport();
		expect(carried?.samples).toEqual([{ name: 'upgrade_admitted_total', labels: {}, value: 7 }]);
	});

	it('accumulates across successive deaths and is idempotent per worker', () => {
		const c = createMetricsCollections();
		c.begin('r', 'a', [1]);
		c.note('a', 1, [{ name: 'relay_gap_frames_total', labels: {}, value: 3 }]);
		c.take();
		c.retire(1);
		c.retire(1);
		c.begin('r', 'b', [2]);
		c.note('b', 2, [{ name: 'relay_gap_frames_total', labels: {}, value: 4 }]);
		c.take();
		c.retire(2);
		expect(c.retiredReport()?.samples).toEqual([{ name: 'relay_gap_frames_total', labels: {}, value: 7 }]);
	});

	it('has nothing to carry before any worker has exited', () => {
		const c = createMetricsCollections();
		expect(c.retiredReport()).toBeNull();
		c.retire(99);
		expect(c.retiredReport()).toBeNull();
	});

	it('carries a LIVE worker that missed the deadline, so the sum does not dip', () => {
		// No death required, and this is the common case: one worker inside a long
		// synchronous stretch or a major GC misses the collect. Dropping it makes
		// the cluster counter fall and then recover, which Prometheus records as a
		// counter reset and charges the recovery as traffic that never happened.
		// A per-worker counter never decreases, so re-using its last known total
		// is monotone: the document undercounts it for one scrape, never erases it.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		c.note('c1', 1, [{ name: 'upgrade_admitted_total', labels: {}, value: 1000 }]);
		c.note('c1', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 1000 }]);
		const first = c.take();
		expect(value(mergeSamples(first.reports, { expected: 2, reporting: 2 }), 'upgrade_admitted_total')).toBe('2000');

		// Second collection: worker 2 is blocked and never answers.
		c.begin('r', 'c2', [1, 2]);
		c.note('c2', 1, [{ name: 'upgrade_admitted_total', labels: {}, value: 1100 }]);
		const second = c.take();
		expect(second.stale).toEqual([{ name: 'upgrade_admitted_total', labels: {}, value: 1000 }]);
		const doc = mergeSamples(
			[...second.reports, { worker: 'stale', samples: second.stale }],
			{ expected: 2, reporting: 1 }
		);
		expect(value(doc, 'upgrade_admitted_total')).toBe('2100');
	});

	it('carries only counters for a missing worker, never its gauges', () => {
		// A stale gauge is a wrong number, not a lagging one - the absent worker's
		// connection count is not what it was a scrape ago.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		c.note('c1', 1, [
			{ name: 'upgrade_admitted_total', labels: {}, value: 10 },
			{ name: 'ws_connections', labels: {}, value: 40 }
		]);
		c.note('c1', 2, [{ name: 'upgrade_admitted_total', labels: {}, value: 5 }]);
		c.take();
		c.begin('r', 'c2', [1, 2]);
		const entry = c.take();
		expect(entry.stale.map((s) => s.name).sort()).toEqual(['upgrade_admitted_total', 'upgrade_admitted_total']);
	});

	it('does not count a worker off twice when it dies after answering', () => {
		// missed() is keyed rather than a blind decrement. Counting an answered
		// worker off again drives pending to zero early and drops the reports of
		// workers still owed.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		c.note('c1', 1, [{ name: 'ws_connections', labels: {}, value: 1 }]);
		expect(c.missed(1)).toBe(false);
		expect(c.active().pending).toBe(1);
		expect(c.missed(2)).toBe(true);
	});

	it('rejects a report from a worker that was never asked', () => {
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		expect(c.note('c1', 99, [{ name: 'ws_connections', labels: {}, value: 1 }])).toBe(false);
		expect(c.active().answered).toBe(0);
	});

	it('rejects a report carrying no correlation id at all', () => {
		// The guard is a positive test on purpose: a "reject a mismatch" form
		// would let any future path that omits the id restore the original defect
		// with every completeness signal still reading green.
		const c = createMetricsCollections();
		c.begin('r', 'c1', [1, 2]);
		expect(c.note(undefined, 1, [{ name: 'ws_connections', labels: {}, value: 1 }])).toBe(false);
		expect(c.active().answered).toBe(0);
	});

	it('ignores a report once the collection has been taken', () => {
		const c = createMetricsCollections();
		c.begin('requester', 'id', [1]);
		expect(c.note('id', 1, [{ name: 'a', labels: {}, value: 1 }])).toBe(true);
		c.take();
		expect(c.note('id', 2, [{ name: 'a', labels: {}, value: 2 }])).toBe(false);
		expect(c.take()).toBeNull();
		expect(c.join('anyone', 'id-x')).toBe(false);
	});
});
