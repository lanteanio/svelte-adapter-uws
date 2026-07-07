// Steady-state hypotheses: pure whole-run predicates that read a trajectory
// recorded across an ENTIRE simulation run and return the first violation each
// finds (or null). They are distinct from the per-step invariant auditor
// (invariants.js, checked after every scheduler round) and from the quiescent
// convergence/misdelivery checks (sim-cluster.js, checked once at end-of-run over
// structural state): these read the run's HISTORY - the recorded virtual clock,
// the publish-time subscriber sets, and every delivered frame - to test
// properties no single step can see.
//
// Posture is identical to invariants.js: dependency-free, reads no clock / RNG /
// timer (no Date.now / Math.random / setTimeout), so it is trivially
// deterministic and safe to import anywhere. A recorded trajectory is a plain,
// already-extracted object - this module never learns the in-memory app shape;
// the runner does the extraction and hands over structure only.
//
// Each predicate returns `null` when its hypothesis holds, or a
// `{ category, context }` describing the first violation - the exact shape the
// per-step auditor produces - so the runner folds the results into its existing
// `invariantViolations` de-dup unchanged and a clean run stays `[]`.
//
// Categories:
//   steady.time-nonmonotonic     - the recorded virtual clock went backward
//   steady.no-quiescence         - the run did not drain (leftover refed work)
//   steady.delivery-nonmonotonic - a client saw a per-topic seq regress
//   steady.starvation            - a publish-time subscriber never got a frame
// plus topic.zero-subscribers (reused from invariants.js on the terminal snapshot).

import { checkTopicsHaveSubscribers } from './invariants.js';

/**
 * @typedef {{ drop?: boolean, duplicate?: boolean, corrupt?: boolean, reorder?: boolean, disrupted?: boolean, multiOriginator?: boolean }} FaultClasses
 * @typedef {{ id: unknown, raw: Array<{ routingTopic?: string | null }>, decoded: any[] }} DeliveredClient
 * @typedef {{ topic: string, subscribers: Array<unknown> }} PublishLogEntry
 * @typedef {{
 *   clockSamples?: number[],
 *   drained?: boolean,
 *   pending?: number,
 *   terminal?: { topicCounts?: Record<string, number> },
 *   publishLog?: PublishLogEntry[],
 *   clients?: DeliveredClient[],
 *   faults?: FaultClasses
 * }} SteadyStateTrajectory
 * @typedef {{ category: string, context: unknown } | null} SteadyStateViolation
 */

/**
 * Reduce a run's raw + relay fault spec to the boolean fault classes the guards
 * read. A fault class is "active" when its probability is above zero in EITHER
 * channel (the per-worker wire faults or, for a cluster run, the cross-worker
 * relay faults), because a legitimate interleaving under either one is exactly
 * what the guard exists to excuse. Pure: reads only the passed-in spec objects.
 *
 * @param {{ drop?: number, duplicate?: number, corrupt?: number, reorder?: number } | undefined} faults
 * @param {{ drop?: number, duplicate?: number, corrupt?: number, reorder?: number } | undefined} [relayFaults]
 * @returns {FaultClasses}
 */
export function faultClasses(faults, relayFaults) {
	const a = faults || {};
	const b = relayFaults || {};
	const on = (key) => Number(a[key]) > 0 || Number(b[key]) > 0;
	return {
		drop: on('drop'),
		duplicate: on('duplicate'),
		corrupt: on('corrupt'),
		reorder: on('reorder')
	};
}

/**
 * Whether the delivery-monotonic hypothesis is suppressed for this run. A
 * `reorder` fault legitimately re-orders frames, a `duplicate` fault legitimately
 * re-delivers one (both make a per-topic seq regress), and a `corrupt` fault
 * mangles the envelope body the seq is read from (a flipped digit fabricates a
 * regression), so under any of them a seq that goes backward is expected, not a
 * bug. A cluster run with more than one worker publishing to the same topic
 * interleaves two independent seq spaces, which also reads as non-monotonic at a
 * subscriber, so `multiOriginator` suppresses it too.
 *
 * @param {FaultClasses | undefined} faults
 * @returns {boolean}
 */
function guardedForDelivery(faults) {
	return !!(faults && (faults.reorder || faults.duplicate || faults.corrupt || faults.multiOriginator));
}

