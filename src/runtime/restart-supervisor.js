/**
 * Per-slot crash-restart supervisor for the cluster primary.
 *
 * A cluster owns a FIXED set of worker slots - `io_count` io slots plus
 * `compute_count` compute slots. Each slot has a stable identity (`role#index`)
 * that survives a crash: a dead worker's replacement re-occupies the SAME slot
 * with the same replayed workerData. This supervisor tracks the restart attempt
 * count, the exponential backoff delay, and the pending respawn timer PER SLOT.
 *
 * The point of per-slot state is isolation. When these three lived as single
 * cohort-global variables, any worker reaching "ready" reset the shared backoff
 * and cleared EVERY pending restart timer - so a simultaneous two-worker flap
 * let the first slot's recovery cancel the second slot's still-pending respawn,
 * and capacity stayed permanently reduced. With per-slot budgets a slot only
 * ever resets or reschedules itself, and `reconcile()` reschedules any slot left
 * with no live worker, no booting worker, and no pending respawn - a safety net
 * for the live-plus-spawning-plus-pending-equals-desired invariant. (A slot that
 * is merely booting, `spawning`, is intentionally left alone; a worker that
 * WEDGES mid-boot - never reports and so stays `spawning` forever - is out of
 * this module's reach and is the primary's boot-deadline watchdog's job.)
 *
 * A worker reporting ready no longer resets its slot's budget on its own. A
 * crash-looping slot that reports a brief `ready` between every crash would
 * otherwise reset its attempt count on every recovery and so never exhaust - it
 * would flap forever, invisible to the exhaustion escalation. Instead the budget
 * resets on the NEXT exit, and only when the slot had been stably up for at
 * least `stableMs`: a genuinely healthy worker that finally dies gets a fresh
 * backoff, while a fast flapper (up for less than `stableMs` between crashes)
 * keeps accumulating attempts until it exhausts. `noteReady` just records when
 * the worker came up; `noteExit` reads that timestamp to decide.
 *
 * All timing is injected (`setTimer`/`clearTimer`/`now`) so the scheduling logic
 * is unit-testable without real timers or real worker threads. Cold path: this
 * only runs when a worker actually exits.
 *
 * @param {object} opts
 * @param {(fn: () => void, ms: number) => any} opts.setTimer  schedule a respawn
 * @param {(token: any) => void} opts.clearTimer  cancel a scheduled respawn
 * @param {(slot: { role: string, index: number }) => void} opts.spawn  (re)spawn a worker for the slot
 * @param {(slot: { role: string, index: number }) => void} opts.onExhausted  a slot exceeded maxAttempts (fatal)
 * @param {() => boolean} opts.shuttingDown  true once the primary is tearing down
 * @param {() => number} [opts.now]  monotonic clock in ms (default performance.now); used to age stable uptime
 * @param {number} [opts.delayBase]  first backoff delay in ms (default 100)
 * @param {number} [opts.delayMax]  backoff ceiling in ms (default 5000)
 * @param {number} [opts.maxAttempts]  per-slot restart cap before onExhausted (default 50)
 * @param {number} [opts.stableMs]  min uptime before a crash resets the slot's budget (default 30000)
 */
