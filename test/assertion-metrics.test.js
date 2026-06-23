// Unit coverage for the assertion -> Prometheus bridge: wireAssertionMetrics
// binds a registry counter that assert (severity="soft") and fatal
// (severity="fatal") increment alongside the in-memory assertionCounts Map.
// In test mode assert/fatal throw AFTER recording, so each call is wrapped in
// `swallow` and the recording is asserted independently of the throw.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	assert,
	fatal,
	wireAssertionMetrics,
	readAssertionCounts,
	_resetAssertionCountsForTest
} from '../src/runtime/utils/assertions.js';

const METRIC = 'framework_assertion_violations_total';

// Registry shaped like the `metrics` option contract: positional counter
// factory, idempotent per name, label sets keyed by their JSON form.
function recordingRegistry() {
	const counters = new Map();
	return {
		counter(name) {
			let c = counters.get(name);
			if (!c) {
				c = {
					series: new Map(),
					inc(labels) {
						const key = labels ? JSON.stringify(labels) : '';
						this.series.set(key, (this.series.get(key) || 0) + 1);
					}
				};
				counters.set(name, c);
			}
			return c;
		},
		series(name, labels) {
			const c = counters.get(name);
			return c ? (c.series.get(JSON.stringify(labels)) || 0) : 0;
		},
		total(name) {
			const c = counters.get(name);
			if (!c) return 0;
			let sum = 0;
			for (const v of c.series.values()) sum += v;
			return sum;
		}
	};
}

// assert/fatal throw in test mode; the violation is recorded before the throw.
const swallow = (fn) => { try { fn(); } catch { /* expected: test-mode throw */ } };

describe('framework_assertion_violations_total', () => {
	beforeEach(() => { _resetAssertionCountsForTest(); });

	it('counts in the in-memory Map even when no registry is wired', () => {
		swallow(() => assert(false, 'wire.unwired'));
		expect(readAssertionCounts().get('wire.unwired')).toBe(1);
	});

	it('increments {category, severity="soft"} for assert once wired', () => {
		const metrics = recordingRegistry();
		wireAssertionMetrics(metrics);
		swallow(() => assert(false, 'wire.test'));
		swallow(() => assert(false, 'wire.test'));
		swallow(() => assert(false, 'wire.other'));
		expect(metrics.series(METRIC, { category: 'wire.test', severity: 'soft' })).toBe(2);
		expect(metrics.series(METRIC, { category: 'wire.other', severity: 'soft' })).toBe(1);
	});

	it('labels fatal violations severity="fatal" in the same counter', () => {
		const metrics = recordingRegistry();
		wireAssertionMetrics(metrics);
		swallow(() => fatal(false, 'wire.fatal'));
		expect(metrics.series(METRIC, { category: 'wire.fatal', severity: 'fatal' })).toBe(1);
		expect(metrics.series(METRIC, { category: 'wire.fatal', severity: 'soft' })).toBe(0);
	});

	it('never increments on a passing assert', () => {
		const metrics = recordingRegistry();
		wireAssertionMetrics(metrics);
		assert(true, 'wire.passes');
		expect(metrics.total(METRIC)).toBe(0);
	});

	it('survives a registry whose emit throws: the Map still counts, no crash', () => {
		wireAssertionMetrics({ counter: () => ({ inc() { throw new Error('emit boom'); } }) });
		swallow(() => assert(false, 'wire.throwing'));
		expect(readAssertionCounts().get('wire.throwing')).toBe(1);
	});

	it('rejects a registry without a counter factory', () => {
		expect(() => wireAssertionMetrics({})).toThrow(/metrics registry is required/);
		expect(() => wireAssertionMetrics(null)).toThrow(/metrics registry is required/);
	});

	it('replaces the bound counter when wired twice (most-recent wins)', () => {
		const first = recordingRegistry();
		const second = recordingRegistry();
		wireAssertionMetrics(first);
		wireAssertionMetrics(second);
		swallow(() => assert(false, 'wire.replace'));
		expect(first.total(METRIC)).toBe(0);
		expect(second.series(METRIC, { category: 'wire.replace', severity: 'soft' })).toBe(1);
	});

	it('stops emitting after _resetAssertionCountsForTest clears the binding', () => {
		const metrics = recordingRegistry();
		wireAssertionMetrics(metrics);
		_resetAssertionCountsForTest();
		swallow(() => assert(false, 'wire.after-reset'));
		expect(metrics.total(METRIC)).toBe(0);
		expect(readAssertionCounts().get('wire.after-reset')).toBe(1);
	});
});
