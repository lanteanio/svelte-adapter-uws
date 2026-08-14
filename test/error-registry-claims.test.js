// Registry entries driven from the conditions they claim.
//
// generate-error-reference verifies that entries EXIST, are indexed, and render
// into docs/errors.md. It counts and it renders; it cannot read. So an entry can
// name a cause its own code cannot reach, promise a consequence wider than the
// code delivers, or prescribe a next action that reads all-clear under the very
// failure it describes, and every gate stays green. The entries that came back
// defect-after-defect were all of that shape: written by reasoning about what
// could go wrong, then checked by something that cannot evaluate the reasoning.
//
// A case here reaches the condition an entry names through the real code, then
// holds the entry to what it promised about it. Adding an entry is not what
// makes it true; this is.

import { describe, it, expect } from 'vitest';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { createRestartSupervisor } from '../src/runtime/restart-supervisor.js';
import { mergeSamples } from '../src/runtime/utils/metrics-merge.js';
import { SIGNALS } from '../src/runtime/observability-manifest.js';
import { METRIC_REGISTRATIONS_SAMPLE } from '../src/runtime/utils/metrics.js';

// The worker-scoped signals a report must carry to count as complete, taken
// from the manifest so this stays true as the manifest moves.
const REQUIRED_WORKER_SIGNALS = SIGNALS.filter((signal) =>
	signal.merged !== true && signal.optional !== true && signal.scope === 'worker'
);

/** A report that the merge's completeness rule accepts, used as the control. */
function completeWorkerReport(worker) {
	return {
		worker,
		samples: [
			{ name: METRIC_REGISTRATIONS_SAMPLE, families: REQUIRED_WORKER_SIGNALS.map((s) => s.name) },
			...REQUIRED_WORKER_SIGNALS.map((signal) => ({ name: signal.name, labels: {}, value: 0 }))
		]
	};
}

/** Read a single unlabelled gauge out of a rendered Prometheus document. */
function readGauge(text, name) {
	for (const line of String(text).split('\n')) {
		if (line.startsWith('#') || !line.startsWith(name)) continue;
		const rest = line.slice(name.length);
		if (rest.startsWith(' ')) return Number(rest.trim());
	}
	return undefined;
}

/** @param {string} id */
function entryFor(id) {
	const entry = ADAPTER_ERROR_REGISTRY.find((candidate) => candidate.id === id);
	expect(entry, `no registry entry for ${id}`).toBeTruthy();
	return entry;
}

// The primary's real supervisor on a virtual clock - same shape index.js wires,
// with the budget shrunk so exhaustion is reachable in a case rather than after
// fifty crashes.
function supervisor({ maxAttempts = 3, stableMs = 30000 } = {}) {
	let nowMs = 0;
	let id = 0;
	/** @type {Map<number, () => void>} */
	const timers = new Map();
	const spawned = [];
	const exhausted = [];
	/** @type {ReturnType<typeof createRestartSupervisor>} */
	let sup;
	sup = createRestartSupervisor({
		setTimer: (fn) => { timers.set(++id, fn); return id; },
		clearTimer: (t) => timers.delete(t),
		now: () => nowMs,
		spawn: (slot) => { spawned.push(`${slot.role}#${slot.index}`); sup.noteSpawn(slot); },
		onExhausted: (slot) => exhausted.push(`${slot.role}#${slot.index}`),
		shuttingDown: () => false,
		delayBase: 100,
		delayMax: 5000,
		maxAttempts,
		stableMs
	});
	return {
		sup,
		spawned,
		exhausted,
		advance: (ms) => { nowMs += ms; },
		fireAll: () => { for (const [t, fn] of [...timers]) { timers.delete(t); fn(); } }
	};
}

