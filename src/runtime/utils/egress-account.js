// The publish-egress accounting primitives shared by every fan-out surface:
// the production runtime (via handler/egress-budget.js), the createTestServer
// harness, and the dev plugin all run THIS account, so the charge law and the
// ceiling semantics cannot drift between them. A leaf module on purpose -
// like message-admission.js beside it - importing nothing that reaches the
// production handler graph, so the harness and the dev plugin can load it
// without dragging the bridged handler modules in.
//
// The charge law, stated once (docs/tenancy.md carries the cross-repo
// contract):
//   - One charge per logical publish. The batching primitives that build one
//     wire frame - publishBatched and publishWireBatch - are N logical
//     publishes sharing ONE admission decision. `platform.batch()` is not one
//     of them: it is a convenience wrapper over N independent publish calls and
//     each takes its own decision, so a ceiling can admit part of it.
//   - deliveries = local recipients at the instant of the publish, minus an
//     excluded socket that holds the subscription, times messages. Each
//     surface counts from the registry it delivers by: the production runtime
//     from its tracked logical membership, createTestServer from the native
//     subscriber count, the dev plugin from the subscription map it maintains
//     itself.
//   - bytes = the serialized form the lane sends, per recipient: UTF-8 bytes
//     of the JSON envelope, or the encoded binary frame where the lane
//     produces one for capability-advertising subscribers. Pre-compression;
//     permessage-deflate is a transport concern the budget does not see.
//   - Relay-received frames charge NOTHING: the origin worker charged its own
//     local recipients, and each instance owns only its own egress.
//
// Enforcement semantics, stated once (the extensions bus mirrors these for
// cross-instance multiplication):
//   - Ceilings are per rotation window (windowMs, default 1000 ms, lazily
//     rotated - no timer).
//   - The messages and deliveries ceilings refuse the publish that WOULD
//     cross them (both quantities are known before the decision).
//   - The bytes ceiling refuses once the window's charged bytes have REACHED
//     it: a publish's byte weight exists only after serialization, which must
//     not happen before admission (a stamped-then-refused publish would leave
//     a client-visible sequence gap), so the crossing publish is delivered
//     and the next is refused. Overshoot is bounded by one publish's bytes.
//   - The decision is made before the first frame of a logical publish; there
//     is no mid-walk shedding.

import { monotonicNow } from '../runtime.js';
import { isValidAttributionId } from './attribution.js';
import { WS_SUBSCRIPTIONS } from './ws-symbols.js';

export const EGRESS_DEFAULT_WINDOW_MS = 1000;

/**
 * Marks an options object whose call already took the egress decision for a
 * whole batch, so the per-entry lane charges without re-deciding (see
 * `publishWireBatch`'s stateless branch and `publishBatched`'s slow path).
 *
 * A Symbol, not a string key: a string would be settable by any caller that
 * hands a publish an options object, which would turn an internal batch
 * detail into a way to bypass every ceiling. Only code that imports this
 * module can name it, and it survives no JSON round trip - so it can never
 * arrive from a client or from a relayed frame either.
 */
export const EGRESS_ADMITTED = Symbol('adapter-uws.egress-admitted');

/**
 * Default bound on the per-scope usage maps and the tenant-resolution memo: the
 * ledger never holds more entries than its bound, and a key seated past it is a
 * key some other key gave its ceiling up for. `egress.maxKeys` sizes it; this
 * is what applies when the option is absent.
 *
 * A POWER OF TWO deliberately, and for MEMORY. V8 sizes a Map's backing table
 * to a power of two and, under the steady delete-plus-insert churn a ledger at
 * its bound performs, settles it above roughly twice the live count. So 4096
 * settles into an 8192-slot table at 56 bytes per entry while 4353 would take a
 * 16384-slot one at 105 - nearly double the footprint for one more key, on a
 * structure that exists once per scope per worker. That law is why a configured
 * `maxKeys` is rounded UP to the next power of two rather than taken verbatim:
 * the backing table is the power-of-two size either way, so the rounded bound
 * holds no fewer keys - strictly more whenever rounding moves the value - in
 * the same memory the requested one would have taken. The sweep slack is
 * derived from the bound and is not part of the rule.
 *
 * The power of two buys no CPU, and the file used to claim it did. Iteration
 * and rehash cost per operation measured flat across the boundary (147.4
 * against 147.3 ns), and the larger table actually rehashes less often. The
 * claim came from readings that sat inside one unchanged arm's warm-up spread.
 *
 * A key that finds the ledger at its sweep floor reclaims lapsed windows before
 * it is seated, and a key's ceiling is given up only once the ledger is full and
 * reclamation has failed to free a slot. So what fills the map is the keys live
 * at once and not every key the worker has ever published to: 3800 topics
 * publishing in most windows, plus a trickle of one-shot topics, evict nothing,
 * where the same workload with no reclamation gave up 307 live windows.
 *
 * Once more keys than the bound are LIVE inside a single window there is
 * nothing expired left to reclaim, and eviction starts costing enforcement: the
 * evicted key restarts empty, so a key at its ceiling is admitted again for the
 * rest of that window. Every eviction of that kind increments
 * `egress_window_evicted_total`, because the symptom - fewer refusals - is
 * otherwise indistinguishable from traffic that simply fits. A workload there
 * used to be stuck with the documentation as the whole answer; now it sizes
 * `egress.maxKeys` to its live cardinality, at the documented 56 bytes per
 * seated key. The scope argument still bounds the damage when nobody does:
 * `tenant` windows need this many distinct TENANT ids to turn over, so the
 * fair-share case holds under any topic cardinality, including the unbounded
 * `room:<uuid>` shape whose keys retire for good after a few windows.
 */
