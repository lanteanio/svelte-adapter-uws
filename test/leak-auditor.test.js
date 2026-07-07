import { describe, it, expect } from 'vitest';
import { createResourceGrowthAuditor } from '../src/runtime/leak-probes.js';

// createResourceGrowthAuditor is the opt-in, observe-only PRODUCTION trend
// auditor (installed only when resourceGrowthAuditIntervalMs > 0). Its contract:
// on a rising series it increments the metric and calls onGrowth once per
// suspected series; on a flat series it does neither; and it NEVER throws out of
// a tick, even when a user onGrowth handler or the metrics sink throws - a
// probabilistic background signal must not be able to crash the server. Driven
// via runOnce() (no timer) so every case is deterministic.

function growingProbe(name = 'leaky') {
	let n = 0;
	const m = new Map();
	return { name, read: () => { m.set(n, n); n++; return m.size; } };
}
function flatProbe(name = 'steady') {
	return { name, read: () => 5 };
}

describe('createResourceGrowthAuditor (observe-only production trend auditor)', () => {
	it('flags a monotonically growing series: metric inc + onGrowth past minSamples', () => {
		const incs = [];
		const grown = [];
		const auditor = createResourceGrowthAuditor({
			probes: [growingProbe()],
			metrics: { inc: (labels) => incs.push(labels) },
			onGrowth: (report) => grown.push(report)
		});
		// Default minSamples is ~8; drive enough ticks to fill and flag.
		for (let i = 0; i < 12; i++) auditor.runOnce();

		expect(incs.length).toBeGreaterThan(0);
		expect(incs[0]).toEqual({ resource: 'leaky' });
		expect(grown.length).toBeGreaterThan(0);
		expect(grown[0].name).toBe('leaky');
		expect(grown[0].leaking).toBe(true);
		expect(auditor.stats.suspected).toBeGreaterThan(0);
	});

	it('stays silent on a flat series (no metric, no onGrowth)', () => {
		const incs = [];
		const grown = [];
		const auditor = createResourceGrowthAuditor({
			probes: [flatProbe()],
			metrics: { inc: (labels) => incs.push(labels) },
			onGrowth: (report) => grown.push(report)
		});
		for (let i = 0; i < 12; i++) auditor.runOnce();

		expect(incs).toHaveLength(0);
		expect(grown).toHaveLength(0);
		expect(auditor.stats.suspected).toBe(0);
	});

	it('never throws out of a tick when the onGrowth handler throws', () => {
		const auditor = createResourceGrowthAuditor({
			probes: [growingProbe()],
			onGrowth: () => { throw new Error('user handler blew up'); }
		});
		expect(() => { for (let i = 0; i < 12; i++) auditor.runOnce(); }).not.toThrow();
		expect(auditor.stats.suspected).toBeGreaterThan(0);
	});

	it('never throws out of a tick when the metrics sink throws', () => {
		const auditor = createResourceGrowthAuditor({
			probes: [growingProbe()],
			metrics: { inc: () => { throw new Error('metrics backend down'); } }
		});
		expect(() => { for (let i = 0; i < 12; i++) auditor.runOnce(); }).not.toThrow();
	});

	it('start() is idempotent and stop() is safe before start or after', () => {
		const auditor = createResourceGrowthAuditor({ probes: [flatProbe()], intervalMs: 100000 });
		expect(() => {
			auditor.stop();        // safe before start
			auditor.start();
			auditor.start();       // idempotent
			auditor.stop();
			auditor.stop();        // safe repeat
		}).not.toThrow();
	});
});