describe('ADAPTER-ERR-RELAY-SPILL-OVERFLOW', () => {
	const entry = () => entryFor(ADAPTER_ERROR_IDS.RELAY_SPILL_OVERFLOW);
	const slot = { role: 'io', index: 0 };

	it('recovers by respawn only while the slot has restart budget left', () => {
		// The entry's own nextAction names a blocked or slow primary as the usual
		// cause. That cause does not clear when one worker is replaced: the
		// replacement queues against the same blocked primary, spills, and exits
		// again without ever reaching stable uptime. Drive exactly that.
		const { sup, spawned, exhausted } = supervisor({ maxAttempts: 3 });

		for (let attempt = 1; attempt <= 3; attempt++) {
			const outcome = sup.noteExit(slot);
			expect(outcome, `attempt ${attempt} should still schedule a respawn`).toMatchObject({ attempts: attempt });
			expect('exhausted' in /** @type {any} */ (outcome)).toBe(false);
		}
		expect(spawned.length).toBe(0); // nothing respawns until a timer fires

		// The next exit is past the budget. This is where "the supervisor replaces
		// it" stops being true, and the primary takes the whole process down.
		const past = sup.noteExit(slot);
		expect(past).toEqual({ exhausted: true, attempts: 4 });
		expect(exhausted).toEqual(['io#0']);
	});

	it('gets a fresh budget only when the replacement actually stays up', () => {
		// The other half of the same rule, so the case above cannot pass for the
		// wrong reason: recovery IS unbounded when each replacement is healthy.
		const { sup, exhausted, advance, fireAll } = supervisor({ maxAttempts: 3, stableMs: 30000 });

		for (let cycle = 0; cycle < 6; cycle++) {
			sup.noteExit(slot);
			fireAll();                 // respawn lands, noteSpawn runs
			sup.noteReady(slot);       // the replacement reports ready
			advance(30000);            // and stays up past stableMs
		}
		expect(exhausted).toEqual([]);
	});

	it('says so, rather than promising recovery its supervisor cannot deliver', () => {
		// Binding the prose to the behaviour above. The entry read "Yes. The worker
		// exits so the supervisor replaces it." - true per incident, and wrong about
		// the condition it is written for, in the direction that misleads: an
		// operator reading an unqualified yes does not expect the process to exit.
		const { automaticRecovery, consequence } = entry();
		expect(automaticRecovery).not.toMatch(/^Yes\.\s*The worker exits so the supervisor replaces it\.$/);
		expect(automaticRecovery).toMatch(/budget/i);
		expect(automaticRecovery).toContain('ADAPTER-ERR-WORKER-RESTART-LIMIT');
		// And it must not promise a sibling is left to reconnect to, since the
		// usual cause takes every worker at once.
		expect(consequence).not.toMatch(/normally to another worker/);
	});

	it('points at the restart-limit entry, which owns the outcome it hands off to', () => {
		// A cross-reference that names an id no longer in the registry sends an
		// operator to a page that does not exist.
		const limit = entryFor(ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT);
		expect(entry().automaticRecovery).toContain(limit.id);
		// The two describe one supervisor from opposite ends, so the entry being
		// handed off to has to actually own the process-exit outcome.
		expect(limit.consequence).toMatch(/primary exits/i);
	});
});