const EGRESS_DEFAULT_MAX_KEYS = 4096;

/**
 * The values `maxKeys` may take, duplicated verbatim in the shared guard
 * (`assertEgressSection` in src/config-guards.js) so every intake surface
 * refuses what this module would silently replace with the default. Below the
 * floor there is no sizing story - the option exists because deployments need
 * MORE keys, the whole default costs ~230 KB per scope, and a tiny cap guts
 * enforcement quietly. The ceiling is V8's own: a Map refuses its
 * 16,777,217th entry ('Map maximum size exceeded', verified empirically at
 * exactly 2^24), so a larger bound would crash the publish path on an insert
 * before eviction ever engaged. 2^24 itself is safe - at the bound the
 * eviction frees a slot before the seat, so the size never exceeds it. There
 * is deliberately no `0 disables`: an unbounded ledger turns topic
 * cardinality into the same crash, behind unbounded memory first.
 */
const EGRESS_MAX_KEYS_FLOOR = 1024;
const EGRESS_MAX_KEYS_CEILING = 2 ** 24;

/**
 * How many entries an eviction inspects before it takes the least active one it
 * saw, when `egress.evictionSample` does not size it. Small because an expired
 * window wins outright and ends the sample, and that is the common case in the
 * churn that reaches the cap at all. A deployment that raises `maxKeys` by an
 * order of magnitude may widen it to match - the sample is what finds an
 * expired window before a live one is taken - and the walk stays bounded at
 * any width, because a pass wraps the ledger at most once per eviction
 * whatever the sample asks for.
 */
const EGRESS_DEFAULT_EVICT_SAMPLE = 8;

/**
 * How many entries a new key sweeps for expired windows before it is seated.
 * Larger than one so the map drains faster than keys arrive: at one step per
 * insert a sweep only keeps pace with the churn feeding it, and the expired
 * backlog never shrinks.
 *
 * It runs on an insert that finds the map at or above its sweep floor - the
 * bound less its slack, not the bound itself - because at the bound the only
 * remaining move is to take somebody's ceiling, and the whole design is to have
 * reclaimed before that. Below the floor an expired window is harmless: it
 * holds one map slot and answers the next read with a reset, so nothing pays
 * for reclamation it does not need. That boundary is what a floor buys, and how
 * far down to put it is a real trade: sweeping from HALF the cap was measured
 * and rejected, because a ledger parked between that floor and the cap then
 * pays continuously for reclamation it never needs, at 91 ns per publish
 * against 50 for the same workload with no sweeping at all.
 */
const EGRESS_SWEEP_STEPS = 32;

/**
 * How far below the bound reclamation starts working, as a fraction of the
 * bound: one sixteenth, the ratio the shipped 256-of-4096 slack was measured
 * at, preserved across every configured `maxKeys` so a resized ledger keeps
 * the measured shape rather than a fixed offset that would be generous on a
 * small bound and a rounding error on a large one. The floor on `maxKeys`
 * keeps the derived slack at 64 or more.
 *
 * Why a slack at all: a sweep looks at consecutive entries, so it can land
 * inside a run of windows that are all still counting and come back with
 * nothing even though thousands of lapsed ones sit elsewhere - keys created
 * together sit together, and they go busy and idle together. Starting only at
 * the bound would mean every one of those answers arrives with no room left,
 * and a ceiling would go on the strength of where a cursor happened to stop.
 *
 * The slack turns that into a delay instead: the map takes one more key, the
 * cursor moves on, and the next inserts sweep from further along, so the lapsed
 * windows are mostly gone before anything is full.
 *
 * How much reclamation happens BEFORE the ledger is full is what this decides,
 * and that is why it is sized well above one sweep: the whole mechanism is that
 * the cursor has already walked the lapsed windows out by the time a key
 * arrives at the bound, because at the bound the only remaining move is to take
 * somebody's ceiling. Reclamation is deliberately amortised across these
 * inserts rather than concentrated into one long walk at the bound - that
 * alternative was built, measured at +213% per publish, and rejected.
 */
