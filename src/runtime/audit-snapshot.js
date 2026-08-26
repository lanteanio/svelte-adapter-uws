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
 * @param {((subscriptions: unknown) => boolean) | null} [args.isSettled] - reports
 *   whether the close path already released a registry's memberships. Injected
 *   rather than imported so this builder still reads nothing but its arguments.
 *   Omit it and the window carries no settled count, which is what a caller that
 *   cannot answer the question should report.
 * @returns {{ connections: Array<{ id: unknown, subscribed: string[] | null, bookkeeping: string[] | null }>, total: number, totalSubscriptions?: number, settled?: number }}
 */
export function buildConnectionAuditSnapshot(args) {
	const { connections, subscriptionsKey, sessionIdKey, totalSubscriptions, offset, limit } = args;
	const isSettled = typeof args.isSettled === 'function' ? args.isSettled : null;
	const total = connections.size;
	/** @type {Array<{ id: unknown, subscribed: string[] | null, bookkeeping: string[] | null }>} */
	const out = [];
	let settled = 0;
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
		// A registry the close path already settled, on a connection still in the
		// live set. Its topics still count toward `summed` while the counter has
		// released them, so it raises the sum against an unchanged total - the
		// same arithmetic as a membership charged twice. Counted, not judged: the
		// predicate is injected so this builder keeps reading only its arguments.
		if (asArray !== null && isSettled !== null && isSettled(subs)) settled++;
		out.push({ id: ud[sessionIdKey], subscribed: asArray, bookkeeping: asArray });
	}
	/** @type {{ connections: typeof out, total: number, totalSubscriptions?: number, settled?: number }} */
	const snap = { connections: out, total };
	// Reported whenever the caller could answer, including zero: "no settled
	// registry in this window" is the half of the answer that rules the leak out,
	// and a field that appears only when it is non-zero cannot say that.
	if (isSettled !== null) snap.settled = settled;
	// Only attach the cap accountant when this window is a COMPLETE census, i.e.
	// every connection the counter describes was materialized into it. The
	// summed-bookkeeping cross-check compares the counter against the sum of the
	// window, so any connection the counter counts but the window omits makes the
	// sum short and reports a drift no membership explains.
	//
	// Requesting the whole range is not enough to get one. A connection whose
	// native handle was freed mid-walk is skipped above, so a window asked for
	// every connection can still come back one short - and the freed connection's
	// close has not run, so the counter still holds its memberships. `out.length
	// === total` is the condition that actually holds: a partial slice (an offset,
	// or a limit below the population) and a skipped handle both fail it, so one
	// test covers the whole class rather than the two cases anyone thought to name.
	if (out.length === total) snap.totalSubscriptions = totalSubscriptions;
	return snap;
}