/**
 * Whether the no-starvation hypothesis is suppressed for this run. A `drop`
 * fault legitimately drops a frame (a subscriber correctly gets nothing) and a
 * `corrupt` fault mangles the body, so under either one a subscriber that
 * received no readable frame on a topic is expected, not a bug. A cluster run
 * that lost a worker (a flap / wedge / restart / restart-budget fatal) also
 * legitimately drops in-flight deliveries to that worker's clients, so
 * `disrupted` suppresses it too.
 *
 * @param {FaultClasses | undefined} faults
 * @returns {boolean}
 */
function guardedForStarvation(faults) {
	return !!(faults && (faults.drop || faults.corrupt || faults.disrupted));
}

/**
 * Time-monotonicity hypothesis: the virtual clock sampled once per scheduler
 * round must never step backward. The scheduler advances `vnow` monotonically by
 * construction, so this is a regression guard against a future change that lets a
 * clock read regress (which would break every timestamp the wire transcript
 * stamps and every replay derived from it), not a model of a transport. Equal
 * consecutive samples are fine (many rounds fire at one virtual time); only a
 * strict decrease is a violation. Returns the first backward step.
 *
 * @param {number[] | undefined} clockSamples the recorded virtual-clock readings, in order
 * @returns {SteadyStateViolation}
 */
export function checkTimeMonotonic(clockSamples) {
	if (!Array.isArray(clockSamples)) return null;
	for (let i = 1; i < clockSamples.length; i++) {
		if (clockSamples[i] < clockSamples[i - 1]) {
			return {
				category: 'steady.time-nonmonotonic',
				context: { at: i, from: clockSamples[i - 1], to: clockSamples[i] }
			};
		}
	}
	return null;
}

/**
 * Natural-quiescence hypothesis: a healthy run drains to a fixpoint on its own -
 * the scheduler reaches ZERO refed pending work without needing teardown. The
 * sound signal is `pending` (the refed-callback count left when the run settled):
 * `pending > 0` means real leftover work - a leaked refed timer, or a run that hit
 * the step budget while work still remained (a busy-loop / unbounded reschedule),
 * both of which leave refed work behind. `drained` (whether the final drive
 * stopped below `maxSteps`) is carried as diagnostic context only, NOT a firing
 * trigger: a run can settle to zero pending EXACTLY as the step count reaches the
 * budget, which is a clean fixpoint, so firing on `drained === false` alone would
 * be a false positive. No fault guard: the fault engine only ever schedules
 * bounded, refed deliveries that drain, so leftover refed work is always a defect.
 *
 * @param {{ drained?: boolean, pending?: number }} q
 * @returns {SteadyStateViolation}
 */
export function checkQuiescence(q) {
	if (!q) return null;
	if (typeof q.pending === 'number' && q.pending > 0) {
		return {
			category: 'steady.no-quiescence',
			context: { drained: q.drained !== false, pending: q.pending }
		};
	}
	return null;
}

/**
 * Delivery-monotonicity hypothesis: within one client, the per-topic broadcast
 * sequence numbers it receives are strictly increasing. The originator stamps a
 * monotonic `seq` into every published envelope body, so a subscriber that reads
 * that seq going backward - or repeating - on one topic saw a delivery-order or
 * duplication defect. Grouped on the UNcorrupted routing key carried on each raw
 * frame (never the corruptible decoded topic), and only over frames whose body
 * decoded to a numeric seq (a control ack, a non-topic send, or an undecodable
 * body simply does not participate). Suppressed under reorder / duplicate /
 * corrupt / multi-originator (see guardedForDelivery). Returns the first regress.
 *
 * @param {DeliveredClient[] | undefined} clients
 * @param {FaultClasses | undefined} faults
 * @returns {SteadyStateViolation}
 */
export function checkDeliveryMonotonic(clients, faults) {
	if (guardedForDelivery(faults)) return null;
	if (!Array.isArray(clients)) return null;
	for (const c of clients) {
		const raw = (c && c.raw) || [];
		const decoded = (c && c.decoded) || [];
		/** @type {Map<string, number>} topic -> highest seq delivered to this client so far */
		const lastSeq = new Map();
		for (let i = 0; i < raw.length; i++) {
			const f = raw[i];
			if (!f || f.routingTopic == null) continue; // only a topic publish carries a routing key
			const body = decoded[i];
			if (!body || typeof body.seq !== 'number') continue; // no seq to compare
			const t = f.routingTopic;
			if (lastSeq.has(t) && body.seq <= lastSeq.get(t)) {
				return {
					category: 'steady.delivery-nonmonotonic',
					context: { client: c.id, topic: t, seq: body.seq, prev: lastSeq.get(t) }
				};
			}
			lastSeq.set(t, body.seq);
		}
	}
	return null;
}