const EGRESS_SLACK_SHIFT = 4;


/**
 * One scope's usage ledger: the windowed counters plus the eviction that keeps
 * them bounded. A factory rather than a bare Map because the eviction cursor
 * has to survive between calls, and each scope needs its own.
 *
 * @param {{ messages: number, bytes: number, deliveries: number }} ceilings -
 *   this scope's ceilings, which are what makes a window's usage comparable
 *   between keys: the eviction ranks by how much of its allowance a key has
 *   spent, so it needs the allowance
 * @param {(costEnforcement: boolean) => void} onEvict - called once per
 *   eviction; the flag is false when an EXPIRED window was reclaimed (free) and
 *   true when a live one had to go (a ceiling stops holding for the rest of its
 *   window, which is the condition an operator needs to see)
 * @param {number} maxKeys - this ledger's key bound, already normalized to a
 *   power of two (`normalizeEgressOptions` owns that rounding)
 * @param {number} evictionSample - how many entries an eviction inspects
 * @returns {{ map: Map<string, { at: number, pu: number, m: number, b: number, d: number }>, windowFor: (key: string, nowMs: number, windowMs: number) => { at: number, pu: number, m: number, b: number, d: number } }}
 */
function createWindowLedger(ceilings, onEvict, maxKeys, evictionSample) {
	/**
	 * The size at which a new key starts paying for reclamation. Below it the
	 * map has room and an expired window is harmless - it holds one slot and
	 * answers the next read with a reset.
	 */
	const sweepFloor = maxKeys - (maxKeys >>> EGRESS_SLACK_SHIFT);
	/**
	 * How much of its allowance this window has spent, as the largest fraction
	 * across the ARMED dimensions. This, and not a publish count, is what
	 * measures the enforcement an eviction would throw away: at 1.0 the key's
	 * next publish is refused, at 0.1 it is refusing nothing, and the comparison
	 * holds whichever dimension the operator configured. Counting messages
	 * instead reads a one-recipient publish and a ten-thousand-recipient publish
	 * as equal, which under a `deliveries` or `bytes` ceiling is the whole
	 * quantity being enforced.
	 *
	 * It is a ranking input, not a predicate: the score adds the previous
	 * window's fraction, so a total of 1.0 does not by itself mean "refusing
	 * now", and a bytes ceiling admits the publish that crosses it, so a single
	 * oversized publish can leave a fraction well above 1. Both are fine for
	 * choosing between two keys and neither is read as a decision anywhere -
	 * `over()` is what decides refusals, from the counters themselves.
	 *
	 * @param {{ m: number, b: number, d: number }} w
	 * @returns {number}
	 */
	function spent(w) {
		let u = 0;
		if (ceilings.messages > 0) { const r = w.m / ceilings.messages; if (r > u) u = r; }
		if (ceilings.deliveries > 0) { const r = w.d / ceilings.deliveries; if (r > u) u = r; }
		if (ceilings.bytes > 0) { const r = w.b / ceilings.bytes; if (r > u) u = r; }
		return u;
	}

	/** @type {Map<string, { at: number, pu: number, m: number, b: number, d: number }>} */
	const map = new Map();

	/**
	 * Rotating position for the eviction sample, held ACROSS calls - the same
	 * decision the upgrade limiter's bucket eviction records, for the same two
	 * reasons.
	 *
	 * Cheapness: V8 marks a deleted Map slot with a tombstone and compacts only
	 * on rehash, so at the cap - where every insert deletes one entry and adds
	 * another - a FRESH iterator walks an ever-growing tombstone run before it
	 * reaches a live entry, turning an O(sample) look into an O(size) one that
	 * gets worse as the cap grows. Measured against head eviction off a fresh
	 * iterator, interleaved in one process with the arm order rotated per round
	 * and repeated: -58% (780 -> 318 ns per publish) where every resident window
	 * is live, which is where the tombstone re-walk dominates. The other three
	 * shapes - no eviction at all, rotation on every publish, and a new key on
	 * every publish with expired windows to reclaim - sit inside run-to-run
	 * noise at +/-2%, because there the cursor is either not on the path or
	 * finds its victim immediately.
	 *
	 * Correctness: first-insert order puts the longest-lived keys at the head,
	 * so a sample that always starts there feeds exactly the topics worth
	 * keeping - the ones a boot-time subscribe registered and that have
	 * published in every window since - to a flood of one-shot topics. Rotating
	 * means a long-lived key is in the sample about as often as any other key,
	 * instead of every single time.
	 *
	 * @type {Iterator<[string, { at: number, pu: number, m: number, b: number, d: number }]> | null}
	 */
	let evictCursor = null;

	/**
	 * The time until which the ledger is PROVEN to hold no lapsed window, from
	 * the last full pass that reclaimed nothing. This is the whole of the
	 * sweep's amortisation: inside the horizon the walk is skipped because it
	 * cannot find anything, and outside it the walk runs because it can.
	 *
	 * A pass that found every entry live proves something with an expiry date,
	 * not something permanent: an entry live when the cursor passed it at time t
	 * expires at `at + windowMs`, which may be moments later. So the pass records
	 * the smallest expiry it saw, and that instant is exactly how long its
	 * finding survives. Before it, no resident window can be lapsed - a key
	 * seated during the interval starts at `now` and expires no sooner, and a
	 * rotation only ever pushes an expiry later. After it, the finding says
	 * nothing and the ledger has to look again.
	 *
	 * An insert COUNTER was measured in this position and rejected twice over.
	 * Licensing eviction while it ran answered "nothing to reclaim" without
	 * having looked: 4351 live evictions against 32, on a population whose
	 * lapsed windows it never saw. Made honest but left in place - suppressing
	 * the walk while answering "did not look" - it starved the reclamation that
	 * a population living inside the slack depends on, and cost 4683. A count of
	 * inserts is not evidence about time, and lapsing is a fact about time.
	 */
	let sweepUntil = 0;

	/**
	 * The earliest expiry the pass now in progress has seen among the entries it
	 * left resident.
	 *
	 * A pass is one iterator's lifetime, head to `done`: a Map iterator visits
	 * every entry resident when it was created and still resident when it is
	 * reached, plus every entry appended while it runs. So reaching `done` means
	 * every surviving entry was looked at and found live, which is what makes
	 * the minimum a statement about the LEDGER. Counting steps against
	 * `map.size` instead proves nothing of the kind: the denominator moves under
	 * the count, and `evictOne` walks the same cursor.
	 *
	 * Both walkers maintain it, because both consume cursor steps and both apply
	 * the same expiry test - a position `evictOne` judged is a position the pass
	 * has covered.
	 */
	let passEarliestExpiry = Infinity;

	/** Start a pass at the head, with nothing yet seen. */
	function openPass() {
		evictCursor = map.entries();
		passEarliestExpiry = Infinity;
	}

	/**
	 * A pass reached the end of the ledger. Every entry it left resident was live
	 * when the cursor visited it, so the earliest any of them can lapse is the
	 * smallest expiry it saw - and that instant, not an insert count, is how long
	 * "there is nothing to reclaim" stays true. Windows it DID reclaim change
	 * nothing about that: they are gone, and what remains is what it looked at.
	 *
	 * A horizon already in the past is the case where a window lapsed BEHIND the
	 * cursor while the pass ran. Recording it is still right: the comparison
	 * against it then fails, so the finding buys nothing and the next insert
	 * walks - which is the whole reason this is a time and not a flag.
	 */
	function closePass() {
		evictCursor = null;
		// Infinity means the pass saw no surviving entry at all, so there is no
		// horizon to record - an empty ledger, not a proven-clean one.
		if (passEarliestExpiry === Infinity) return;
		sweepUntil = passEarliestExpiry;
	}

	/**
	 * Drop expired windows the cursor passes, a bounded number of steps per new
	 * key. This is what keeps the map's SIZE a measure of the keys live at once
	 * rather than of every key the worker has seen, and it is the difference
	 * between a cap that bites on live cardinality and one that bites much
	 * earlier.
	 *
	 * Without it nothing removed an expired window except an eviction that
	 * happened to land on one, so expired entries accumulated until the map was
	 * full of them and every new key forced `evictOne` to choose a victim from
	 * whatever eight CONSECUTIVE entries the cursor was standing on. Keys created
	 * together sit together in first-publish order and go busy together, so an
	 * all-live slice needs only a contiguous live block, not a full map: a block
	 * of 1024 live keys - a quarter of the cap - cost 128 at-ceiling topics their
	 * enforcement while 3072 expired windows sat resident and reclaimable.
	 *
	 * Draining faster than keys arrive is what makes it work: each new key pays
	 * up to EGRESS_SWEEP_STEPS steps, so while any expired window remains the map
	 * shrinks. The cursor is the same rotating one the eviction uses, so a sweep
	 * step is never a re-walk from the head.
	 *
	 * The budget stays FIXED, including on the insert that is about to cost a
	 * live key its ceiling. Lifting it to a whole pass there is the obvious
	 * trade - bounded steps against a ceiling that stops holding - and it was
	 * measured and rejected, because the bound on the steps is the ledger's own
	 * size and the insert path is per-publish. It also only looks cheap under a
	 * clock that stands still inside a window: `sweepUntil` is a MINIMUM over
	 * resident expiries, so a frozen clock puts it a whole window away and one
	 * pass covers everything, while a clock that advances per publish - which is
	 * what `monotonicNow` does - puts it `windowMs / size` away, 0.24 ms at the
	 * defaults. The horizon then expires at once and the whole pass runs again on
	 * the next insert: +213% and +152% per publish on live populations near the
	 * bound, with single-call latency reaching 87 us. Reclamation is amortised
	 * across inserts instead, which is what the cursor surviving between calls is
	 * for.
	 *
	 * @param {number} nowMs
	 * @param {number} windowMs
	 */
	function reclaimExpired(nowMs, windowMs) {
		// Still inside a previous pass's proven-clean horizon: nothing resident
		// can have lapsed yet, so a walk would cost 32 steps to find nothing.
		if (nowMs < sweepUntil) return;
		// Expired is the right horizon, even though a swept key loses the `pu`
		// it would have carried had it published again within one more window.
		// Holding those entries back instead was measured: a population where
		// most keys idle for a window at a time then fills the map with them, and
		// the eviction that follows takes windows that are still counting - 145
		// of them at 8000 keys against none when the sweep takes an expired entry
		// as soon as it is expired. A lost carry costs one key one place in an
		// eviction ranking; a full map costs a key its ceiling.
		const budget = EGRESS_SWEEP_STEPS;
		let steps = 0;
		let wrapped = 0;
		while (steps < budget && wrapped < 2) {
			if (evictCursor === null) {
				openPass();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				// The pass ended. Rebuilding rather than leaving the null for
				// `evictOne` matters: a fresh iterator starts at the head, and
				// the head is where the longest-lived keys sit.
				closePass();
				continue;
			}
			steps++;
			const [key, w] = step.value;
			if (nowMs - w.at >= windowMs) {
				map.delete(key);
			} else {
				const expiry = w.at + windowMs;
				if (expiry < passEarliestExpiry) passEarliestExpiry = expiry;
			}
		}
	}

	/**
	 * Reclaim one slot, preferring an EXPIRED window and otherwise the LEAST
	 * ACTIVE key in the sample.
	 *
	 * An expired window is free to drop - its next read would have reset it to
	 * zero anyway - so it wins outright and ends the sample.
	 *
	 * Activity is the allowance SPENT across the current window and the one
	 * before it, the same two-window span the upgrade limiter's bucket eviction
	 * scores on and for the same reason: a key whose window has just rotated has
	 * charged nothing yet, so scoring the current window alone would make every
	 * key that publishes more slowly than one window the preferred victim, and
	 * would do it right after the rotation that proves the key is still live.
	 *
	 * Spent allowance, not publish COUNT: `m` counts calls, so under a
	 * `deliveries` or `bytes` ceiling one publish to ten thousand subscribers
	 * scores exactly what a one-shot publish to one subscriber scores, and the
	 * key actually consuming the budget is no better protected than the churn.
	 * Fractions of the configured ceiling are the only quantity comparable
	 * across keys whichever dimension is armed.
	 *
	 * Window START is emphatically NOT the score. `at` moves only on rotation,
	 * so among live keys the oldest `at` belongs to whichever key rotated at the
	 * window boundary - that is, the one publishing continuously - while a key
	 * that arrived mid-window carries a younger one. Scoring by `at` therefore
	 * selects the BUSIEST key in the sample, which is precisely the runaway
	 * publisher a ceiling exists to bound.
	 *
	 * Dropping a live window restarts a key that may be sitting at its ceiling,
	 * so it under-enforces for the rest of that window rather than merely losing
	 * a log line. That is the price of a hard bound, and this is what decides
	 * who pays it.
	 *
	 * @param {number} nowMs
	 * @param {number} windowMs
	 */
	function evictOne(nowMs, windowMs) {
		/** @type {string | null} */
		let victim = null;
		let victimScore = Infinity;
		let sampled = 0;
		let wrapped = 0;
		while (sampled < evictionSample && wrapped < 2) {
			if (evictCursor === null) {
				openPass();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				closePass();
				continue;
			}
			sampled++;
			const [key, w] = step.value;
			if (nowMs - w.at >= windowMs) {
				map.delete(key);
				onEvict(false);
				return;
			}
			const expiry = w.at + windowMs;
			if (expiry < passEarliestExpiry) passEarliestExpiry = expiry;
			const score = spent(w) + w.pu;
			if (score < victimScore) { victimScore = score; victim = key; }
		}
		if (victim !== null) {
			map.delete(victim);
			onEvict(true);
		}
	}

	return {
		map,

		/**
		 * Lazily-rotated usage window for one scope key. `at` is the window's
		 * start; a read past `at + windowMs` resets the counters in place, so
		 * the steady state allocates nothing per publish and the key does not
		 * move - re-seating it to keep the map ordered by window start was
		 * measured at +77% on this ledger's own work (31.6 -> 56.0 ns per
		 * publish) for a workload whose topics each publish slower than one
		 * window, because every rotation then pays a Map delete plus a Map
		 * insert. The eviction sample buys the same information for nothing on
		 * the publish path.
		 *
		 * @param {string} key
		 * @param {number} nowMs
		 * @param {number} windowMs
		 */
		windowFor(key, nowMs, windowMs) {
			let w = map.get(key);
			if (w === undefined) {
				if (map.size >= sweepFloor) {
					// Reclaim first: a window that has already lapsed is free to
					// drop, so the room it frees costs nobody their ceiling.
					reclaimExpired(nowMs, windowMs);
					// And evict ONLY when the ledger is full and reclamation could
					// not free a slot. Being full is the whole of the grounds: a
					// sweep that concludes the ledger is all live has established
					// where the memory went, not that a key must lose its ceiling,
					// and there may be room left. Letting that conclusion decide it
					// instead evicted on 85% of the inserts that reach this branch.
					if (map.size >= maxKeys) evictOne(nowMs, windowMs);
				}
				w = { at: nowMs, pu: 0, m: 0, b: 0, d: 0 };
				map.set(key, w);
				return w;
			}
			if (nowMs - w.at >= windowMs) {
				// `pu` carries the window just closed, so eviction can tell a key
				// that has gone quiet from one that has merely rotated. A gap of
				// more than one window means the previous window is not adjacent
				// and what it spent is not evidence of current activity.
				w.pu = nowMs - w.at < windowMs * 2 ? spent(w) : 0;
				w.at = nowMs;
				w.m = 0;
				w.b = 0;
				w.d = 0;
			}
			return w;
		}
	};
}

