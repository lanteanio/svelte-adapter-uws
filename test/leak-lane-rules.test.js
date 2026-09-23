// The leak lane's verdict rules, driven in milliseconds.
//
// The lane itself spends minutes by design - a slope needs a window - so its
// rules are pure functions that can be exercised without one. This file is what
// keeps them honest: every rule is asserted from BOTH sides, because a gate
// that only ever sees the shape it is supposed to reject is indistinguishable
// from a gate that rejects everything.
//
// The series below are the two the lane exists to tell apart, and they are
// deliberately close: a flat-but-noisy resident set that a least-squares line
// still tilts through, and a real climb. Slope alone cannot separate them,
// which is why the fit quality is a vote.

import { describe, it, expect } from 'vitest';
import {
	judge, selfCheckVerdict, quantile, retainedBytes,
	MIN_R_SQUARED, MAX_ERROR_RATE, MAX_P95_CREEP, RSS_TOLERANCE_BYTES, MAX_RETAINED_GROWTH, RETAINED_TOLERANCE_BYTES
} from '../scripts/leak-lane.js';
import { detectGrowth, DEFAULT_MIN_SAMPLES } from '../src/runtime/leak-detect.js';
import { hasUWS, startRealRuntime, connectRealClient, REAL_BOOT_BUDGET_MS } from './helpers/real-runtime.js';

const MiB = 1048576;

/** A resident set holding its working set, wandering a few MiB either way. */
const NOISY_FLAT = [220, 231, 218, 236, 222, 229, 217, 234, 226, 219, 233, 221, 228, 235, 223]
	.map((mb) => mb * MiB);

/** A real climb: the same noise riding a steady 8 MiB per sample. */
const CLIMBING = NOISY_FLAT.map((v, i) => v + i * 8 * MiB);

/** The healthy case, with a settled baseline and a clean window. */
const HEALTHY = {
	rss: NOISY_FLAT, errors: 2, requests: 6000,
	baselineP95: 12, windowP95: 13, settled: true
};

describe('the leak lane reaches a verdict the way it says it does', () => {
	it('calls a noisy but flat resident set clean', () => {
		const verdict = judge(HEALTHY);
		expect(verdict.failing).toBe(false);
		expect(verdict.health).toEqual([]);
		expect(verdict.growth.leaking).toBe(false);
	});

	it('calls a real climb a leak, and says by how much', () => {
		const verdict = judge({ ...HEALTHY, rss: CLIMBING });
		expect(verdict.failing).toBe(true);
		expect(verdict.growth.leaking).toBe(true);
		expect(verdict.failures[0]).toMatch(/resident set grew/);
	});

	it('needs the fit to explain the samples, not merely to tilt', () => {
		// The discriminator, isolated: the flat series' least-squares line has a
		// slope, and taking the fit quality away is enough to make it a leak.
		// If this ever passes with the r-squared vote in place, the vote has
		// stopped voting.
		const withoutFit = detectGrowth(NOISY_FLAT, {
			warmup: 0, tolerance: 0, minSlope: 0, minMonotonicFraction: 0, minRSquared: 0
		});
		const withFit = detectGrowth(NOISY_FLAT, {
			warmup: 0, tolerance: 0, minSlope: 0, minMonotonicFraction: 0, minRSquared: MIN_R_SQUARED
		});
		expect(withoutFit.rSquared).toBeLessThan(MIN_R_SQUARED);
		expect(withFit.reason).toBe('fit-too-poor');
		expect(withFit.leaking).toBe(false);
	});

	it('keeps the fit vote from swallowing a genuine climb', () => {
		const climb = detectGrowth(CLIMBING, {
			warmup: 0, tolerance: RSS_TOLERANCE_BYTES, minSlope: 0, minMonotonicFraction: 0, minRSquared: MIN_R_SQUARED
		});
		expect(climb.rSquared).toBeGreaterThan(MIN_R_SQUARED);
		expect(climb.leaking).toBe(true);
	});

	it('fails a window that lost more requests than the ceiling allows', () => {
		const belowCeiling = judge({ ...HEALTHY, errors: 29, requests: 6000 });
		const overCeiling = judge({ ...HEALTHY, errors: 31, requests: 6000 });
		expect(29 / 6000).toBeLessThan(MAX_ERROR_RATE);
		expect(belowCeiling.failing).toBe(false);
		expect(overCeiling.failing).toBe(true);
		expect(overCeiling.failures[0]).toMatch(/requests failed/);
	});

	it('fails a window whose p95 crept past the warmed baseline', () => {
		const under = judge({ ...HEALTHY, baselineP95: 10, windowP95: 14.9 });
		const over = judge({ ...HEALTHY, baselineP95: 10, windowP95: 15.1 });
		expect(MAX_P95_CREEP).toBe(0.5);
		expect(under.failing).toBe(false);
		expect(over.failing).toBe(true);
		expect(over.failures[0]).toMatch(/p95 latency crept/);
	});

	it('reports an unsettled baseline as a health problem, not as a pass', () => {
		// The distinction the exit codes rest on: the lane not knowing is not the
		// same as the server being clean, and a lane that conflates them reports
		// green on every run where the measurement fell apart.
		const verdict = judge({ ...HEALTHY, settled: false });
		expect(verdict.failing).toBe(false);
		expect(verdict.health.join(' ')).toMatch(/never settled/);
	});

	it('reports a missing latency baseline rather than passing the creep gate on it', () => {
		const verdict = judge({ ...HEALTHY, baselineP95: 0, windowP95: 900 });
		expect(verdict.p95Creep).toBeNull();
		expect(verdict.health.join(' ')).toMatch(/no warmed baseline/);
	});

	it('reports a window with fewer samples than the growth fit needs', () => {
		// The fit answers "not leaking" below its own minimum, so a short series
		// must be reported as unjudged rather than read as clean. The floor is
		// the detector's own constant, not a second copy of it.
		const verdict = judge({ ...HEALTHY, rss: [220 * MiB] });
		expect(verdict.health.join(' ')).toMatch(/growth fit needs/);
		const justShort = judge({ ...HEALTHY, rss: Array.from({ length: DEFAULT_MIN_SAMPLES - 1 }, () => 220 * MiB) });
		expect(justShort.health.join(' ')).toMatch(/growth fit needs/);
		const enough = judge({ ...HEALTHY, rss: Array.from({ length: DEFAULT_MIN_SAMPLES }, () => 220 * MiB) });
		expect(enough.health.join(' ')).not.toMatch(/growth fit needs/);
	});

	it('does not ask a resident set to be monotonic, because one never is', () => {
		// The vote the lane switches off, and the reason it has to: even the
		// climbing series steps backwards often enough to fail a 90% rule, so
		// leaving the kernel's default in place would make this gate unable to
		// fire at all. If judge() ever stops overriding it, this fails.
		const withDefaultVote = detectGrowth(CLIMBING, {
			warmup: 0, tolerance: RSS_TOLERANCE_BYTES, minSlope: 0, minRSquared: MIN_R_SQUARED
		});
		expect(withDefaultVote.monotonicFraction).toBeLessThan(0.9);
		expect(withDefaultVote.reason).toBe('non-monotonic');
		expect(judge({ ...HEALTHY, rss: CLIMBING }).growth.leaking).toBe(true);
	});

	it('takes the quantile at the sample, not at an interpolation of it', () => {
		expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
		expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(quantile([], 0.95)).toBe(0);
	});
});

