// Shared invariant predicates: pure functions of a plain state snapshot that
// return the first violation they find (or null). They are the single source of
// truth for "what correct server state looks like", imported by both the
// in-process consistency auditor (which builds a snapshot from live worker
// state on a background timer) and the deterministic simulator (which builds
// the same snapshot after every step). Keeping the predicates here - not inline
// in either consumer - means a tightened invariant tightens both at once.
//
// A snapshot is a plain, structure-only object. It carries NO payload bytes and
// NO user data; only the bookkeeping shapes an invariant needs. The canonical
// snapshot shape:
//
//   {
//     connections: [{ id, subscribed: string[], bookkeeping: string[] | null }],
//     topicCounts: { [topic]: number },   // subscribers per topic
//     totalSubscriptions: number          // running cap accountant
//   }
//
// Each predicate accepts that snapshot (or the subset it needs) and returns
// `null` when the invariant holds, or `{ category, context }` describing the
// first violation. `category` is a stable `<area>.<thing>` string reused as the
// metric label and the assert/fatal category; `context` is a small serialisable
// object for the structured log - never raw payloads.
//
// This module is dependency-free and reads no clock/RNG/timer, so it is safe to
// import anywhere and trivially deterministic.

/**
 * @typedef {{ id: unknown, subscribed: string[], bookkeeping: string[] | null }} ConnectionSnapshot
 * @typedef {{
 *   connections?: ConnectionSnapshot[],
 *   topicCounts?: Record<string, number>,
 *   totalSubscriptions?: number
 * }} StateSnapshot
 * @typedef {{ category: string, context: unknown } | null} Violation
 */

/**
 * Subscription-bookkeeping invariant: a connection's subscription set (the one
 * fan-out reads) must agree with its cap-counted bookkeeping set. The dispatch
 * maintains the two in lockstep, so this is a regression guard against a code
 * path that mutates one without the other (a missing subscribe, a dropped Set
 * type), not a model of a transport that silently caps or drops a subscription.
 * Returns the first connection whose two sets disagree.
 *
 * @param {StateSnapshot} snap
 * @returns {Violation}
 */
export function checkSubscriptionBookkeeping(snap) {
	const connections = snap && snap.connections;
	if (!connections) return null;
	for (const conn of connections) {
		const bookkeeping = conn.bookkeeping;
		if (!Array.isArray(bookkeeping)) return { category: 'subs.shape', context: { ws: conn.id } };
		const subscribed = conn.subscribed || [];
		if (bookkeeping.length !== subscribed.length) {
			return {
				category: 'subs.bookkeeping',
				context: { ws: conn.id, bookkeeping: bookkeeping.length, subscribed: subscribed.length }
			};
		}
		const subscribedSet = new Set(subscribed);
		for (const t of bookkeeping) {
			if (!subscribedSet.has(t)) return { category: 'subs.bookkeeping.missing', context: { ws: conn.id, topic: t } };
		}
	}
	return null;
}

/**
 * Cap-accountant invariant: the running `totalSubscriptions` counter (checked
 * against the per-worker subscription cap) must never go negative and must
 * equal the sum of every connection's bookkeeping set. A drift here means an
 * add/remove pair fell out of balance, which would let the worker accept past
 * its cap or reject under it. Only evaluated when the snapshot carries the
 * counter and the per-connection sets, so a partial snapshot is a no-op.
 *
 * @param {StateSnapshot} snap
 * @returns {Violation}
 */
export function checkTotalSubscriptions(snap) {
	if (!snap || typeof snap.totalSubscriptions !== 'number') return null;
	if (snap.totalSubscriptions < 0) {
		return { category: 'subs.total-negative', context: { totalSubscriptions: snap.totalSubscriptions } };
	}
	const connections = snap.connections;
	if (!connections) return null;
	let summed = 0;
	for (const conn of connections) {
		if (Array.isArray(conn.bookkeeping)) summed += conn.bookkeeping.length;
	}
	if (summed !== snap.totalSubscriptions) {
		return {
			category: 'subs.total-mismatch',
			context: { totalSubscriptions: snap.totalSubscriptions, summed }
		};
	}
	return null;
}

/**
 * Topic-index invariant: every topic the index counts must have at least one
 * subscriber. A topic that lingers in the index with a zero (or negative) count
 * is a leaked index entry - the unsubscribe/close path that should have evicted
 * it did not. Returns the first such topic.
 *
 * @param {StateSnapshot} snap
 * @returns {Violation}
 */
export function checkTopicsHaveSubscribers(snap) {
	const topicCounts = snap && snap.topicCounts;
	if (!topicCounts) return null;
	for (const topic of Object.keys(topicCounts)) {
		const count = topicCounts[topic];
		if (!(count > 0)) return { category: 'topic.zero-subscribers', context: { topic, count } };
	}
	return null;
}

/**
 * The default predicate set, in the order the auditor and the simulator run
 * them. Ordered cheapest-and-most-fundamental first so a structural break
 * (a dropped Set type) surfaces before the derived accounting checks.
 *
 * @type {Array<(snap: StateSnapshot) => Violation>}
 */
export const defaultInvariants = [
	checkSubscriptionBookkeeping,
	checkTotalSubscriptions,
	checkTopicsHaveSubscribers
];

/**
 * Run a predicate list against a snapshot and collect every violation (one per
 * predicate at most, since each returns its first). Pure: no dedup, no clock,
 * no side effect - the caller owns dedup and routing.
 *
 * @param {StateSnapshot} snap
 * @param {Array<(snap: StateSnapshot) => Violation>} [predicates]
 * @returns {Array<{ category: string, context: unknown }>}
 */
export function runInvariants(snap, predicates = defaultInvariants) {
	const out = [];
	for (const predicate of predicates) {
		const v = predicate(snap);
		if (v) out.push(v);
	}
	return out;
}
