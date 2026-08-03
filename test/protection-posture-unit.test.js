// Pure-function coverage for the graduated protection posture and the capacity
// reason override. These tests drive the exported helpers directly and import
// nothing that pulls in uWebSockets.js, so they evaluate identically under every
// pool worker and cannot flake on cross-file module-load ordering. The live
// createTestServer coupling lives in protection-posture.test.js.
//
// Exercised here:
//   - createPosture: normal -> elevated -> siege escalation, the asymmetric
//     (slower) relaxation, exactly what feeds the over-capacity escalation (the
//     maxConcurrent-503 count) and what deliberately does not (the per-IP 429
//     count), the per-sample 2x boundary, the pinned-level freeze, and the
//     auto-mode fold-loop relaxation through the same layered-reason path the
//     production sampler walks.
//   - applyCapacityReason: the no-op normal pass-through, the CAPACITY surface at
//     elevated/siege, and the MEMORY precedence.

import { describe, it, expect, vi } from 'vitest';
import {
	createPosture,
	applyCapacityReason,
	createUpgradeAdmission,
	computePressureReason
} from '../src/runtime/utils.js';

// A pressure snapshot shaped like the live one the sampler folds. `active`
// is the only field the posture machine reads on tick.
function snapshot(active) {
	return { active, reason: active ? 'SUBSCRIBERS' : 'NONE', value: active ? 1 : 0 };
}

// Drive `n` consecutive ticks with the same active flag.
function tickActive(posture, n, active) {
	for (let i = 0; i < n; i++) posture.tick(snapshot(active));
}

// Drive `n` ticks while recording `perTick` capacity rejects (the maxConcurrent
// 503 site) before each tick, so the rolling reject rate stays elevated.
function tickWithCapacityRejects(posture, n, perTick) {
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < perTick; j++) posture.recordCapacityReject();
		posture.tick(snapshot(true));
	}
}

// - posture state machine --------------------------------------------------