// The two gates that read what the resident set cannot. Each is asserted from
// both sides of its line, and a record measured without them judges exactly as
// it did before they existed.
describe('the retention gate compares settled heap plus external', () => {
	const settledRun = (baseline, final) => ({ ...HEALTHY, retained: { baseline, final, settled: true } });

	it('counts external, because a Buffer lives outside the heap', () => {
		expect(retainedBytes({ heapUsed: 10, external: 5 })).toBe(15);
		expect(retainedBytes({ heapUsed: 10 })).toBe(10);
	});

	it('fails growth past the ratio when it is also past the byte floor', () => {
		const base = 40 * MiB;
		const under = judge(settledRun(base, base * (1 + MAX_RETAINED_GROWTH) - 1));
		const over = judge(settledRun(base, base * (1 + MAX_RETAINED_GROWTH) + 1));
		expect(under.failing).toBe(false);
		expect(under.retained.leaking).toBe(false);
		expect(over.failing).toBe(true);
		expect(over.retained.leaking).toBe(true);
		expect(over.failures[0]).toMatch(/retained \(heap\+external\) grew/);
	});

	it('does not fail a bounded structure filling once on a small baseline', () => {
		// Past the ratio, under the byte floor: a cache reaching its cap, not a
		// per-request leak. The floor is what lets the ratio stay tight.
		const small = judge(settledRun(3 * MiB, 3 * MiB + RETAINED_TOLERANCE_BYTES - 1));
		expect(small.retained.ratio, 'the premise: the ratio alone would fail this').toBeGreaterThan(MAX_RETAINED_GROWTH);
		expect(small.retained.leaking).toBe(false);
		const large = judge(settledRun(3 * MiB, 3 * MiB + RETAINED_TOLERANCE_BYTES + 1));
		expect(large.retained.leaking).toBe(true);
	});

	it('reports retention that never settled as a health problem', () => {
		const verdict = judge({ ...HEALTHY, retained: { baseline: 40 * MiB, final: 41 * MiB, settled: false } });
		expect(verdict.failing).toBe(false);
		expect(verdict.health.join(' ')).toMatch(/retention never settled/);
	});

	it('leaves a record measured without it exactly as it was', () => {
		const verdict = judge(HEALTHY);
		expect('retained' in verdict).toBe(false);
		expect(verdict.health).toEqual([]);
	});
});

