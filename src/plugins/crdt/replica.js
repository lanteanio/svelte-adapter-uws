/**
 * Server-side CRDT document authority: the per-topic replica set behind
 * `live.doc` / `live.map` / `live.array`.
 *
 * One authority instance manages every active document topic for one
 * declaration: a per-topic Yjs replica (the authoritative copy new joiners
 * sync against), reference-counted lifecycle, the durable persistence
 * schedule, and the access-record normalization for the `{read, write,
 * comment}` guard. The wire stays the shipped CRDT codec's concern; this
 * module never frames bytes, it produces and consumes them:
 *
 *   - `acquire(topic)` loads the durable state once per cold topic (concurrent
 *     joiners coalesce on one in-flight load - the hydrate-stampede gate) and
 *     counts a reference.
 *   - `applyUpdate(topic, bytes)` merges an inbound update into the replica
 *     and returns the normalized bytes for the caller to fan out verbatim.
 *   - `diff(topic, stateVector)` answers a joiner's sync with exactly the
 *     structs it lacks; `stateVector(topic)` is the server's own summary so
 *     the client can upload what the SERVER lacks - the two-way exchange that
 *     makes reconnect and offline recovery one idempotent round trip.
 *   - `release(topic)` drops a reference; the last release runs the final
 *     store (edit-then-disconnect is never lost) and unloads the replica.
 *
 * Persistence is scheduled, never inline on the message path: a trailing
 * debounce (`debounceWait`) with a sustained-edit force (`debounceMaxWait`),
 * an update-count compaction trigger (`snapshotEvery`), and the on-empty
 * final store (`persistOnEmpty`). The durable artifact is always the full
 * document state in one blob (`encodeStateAsUpdate`), captured synchronously
 * at schedule time so a consistent point is stored; the host app owns the
 * I/O through the `persist.load` / `persist.store` hooks and this module owns
 * only the schedule. A flapping client cannot multiply `store` calls: the
 * debounce coalesces and the final store runs once per empty transition.
 *
 * The scheduled path is best-effort by design (a failed store retries, an
 * operator watches `onError`), but an EXPLICIT flush - `persistNow()`, the
 * shutdown path - is not: it is bounded by a deadline so a host store that
 * never settles cannot wedge the exit, and it resolves to the per-topic
 * outcome (durable / declined / failed / timed out / still dirty) so a caller
 * can never mistake "every store rejected" for "everything is durable". The
 * host's own I/O is bounded with it: each `load` / `store` call receives an
 * `AbortSignal` that fires when the flush deadline expires or the authority
 * is torn down. Giving up on a write is never the same as it succeeding: an
 * abandoned store's answer is discarded whatever it turns out to be - the
 * alternative, trusting whatever a cancelled write reports, is how a flush
 * would report bytes durable that were never written. When it was a flush
 * deadline that gave up, the captured state also goes back to dirty and the
 * retry schedule takes it; a teardown (`drop`, `destroy`) has no record left
 * to reschedule and is not a persistence fault either.
 *
 * The document bytes are opaque to the wire codec but NOT to this module:
 * this is the one place the CRDT library lives server-side. Yjs types never
 * leak through the public surface.
 *
 * @module svelte-adapter-uws/plugins/crdt/replica
 */

import * as Y from 'yjs';
import { now, monotonicNow, randomU32, setTimer, clearTimer } from '../../runtime/runtime.js';

/**
 * Transaction origin tag for updates applied from the wire, so a hook on the
 * document's own `update` event (none in this module, but a power user can
 * reach the doc in a test) can tell a remote merge from a local mutation.
 * A module-private object reference cannot collide with any app origin.
 */
const REMOTE_ORIGIN = Object.freeze({ crdt: 'remote' });

/**
 * Normalize opaque CRDT bytes: accept a Uint8Array (native) or the JSON
 * `number[]` form, reject anything else. Mirrors the codec's tolerance so the
 * authority and the wire never disagree on what counts as bytes.
 * @param {any} bytes
 * @returns {Uint8Array | null}
 */
function toBytes(bytes) {
	if (bytes instanceof Uint8Array) return bytes;
	if (!Array.isArray(bytes)) return null;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return null;
		out[i] = b;
	}
	return out;
}

/**
 * Normalize a guard's return value into the `{read, write, comment}` access
 * record.
 *
 * - A non-object return is read as a boolean gate and widened to all three
 *   rights (`guard: () => user != null` never learns the record shape).
 * - An object return is read as a partial record; a missing right is `false`,
 *   so the safe choice is the default when a field is omitted (`{read: true}`
 *   means read-only).
 *
 * The `comment` right is carried, cached, and surfaced in full, but no
 * comment producer exists in 0.6: comment-tagged updates are not a separate
 * accepted class yet, because the server cannot structurally verify that a
 * client-tagged update touches only comment marks until the rich-text marks
 * layer lands. Guards written against the record today keep working
 * unchanged when that layer activates the right.
 *
 * @param {any} value - whatever the guard returned
 * @returns {{ read: boolean, write: boolean, comment: boolean }}
 */