describe('createPosture escalation and relaxation', () => {
	// A small admit rate keeps the 2x over-capacity escalation threshold cheap
	// to drive: at maxConcurrent 2 the gate admits ~2/sample, so 2x is >= 4
	// capacity rejects per sample.
	const makeGate = () => createUpgradeAdmission({ maxConcurrent: 2 });
	const getThresholds = () => ({
		memoryHeapUsedRatio: 0.85,
		publishRatePerSec: 10000,
		subscriberRatio: 50,
		sampleIntervalMs: 1000
	});

	it('starts at normal with no pressure and no rejects', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		expect(posture.level).toBe('normal');
		expect(posture.rejectedPerSecond).toBe(0);
	});

	it('stays normal while pressure is active but the dwell has not elapsed', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		// Four active samples is below the escalation dwell; still normal.
		tickActive(posture, 4, true);
		expect(posture.level).toBe('normal');
	});

	it('escalates to elevated after a sustained active-pressure dwell', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
	});

	it('resets the escalation dwell when a calm sample interrupts the run', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 4, true);
		// A single calm sample breaks the consecutive-active run.
		tickActive(posture, 1, false);
		tickActive(posture, 4, true);
		// Only four consecutive active samples since the interruption: not yet.
		expect(posture.level).toBe('normal');
		tickActive(posture, 1, true);
		expect(posture.level).toBe('elevated');
	});

	it('escalates to siege when capacity rejects run at twice the admit rate', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		// Climb to elevated first.
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
		// maxConcurrent 2 -> admit rate ~2/sample -> 2x is >= 4 rejects/sample.
		// Sustain that for the longer siege dwell.
		tickWithCapacityRejects(posture, 10, 4);
		expect(posture.level).toBe('siege');
	});

	it('does not reach siege when over-capacity rejects sit below twice the admit rate', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
		// One reject per sample is well under 2x the admit rate.
		tickWithCapacityRejects(posture, 20, 1);
		expect(posture.level).toBe('elevated');
	});

	it('holds elevated at exactly one below twice the admit rate, and reaches siege at exactly twice', () => {
		// maxConcurrent 5 -> admit rate ~5/sample -> the boundary is 2x = 10
		// capacity rejects per sample. One below must NOT trip; exactly the
		// boundary must, so the 2x-per-sample threshold is pinned, not the
		// half-rate the rolling sum used to produce.
		const just_under = createPosture({
			admission: createUpgradeAdmission({ maxConcurrent: 5 }),
			getThresholds
		});
		tickActive(just_under, 5, true);
		expect(just_under.level).toBe('elevated');
		tickWithCapacityRejects(just_under, 30, 9);
		expect(just_under.level).toBe('elevated');

		const at_boundary = createPosture({
			admission: createUpgradeAdmission({ maxConcurrent: 5 }),
			getThresholds
		});
		tickActive(at_boundary, 5, true);
		expect(at_boundary.level).toBe('elevated');
		tickWithCapacityRejects(at_boundary, 10, 10);
		expect(at_boundary.level).toBe('siege');
	});

	it('uses maxConnections as the capacity basis when the handshake ceiling is disabled', () => {
		const posture = createPosture({
			admission: createUpgradeAdmission({ maxConnections: 2 }),
			getThresholds
		});
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
		tickWithCapacityRejects(posture, 10, 4);
		expect(posture.level).toBe('siege');
	});

	it('relaxes from elevated to normal only after a longer quiet dwell', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');

		// Quiet for the same number of samples the escalation took: relaxation
		// is deliberately slower, so it must still be elevated here.
		tickActive(posture, 5, false);
		expect(posture.level).toBe('elevated');

		// Keep it quiet long enough to clear the longer relaxation dwell.
		tickActive(posture, 10, false);
		expect(posture.level).toBe('normal');
	});

	it('relaxes from siege down through elevated, never skipping a level on the way down', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 5, true);
		tickWithCapacityRejects(posture, 10, 4);
		expect(posture.level).toBe('siege');

		// Quiet (no rejects, no active pressure). The first relaxation dwell
		// steps siege -> elevated, not straight to normal.
		tickActive(posture, 10, false);
		expect(posture.level).toBe('elevated');

		// A second quiet dwell completes elevated -> normal.
		tickActive(posture, 10, false);
		expect(posture.level).toBe('normal');
	});

	it('climbs faster than it relaxes (asymmetric hysteresis)', () => {
		const fast = createPosture({ admission: makeGate(), getThresholds });
		let escalateSamples = 0;
		while (fast.level === 'normal' && escalateSamples < 100) {
			fast.tick(snapshot(true));
			escalateSamples++;
		}
		expect(fast.level).toBe('elevated');

		const slow = createPosture({ admission: makeGate(), getThresholds });
		tickActive(slow, escalateSamples, true);
		expect(slow.level).toBe('elevated');
		let relaxSamples = 0;
		while (slow.level !== 'normal' && relaxSamples < 200) {
			slow.tick(snapshot(false));
			relaxSamples++;
		}
		expect(slow.level).toBe('normal');
		// The defining property: coming down takes strictly more samples than
		// going up, so the posture cannot flap on a brief lull.
		expect(relaxSamples).toBeGreaterThan(escalateSamples);
	});

	it('relaxes auto mode through the layered-reason fold the sampler walks', () => {
		// The production sampler computes a base pressure reason, layers CAPACITY
		// on top via applyCapacityReason, then ticks the posture. Once the level
		// is engaged the layered reason is forced to CAPACITY every sample, so the
		// tick MUST read the base activity, not the layered one, or the relaxation
		// dwell would never see a calm sample. This replays that exact fold loop
		// and asserts the level returns to normal once the base load drops.
		const posture = createPosture({ admission: makeGate(), getThresholds });
		const thresholds = getThresholds();

		// Replay one fold: base reason -> layered reason -> tick from BASE activity.
		const fold = (sample) => {
			const reason = computePressureReason(sample, thresholds);
			// The layered reason is what the snapshot/poll surface reports; it is
			// deliberately NOT what drives the tick.
			applyCapacityReason(reason, posture.level);
			posture.tick({ active: reason !== 'NONE' });
		};

		const loaded = { heapUsedRatio: 0.4, publishRate: 100, subscriberRatio: 60 };
		const idle = { heapUsedRatio: 0.4, publishRate: 100, subscriberRatio: 5 };

		// Sustained load escalates to elevated.
		for (let i = 0; i < 5; i++) fold(loaded);
		expect(posture.level).toBe('elevated');

		// A long fully-quiet stretch (base reason NONE) must relax back to normal,
		// even though the layered reason reads CAPACITY on every one of these
		// samples while the level is still engaged.
		for (let i = 0; i < 50; i++) fold(idle);
		expect(posture.level).toBe('normal');
	});
});