describe('ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE', () => {
	it('does not send the operator to a test its own cause rules out', () => {
		// The entry establishes that an attribute which cannot be serialized is
		// absorbed by the retry and never reaches this line. Guidance that then
		// asks the operator to serialize the event's own attributes contradicts
		// that: attributes are the one input already excluded, so a throw there
		// says nothing about this failure - and under guidance that reads "a
		// difference between them IS the wrapper" it convicts a wrapper that does
		// not exist. Each sentence was true alone; together they pointed at a
		// false positive.
		const entry = entryFor(ADAPTER_ERROR_IDS.DIAGNOSTIC_RENDER_COLLAPSE);

		expect(entry.cause).toMatch(/attributes.*absorbed by the retry|absorbed by the retry/i);
		expect(entry.nextAction).not.toMatch(/on the event's own attributes/);
		// The sound test is the shape the RETRY formats: the envelope WITHOUT
		// attributes, which is what actually failed.
		expect(entry.nextAction).toMatch(/no attributes|without attributes/i);
		// And it must still say why the attributes are not the test, so the
		// branch cannot be reinstated as an obvious-looking improvement.
		expect(entry.nextAction).toMatch(/never produces this line|proves nothing/i);
	});
});

describe('ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY', () => {
	it('does not send the operator to a metric the runtime does not publish', () => {
		// The entry admits its own blind spot - the line is latched and fires once,
		// so it cannot show a trend - and then named a topic-registry gauge as the
		// way to get one. No such signal exists: `topicCount` is carried ONLY as an
		// attribute on this event, and the nearest manifest signal, ws_subscriptions,
		// counts subscriptions rather than distinct topics. Acknowledging a blind
		// spot and then pointing at an instrument that is not there leaves the
		// reader worse off than saying nothing.
		const entry = entryFor(ADAPTER_ERROR_IDS.PRESSURE_TOPIC_REGISTRY);

		// A filter over an empty manifest returns [] and would pass for the wrong
		// reason, so prove the manifest is loaded and that this filter can select
		// before trusting what it does not select.
		expect(SIGNALS.length).toBeGreaterThan(20);
		expect(SIGNALS.filter((signal) => /topic/i.test(`${signal.name} ${signal.help ?? ''}`)).length)
			.toBeGreaterThan(0);

		const cardinalitySignals = SIGNALS.filter((signal) =>
			/topic/i.test(signal.name) && /cardinal|registry|distinct/i.test(`${signal.name} ${signal.help ?? ''}`)
		);
		expect(cardinalitySignals).toEqual([]);
		expect(entry.nextAction).not.toMatch(/topic-registry gauge/i);
		expect(entry.nextAction).toMatch(/no continuous topic-cardinality metric/i);

		// What it points at instead has to be what the event actually carries.
		for (const attribute of ['topPublishers', 'topicCount']) {
			expect(entry.nextAction, `nextAction should name ${attribute}`).toContain(attribute);
		}
	});

	it('still describes a latch the code actually holds', () => {
		// The "fires ONCE per process" claim is the reason the guidance above has to
		// exist at all, so it is pinned here rather than assumed: a repeat-firing
		// warning would need entirely different advice.
		const entry = entryFor(ADAPTER_ERROR_IDS.PRESSURE_TOPIC_REGISTRY);
		expect(entry.nextAction).toMatch(/fires ONCE per process|latched/i);
		expect(entry.automaticRecovery).toMatch(/^None/);
	});
});

describe('ADAPTER-ERR-METRICS-MIRROR-READ', () => {
	it('leaves the failed worker as an expected-versus-reporting gap, not a silent omission', () => {
		// The entry promises the failure is VISIBLE: the worker "contributes
		// nothing to the scrape and appears as a difference between the expected
		// and reporting worker counts, which is the intended signal rather than a
		// silent omission". That is not self-evident from the failure path, which
		// swallows the error and returns an empty sample list - the worker still
		// answers IPC, so it could just as easily have been counted as reporting
		// and vanished. Drive the real merge and hold it to the promise.
		// Built from the signal manifest rather than hand-listed: a hand-rolled
		// report omits fields the completeness rule reads and would then be
		// discounted for a reason that has nothing to do with a mirror read.
		const healthy = completeWorkerReport(1);
		const mirrorFailed = { worker: 2, samples: [] }; // what collectLocalMetrics returns on a throw

		// Tied to the entry, not just to the behaviour: without this the cases
		// below would keep passing after the entry was reworded or removed, and
		// the promise they exist to hold would be gone with nothing failing.
		expect(entryFor(ADAPTER_ERROR_IDS.METRICS_MIRROR_READ).consequence)
			.toMatch(/difference between the expected and reporting worker counts/);

		const text = mergeSamples([healthy, mirrorFailed], { expected: 2, reporting: 2 });
		const reporting = readGauge(text, 'metrics_snapshot_workers_reporting');
		const expected = readGauge(text, 'metrics_snapshot_workers_expected');

		expect(expected).toBe(2);
		// Both workers answered IPC, so a merge that trusted the answer count would
		// print 2 here and hide the failure completely.
		expect(reporting).toBeLessThan(expected);
		expect(reporting).toBe(1);
	});

	it('counts a worker that reported nothing as not reporting, which is what makes the gap appear', () => {
		// The load-bearing half, isolated: an empty sample list is what the failure
		// path produces, and it is discounted for exactly that reason. If an empty
		// report ever counted as complete, the entry above would become false while
		// every gate stayed green.
		const answered = { worker: 1, samples: [], registered: [] };
		const text = mergeSamples([answered], { expected: 1, reporting: 1 });
		expect(readGauge(text, 'metrics_snapshot_workers_reporting')).toBe(0);
	});
});

describe('ADAPTER-ERR-RELAY-FRAME-OVERSIZED', () => {
	it('asks the operator to compare attributes the event actually carries', () => {
		// The emission site passes { declaredBytes, maxFrameBytes }. A nextAction
		// naming a field the record does not carry sends the reader looking for
		// something that was never emitted - the failure this file exists to catch.
		const entry = entryFor(ADAPTER_ERROR_IDS.RELAY_FRAME_OVERSIZED);
		for (const attribute of ['declaredBytes', 'maxFrameBytes']) {
			expect(entry.nextAction, `nextAction should name ${attribute}`).toContain(attribute);
		}
		// The ceiling it describes is derived, not configured directly: the
		// reassembly limit is four times the configured relay frame ceiling.
		expect(entry.cause).toMatch(/four times/i);
	});
});