export function normalizeCrdtAccess(value) {
	if (value !== null && typeof value === 'object') {
		return { read: !!value.read, write: !!value.write, comment: !!value.comment };
	}
	const b = !!value;
	return { read: b, write: b, comment: b };
}

/**
 * Validate one numeric knob: undefined adopts the default, anything else must
 * be a finite number >= min.
 * @param {any} v @param {string} label @param {number} min
 * @returns {number | undefined}
 */
function checkKnob(v, label, min) {
	if (v === undefined) return undefined;
	if (!(typeof v === 'number' && Number.isFinite(v) && v >= min)) {
		throw new Error('crdt: ' + label + ' must be a number >= ' + min);
	}
	return v;
}

/**
 * Validate a flush budget: milliseconds as a finite number >= 0, or `Infinity`
 * to wait indefinitely (the explicit opt-out of the deadline).
 * @param {any} v @param {string} label
 * @returns {number | undefined}
 */
function checkTimeout(v, label) {
	if (v === undefined) return undefined;
	if (v === Infinity) return Infinity;
	if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
		throw new Error('crdt: ' + label + ' must be a number >= 0 or Infinity');
	}
	return v;
}

/**
 * Read the outcome of a settled store chain. A chain that ran no store of its
 * own (the initial resolved promise, or a flush that found nothing to write)
 * resolves undefined, which means there is nothing unwritten.
 * @param {any} value
 * @returns {'durable' | 'declined' | 'failed'}
 */
function asOutcome(value) {
	return value === 'declined' || value === 'failed' ? value : 'durable';
}

/**
 * Whether a value is a plain options bag. An array is NOT one, and neither is
 * any other class instance: `persistNow(['a', 'b'])` is a caller passing topics
 * where one topic string belongs (an easy mistake to make when the RESULT is
 * topic arrays), and it has to throw rather than be read as an every-topic
 * flush that silently writes more than the caller asked for.
 * @param {any} v
 * @returns {boolean}
 */
function isOptionsBag(v) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * Create the document authority for one CRDT declaration.
 *
 * @param {{
 *   persist?: {
 *     load?: (topic: string, info: { signal: AbortSignal }) => Promise<Uint8Array | number[] | null | undefined> | Uint8Array | number[] | null | undefined,
 *     store?: (topic: string, bytes: Uint8Array, info: { signal: AbortSignal, deadline: number | null, attempt: number }) => Promise<void | boolean> | void | boolean
 *   },
 *   debounceWait?: number,
 *   debounceMaxWait?: number,
 *   snapshotEvery?: number,
 *   flushTimeout?: number,
 *   persistOnEmpty?: boolean,
 *   gc?: boolean,
 *   onError?: (err: unknown, info: { topic: string, op: 'load' | 'store' }) => void
 * }} [options]
 */
