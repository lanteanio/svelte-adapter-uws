// The primary's posture aggregation, driven directly - no threads, the same
// reason metrics-collector has its own unit suite: the decision is separable
// from the socket I/O, and every rule below is a rule about what a consumer
// reads off one line.

import { describe, it, expect } from 'vitest';
import { createPostureAggregator } from '../src/runtime/posture-collector.js';

/** A worker's report, shaped as handler.js builds it. */
function report(posture, reason, value, extra) {
	return { v: 1, posture, reason, value, psi: null, cpuThrottle: null, ...extra };
}

describe('the deployment posture is the worst worker, not an average', () => {
	it('reports the highest level any worker is in', () => {
		const agg = createPostureAggregator();
		agg.note(1, report('normal', 'none', 0));
		agg.note(2, report('siege', 'PSI', 0.94));
		agg.note(3, report('elevated', 'CPU', 0.7));
		expect(agg.line().posture).toBe('siege');
	});

	it('carries the winning worker own reason and numbers, not a maximum across workers', () => {
		// The line has to be internally consistent: `reason` must explain the
		// `posture` beside it. Taking each field's maximum independently would
		// produce a line describing a state no worker was ever in.
		const agg = createPostureAggregator();
		agg.note(1, report('normal', 'quiet', 0.01, { psi: { some: 1 } }));
		agg.note(2, report('elevated', 'MEMORY', 0.66, { psi: { some: 42 }, cpuThrottle: { pct: 3 } }));
		const line = agg.line();
		expect(line.posture).toBe('elevated');
		expect(line.reason).toBe('MEMORY');
		expect(line.value).toBe(0.66);
		expect(line.psi).toEqual({ some: 42 });
		expect(line.cpuThrottle).toEqual({ pct: 3 });
	});

	it('breaks a tie on the lowest thread id, so a steady fleet reports steady numbers', () => {
		// Without a deterministic tie-break the reported reason would rotate
		// between equally-loaded workers on every tick, which reads to a
		// consumer as the cause changing while nothing changed.
		const agg = createPostureAggregator();
		agg.note(7, report('elevated', 'from-seven', 0.5));
		agg.note(3, report('elevated', 'from-three', 0.5));
		agg.note(9, report('elevated', 'from-nine', 0.5));
		expect(agg.line().reason).toBe('from-three');
		// Re-reporting in a different order must not move it.
		agg.note(9, report('elevated', 'from-nine', 0.5));
		agg.note(7, report('elevated', 'from-seven', 0.5));
		expect(agg.line().reason).toBe('from-three');
	});

	it('says how many workers the line summarizes', () => {
		const agg = createPostureAggregator();
		expect(agg.line()).toBe(null);
		agg.note(1, report('normal', 'none', 0));
		expect(agg.line().workers).toBe(1);
		agg.note(2, report('normal', 'none', 0));
		expect(agg.line().workers).toBe(2);
		// A second report from a worker already counted replaces its line.
		agg.note(2, report('elevated', 'PSI', 0.8));
		expect(agg.line().workers).toBe(2);
		expect(agg.line().posture).toBe('elevated');
	});
});

describe('a worker that leaves stops speaking for the deployment', () => {
	it('retires an exited worker rather than holding its last level', () => {
		// The aggregate is the worst worker, so a thread that died in siege
		// would pin the whole deployment there for as long as the primary runs
		// - and a defense daemon would keep shedding traffic for a worker that
		// no longer exists.
		const agg = createPostureAggregator();
		agg.note(1, report('normal', 'quiet', 0));
		agg.note(2, report('siege', 'PSI', 0.99));
		expect(agg.line().posture).toBe('siege');
		agg.retire(2);
		expect(agg.line().posture).toBe('normal');
		expect(agg.line().workers).toBe(1);
	});

	it('goes silent when the last worker is gone', () => {
		// Null is the export's documented liveness answer: the cadence stops
		// and a consumer concludes the adapter is not serving, which is true.
		const agg = createPostureAggregator();
		agg.note(1, report('elevated', 'PSI', 0.7));
		agg.retire(1);
		expect(agg.line()).toBe(null);
		expect(agg.reporting()).toBe(0);
	});

	it('retiring a worker that never reported changes nothing', () => {
		const agg = createPostureAggregator();
		agg.note(1, report('normal', 'quiet', 0));
		agg.retire(42);
		expect(agg.line().workers).toBe(1);
	});
});

describe('a transition is what earns an immediate push', () => {
	it('reports a change of the DEPLOYMENT level, not of one worker', () => {
		const agg = createPostureAggregator();
		expect(agg.note(1, report('normal', 'quiet', 0)), 'the first report is a change').toBe(true);
		expect(agg.note(2, report('normal', 'quiet', 0)), 'a second quiet worker is not').toBe(false);
		expect(agg.note(2, report('elevated', 'PSI', 0.7)), 'one worker rising takes the deployment with it').toBe(true);
		// Worker 1 dropping to elevated changes nothing a consumer would see:
		// the deployment was already elevated because of worker 2.
		expect(agg.note(1, report('elevated', 'PSI', 0.7)), 'a second worker joining the level is not a transition').toBe(false);
	});

	it('counts a reason change at the same level as a transition', () => {
		// The export contract pushes on posture OR reason transitions: the
		// cause moving from memory to CPU is a different instruction to a
		// daemon even when the level has not moved.
		const agg = createPostureAggregator();
		agg.note(1, report('elevated', 'MEMORY', 0.7));
		expect(agg.note(1, report('elevated', 'CPU', 0.7))).toBe(true);
		expect(agg.note(1, report('elevated', 'CPU', 0.9)), 'a value alone rides the cadence').toBe(false);
	});
});

describe('a report is checked, not trusted', () => {
	it('refuses a malformed or unknown-level report', () => {
		// It arrives over IPC. A report that cannot be read must not be able to
		// take the aggregate to a level nothing is actually in.
		const agg = createPostureAggregator();
		expect(agg.note(1, null)).toBe(false);
		expect(agg.note(1, 'siege')).toBe(false);
		expect(agg.note(1, { posture: 'apocalypse' })).toBe(false);
		expect(agg.note(1, { v: 1 })).toBe(false);
		expect(agg.line(), 'a refused report must not create a reporting worker').toBe(null);
	});

	it('keeps a good report after a bad one from the same worker', () => {
		const agg = createPostureAggregator();
		agg.note(1, report('siege', 'PSI', 0.99));
		agg.note(1, { posture: 42 });
		expect(agg.line().posture, 'a rejected report must not erase the last good one').toBe('siege');
	});
});