describe('createPosture reject accounting', () => {
	const makeGate = () => createUpgradeAdmission({ maxConcurrent: 2 });
	const getThresholds = () => ({ memoryHeapUsedRatio: 0.85, sampleIntervalMs: 1000 });

	it('counts a maxConcurrent-503 reject toward the rolling per-second rate', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		posture.recordCapacityReject();
		posture.recordCapacityReject();
		posture.recordCapacityReject();
		expect(posture.rejectedPerSecond).toBe(3);
	});

	it('decays the rolling reject count across a tick rather than accumulating forever', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickWithCapacityRejects(posture, 1, 8);
		// After the window rolls and no fresh rejects arrive, the rate must
		// fall back toward zero rather than holding the old peak.
		const afterBurst = posture.rejectedPerSecond;
		tickActive(posture, 3, false);
		expect(posture.rejectedPerSecond).toBeLessThan(afterBurst);
	});

	it('does NOT let per-IP 429 rejects drive the over-capacity escalation', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');

		// Hammer the rate-limit reject site (the attack signal) far above the
		// 2x admit rate for well beyond the siege dwell. This is NOT a capacity
		// signal, so it must never push the posture to siege.
		for (let i = 0; i < 20; i++) {
			for (let j = 0; j < 50; j++) posture.recordRateLimitReject();
			posture.tick(snapshot(true));
		}
		expect(posture.level).toBe('elevated');
	});

	it('keeps a single decayed integer, not a per-IP structure', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		// The reject site is parameterless: there is no per-IP key to record,
		// so the counter cannot itself be grown into a DoS vector.
		expect(posture.recordCapacityReject.length).toBe(0);
		expect(typeof posture.rejectedPerSecond).toBe('number');
		expect(Number.isInteger(posture.rejectedPerSecond)).toBe(true);
	});

	it('counts a saturated cursor-lane reject as over-capacity pressure, not a rate-limit reject', () => {
		// Drive the real gate to a saturated cursor sub-budget, then record the
		// reject the way the upgrade handler does on the cursor reject path: a
		// cursor-lane reject is genuine capacity pressure, so it feeds the
		// over-capacity counter (which can escalate an auto posture) and never
		// the rate-limit counter (which is deliberately inert for escalation).
		const admission = createUpgradeAdmission({ maxConcurrent: 4, cursorLane: { fraction: 0.25 } });
		const posture = createPosture({ admission, getThresholds });
		expect(admission.cursorMaxConcurrent).toBe(1);
		expect(admission.tryAcquireCursor()).toBe(true); // sub-budget now full
		// A second cursor upgrade is refused even though the main lane has room.
		expect(admission.tryAcquireCursor()).toBe(false);
		// The handler records this refusal on the capacity site.
		posture.recordCapacityReject();
		expect(posture.rejectedPerSecond).toBe(1);

		// Confirm it climbs the over-capacity escalation, not the inert 429 path:
		// a 429 storm of the same size leaves the rolling capacity rate at the
		// reject already counted, never higher.
		const before = posture.rejectedPerSecond;
		for (let j = 0; j < 50; j++) posture.recordRateLimitReject();
		expect(posture.rejectedPerSecond).toBe(before);
	});
});

describe('createPosture pinning', () => {
	const makeGate = () => createUpgradeAdmission({ maxConcurrent: 2 });
	const getThresholds = () => ({ memoryHeapUsedRatio: 0.85, sampleIntervalMs: 1000 });

	it('pins siege and freezes the machine against a fully quiet stream', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds, pin: 'siege' });
		expect(posture.level).toBe('siege');
		// Even a long quiet dwell cannot relax a pinned level.
		tickActive(posture, 50, false);
		expect(posture.level).toBe('siege');
	});

	it('pins normal and refuses to escalate on sustained pressure', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds, pin: 'normal' });
		tickActive(posture, 30, true);
		tickWithCapacityRejects(posture, 30, 10);
		expect(posture.level).toBe('normal');
	});

	it('treats an absent pin as auto resolution from the live signal', () => {
		const posture = createPosture({ admission: makeGate(), getThresholds });
		expect(posture.level).toBe('normal');
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
	});
});

// - transition observer ------------------------------------------------------

