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

// - Structural state hash ----------------------------------------------------

// FNV-1a 32-bit string fold. Module-private and deliberately duplicated (the few
// lines are trivial) rather than imported from the simulation core, so this
// module keeps its dependency-free, safe-to-import-anywhere posture: pulling in
// the sim core would drag its native-event-loop graph and its determinism
// exemptions behind a pure-predicate file. Fully deterministic - charCodeAt +
// Math.imul over a fixed string, no clock/RNG/locale input.
/** @param {number} h @param {string} str @returns {number} */
function fnvStr(h, str) {
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

const FNV_OFFSET = 2166136261 >>> 0;

/**
 * Fold a structure-only state projection into a single unsigned 32-bit integer
 * that is stable across runs and processes and order-independent over its input.
 *
 * INPUT CONTRACT: `{ topicSeqs }` where `topicSeqs` is a `Record<string, number>`
 * mapping a topic string to the highest non-negative `seq` that topic was
 * observed at. It is a PLAIN, already-extracted object - this module never learns
 * the in-memory app shape; the caller does the extraction. Any other property on
 * the input object is ignored, so two inputs that agree on `topicSeqs` hash
 * identically regardless of what else they carry.
 *
 * PRIVACY (structure only): the returned value carries no recoverable
 * identifiers. Topic strings are folded into the hash but never appear verbatim
 * in the integer; nothing else is read. No payload bytes, no event names, no data
 * values, no presence data, no connection/user keys, no ws ids, no subscriber
 * counts contribute.
 *
 * ORDERING: insertion order must not change the result. Each `[topic, seq]` entry
 * is reduced to a per-entry FNV digest folding the topic STRING and the integer
 * seq (rendered with `String(seq)`, with a `:` separator so a topic/seq boundary
 * cannot collide). The per-entry digests are combined with unsigned 32-bit
 * modular addition, which is commutative and associative, so any iteration order
 * yields the same accumulator. The accumulator starts from a count-seeded base so
 * a state with the same digests but a different number of topics (e.g. one extra
 * zero-seq topic) cannot collide.
 *
 * This is a structural divergence DETECTOR, not a cryptographic commitment: a
 * 32-bit fold has a birthday bound, but a real divergence almost always moves a
 * seq integer, which moves that entry's digest. A later consumer can widen to 64
 * bits if collision risk ever matters.
 *
 * SCOPE: this compares MAXIMA, which is a question no single worker can answer
 * about itself - holding a lower maximum than a sibling is only knowable by
 * comparison, which is what the majority vote over this hash is for. A lost
 * INTERIOR frame is the opposite kind of fact: the worker that lost it can tell
 * on its own (see handler/state.js `recordOriginStream`), so it is reported
 * directly rather than voted on, and deliberately does NOT enter this hash.
 *
 * @param {{ topicSeqs?: Record<string, number> }} projection
 * @returns {number} unsigned 32-bit hash
 */
export function computeStateHash(projection) {
	const topicSeqs = (projection && projection.topicSeqs) || {};
	const topics = Object.keys(topicSeqs);
	let acc = fnvStr(FNV_OFFSET, 't:' + topics.length);
	for (const topic of topics) {
		let e = fnvStr(FNV_OFFSET, topic);
		e = fnvStr(e, ':' + String(topicSeqs[topic]));
		acc = (acc + e) >>> 0;
	}
	return acc >>> 0;
}
