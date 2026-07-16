// The cluster primary's per-slot crash-restart supervisor
// (runtime/restart-supervisor.js). Drives the real supervisor through a
// deterministic in-memory timer queue - no real timers, no worker threads - so
// the scheduling contract is asserted directly. The load-bearing case is the
// two-worker flap: one slot recovering must never cancel another slot's pending
// respawn (the cohort-global regression that left capacity permanently reduced).

import { describe, it, expect } from 'vitest';
import { createRestartSupervisor } from '../src/runtime/restart-supervisor.js';

// Minimal controllable timer queue. `setTimer` records a callback; `fireOldest`
// runs the earliest still-live one (insertion order); `fireAll` drains them.
function makeClock() {
	let idc = 0;
	/** @type {Map<number, { fn: () => void, delay: number, cancelled: boolean }>} */
	const timers = new Map();
	return {
		setTimer(fn, delay) {
			const id = ++idc;
			timers.set(id, { fn, delay, cancelled: false });
			return id;
		},
		clearTimer(id) {
			const t = timers.get(id);
			if (t) t.cancelled = true;
		},
		fireOldest() {
			for (const id of [...timers.keys()]) {
				const t = timers.get(id);
				if (t.cancelled) { timers.delete(id); continue; }
				timers.delete(id);
				t.fn();
				return true;
			}
			return false;
		},
		fireAll() {
			for (const id of [...timers.keys()]) {
				const t = timers.get(id);
				timers.delete(id);
				if (!t.cancelled) t.fn();
			}
		},
		liveTimers() {
			return [...timers.values()].filter((t) => !t.cancelled);
		}
	};
}

// Build a supervisor wired to a fresh clock, plus recorders. `spawn` mirrors
// index.js: the real spawn_worker calls noteSpawn(slot) at its top, so the test
// spawn does too - keeping the simulated lifecycle faithful. `now` is a virtual
// monotonic clock the test advances with `advance(ms)`, so stable-up aging is
// deterministic and never touches real time.
function harness({ maxAttempts = 50, delayBase = 100, delayMax = 5000, stableMs = 30000 } = {}) {
	const clock = makeClock();
	let nowMs = 0;
	const spawned = [];
	const exhausted = [];
	let shuttingDown = false;
	/** @type {ReturnType<typeof createRestartSupervisor>} */
	let sup;
	sup = createRestartSupervisor({
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		now: () => nowMs,
		spawn: (slot) => { spawned.push(`${slot.role}#${slot.index}`); sup.noteSpawn(slot); },
		onExhausted: (slot) => { exhausted.push(`${slot.role}#${slot.index}`); },
		shuttingDown: () => shuttingDown,
		delayBase,
		delayMax,
		maxAttempts,
		stableMs
	});
	return {
		sup,
		clock,
		spawned,
		exhausted,
		advance: (ms) => { nowMs += ms; },
		setShuttingDown: (v) => { shuttingDown = v; }
	};
}

const io = (index) => ({ role: 'io', index });

describe('restart supervisor: per-slot budgets', () => {
	it('grows backoff exponentially while a slot keeps crashing without becoming ready', () => {
		const { sup, clock } = harness();
		sup.register(io(0));

		expect(sup.noteExit(io(0)).delay).toBe(100);
		clock.fireOldest(); // respawn fires (noteSpawn), but the worker never reports ready
		expect(sup.noteExit(io(0)).delay).toBe(200);
		clock.fireOldest();
		expect(sup.noteExit(io(0)).delay).toBe(400);
	});

	it('caps backoff at delayMax', () => {
		const { sup, clock } = harness({ delayBase: 100, delayMax: 300 });
		sup.register(io(0));
		expect(sup.noteExit(io(0)).delay).toBe(100);
		clock.fireOldest();
		expect(sup.noteExit(io(0)).delay).toBe(200);
		clock.fireOldest();
		expect(sup.noteExit(io(0)).delay).toBe(300); // 400 clamped
		clock.fireOldest();
		expect(sup.noteExit(io(0)).delay).toBe(300); // stays clamped
	});
});