export function createCrdtAuthority(options = {}) {
	if (options === null || typeof options !== 'object') {
		throw new Error('crdt: options must be an object');
	}
	const persist = options.persist;
	if (persist !== undefined && (persist === null || typeof persist !== 'object')) {
		throw new Error('crdt: persist must be an object with load/store hooks');
	}
	if (persist && persist.load !== undefined && typeof persist.load !== 'function') {
		throw new Error('crdt: persist.load must be a function');
	}
	if (persist && persist.store !== undefined && typeof persist.store !== 'function') {
		throw new Error('crdt: persist.store must be a function');
	}
	if (options.onError !== undefined && typeof options.onError !== 'function') {
		throw new Error('crdt: onError must be a function');
	}
	const debounceWait = checkKnob(options.debounceWait, 'debounceWait', 0) ?? 2000;
	const debounceMaxWait = checkKnob(options.debounceMaxWait, 'debounceMaxWait', 0) ?? 10000;
	const snapshotEvery = checkKnob(options.snapshotEvery, 'snapshotEvery', 1) ?? 200;
	// The default budget for an explicit flush. Well inside a typical process
	// shutdown grace period, so a wedged store surfaces as a reported timeout
	// instead of an orchestrator kill with no diagnosis.
	const flushTimeout = checkTimeout(options.flushTimeout, 'flushTimeout') ?? 10000;
	const persistOnEmpty = options.persistOnEmpty !== false;
	const gc = options.gc !== false;
	const onError = options.onError;
	const hasStore = !!(persist && typeof persist.store === 'function');

	/**
	 * One in-flight host call. `waiters` holds the explicit flushes currently
	 * awaiting it, each carrying its own deadline, so a flush that runs out of
	 * budget cancels only calls that nobody else is still waiting on - a short
	 * flush must not pull the write out from under a longer-budget one - and the
	 * deadline the host is handed is the whole room's rather than one caller's.
	 * `abandoned` marks a call whose answer is no longer trusted - its signal was
	 * fired and its captured state was put back on the retry schedule, so a late
	 * resolution proves nothing.
	 * @typedef {{ deadline: number | null }} FlushToken
	 * @typedef {{
	 *   kind: 'load' | 'store',
	 *   attempt: number,
	 *   aborter: AbortController,
	 *   waiters: Set<FlushToken>,
	 *   abandoned: boolean,
	 *   silent: boolean,
	 *   release: (() => void) | null
	 * }} CallHandle
	 */
	/**
	 * @typedef {{
	 *   doc: import('yjs').Doc,
	 *   refs: number,
	 *   loading: Promise<void> | null,
	 *   loaded: boolean,
	 *   dirty: boolean,
	 *   updatesSinceStore: number,
	 *   debounceTimer: any,
	 *   maxWaitStart: number | null,
	 *   storing: Promise<any>,
	 *   newest: CallHandle | null,
	 *   storeAttempt: number,
	 *   inflight: Set<CallHandle>,
	 *   unloading: boolean
	 * }} TopicRecord
	 */
	/** @type {Map<string, TopicRecord>} */
	const topics = new Map();
	let destroyed = false;

	/** Report a persist I/O failure to the host without throwing into the schedule. */
	function reportError(err, topic, op) {
		if (onError) {
			try { onError(err, { topic, op }); } catch { /* the host's handler must not break the schedule */ }
		}
	}

	function clearSchedule(rec) {
		if (rec.debounceTimer !== null) {
			clearTimer(rec.debounceTimer);
			rec.debounceTimer = null;
		}
		rec.maxWaitStart = null;
	}

	/**
	 * Arm the recovery timer for a record holding unstored bytes: retry at the
	 * max-wait cadence, floored so a zero max-wait configuration cannot spin a
	 * hot retry loop against a down backend.
	 * @param {string} topic @param {TopicRecord} rec
	 */
	function armRetry(topic, rec) {
		if (rec.debounceTimer !== null) return;
		rec.debounceTimer = setTimer(() => {
			rec.debounceTimer = null;
			if (destroyed || topics.get(topic) !== rec || !rec.dirty) return;
			storeNow(topic, rec);
		}, Math.max(1000, debounceMaxWait));
	}

	/**
	 * Stop waiting on one in-flight host call and cancel it.
	 *
	 * Abandoning a store is not the same as it failing: the authority no longer
	 * knows whether those bytes landed, so it must assume they did not. The
	 * captured state therefore goes back to dirty and back on the retry
	 * schedule, and the call's own late answer is ignored - a host that honours
	 * the signal by abandoning the write and RESOLVING must never be read as
	 * "durable". The store chain is released at the same time: the next store
	 * for a topic waits behind the previous one, so a host promise that never
	 * settles would otherwise wedge that topic's persistence for good.
	 *
	 * `silent` marks an intentional teardown (the topic was erased, the
	 * authority destroyed). There is no record left to keep dirty and the
	 * cancellation is not a persistence fault, so it neither reschedules nor
	 * reports through `onError`.
	 * @param {string} topic @param {TopicRecord} rec @param {CallHandle} handle
	 * @param {Error} reason @param {boolean} silent
	 */
	function abandon(topic, rec, handle, reason, silent) {
		if (handle.abandoned) return;
		handle.abandoned = true;
		handle.silent = silent;
		rec.inflight.delete(handle);
		try { handle.aborter.abort(reason); } catch { /* an already-settled controller must not break teardown */ }
		if (handle.release) handle.release();
		if (handle.kind !== 'store' || silent) return;
		if (destroyed || topics.get(topic) !== rec) return;
		// A write that did not confirm counts as an attempt of this unstored
		// state, so a host reading `attempt` backs off against a wedged backend
		// exactly as it does against a rejecting one.
		rec.storeAttempt = handle.attempt;
		rec.dirty = true;
		armRetry(topic, rec);
	}

	/**
	 * Cancel every host call still in flight for one record because the record
	 * itself is going away: the topic was erased, or the authority was torn
	 * down. A host that ignores the signal simply runs to completion - nothing
	 * is left to strand.
	 * @param {string} topic @param {TopicRecord} rec @param {Error} reason
	 */
	function abortInFlight(topic, rec, reason) {
		if (rec.inflight.size === 0) return;
		for (const handle of [...rec.inflight]) abandon(topic, rec, handle, reason, true);
	}

	/**
	 * The moment the LAST flush still waiting on one call stops waiting: the
	 * latest of its waiters' deadlines, and null when nothing bounds it (no
	 * waiter at all - a store the background schedule owns - or a waiter that
	 * opted out with an `Infinity` budget). Handing the host the latest rather
	 * than the arming flush's own is what keeps a short flush from shortening
	 * the write a longer one is waiting on: the signal already outlives the
	 * short flush, and a host that sizes its I/O by the deadline has to reach
	 * the same conclusion or the short budget decides for everybody anyway.
	 * @param {CallHandle} handle
	 * @returns {number | null}
	 */
	function waiterDeadline(handle) {
		let latest = null;
		for (const flush of handle.waiters) {
			if (flush.deadline === null) return null;
			if (latest === null || flush.deadline > latest) latest = flush.deadline;
		}
		return latest;
	}

	/**
	 * Capture the full state NOW (a consistent point) and chain the host's
	 * `store` behind any in-flight store, so writes for one topic never race
	 * each other or arrive out of order - with the one documented exception
	 * that {@link abandon} releases the chain, so a host that ignores the abort
	 * signal can see the rescheduled write overlap the one the flush gave up
	 * on. Success completes a deferred on-empty unload; anything short of
	 * success - a failure, a decline, or a write a flush deadline abandoned -
	 * marks the record dirty again and retries at the `debounceMaxWait` cadence
	 * (with a genuine failure surfaced through `onError` each attempt), so an
	 * edit-then-silence is never stranded in memory and a dirty replica is
	 * never unloaded.
	 * The returned promise never rejects: it resolves to this attempt's outcome
	 * so an explicit flush can report what actually happened to the bytes.
	 * @param {string} topic @param {TopicRecord} rec
	 * @param {FlushToken | null} [flush] - the explicit flush that armed this
	 *   store, registered as a waiter so its deadline only cancels writes no
	 *   other flush still needs and so its budget joins the deadline the host
	 *   is handed; null for a store the background schedule owns.
	 * @returns {Promise<'durable' | 'declined' | 'failed'>}
	 */
	function storeNow(topic, rec, flush = null) {
		clearSchedule(rec);
		rec.dirty = false;
		rec.updatesSinceStore = 0;
		if (!persist || typeof persist.store !== 'function') return rec.storing.then(asOutcome, () => 'failed');
		const blob = Y.encodeStateAsUpdate(rec.doc);
		// 1 for the first write of the current unstored state. The count only
		// grows where the documented meaning says it does - a write of that
		// same state that did not confirm, whether it failed, was declined, or
		// was abandoned by a flush deadline - so a host that backs off or
		// escalates on it is reading retries, not throughput: sustained editing
		// against a healthy backend reports 1 every time.
		const attempt = rec.storeAttempt + 1;
		/** @type {CallHandle} */
		const handle = {
			kind: 'store',
			attempt,
			aborter: new AbortController(),
			waiters: new Set(),
			abandoned: false,
			silent: false,
			release: null
		};
		if (flush !== null) handle.waiters.add(flush);
		rec.inflight.add(handle);
		const settled = rec.storing
			// A store waits behind the previous one, so it can be abandoned
			// before it is ever issued: handing the host a signal that already
			// fired would be a write nobody wants. The deadline is read HERE,
			// not at capture time, so a longer-budget flush that joined while
			// this write was queued is already part of it.
			.then(() => (handle.abandoned ? undefined : persist.store(topic, blob, { signal: handle.aborter.signal, deadline: waiterDeadline(handle), attempt })))
			.then((result) => {
				rec.inflight.delete(handle);
				// An abandoned attempt is not evidence. The flush that owned it
				// stopped waiting and fired its signal, so a host answering
				// late - including one that honours the abort by dropping the
				// write and resolving - must not clear the retry count, finish
				// an unload, or be reported as durable.
				if (handle.abandoned) return 'failed';
				// The outcome describes the host's answer, so it is read before
				// any lifecycle guard can return early: a caller awaiting this
				// attempt must learn a decline even when the replica went away
				// underneath it.
				const outcome = result === false ? 'declined' : 'durable';
				if (destroyed || topics.get(topic) !== rec) return outcome;
				// Only the NEWEST store in the chain owns the lifecycle: an
				// older store settling while a newer captured state is still
				// in flight behind it must neither unload the replica nor
				// decide the empty transition - the newest store's own
				// settlement does.
				if (rec.newest !== handle) return outcome;
				if (outcome === 'declined') {
					// The host declined to write this captured state (e.g. a
					// cluster instance that does not currently hold the
					// per-topic persist lease). The bytes are NOT durable here,
					// so keep the record dirty and re-probe at the max-wait
					// cadence until a write succeeds - tightening a stale
					// snapshot to debounceMaxWait rather than next-edit. The
					// data is not lost: it lives in this replica and (in a
					// cluster) was relayed to the lease holder, which persists
					// it. On the unload path we still let the replica go - the
					// holder owns the durable write - so a decline never pins a
					// replica in memory.
					rec.storeAttempt = attempt;
					rec.dirty = true;
					if (rec.unloading && rec.refs === 0) unload(topic, rec);
					else armRetry(topic, rec);
					return outcome;
				}
				rec.storeAttempt = 0;
				if (rec.unloading && rec.refs === 0) {
					// Edits that landed while the store was in flight re-store
					// before the deferred unload completes; a clean store
					// finishes the empty transition.
					if (rec.dirty) storeNow(topic, rec);
					else unload(topic, rec);
				}
				return outcome;
			})
			.catch((err) => {
				rec.inflight.delete(handle);
				// A write cancelled on purpose (the topic was erased, the
				// authority destroyed) rejects with this module's own abort
				// reason coming back. That is an intentional stop, not a
				// persistence fault, so it must not reach an operator's error
				// handler and page them on every clean shutdown. The load path
				// guards the same way. A deadline-aborted write is NOT silent:
				// there the host really did run out of budget.
				if (!handle.silent && !destroyed) reportError(err, topic, 'store');
				if (handle.abandoned) return 'failed';
				if (destroyed || topics.get(topic) !== rec) return 'failed';
				// A newer chained store carries a superset of this blob (the
				// full state captured later), so its settlement owns the
				// dirty/retry decision; this older failure is already
				// superseded.
				if (rec.newest !== handle) return 'failed';
				rec.storeAttempt = attempt;
				rec.dirty = true;
				armRetry(topic, rec);
				return 'failed';
			});
		// What the NEXT store for this topic waits behind. It completes when
		// this attempt settles OR when this attempt is abandoned, so a host
		// promise that never settles cannot wedge the topic's persistence for
		// good: the recovery store issued after a flush deadline has to be able
		// to run.
		const chain = new Promise((resolve) => {
			handle.release = () => resolve('failed');
			settled.then(resolve, () => resolve('failed'));
		});
		rec.newest = handle;
		rec.storing = chain;
		return chain;
	}

	/**
	 * Trailing debounce with a sustained-edit force: persist `debounceWait`
	 * after the last edit, but never let a continuously-edited document go
	 * longer than `debounceMaxWait` without a checkpoint.
	 * @param {string} topic @param {TopicRecord} rec
	 */
	function scheduleStore(topic, rec) {
		if (!persist || typeof persist.store !== 'function') return;
		const mono = monotonicNow();
		if (rec.maxWaitStart === null) rec.maxWaitStart = mono;
		if (rec.debounceTimer !== null) clearTimer(rec.debounceTimer);
		const untilMax = rec.maxWaitStart + debounceMaxWait - mono;
		const wait = Math.max(0, Math.min(debounceWait, untilMax));
		rec.debounceTimer = setTimer(() => {
			rec.debounceTimer = null;
			if (destroyed || topics.get(topic) !== rec || !rec.dirty) return;
			storeNow(topic, rec);
		}, wait);
	}

	/** Destroy a record's doc and forget the topic. */
	function unload(topic, rec) {
		clearSchedule(rec);
		// Nothing is normally in flight here (a clean unload follows a settled
		// store), but an erasure can land on top of live I/O: whatever it was
		// reading or writing is about to be irrelevant, so cancel it.
		abortInFlight(topic, rec, new Error('crdt: topic unloaded'));
		if (topics.get(topic) === rec) topics.delete(topic);
		try { rec.doc.destroy(); } catch { /* a destroyed doc must not break unload */ }
	}

	/**
	 * Ensure the topic's replica exists and is loaded, coalescing concurrent
	 * cold joins onto ONE `persist.load` (the hydrate-stampede gate: N
	 * simultaneous joiners to an empty topic produce exactly one load; the
	 * rest await the same promise). A failed load forgets the topic and
	 * rejects every coalesced waiter, so a retry re-attempts the load.
	 * @param {string} topic
	 * @returns {Promise<TopicRecord>}
	 */
	function ensure(topic) {
		if (destroyed) return Promise.reject(new Error('crdt: authority destroyed'));
		let rec = topics.get(topic);
		if (rec) {
			// A re-join during the on-empty store keeps the live replica: the
			// store completes in the background and the unload is cancelled.
			rec.unloading = false;
			if (rec.loaded) return Promise.resolve(rec);
			return rec.loading.then(() => rec);
		}
		const doc = new Y.Doc({ gc });
		// Route the replica's actor id through the injectable RNG so a
		// deterministic harness reproduces identical struct ids run to run.
		doc.clientID = randomU32();
		rec = {
			doc,
			refs: 0,
			loading: null,
			loaded: false,
			dirty: false,
			updatesSinceStore: 0,
			debounceTimer: null,
			maxWaitStart: null,
			storing: Promise.resolve(),
			newest: null,
			storeAttempt: 0,
			inflight: new Set(),
			unloading: false
		};
		topics.set(topic, rec);
		const hasLoad = !!(persist && typeof persist.load === 'function');
		/** @type {CallHandle} */
		const handle = {
			kind: 'load',
			attempt: 1,
			aborter: new AbortController(),
			waiters: new Set(),
			abandoned: false,
			silent: false,
			release: null
		};
		rec.inflight.add(handle);
		rec.loading = Promise.resolve()
			.then(() => (hasLoad ? persist.load(topic, { signal: handle.aborter.signal }) : null))
			.then((stored) => {
				rec.inflight.delete(handle);
				if (topics.get(topic) !== rec) {
					// The authority was torn down while the load was in
					// flight: every coalesced waiter must REJECT (destroy is
					// terminal), never resolve onto a destroyed replica.
					throw new Error('crdt: authority destroyed');
				}
				if (stored !== null && stored !== undefined) {
					const bytes = toBytes(stored);
					if (bytes === null) throw new Error('crdt: persist.load must return bytes (Uint8Array or number[]) or null');
					Y.applyUpdate(rec.doc, bytes, REMOTE_ORIGIN);
				}
				rec.loaded = true;
				rec.loading = null;
			})
			.catch((err) => {
				rec.inflight.delete(handle);
				// Forget the topic so the NEXT join retries the load; every
				// waiter coalesced on this flight sees the same rejection.
				unload(topic, rec);
				// A load cancelled by teardown rejects with this module's own
				// abort reason; erasing a topic is not a load failure, so it
				// does not reach the operator's error handler.
				if (!handle.silent && !destroyed) reportError(err, topic, 'load');
				throw err;
			});
		return rec.loading.then(() => rec);
	}

	/**
	 * One topic's contribution to a flush: force a store when the replica holds
	 * unstored edits, otherwise join whatever store is already in flight so the
	 * flush reports on bytes it did not itself capture too.
	 *
	 * Either way the flush registers itself on every store it ends up waiting
	 * on - the one it arms AND the older ones that one is chained behind - so
	 * its deadline can tell "nobody else needs this write" from "another flush
	 * is still waiting on it", and so a write not yet dispatched is handed this
	 * flush's budget too.
	 * @param {string} topic @param {TopicRecord} rec @param {FlushToken} flush
	 * @returns {Promise<'durable' | 'declined' | 'failed'>}
	 */
	function flushOne(topic, rec, flush) {
		for (const handle of rec.inflight) {
			if (handle.kind === 'store') handle.waiters.add(flush);
		}
		if (rec.loaded && rec.dirty && hasStore) return storeNow(topic, rec, flush);
		return rec.storing.then(asOutcome, () => 'failed');
	}

	/**
	 * Assemble the caller-facing flush report. The four outcome sets partition
	 * the flushed topics; `dirty` is the crosscutting "bytes this authority has
	 * NOT confirmed durable" view: every non-durable outcome, plus a topic that
	 * took an edit while the flush ran, plus (with no `store` hook) anything
	 * holding edits at all. A topic is only claimed durable when a store hook
	 * exists to have made it so.
	 * @param {Array<[string, TopicRecord]>} targets
	 * @param {Map<string, string>} outcomes
	 */
	function buildFlushResult(targets, outcomes) {
		const durable = [];
		const declined = [];
		const failed = [];
		const timedOut = [];
		const dirty = [];
		for (const [topic, rec] of targets) {
			const outcome = outcomes.get(topic);
			if (outcome === 'declined') declined.push(topic);
			else if (outcome === 'failed') failed.push(topic);
			else if (outcome === 'timedout') timedOut.push(topic);
			else if (hasStore) durable.push(topic);
			// A timed-out store reads clean (the record is cleared when the
			// capture is taken, not when it lands), so the outcome - not
			// `rec.dirty` alone - decides whether the bytes are unconfirmed.
			if (outcome !== 'durable' || (rec.dirty && topics.get(topic) === rec)) dirty.push(topic);
		}
		return {
			// The shutdown question in one boolean, so it has to answer for
			// everything unconfirmed - not only for the stores that reported a
			// problem. `dirty` is already that whole set: every non-durable
			// outcome, plus a topic edited while the flush ran, plus (with no
			// store hook, where nothing can be durable) anything holding edits
			// at all. An authority deliberately run without persistence
			// therefore reports ok:false while it holds edits, which is the
			// truth: `if (result.ok) destroy()` must never discard bytes.
			ok: dirty.length === 0,
			durable,
			declined,
			failed,
			timedOut,
			dirty
		};
	}

	/**
	 * Run one bounded flush over a snapshot of records. The deadline stops the
	 * WAIT, not the work: topics still in flight when it expires are reported
	 * as timed out, and every write this flush was the last one waiting on is
	 * abandoned - its signal fires, its captured state goes back to dirty, and
	 * the retry schedule picks it up - so a flush can never leave bytes it
	 * failed to confirm looking stored. A write another flush is still waiting
	 * on keeps running, and keeps being handed the LATER deadline: the shortest
	 * budget in the room must not decide for everybody, through the signal or
	 * through the hint.
	 * @param {Array<[string, TopicRecord]>} targets @param {number} timeout
	 */
	function runFlush(targets, timeout) {
		// This flush's identity among the waiters on a shared store chain, and
		// the budget it contributes to the deadline those writes are handed.
		/** @type {FlushToken} */
		const token = { deadline: timeout === Infinity ? null : now() + timeout };
		/** @type {Map<string, TopicRecord>} */
		const pending = new Map();
		/** @type {Map<string, string>} */
		const outcomes = new Map();
		return new Promise((resolve) => {
			let timer = null;
			let waiting = targets.length;
			const finish = () => {
				if (timer !== null) {
					clearTimer(timer);
					timer = null;
				}
				// Stop counting as a waiter everywhere: a finished flush must
				// not keep another flush's deadline from cancelling a write.
				for (const [, rec] of targets) {
					for (const handle of rec.inflight) handle.waiters.delete(token);
				}
				resolve(buildFlushResult(targets, outcomes));
			};
			for (const [topic, rec] of targets) {
				pending.set(topic, rec);
				flushOne(topic, rec, token).then((outcome) => {
					// The deadline already answered for this topic: its late
					// settlement belongs to the schedule, not to this flush.
					if (!pending.has(topic)) return;
					pending.delete(topic);
					outcomes.set(topic, outcome);
					if (--waiting === 0) finish();
				});
			}
			if (waiting === 0) {
				finish();
				return;
			}
			if (token.deadline === null) return;
			timer = setTimer(() => {
				timer = null;
				const reason = new Error('crdt: persist flush deadline exceeded');
				for (const [topic, rec] of pending) {
					outcomes.set(topic, 'timedout');
					for (const handle of [...rec.inflight]) {
						// Only writes THIS flush was waiting on, and only once
						// it is the last one waiting: a concurrent flush with a
						// longer budget still needs its write to land.
						if (!handle.waiters.delete(token)) continue;
						if (handle.waiters.size > 0) continue;
						abandon(topic, rec, handle, reason, false);
					}
				}
				pending.clear();
				finish();
			}, timeout);
		});
	}

	return {
		/**
		 * Load (once) and reference the topic's replica. Every successful
		 * acquire must be paired with one `release`.
		 * @param {string} topic
		 * @returns {Promise<void>}
		 */
		acquire(topic) {
			return ensure(topic).then((rec) => {
				rec.refs++;
			});
		},

		/**
		 * Drop one reference. The last release runs the final on-empty store
		 * (when `persistOnEmpty`, the default) and unloads the replica once
		 * that store has settled - unless a new joiner re-acquired the topic
		 * meanwhile, in which case the replica stays live (a connect/disconnect
		 * flap coalesces instead of multiplying store calls).
		 * @param {string} topic
		 */
		release(topic) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return;
			if (rec.refs > 0) rec.refs--;
			if (rec.refs > 0) return;
			rec.unloading = true;
			if (persistOnEmpty && rec.dirty && hasStore) {
				// The unload completes in the store's success path, so a dirty
				// replica is never destroyed before its bytes are durable.
				storeNow(topic, rec);
				return;
			}
			rec.storing.then(() => {
				if (destroyed || topics.get(topic) !== rec) return;
				// Dirty blocks the unload only when an on-empty store could
				// still make the bytes durable: with no store hook there is
				// nothing to write, and with persistOnEmpty off the caller
				// opted out of the final write by contract.
				if (rec.refs === 0 && rec.unloading && (!rec.dirty || !hasStore || !persistOnEmpty)) unload(topic, rec);
			});
		},

		/**
		 * Merge one inbound update into the authoritative replica and return
		 * the normalized bytes for the caller to fan out verbatim (the same
		 * bytes every capable subscriber decodes; design rule: never re-encode
		 * from the replica's own update event, so an applied-remote update is
		 * never re-broadcast to its sender by accident). Returns `null` when
		 * the topic is not loaded or the bytes are malformed - the frame is
		 * dropped and the sender's next sync reconciles.
		 *
		 * Apply + persist-schedule is one synchronous unit: a second update
		 * arriving in the next task sees this one's applied state.
		 * @param {string} topic
		 * @param {Uint8Array | number[]} bytes
		 * @returns {Uint8Array | null}
		 */
		applyUpdate(topic, bytes) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded || destroyed) return null;
			const u8 = toBytes(bytes);
			if (u8 === null || u8.length === 0) return null;
			try {
				Y.applyUpdate(rec.doc, u8, REMOTE_ORIGIN);
			} catch {
				return null; // malformed update: drop, never corrupt the replica
			}
			rec.dirty = true;
			rec.updatesSinceStore++;
			if (rec.updatesSinceStore >= snapshotEvery) {
				storeNow(topic, rec);
			} else {
				scheduleStore(topic, rec);
			}
			return u8;
		},

		/**
		 * The missing-structs diff for a joiner: exactly what a client holding
		 * `stateVector` lacks, independent of how long it was away. A missing,
		 * empty, or malformed state vector yields the full document state -
		 * always correct, because re-applying known structs is a no-op.
		 * @param {string} topic
		 * @param {Uint8Array | number[] | null} [stateVector]
		 * @returns {Uint8Array | null} diff bytes, or null when the topic is not loaded
		 */
		diff(topic, stateVector) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return null;
			const sv = stateVector === null || stateVector === undefined ? null : toBytes(stateVector);
			if (sv !== null && sv.length > 0) {
				try {
					return Y.encodeStateAsUpdate(rec.doc, sv);
				} catch {
					// fall through: a malformed vector gets the full state
				}
			}
			return Y.encodeStateAsUpdate(rec.doc);
		},

		/**
		 * The server replica's state vector, sent to a syncing client so it
		 * can upload exactly what the SERVER lacks (the offline-edit flush).
		 * @param {string} topic
		 * @returns {Uint8Array | null} vector bytes, or null when the topic is not loaded
		 */
		stateVector(topic) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return null;
			return Y.encodeStateVector(rec.doc);
		},

		/**
		 * Force the persistence of one topic now (bypassing the debounce), or
		 * of every topic when none is given. For graceful shutdown and tests.
		 *
		 * Resolves - never rejects - to the per-topic outcome, because the
		 * whole point of an explicit flush is that the caller learns whether
		 * the bytes are safe: a store that rejected lands in `failed`, one that
		 * declined in `declined`, one that never settled within the budget in
		 * `timedOut`, and anything still holding unconfirmed bytes in `dirty`.
		 * `ok` is the single shutdown question, "did everything land here": it
		 * is false whenever `dirty` is non-empty, including for an authority
		 * with no `store` hook, which can never make bytes durable.
		 *
		 * The wait is bounded by `timeout` ms (the authority's `flushTimeout`
		 * by default, `Infinity` to wait indefinitely). On expiry each store
		 * this flush was the LAST one waiting on is abandoned: its signal
		 * fires, its captured state goes back to dirty and onto the retry
		 * schedule, and its late answer is ignored - so the topic is reported
		 * as timed out instead of the flush hanging forever, and no unconfirmed
		 * write is left looking stored. A store a concurrent longer-budget
		 * flush is still waiting on keeps running untouched, and the deadline
		 * that store was handed is the longer flush's - the short budget
		 * decides for nobody but itself, neither through the signal nor
		 * through the hint. The seam: a flush that joins a write already
		 * dispatched cannot widen the deadline the host has already read, so
		 * a host that bounds its own I/O by that reading stops at the earlier
		 * one even though the write is still wanted.
		 * @param {string | { timeout?: number }} [topic]
		 * @param {{ timeout?: number }} [options]
		 * @returns {Promise<{ ok: boolean, durable: string[], declined: string[], failed: string[], timedOut: string[], dirty: string[] }>}
		 */
		persistNow(topic, options) {
			let name = topic;
			let opts = options;
			if (isOptionsBag(name)) {
				// The every-topic flush with options: persistNow({ timeout }).
				opts = name;
				name = undefined;
			}
			if (name !== undefined && typeof name !== 'string') {
				throw new Error('crdt: persistNow topic must be a string');
			}
			if (opts !== undefined && !isOptionsBag(opts)) {
				throw new Error('crdt: persistNow options must be an object');
			}
			const timeout = checkTimeout(opts ? opts.timeout : undefined, 'persistNow timeout') ?? flushTimeout;
			/** @type {Array<[string, TopicRecord]>} */
			const targets = [];
			if (name !== undefined) {
				const rec = topics.get(name);
				if (rec) targets.push([name, rec]);
			} else {
				// Snapshot first: a store settling during the flush can unload
				// its topic, and a mutating map must not break the iteration.
				for (const entry of topics) targets.push(entry);
			}
			return runFlush(targets, timeout);
		},

		/** Whether the topic currently holds a loaded replica. */
		has(topic) {
			const rec = topics.get(topic);
			return !!(rec && rec.loaded);
		},

		/** Live references on the topic (0 when absent). */
		refs(topic) {
			const rec = topics.get(topic);
			return rec ? rec.refs : 0;
		},

		/** Number of loaded topics (diagnostics). */
		size() {
			let n = 0;
			for (const rec of topics.values()) if (rec.loaded) n++;
			return n;
		},

		/**
		 * Erase one topic's replica REGARDLESS of live references: cancel its
		 * persistence schedule and destroy the doc WITHOUT running any store -
		 * an erasure must never write back the state it is erasing. Returns
		 * `true` when a replica (loaded or still loading) was dropped. Live
		 * holders observe the topic as unloaded from the next call on
		 * (`applyUpdate`/`diff` return null, exactly like a never-acquired
		 * topic) and their later `release` calls no-op. A subsequent `acquire`
		 * cold-loads from persistence - deleting the persisted copy is the
		 * `persist`-store owner's half of a whole-document erasure.
		 * @param {string} topic
		 * @returns {boolean}
		 */
		drop(topic) {
			const rec = topics.get(topic);
			if (!rec) return false;
			unload(topic, rec);
			return true;
		},

		/**
		 * Tear the authority down: cancel every schedule, abort the host I/O
		 * still in flight, and destroy every replica. Pending edits are NOT
		 * stored (call `persistNow()` first for a graceful path, and check its
		 * result before destroying); destroy is the hard-stop for tests and
		 * shutdown.
		 */
		destroy() {
			if (destroyed) return;
			destroyed = true;
			const reason = new Error('crdt: authority destroyed');
			for (const [topic, rec] of topics) {
				clearSchedule(rec);
				abortInFlight(topic, rec, reason);
				try { rec.doc.destroy(); } catch { /* ignore */ }
			}
			topics.clear();
		}
	};
}
