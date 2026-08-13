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