/**
 * No-starvation (eventual-delivery) hypothesis: every subscriber that was on a
 * topic AT THE MOMENT a broadcast fanned out must receive at least one frame on
 * that topic by end-of-run. The subscriber set in `publishLog` is captured at
 * PUBLISH time (not end-of-run), so for a SYNCHRONOUS-delivery path (single
 * worker: the publish fan-out schedules each subscriber's frame in the same tick
 * it reads membership) a mid-run subscribe / unsubscribe never makes it misfire -
 * only clients actually eligible for that broadcast are checked. A DEFERRED-
 * delivery path (the cross-worker relay) can drop a client that unsubscribes
 * inside the delivery window, so its runner pre-restricts `publishLog` to
 * subscribers still on the topic at end-of-run before calling here (see
 * runClusterSim); this predicate itself only reads the log it is handed.
 * Reception is counted on the UNcorrupted routing key, so a corrupt body still
 * counts as delivered (and corrupt is guarded off regardless). Suppressed under
 * drop / corrupt / cluster disruption (see guardedForStarvation). A publish
 * nobody was subscribed to, and a client that received MORE than was logged, are
 * both fine - the check only fails on a logged subscriber that got nothing.
 * Returns the first starved (subscriber, topic).
 *
 * @param {DeliveredClient[] | undefined} clients
 * @param {PublishLogEntry[] | undefined} publishLog
 * @param {FaultClasses | undefined} faults
 * @returns {SteadyStateViolation}
 */
export function checkStarvation(clients, publishLog, faults) {
	if (guardedForStarvation(faults)) return null;
	if (!Array.isArray(publishLog) || publishLog.length === 0) return null;
	if (!Array.isArray(clients)) return null;
	// Per client id: the set of topics it received at least one routed frame on.
	/** @type {Map<unknown, Set<string>>} */
	const receivedTopics = new Map();
	for (const c of clients) {
		if (!c) continue;
		const set = new Set();
		for (const f of (c.raw || [])) {
			if (f && f.routingTopic != null) set.add(f.routingTopic);
		}
		receivedTopics.set(c.id, set);
	}
	for (const entry of publishLog) {
		if (!entry) continue;
		const subscribers = entry.subscribers || [];
		for (const subId of subscribers) {
			const set = receivedTopics.get(subId);
			if (!set || !set.has(entry.topic)) {
				return {
					category: 'steady.starvation',
					context: { client: subId, topic: entry.topic }
				};
			}
		}
	}
	return null;
}

/**
 * Run every steady-state hypothesis against one recorded trajectory and collect
 * the violations (one per hypothesis at most, since each returns its first).
 * Pure: no de-dup, no clock, no side effect - the runner owns de-dup and folds
 * the results into its existing `invariantViolations` list. A clean run returns
 * `[]`, so a caller that folds and compares stays byte-identical to today.
 *
 * The terminal orphan-topic check reuses `checkTopicsHaveSubscribers` verbatim
 * over the run's final snapshot (its `topicCounts`), so a topic left in the index
 * with a zero/negative count surfaces here as `topic.zero-subscribers` - the same
 * category and shape the per-step auditor would use, with no new predicate.
 *
 * @param {SteadyStateTrajectory} trajectory
 * @returns {Array<{ category: string, context: unknown }>}
 */
export function runSteadyState(trajectory) {
	const t = trajectory || {};
	const out = [];
	const add = (v) => { if (v) out.push(v); };
	add(checkTimeMonotonic(t.clockSamples));
	add(checkQuiescence({ drained: t.drained, pending: t.pending }));
	add(checkTopicsHaveSubscribers(t.terminal || {}));
	add(checkDeliveryMonotonic(t.clients, t.faults));
	add(checkStarvation(t.clients, t.publishLog, t.faults));
	return out;
}