/**
 * Normalize a raw `egress` option section into the frozen config the account
 * runs on. Assumes the shared guard (`assertEgressSection`) already refused
 * misshaped values on every intake surface; anything unusable that still
 * arrives here reads as disabled rather than inverted.
 *
 * @param {any} input - the raw `websocket.egress` section (or undefined)
 * @returns {{ windowMs: number, maxKeys: number, evictionSample: number, topic: { messages: number, bytes: number, deliveries: number }, tenant: { messages: number, bytes: number, deliveries: number }, topicEnabled: boolean, tenantEnabled: boolean }}
 */
export function normalizeEgressOptions(input) {
	const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
	const windowMs = src && typeof src.windowMs === 'number' && Number.isFinite(src.windowMs) && src.windowMs >= 100
		? src.windowMs
		: EGRESS_DEFAULT_WINDOW_MS;
	// The EFFECTIVE bound, after the power-of-two rounding the module's memory
	// law requires: the V8 backing table is the power-of-two size either way,
	// so rounding UP holds no fewer keys - strictly more whenever it moves the
	// value - in the memory the requested value would have taken. A
	// bit-doubling loop rather than Math.log2, because the rounding must be
	// exact at every bound the guard admits.
	let maxKeys = EGRESS_DEFAULT_MAX_KEYS;
	if (src && Number.isSafeInteger(src.maxKeys) &&
		src.maxKeys >= EGRESS_MAX_KEYS_FLOOR && src.maxKeys <= EGRESS_MAX_KEYS_CEILING) {
		maxKeys = EGRESS_MAX_KEYS_FLOOR;
		while (maxKeys < src.maxKeys) maxKeys *= 2;
	}
	const evictionSample = src && Number.isSafeInteger(src.evictionSample) && src.evictionSample >= 1
		? src.evictionSample
		: EGRESS_DEFAULT_EVICT_SAMPLE;
	const scope = (section) => {
		const s = section && typeof section === 'object' && !Array.isArray(section) ? section : null;
		const ceiling = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
		return Object.freeze({
			messages: ceiling(s ? s.messages : 0),
			bytes: ceiling(s ? s.bytes : 0),
			deliveries: ceiling(s ? s.deliveries : 0)
		});
	};
	const topic = scope(src ? src.topic : null);
	const tenant = scope(src ? src.tenant : null);
	return Object.freeze({
		windowMs,
		maxKeys,
		evictionSample,
		topic,
		tenant,
		topicEnabled: topic.messages > 0 || topic.bytes > 0 || topic.deliveries > 0,
		tenantEnabled: tenant.messages > 0 || tenant.bytes > 0 || tenant.deliveries > 0,
		// Only a BYTES ceiling decides on an encoded length, so only a bytes
		// ceiling is worth walking the envelope for: a messages-only or
		// deliveries-only budget would otherwise pay an O(envelope) measure
		// per publish for a number nothing reads.
		bytesEnabled: topic.bytes > 0 || tenant.bytes > 0
	});
}

