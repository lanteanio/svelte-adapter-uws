// Bounded, structure-only snapshot builder for the per-worker consistency
// auditor. Pure with respect to its arguments (reads no clock / RNG / module
// singletons), so a unit test drives it with fake connections and the handler
// install site closes over the live state. Kept out of the predicate module so
// invariants.js stays dependency-free; kept out of handler.js so it is testable
// without the rollup-global handler graph.
//
// The window is round-robin: the auditor advances `offset` by the page size each
// tick and wraps at the reported `total`, so a worker with a million connections
// audits a fixed slice per tick. We iterate the connection set ONCE with a
// skip-counter rather than materializing the whole population (a spread + slice
// would allocate every connection every tick and defeat the bound).

/**
 * Build a bounded snapshot of the round-robin window of live connections in the
 * shape the shared invariant predicates read.
 *
 * @param {object} args
 * @param {Iterable<any> & { size: number }} args.connections - the live
 *   connection set (read for `.size` as the population total and iterated for
 *   the window).
 * @param {symbol | string} args.subscriptionsKey - the userData slot holding the
 *   per-connection subscription `Set`.
 * @param {symbol | string} args.sessionIdKey - the userData slot holding the
 *   per-connection session id (used only as a structure-only log label).
 * @param {number} args.totalSubscriptions - the live cap-accountant counter.
 * @param {number} args.offset - window start (round-robin position).
 * @param {number} args.limit - window size (max connections this tick).
 * @returns {{ connections: Array<{ id: unknown, subscribed: string[] | null, bookkeeping: string[] | null }>, total: number, totalSubscriptions?: number }}
 */
export function buildConnectionAuditSnapshot(args) {
	const { connections, subscriptionsKey, sessionIdKey, totalSubscriptions, offset, limit } = args;
	const total = connections.size;
	/** @type {Array<{ id: unknown, subscribed: string[] | null, bookkeeping: string[] | null }>} */
	const out = [];
	let i = 0;
	for (const ws of connections) {
		if (i < offset) { i++; continue; }
		if (out.length >= limit) break;
		i++;
		// `getUserData` throws on a freed native handle. The close path removes a
		// connection from the set synchronously before the slot could be observed
		// non-Set, so a freed read here is rare - but guard it: a freed handle is
		// skipped, never reported as a violation.
		let ud;
		try { ud = ws.getUserData(); }
		catch { continue; }
		const subs = ud[subscriptionsKey];
		// In production there is exactly ONE subscription Set per connection, so
		// `subscribed` and `bookkeeping` read the same Set and
		// checkSubscriptionBookkeeping degrades to a pure Set-shape guard. A non-Set
		// slot yields null for both, which fires `subs.shape` - the regression guard.
		const asArray = subs instanceof Set ? [...subs] : null;
		out.push({ id: ud[sessionIdKey], subscribed: asArray, bookkeeping: asArray });
	}
	/** @type {{ connections: typeof out, total: number, totalSubscriptions?: number }} */
	const snap = { connections: out, total };
	// Only attach the cap accountant when the window covers ALL connections. On a
	// partial slice the summed-bookkeeping cross-check in checkTotalSubscriptions
	// would false-positive off a partial sum, so omit it and let the predicate
	// degrade to the negative-only check on a full pass.
	if (offset === 0 && total <= limit) snap.totalSubscriptions = totalSubscriptions;
	return snap;
}