describe('restart supervisor: stable-up budget reset', () => {
	// A worker reporting 'ready' no longer resets its slot's budget. The reset
	// happens on the NEXT exit, and only when the worker had been up past
	// stableMs, so a slot that flaps a brief ready between every crash still
	// accumulates attempts and exhausts instead of resetting forever.
	it('a slot flapping faster than stableMs never resets its budget, so it still exhausts', () => {
		const { sup, clock, exhausted, advance } = harness({ maxAttempts: 3 });
		sup.register(io(0));

		// Each cycle: worker boots, reports ready, runs briefly (far under
		// stableMs), then crashes. The old code reset attempts to 0 on every ready,
		// so a flapper's count could never reach the cap - it flapped forever,
		// invisible to the exhaustion escalation. Now attempts climb across cycles.
		for (let i = 1; i <= 3; i++) {
			advance(1000);
			sup.noteReady(io(0));  // brief ready - NOT enough uptime to earn a reset
			advance(1000);
			expect(sup.noteExit(io(0)).attempts).toBe(i); // climbs, not stuck at 1
			clock.fireOldest();    // respawn timer fires -> noteSpawn
		}
		const last = sup.noteExit(io(0)); // 4th crash > cap 3
		expect(last).toEqual({ exhausted: true, attempts: 4 });
		expect(exhausted).toEqual(['io#0']);
	});

	it('a slot up for at least stableMs resets its budget on the next crash', () => {
		const { sup, clock, advance } = harness();
		sup.register(io(0));

		// Two quick crashes with no stable uptime: attempts 2, delay 200.
		expect(sup.noteExit(io(0)).delay).toBe(100);
		clock.fireOldest();
		expect(sup.noteExit(io(0))).toEqual({ delay: 200, attempts: 2 });
		clock.fireOldest();

		// The worker finally comes up and stays up exactly stableMs, then crashes:
		// the crash earns a fresh budget, so it charges as attempt 1 at base backoff.
		sup.noteReady(io(0));
		advance(30000); // == stableMs (inclusive boundary)
		expect(sup.noteExit(io(0))).toEqual({ delay: 100, attempts: 1 });
	});

	it('a crash one ms short of stableMs keeps the accumulated budget', () => {
		const { sup, clock, advance } = harness();
		sup.register(io(0));

		sup.noteExit(io(0)); clock.fireOldest();                          // attempts 1, delay 100
		expect(sup.noteExit(io(0))).toEqual({ delay: 200, attempts: 2 }); // attempts 2, delay 200
		clock.fireOldest();

		sup.noteReady(io(0));
		advance(29999); // one ms short of the stable window
		expect(sup.noteExit(io(0))).toEqual({ delay: 400, attempts: 3 }); // no reset - keeps climbing
	});
});