/**
 * The number of bytes a `0x03` binary frame puts on the wire for one
 * recipient: tag + schemaVersion + a one-byte topic-id varint + the seq
 * varint + the codec payload. Topic ids above 127 widen their varint by a
 * byte per frame that this charge does not see - a documented approximation,
 * bounded to single bytes, taken so the charge never needs the per-connection
 * id resolution the walk performs.
 *
 * @param {number} payloadLength
 * @param {number} seq - the on-wire seq (0 when unstamped)
 * @returns {number}
 */
export function binaryFrameChargeBytes(payloadLength, seq) {
	let seqLen = 1;
	let v = seq;
	while (v > 0x7f) {
		v = Math.floor(v / 128);
		seqLen++;
	}
	return 3 + seqLen + payloadLength;
}

/**
 * The wire bytes one JSON envelope puts on the wire for `recipients`
 * recipients.
 *
 * `exact` decides the unit, and it is a cost decision, not a taste one:
 * `Buffer.byteLength` walks the string, so it is O(envelope) on the hottest
 * primitive in the adapter - measured at 29 ns for a 70-character envelope and
 * 517 ns for a 2 KB one, per publish. A configured BYTES ceiling makes that
 * walk load-bearing (a budget decision must not under-count a multi-byte
 * payload), so an operator who arms one opts into it. A messages-only or
 * deliveries-only budget decides nothing on the value, and neither does a
 * zero-config server, so in both cases the window counters take the UTF-16
 * length instead - the unit `topicPublishStats` has always used, identical for
 * the ASCII envelopes the adapter builds around an ASCII payload, and free.
 *
 * The length is read only when someone will actually receive the frame. A
 * publish to a topic no connection holds is the ordinary shape on a server
 * that publishes ahead of its subscribers (and the shape a walk lane takes
 * after excluding its only recipient), and it charges zero bytes by
 * definition - so the walk that would price it is skipped rather than paid and
 * multiplied by zero.
 *
 * @param {string} envelope
 * @param {number} recipients
 * @param {boolean} [exact] - true once a BYTES ceiling is armed
 * @returns {number}
 */