describe('the connections gate reads the live count after the cooldown', () => {
	it('passes at zero and fails on any connection still registered', () => {
		expect(judge({ ...HEALTHY, connectionsAfter: 0 }).failing).toBe(false);
		const leaked = judge({ ...HEALTHY, connectionsAfter: 3 });
		expect(leaked.failing).toBe(true);
		expect(leaked.failures[0]).toMatch(/3 WebSocket connection\(s\) still registered/);
	});

	it('reports a count the probe could not read instead of passing on it', () => {
		for (const unread of [-1, undefined, null, 1.5]) {
			const verdict = judge({ ...HEALTHY, connectionsAfter: unread });
			expect(verdict.failing, `connectionsAfter ${unread}`).toBe(false);
			expect(verdict.health.join(' '), `connectionsAfter ${unread}`).toMatch(/could not read the live connection count/);
		}
		expect(judge(HEALTHY).health, 'no reading asked for, nothing reported').toEqual([]);
	});
});

// The self-check accepts only the gate it tests. The planted defect is memory
// growth, so a failing verdict is not detection: a deliberately leaking server
// can also shed requests or creep its p95, and a self-check that accepted any
// failure would pass while the growth gate itself was blind. Driven through
// the real judge() outputs rather than hand-built records, so the rule and the
// verdict shape cannot drift apart.
describe('the self-check counts only the growth gate as detection', () => {
	it('passes when the growth gate itself saw the planted leak', () => {
		const record = judge({ ...HEALTHY, rss: CLIMBING });
		expect(record.growth.leaking, 'the premise: this record is a detected leak').toBe(true);
		const check = selfCheckVerdict(record);
		expect(check.pass).toBe(true);
		expect(check.reason).toMatch(/growth gate/);
	});

	it('still passes when the leak also degraded the server, as a real one does', () => {
		// Growth detected AND an error-rate failure beside it: the incidental
		// failure must not mask the detection that matters.
		const record = judge({ ...HEALTHY, rss: CLIMBING, errors: 600 });
		expect(record.failures.length).toBeGreaterThan(1);
		expect(selfCheckVerdict(record).pass).toBe(true);
	});

	it('fails when the verdict failed for any reason but the growth gate stayed blind', () => {
		// The shape the typed check exists for: an error-rate failure makes the
		// verdict failing while the planted growth went undetected. Accepting
		// this record was the defect.
		const record = judge({ ...HEALTHY, errors: 600 });
		expect(record.failing, 'the premise: a failing verdict without a detected leak').toBe(true);
		expect(record.growth.leaking).toBe(false);
		const check = selfCheckVerdict(record);
		expect(check.pass).toBe(false);
		expect(check.reason).toMatch(/went undetected/);
	});

	it('fails on a clean verdict, which is the lane gone quietly blind', () => {
		const record = judge(HEALTHY);
		expect(record.failing).toBe(false);
		expect(selfCheckVerdict(record).pass).toBe(false);
	});

	it('is not satisfied by the retention gate, which the planted buffers also trip', () => {
		const record = judge({ ...HEALTHY, retained: { baseline: 40 * MiB, final: 400 * MiB, settled: true } });
		expect(record.retained.leaking, 'the premise: retention saw the planted leak').toBe(true);
		expect(record.growth.leaking).toBe(false);
		const check = selfCheckVerdict(record);
		expect(check.pass).toBe(false);
		expect(check.reason).toMatch(/went undetected/);
	});
});

// The probe the lane reads the server through reports memory on demand and
// retains buffers on request. Neither belongs in anything anyone deploys, and
// "it only exists in the test fixture" is a claim about where the file sits
// rather than a boundary the running server enforces. The environment variable
// is the boundary, so it is asserted here against a real server that was not
// given it - which is every server except the one the lane spawns.
const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the leak probe answers nothing unless it was armed', () => {
	it('is not found on a server booted without LEAK_PROBE', async () => {
		expect(process.env.LEAK_PROBE, 'this case is meaningless if the harness itself armed it').toBeUndefined();
		const server = await startRealRuntime({ variant: 'default' });
		try {
			for (const op of ['mem', 'gc', 'retain', 'release']) {
				const res = await fetch(`${server.httpUrl}/__leak?op=${op}`);
				expect(res.status, `/__leak?op=${op} answered ${res.status}`).toBe(404);
			}
		} finally {
			await server.stop();
		}
	}, REAL_BOOT_BUDGET_MS);

	it('reports the live WebSocket count once armed, and it falls to zero when the client closes', async () => {
		// The connections gate reads this field; a probe that answered a constant
		// would pass every run. The route reads the variable per request, so it
		// is armed here for this case alone.
		const server = await startRealRuntime({ variant: 'default' });
		process.env.LEAK_PROBE = '1';
		try {
			const count = async () => (await (await fetch(`${server.httpUrl}/__leak?op=mem`)).json()).connections;
			expect(await count()).toBe(0);
			const client = await connectRealClient(server.wsUrl);
			expect(await count()).toBe(1);
			client.ws.close();
			await expect.poll(count, { timeout: 5000 }).toBe(0);
		} finally {
			delete process.env.LEAK_PROBE;
			await server.stop();
		}
	}, REAL_BOOT_BUDGET_MS);
});