describe('restart supervisor: two-worker flap regression', () => {
	it('one slot recovering never cancels another slot pending respawn', () => {
		const { sup, clock, spawned } = harness();
		sup.register(io(0));
		sup.register(io(1));
		sup.noteReady(io(0));
		sup.noteReady(io(1));

		// Invariant holds while both are live.
		expect(sup.desired()).toBe(2);
		expect(sup.liveCount() + sup.pendingCount()).toBe(2);

		// Both workers flap at once: two independent pending respawns.
		sup.noteExit(io(0));
		sup.noteExit(io(1));
		expect(sup.liveCount()).toBe(0);
		expect(sup.pendingCount()).toBe(2);
		expect(sup.liveCount() + sup.pendingCount()).toBe(2);

		// io#0 respawns and reports ready BEFORE io#1's timer fires. The
		// cohort-global bug cleared EVERY pending timer here - io#1 would be
		// stranded and capacity permanently 1. Per-slot, io#1 stays pending.
		clock.fireOldest();       // io#0 respawn timer fires -> spawn(io#0)
		sup.noteReady(io(0));
		expect(sup.hasPending(io(1))).toBe(true);   // <-- the fix
		expect(sup.liveCount()).toBe(1);
		expect(sup.pendingCount()).toBe(1);
		expect(sup.liveCount() + sup.pendingCount()).toBe(2); // invariant intact

		// io#1's respawn still fires; both slots come back.
		clock.fireOldest();       // io#1 respawn timer fires -> spawn(io#1)
		sup.noteReady(io(1));
		expect(sup.liveCount()).toBe(2);
		expect(sup.pendingCount()).toBe(0);
		expect(spawned).toEqual(['io#0', 'io#1']);
	});

	it('a ready slot does not reset another slot attempt budget or backoff', () => {
		const { sup, clock } = harness();
		sup.register(io(0));
		sup.register(io(1));

		// io#0 crashes twice (respawn between, never ready): attempts 2, delay 200.
		sup.noteExit(io(0));
		clock.fireOldest();
		expect(sup.noteExit(io(0)).attempts).toBe(2);
		clock.fireOldest();

		// A DIFFERENT slot becoming ready must not touch io#0's budget.
		sup.noteReady(io(1));
		expect(sup.attemptsFor(io(0))).toBe(2);
		expect(sup.noteExit(io(0)).delay).toBe(400); // keeps growing from io#0's own history
	});
});

describe('restart supervisor: exhaustion and reconcile', () => {
	it('reports a slot as exhausted once it passes its attempt cap and stops respawning it', () => {
		const { sup, clock, exhausted } = harness({ maxAttempts: 3 });
		sup.register(io(0));

		expect(sup.noteExit(io(0)).attempts).toBe(1); clock.fireOldest();
		expect(sup.noteExit(io(0)).attempts).toBe(2); clock.fireOldest();
		expect(sup.noteExit(io(0)).attempts).toBe(3); clock.fireOldest();
		const last = sup.noteExit(io(0)); // 4th > cap 3
		expect(last).toEqual({ exhausted: true, attempts: 4 });
		expect(exhausted).toEqual(['io#0']);
		expect(sup.hasPending(io(0))).toBe(false); // no respawn scheduled past the cap
	});

	it('reconcile backfills a slot that is neither live, spawning, nor pending', () => {
		const { sup } = harness();
		sup.register(io(0)); // registered but never spawned/ready: dropped
		sup.register(io(1));
		sup.noteReady(io(1));

		expect(sup.reconcile()).toBe(1);          // only io#0 needed backfilling
		expect(sup.hasPending(io(0))).toBe(true);
		expect(sup.reconcile()).toBe(0);          // nothing left to do
		expect(sup.liveCount() + sup.pendingCount()).toBe(sup.desired());
	});

	it('reconcile leaves a still-booting slot alone (no double-spawn)', () => {
		const { sup } = harness();
		sup.register(io(0));
		sup.noteSpawn(io(0)); // worker booting, not yet ready: live=false, timer=null, spawning=true

		// The trap: a booting slot looks like a dropped one by live/timer alone.
		// The spawning flag must keep reconcile from scheduling a SECOND worker.
		expect(sup.reconcile()).toBe(0);
		expect(sup.hasPending(io(0))).toBe(false);

		sup.noteReady(io(0));
		expect(sup.reconcile()).toBe(0); // live slot: still nothing to do
	});
});

describe('restart supervisor: shutdown', () => {
	it('stopAll cancels pending respawns and no respawn fires during shutdown', () => {
		const { sup, clock, spawned, setShuttingDown } = harness();
		sup.register(io(0));
		sup.noteExit(io(0));
		expect(sup.pendingCount()).toBe(1);

		setShuttingDown(true);
		sup.stopAll();
		expect(sup.pendingCount()).toBe(0);

		// noteExit during shutdown schedules nothing and returns null.
		expect(sup.noteExit(io(0))).toBeNull();

		// Even a timer that somehow survives is a no-op once shutting down.
		clock.fireAll();
		expect(spawned).toEqual([]);
	});
});