export function envelopeWireBytes(envelope, recipients, exact) {
	if (recipients <= 0) return 0;
	return (exact ? Buffer.byteLength(envelope) : envelope.length) * recipients;
}

/**
 * Whether an excluded socket actually holds the topic, i.e. whether the
 * exclusion reduces the recipient count by one. A socket that never
 * subscribed (or whose native handle already closed) was never a recipient,
 * so excluding it must not discount the charge.
 *
 * @param {{ getUserData(): any } | null | undefined} ws
 * @param {string} topic
 * @returns {boolean}
 */
export function excludedRecipient(ws, topic) {
	if (ws === null || ws === undefined) return false;
	try {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		return subs instanceof Set && subs.has(topic);
	} catch {
		return false;
	}
}

/**
 * Build one egress account: the windowed usage ledger plus its ceilings and
 * tenant resolution. Pure with respect to process state: the clock and every
 * refusal side effect are injected, so a unit test can drive windows with its
 * own clock and every surface reports refusals in its own vocabulary.
 *
 * @param {{
 *   options: ReturnType<typeof normalizeEgressOptions>,
 *   tenantOf?: ((topic: string) => string | null | undefined) | null,
 *   clock?: () => number,
 *   onRefused?: (scope: 'topic' | 'tenant', topic: string | null, dimension: 'messages' | 'bytes' | 'deliveries', limit: number) => void,
 *   onResolverInvalid?: (raw: unknown) => void,
 *   onEvicted?: (scope: 'topic' | 'tenant') => void,
 *   memoize?: boolean
 * }} io
 */