export function createRestartSupervisor({
	setTimer,
	clearTimer,
	spawn,
	onExhausted,
	shuttingDown,
	now = () => performance.now(),
	delayBase = 100,
	delayMax = 5000,
	maxAttempts = 50,
	stableMs = 30000
}) {
	/**
	 * Each slot is always in exactly one of four accounting states so
	 * live-plus-spawning-plus-pending equals desired at all times (minus any
	 * exhausted slots): `live` (worker reported ready), `spawning` (a worker is
	 * booting but has not reported yet), a pending respawn `timer`, or exhausted.
	 * `spawning` is what lets reconcile() tell a still-booting slot (which needs
	 * no action) from a genuinely dropped one (which does). `readyAt` is the
	 * monotonic time the current worker reported ready (null while it is booting
	 * or after it exited); `noteExit` compares it against `stableMs` to decide
	 * whether the crash earns a fresh budget.
	 * @typedef {{ role: string, index: number, attempts: number, delay: number,
	 *   timer: any, live: boolean, spawning: boolean, readyAt: number | null }} SlotState
	 */
	/** @type {Map<string, SlotState>} */
	const slots = new Map();

	/** @param {{ role: string, index: number }} slot */
	const keyOf = (slot) => slot.role + '#' + slot.index;

	/** @param {{ role: string, index: number }} slot @returns {SlotState} */
	function stateOf(slot) {
		const key = keyOf(slot);
		let s = slots.get(key);
		if (s === undefined) {
			s = { role: slot.role, index: slot.index, attempts: 0, delay: 0, timer: null, live: false, spawning: false, readyAt: null };
			slots.set(key, s);
		}
		return s;
	}

	/** @param {SlotState} s */
	function cancelTimer(s) {
		if (s.timer !== null) {
			clearTimer(s.timer);
			s.timer = null;
		}
	}

	/**
	 * Schedule the slot's respawn after its current backoff. No-op if a timer is
	 * already pending (one worker per slot, so one pending respawn per slot) or
	 * if shutting down. Returns the delay used, or null when nothing scheduled.
	 * @param {SlotState} s
	 * @returns {number | null}
	 */
	function schedule(s) {
		if (shuttingDown() || s.timer !== null) return null;
		const delay = s.delay;
		s.timer = setTimer(() => {
			s.timer = null;
			if (shuttingDown()) return;
			spawn({ role: s.role, index: s.index });
		}, delay);
		return delay;
	}

	return {
		/**
		 * Register a slot before its initial spawn so `reconcile()` and
		 * `desired()` account for it even before the first worker reports.
		 * @param {{ role: string, index: number }} slot
		 */
		register(slot) {
			stateOf(slot);
		},

		/**
		 * A worker is (re)spawning for this slot: mark it not-yet-live and drop any
		 * pending respawn timer (the initial boot spawn has none; a timer-driven
		 * respawn has already fired). Call at the top of the spawn routine.
		 * @param {{ role: string, index: number }} slot
		 */
		noteSpawn(slot) {
			const s = stateOf(slot);
			cancelTimer(s);
			s.live = false;
			s.spawning = true;
			s.readyAt = null;
		},

		/**
		 * The slot's worker confirmed alive. Records when it came up (so a later
		 * exit can tell a stably-up worker from a flapper) and clears ONLY this
		 * slot's pending timer - never another slot's. Readiness is slot-local, and
		 * deliberately does NOT reset the attempt budget here: a slot that reports a
		 * brief ready between every crash must still accumulate attempts and
		 * exhaust. The budget reset moved to `noteExit`, gated on stable uptime.
		 * @param {{ role: string, index: number }} slot
		 */
		noteReady(slot) {
			const s = stateOf(slot);
			cancelTimer(s);
			s.live = true;
			s.spawning = false;
			s.readyAt = now();
		},

		/**
		 * The slot's worker exited. If the worker had been ready for at least
		 * `stableMs`, this crash earns a fresh budget (attempts and backoff reset)
		 * before it is charged - a healthy worker that finally dies restarts fast.
		 * A worker that was up for less than `stableMs` (or never reported ready)
		 * keeps its accumulated budget, so a fast flapper climbs toward the cap
		 * instead of resetting on every recovery. Either way this charges one
		 * attempt against THIS slot's budget and schedules THIS slot's respawn
		 * after its own exponential backoff. Returns `{ delay, attempts }` for the
		 * caller's log line, `null` when shutting down, or `{ exhausted: true,
		 * attempts }` when the slot passed its cap (the caller-supplied
		 * `onExhausted` has already fired).
		 * @param {{ role: string, index: number }} slot
		 * @returns {{ delay: number, attempts: number } | { exhausted: true, attempts: number } | null}
		 */
		noteExit(slot) {
			const s = stateOf(slot);
			const wasStablyUp = s.readyAt !== null && now() - s.readyAt >= stableMs;
			s.live = false;
			s.spawning = false;
			s.readyAt = null;
			if (shuttingDown()) return null;
			if (wasStablyUp) {
				s.attempts = 0;
				s.delay = 0;
			}
			s.attempts += 1;
			if (s.attempts > maxAttempts) {
				onExhausted({ role: s.role, index: s.index });
				return { exhausted: true, attempts: s.attempts };
			}
			s.delay = s.delay ? Math.min(s.delay * 2, delayMax) : delayBase;
			const delay = schedule(s);
			return { delay: delay ?? s.delay, attempts: s.attempts };
		},

		/**
		 * Safety-net reconciliation of the accounting invariant: any registered
		 * slot that is not live, not currently spawning, has no pending respawn,
		 * and is under its attempt cap gets a respawn scheduled at its current
		 * backoff. A slot that is merely booting (`spawning`) is left alone - that
		 * distinction is why the `spawning` state exists, so this can run on a
		 * timer without double-scheduling a worker that just has not reported yet.
		 * A correct event sequence never needs this; it exists so a future
		 * regression that drops a slot cannot silently shrink capacity.
		 * @returns {number} how many slots it had to backfill
		 */
		reconcile() {
			if (shuttingDown()) return 0;
			let backfilled = 0;
			for (const s of slots.values()) {
				if (!s.live && !s.spawning && s.timer === null && s.attempts <= maxAttempts) {
					schedule(s);
					backfilled += 1;
				}
			}
			return backfilled;
		},

		/** Cancel every pending respawn (shutdown). */
		stopAll() {
			for (const s of slots.values()) cancelTimer(s);
		},

		/** Total registered slots (the desired worker count). */
		desired() {
			return slots.size;
		},

		/** Slots with a live worker right now. */
		liveCount() {
			let n = 0;
			for (const s of slots.values()) if (s.live) n += 1;
			return n;
		},

		/** Slots with a pending (scheduled, not yet fired) respawn. */
		pendingCount() {
			let n = 0;
			for (const s of slots.values()) if (s.timer !== null) n += 1;
			return n;
		},

		/** @param {{ role: string, index: number }} slot */
		hasPending(slot) {
			const s = slots.get(keyOf(slot));
			return s !== undefined && s.timer !== null;
		},

		/** @param {{ role: string, index: number }} slot */
		attemptsFor(slot) {
			const s = slots.get(keyOf(slot));
			return s === undefined ? 0 : s.attempts;
		}
	};
}