describe('createPosture onTransition', () => {
	const makeGate = () => createUpgradeAdmission({ maxConcurrent: 2 });
	const getThresholds = () => ({ memoryHeapUsedRatio: 0.85, sampleIntervalMs: 1000 });

	it('fires once per level change with the settled from/to pair, in order', () => {
		const transitions = [];
		const posture = createPosture({
			admission: makeGate(),
			getThresholds,
			onTransition: (from, to) => transitions.push([from, to])
		});

		// Full cycle: escalate to elevated, on to siege, then relax back down
		// through the asymmetric dwells.
		tickActive(posture, 5, true);
		expect(transitions).toEqual([['normal', 'elevated']]);

		tickWithCapacityRejects(posture, 10, 4);
		expect(transitions).toEqual([['normal', 'elevated'], ['elevated', 'siege']]);

		tickActive(posture, 10, false);
		expect(transitions[2]).toEqual(['siege', 'elevated']);
		tickActive(posture, 10, false);
		expect(transitions[3]).toEqual(['elevated', 'normal']);
		expect(transitions.length).toBe(4);
	});

	it('does not fire on ticks that leave the level unchanged', () => {
		const transitions = [];
		const posture = createPosture({
			admission: makeGate(),
			getThresholds,
			onTransition: (from, to) => transitions.push([from, to])
		});
		// Below the escalation dwell: active samples, no level change.
		tickActive(posture, 4, true);
		// And a calm stream at normal changes nothing either.
		tickActive(posture, 20, false);
		expect(transitions).toEqual([]);
	});

	it('reads the new level from the observer (the machine has settled first)', () => {
		let seen = null;
		const posture = createPosture({
			admission: makeGate(),
			getThresholds,
			onTransition: (from, to) => { seen = { from, to, live: posture.level }; }
		});
		tickActive(posture, 5, true);
		expect(seen).toEqual({ from: 'normal', to: 'elevated', live: 'elevated' });
	});

	it('never fires on a pinned machine', () => {
		const transitions = [];
		const posture = createPosture({
			admission: makeGate(),
			getThresholds,
			pin: 'siege',
			onTransition: (from, to) => transitions.push([from, to])
		});
		tickActive(posture, 50, false);
		tickWithCapacityRejects(posture, 30, 10);
		expect(posture.level).toBe('siege');
		expect(transitions).toEqual([]);
	});

	it('contains a throwing observer: the machine still escalates and keeps ticking', () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const posture = createPosture({
				admission: makeGate(),
				getThresholds,
				onTransition: () => { throw new Error('observer boom'); }
			});
			tickActive(posture, 5, true);
			expect(posture.level).toBe('elevated');
			// The machine survives the throw and keeps resolving levels.
			tickActive(posture, 10, false);
			expect(posture.level).toBe('normal');
			expect(errSpy).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	it('ignores a non-function onTransition', () => {
		const posture = createPosture({
			admission: makeGate(),
			getThresholds,
			onTransition: 'not a function'
		});
		tickActive(posture, 5, true);
		expect(posture.level).toBe('elevated');
	});
});

// - capacity reason override -----------------------------------------------

describe('applyCapacityReason', () => {
	it('is a no-op at normal: the pressure reason passes through untouched', () => {
		expect(applyCapacityReason('NONE', 'normal')).toBe('NONE');
		expect(applyCapacityReason('SUBSCRIBERS', 'normal')).toBe('SUBSCRIBERS');
		expect(applyCapacityReason('PUBLISH_RATE', 'normal')).toBe('PUBLISH_RATE');
		expect(applyCapacityReason('MEMORY', 'normal')).toBe('MEMORY');
	});

	it('surfaces CAPACITY at elevated when no higher-urgency reason is active', () => {
		expect(applyCapacityReason('NONE', 'elevated')).toBe('CAPACITY');
		expect(applyCapacityReason('SUBSCRIBERS', 'elevated')).toBe('CAPACITY');
		expect(applyCapacityReason('PUBLISH_RATE', 'elevated')).toBe('CAPACITY');
	});

	it('surfaces CAPACITY at siege as well', () => {
		expect(applyCapacityReason('NONE', 'siege')).toBe('CAPACITY');
		expect(applyCapacityReason('SUBSCRIBERS', 'siege')).toBe('CAPACITY');
	});

	it('keeps CAPACITY below MEMORY precedence at any engaged level', () => {
		// MEMORY is the worker-is-approaching-OOM signal and must win.
		expect(applyCapacityReason('MEMORY', 'elevated')).toBe('MEMORY');
		expect(applyCapacityReason('MEMORY', 'siege')).toBe('MEMORY');
	});

	it('does not introduce any reason other than CAPACITY', () => {
		// The only new reason this layer can produce is CAPACITY; it never
		// invents a demand-style reason.
		const out = new Set();
		for (const reason of ['NONE', 'SUBSCRIBERS', 'PUBLISH_RATE', 'MEMORY']) {
			for (const level of ['normal', 'elevated', 'siege']) {
				out.add(applyCapacityReason(reason, level));
			}
		}
		expect([...out].sort()).toEqual(['CAPACITY', 'MEMORY', 'NONE', 'PUBLISH_RATE', 'SUBSCRIBERS']);
		expect(out.has('DEMAND')).toBe(false);
	});

	it('composes after the pure pressure reason without altering it', () => {
		const thresholds = { memoryHeapUsedRatio: 0.85, publishRatePerSec: 10000, subscriberRatio: 50 };
		const calm = { heapUsedRatio: 0.4, publishRate: 100, subscriberRatio: 5 };
		const pureReason = computePressureReason(calm, thresholds);
		expect(pureReason).toBe('NONE');
		// The pure function is untouched; the override is a separate layer on top.
		expect(applyCapacityReason(pureReason, 'normal')).toBe('NONE');
		expect(applyCapacityReason(pureReason, 'elevated')).toBe('CAPACITY');
	});
});