export function createEgressAccount(io) {
	const config = io.options;
	const clock = io.clock || monotonicNow;
	const tenantOf = typeof io.tenantOf === 'function' ? io.tenantOf : null;
	const onRefused = io.onRefused || null;
	const onResolverInvalid = io.onResolverInvalid || null;
	const enabled = config.topicEnabled || config.tenantEnabled;
	// Only an eviction that dropped a LIVE window is reported: reclaiming an
	// expired one costs nothing an operator could act on.
	const onEvicted = io.onEvicted || null;
	const topicWindows = createWindowLedger(config.topic, (cost) => {
		if (cost && onEvicted !== null) {
			try { onEvicted('topic'); } catch { /* reporting never breaks a publish */ }
		}
	}, config.maxKeys, config.evictionSample);
	const tenantWindows = createWindowLedger(config.tenant, (cost) => {
		if (cost && onEvicted !== null) {
			try { onEvicted('tenant'); } catch { /* reporting never breaks a publish */ }
		}
	}, config.maxKeys, config.evictionSample);
	// Topic-to-tenant memo. The resolver is documented pure over the topic
	// string, so its answers are cacheable; wholesale clear at the cap keeps
	// it bounded without an eviction policy a pure function cannot need.
	const memoize = io.memoize !== false;
	/** @type {Map<string, string | null> | null} */
	const memo = memoize && tenantOf !== null ? new Map() : null;
	// The resolver-invalid diagnostic fires once per account: the condition is
	// a coding defect that repeats on every publish, and refusing to attribute
	// is already the fail-closed behavior - one line names it, the counterless
	// repetition would only bury it.
	let resolverReported = false;

	const over = (usage, ceilings, messages, deliveries) => {
		if (ceilings.messages > 0 && usage.m + messages > ceilings.messages) return 'messages';
		if (ceilings.deliveries > 0 && usage.d + deliveries > ceilings.deliveries) return 'deliveries';
		if (ceilings.bytes > 0 && usage.b >= ceilings.bytes) return 'bytes';
		return null;
	};

	return {
		enabled,
		tenantEnabled: config.tenantEnabled,
		/** True only while a BYTES ceiling needs an encoded length. */
		bytesEnabled: config.bytesEnabled,
		config,

		/**
		 * Resolve the tenant a topic's egress is charged to, through the
		 * handler module's `egressTenantOf` export. Null for an unattributed
		 * topic. An invalid result (wrong type, or an id outside the shared
		 * attribution rule) refuses to attribute: the charge lands
		 * unattributed - never on a mangled key - and the defect is reported
		 * once.
		 *
		 * @param {string} topic
		 * @returns {string | null}
		 */
		resolveTenant(topic) {
			if (tenantOf === null) return null;
			if (memo !== null) {
				const hit = memo.get(topic);
				if (hit !== undefined) return hit;
			}
			let raw;
			let threw = false;
			try {
				raw = tenantOf(topic);
			} catch {
				threw = true;
			}
			let id = null;
			if (!threw && raw !== null && raw !== undefined) {
				if (typeof raw === 'string' && isValidAttributionId(raw)) {
					id = raw;
				} else if (!resolverReported) {
					resolverReported = true;
					try { onResolverInvalid?.(raw); } catch { /* diagnostics never break a publish */ }
				}
			}
			if (threw && !resolverReported) {
				resolverReported = true;
				try { onResolverInvalid?.(undefined); } catch { /* diagnostics never break a publish */ }
			}
			if (memo !== null) {
				if (memo.size >= config.maxKeys) memo.clear();
				memo.set(topic, id);
			}
			return id;
		},

		/**
		 * The pre-hoc decision for one logical publish (or one whole batch).
		 * True admits; false means the caller must deliver nothing and return
		 * its refusal shape. Reads usage only - the charge is a separate step
		 * so a refusal leaves every window untouched.
		 *
		 * @param {string | null} topic - null for a topic-less fan-out
		 * @param {string | null} tenantId
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admit(topic, tenantId, messages, deliveries) {
			if (!enabled) return true;
			return this.admitTopic(topic, messages, deliveries) &&
				this.admitTenant(tenantId, topic, messages, deliveries);
		},

		/**
		 * The topic half of the decision, on its own. A batch spanning several
		 * topics admits each topic's own share here and pools the tenant share
		 * separately, because one tenant's ceiling covers all of its topics at
		 * once: asking per topic against an unmoved window would let a batch of
		 * N topics pass N times against the same allowance.
		 *
		 * @param {string | null} topic
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admitTopic(topic, messages, deliveries) {
			if (!enabled || !config.topicEnabled || topic === null) return true;
			const w = topicWindows.windowFor(topic, clock(), config.windowMs);
			const dim = over(w, config.topic, messages, deliveries);
			if (dim === null) return true;
			try { onRefused?.('topic', topic, dim, config.topic[dim]); } catch { /* reporting never breaks a refusal */ }
			return false;
		},

		/**
		 * The tenant half of the decision. `topic` names a topic for the
		 * refusal report only - the ceiling is the tenant's, whatever mix of
		 * topics the publish spans.
		 *
		 * @param {string | null} tenantId
		 * @param {string | null} topic
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admitTenant(tenantId, topic, messages, deliveries) {
			if (!enabled || !config.tenantEnabled || tenantId === null || tenantId === undefined) return true;
			const w = tenantWindows.windowFor(tenantId, clock(), config.windowMs);
			const dim = over(w, config.tenant, messages, deliveries);
			if (dim === null) return true;
			try { onRefused?.('tenant', topic, dim, config.tenant[dim]); } catch { /* reporting never breaks a refusal */ }
			return false;
		},

		/**
		 * Add one admitted logical publish's weight to the windows.
		 *
		 * @param {string | null} topic
		 * @param {string | null} tenantId
		 * @param {number} messages
		 * @param {number} deliveries
		 * @param {number} bytes - total wire bytes (per-recipient size summed)
		 */
		charge(topic, tenantId, messages, deliveries, bytes) {
			if (!enabled) return;
			const at = clock();
			if (config.topicEnabled && topic !== null) {
				const w = topicWindows.windowFor(topic, at, config.windowMs);
				w.m += messages;
				w.d += deliveries;
				w.b += bytes;
			}
			if (config.tenantEnabled && tenantId !== null && tenantId !== undefined) {
				const w = tenantWindows.windowFor(tenantId, at, config.windowMs);
				w.m += messages;
				w.d += deliveries;
				w.b += bytes;
			}
		}
	};
}
