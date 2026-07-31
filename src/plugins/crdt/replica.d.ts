/** The per-document access record a CRDT guard resolves to. */
export interface CrdtAccess {
	/** May subscribe: receives the initial diff and live updates. */
	read: boolean;
	/** May emit document updates that mutate shared state. */
	write: boolean;
	/**
	 * Reserved: gates the comment-marks surface when the rich-text marks layer
	 * lands. Carried and cached in full today; no comment producer exists yet,
	 * so granting it changes nothing in 0.6.
	 */
	comment: boolean;
}

/**
 * Normalize a guard's return value into the access record: a non-object is a
 * boolean gate widened to all three rights; an object is a partial record
 * whose missing rights default to `false` (so `{read: true}` means read-only).
 */
export function normalizeCrdtAccess(value: unknown): CrdtAccess;

/** What the authority tells a `persist.load` call about the context it runs in. */
export interface CrdtLoadInfo {
	/**
	 * Aborts when the topic is erased (`drop`) or the authority is destroyed
	 * while the load is in flight - the handle for cancelling the host's own
	 * query instead of leaving it running against a torn-down authority. Loads
	 * are not retried by the authority (a failed load forgets the topic and the
	 * next `acquire` re-attempts it), so there is no attempt count here.
	 */
	signal: AbortSignal;
}

/** What the authority tells a `persist.store` call about the context it runs in. */
export interface CrdtStoreInfo {
	/**
	 * Aborts when the last explicit flush waiting on this call runs out of
	 * budget, when the topic is erased, or when the authority is destroyed
	 * (a flush that gives up while another is still waiting does not fire
	 * it - see `deadline`). Honouring it is optional -
	 * ignoring it simply runs the write to completion - but a host that passes
	 * it into its client turns a wedged backend into a bounded shutdown.
	 *
	 * Once it fires, this write no longer counts either way: whatever it
	 * resolves or rejects with is discarded. So a host may honour the abort
	 * however it likes - reject, or abandon the write and resolve - without
	 * the flush ever reading the abandoned write as durable. When it was a
	 * flush budget that fired it, the state this write captured also goes back
	 * to dirty and the authority reschedules a fresh full-state write; an
	 * erase or a teardown has no record left to reschedule, which is why those
	 * two do not report through `onError` either. The one thing an ignoring
	 * host gives up is ordering: the rescheduled write can overlap the one it
	 * abandoned, so a host that wants its writes for a topic strictly
	 * serialized should honour the signal.
	 */
	signal: AbortSignal;
	/**
	 * Epoch ms (a `Date.now()` reading) at which the last flush still waiting
	 * on this write stops waiting, or `null` when nothing bounds it: a store
	 * the background schedule owns (no caller is waiting on it), or one whose
	 * only waiters opted out with an `Infinity` budget. Use it to size a
	 * statement timeout.
	 *
	 * It is the LATEST budget among the flushes waiting when the write is
	 * dispatched, not the budget of the one that armed it, so a short flush
	 * running next to a long one does not shorten the long one's write. The
	 * residual: a flush that starts waiting on a write already dispatched
	 * cannot widen the reading the host already took. That write is not
	 * aborted (the signal fires only when the LAST flush waiting on it gives
	 * up), but a host that bounded its own I/O by the earlier reading has
	 * already stopped - bound on `signal` too if the write must survive for
	 * whoever is still waiting.
	 */
	deadline: number | null;
	/**
	 * 1 on the first store of the current unstored state, incremented for every
	 * consecutive retry after a write that did not confirm (one that failed,
	 * declined, or was abandoned by a flush deadline), reset by a successful
	 * one. Lets a host back off or escalate without tracking state per topic.
	 *
	 * It counts retries, not writes: sustained editing against a healthy
	 * backend reports 1 on every store however fast the edits arrive, so
	 * `attempt > n` means "n writes of this state did not stick", never "this
	 * document is busy".
	 */
	attempt: number;
}

/** Durable persistence hooks - the host app owns the I/O, the authority owns the schedule. */
export interface CrdtPersist {
	/** Load the durable full-state blob for a cold topic; null/undefined for a brand-new document. */
	load?: (topic: string, info: CrdtLoadInfo) => Promise<Uint8Array | number[] | null | undefined> | Uint8Array | number[] | null | undefined;
	/**
	 * Store the compacted full-state blob. Called on the debounce schedule,
	 * never inline on the message path. Resolve `false` to decline the write
	 * without failing it (e.g. a cluster instance that does not hold the
	 * per-topic persist lease): the topic stays dirty and is re-probed at the
	 * `debounceMaxWait` cadence until a write succeeds, and the replica may
	 * still unload (the data is durable wherever the write does land). Throw
	 * (or reject) to signal a genuine I/O failure, which retries via `onError`.
	 */
	store?: (topic: string, bytes: Uint8Array, info: CrdtStoreInfo) => Promise<void | boolean> | void | boolean;
}

/** Per-call overrides for an explicit flush. */
export interface CrdtFlushOptions {
	/**
	 * Milliseconds to wait before giving up on the topics still in flight.
	 * Defaults to the authority's `flushTimeout`. `Infinity` waits
	 * indefinitely - only correct when something else bounds the caller.
	 */
	timeout?: number;
}

/**
 * What one explicit flush did, per topic. The four outcome sets partition the
 * flushed topics; `dirty` is the crosscutting view of what is NOT known
 * durable, so a shutdown path can log exactly which documents are at risk.
 */
export interface CrdtFlushResult {
	/**
	 * True when nothing is left unconfirmed - exactly `dirty.length === 0`, so
	 * `if (result.ok) authority.destroy()` can never discard bytes. A decline
	 * is not necessarily data loss (in a cluster the lease holder writes it),
	 * but it is not durable at THIS authority, so it still clears `ok`; so does
	 * a topic edited while the flush ran, and so does any topic holding edits
	 * on an authority with no `store` hook, which has nothing to make them
	 * durable with.
	 */
	ok: boolean;
	/**
	 * Topics whose store resolved, plus topics that had nothing unstored. Empty
	 * when no `persist.store` hook is configured: an authority with no store
	 * hook can never claim a topic is durable.
	 */
	durable: string[];
	/** Topics whose store resolved `false` (declined the write). */
	declined: string[];
	/** Topics whose store rejected. The error itself is reported through `onError`. */
	failed: string[];
	/**
	 * Topics whose store had not settled when the budget expired. The write is
	 * abandoned - its signal fires and its answer is discarded however it
	 * eventually settles - the record goes back to dirty, and a fresh
	 * full-state write is scheduled at the `debounceMaxWait` cadence (floored
	 * at 1000 ms). The flush stopped waiting; it did not decide the bytes were
	 * safe.
	 *
	 * The rescheduled write is one attempt, not an unbounded retry loop: only
	 * an explicit flush has a deadline, so if that write ALSO never settles the
	 * topic's persistence stalls until it settles or until the next
	 * `persistNow()` abandons it. Editing does NOT clear the stall: the edit's
	 * own write is captured behind the wedged one in the topic's store chain
	 * and is never dispatched, so a deployment that can wedge a write needs a
	 * periodic `persistNow()`, not traffic. The flush result is where a caller
	 * learns that, which is why a shutdown path should act on `dirty` rather
	 * than flush and exit.
	 *
	 * A write another flush with a longer budget is still waiting on is NOT
	 * abandoned: this flush reports the topic as timed out and leaves the write
	 * running for the flush that still needs it, with the longer flush's
	 * `deadline` (see `CrdtStoreInfo.deadline` for the one seam in that).
	 */
	timedOut: string[];
	/**
	 * Every flushed topic still holding bytes this authority has not confirmed
	 * durable: the failed, declined and timed-out ones, anything edited while
	 * the flush ran, and - with no `persist.store` hook - anything holding
	 * edits at all.
	 */
	dirty: string[];
}

export interface CrdtAuthorityOptions {
	/** Durable backing hooks. Omit for a purely in-memory document set. */
	persist?: CrdtPersist;
	/** Persist this long after the last edit (ms). Default 2000. */
	debounceWait?: number;
	/** Force a persist at least this often during sustained editing (ms). Default 10000. */
	debounceMaxWait?: number;
	/** Compact (full-state store) every N updates. Default 200. */
	snapshotEvery?: number;
	/**
	 * How long an explicit `persistNow()` waits for the host's stores before
	 * reporting them as timed out and aborting their signals (ms). Default
	 * 10000. `Infinity` waits indefinitely, which is what a flush on the
	 * shutdown path must never do unless the caller bounds it itself.
	 */
	flushTimeout?: number;
	/** Run a final store when the last reference releases. Default true. */
	persistOnEmpty?: boolean;
	/** CRDT garbage collection on the server replicas. Default true. */
	gc?: boolean;
	/**
	 * Observe persist I/O failures (the schedule retries; this is the operator
	 * signal). A store aborted by a flush deadline surfaces here too, as
	 * whatever the host's client throws on abort - the host really did run out
	 * of budget. A call cancelled by `drop()` or `destroy()` does NOT: erasing
	 * a topic and tearing the authority down are intentional stops, and a
	 * handler that pages or increments an error counter must not fire on every
	 * clean shutdown that had writes in flight.
	 */
	onError?: (err: unknown, info: { topic: string; op: 'load' | 'store' }) => void;
}

/**
 * The server-side document authority: per-topic authoritative replicas,
 * reference-counted lifecycle, hydrate-stampede-safe loading, and the
 * persistence schedule. The wire stays the CRDT codec's concern; this is
 * where the document bytes are produced and merged server-side.
 */
export interface CrdtAuthority {
	/**
	 * Load (once - concurrent cold joins coalesce on one `persist.load`) and
	 * reference the topic's replica. Pair every successful acquire with one
	 * `release`. Rejects when the load failed; the next acquire retries.
	 */
	acquire(topic: string): Promise<void>;
	/**
	 * Drop one reference. The last release runs the final on-empty store and
	 * unloads the replica once the store settled; a re-acquire meanwhile keeps
	 * the replica live (flap-safe).
	 */
	release(topic: string): void;
	/**
	 * Merge one inbound update into the replica and return the normalized
	 * bytes for fan-out, or null when the topic is unloaded or the bytes are
	 * malformed (the frame drops; the sender's next sync reconciles).
	 */
	applyUpdate(topic: string, bytes: Uint8Array | number[]): Uint8Array | null;
	/**
	 * The missing-structs diff against a joiner's state vector (full state for
	 * a missing/empty/malformed vector), or null when the topic is unloaded.
	 */
	diff(topic: string, stateVector?: Uint8Array | number[] | null): Uint8Array | null;
	/** The replica's own state vector (what the client uploads against), or null when unloaded. */
	stateVector(topic: string): Uint8Array | null;
	/**
	 * Force persistence of one topic (or every topic) now, bounded by
	 * `timeout` / the authority's `flushTimeout`. Resolves - never rejects -
	 * to what happened per topic, so a caller cannot mistake a flush in which
	 * every store rejected for a durable one; a store still running when the
	 * budget expires is reported in `timedOut` rather than hanging the flush,
	 * and has its signal aborted unless another flush is still waiting on it.
	 *
	 * The first argument is a topic name or an options bag, and nothing else:
	 * `persistNow(['a', 'b'])` throws rather than being read as an every-topic
	 * flush, so a caller who confuses the topic argument with the topic ARRAYS
	 * in the result cannot get a wider flush than it asked for reported as a
	 * success.
	 */
	persistNow(topic?: string, options?: CrdtFlushOptions): Promise<CrdtFlushResult>;
	persistNow(options: CrdtFlushOptions): Promise<CrdtFlushResult>;
	/** Whether the topic currently holds a loaded replica. */
	has(topic: string): boolean;
	/**
	 * Erase one topic's replica regardless of live references: cancel its
	 * persistence schedule and destroy the doc WITHOUT running any store (an
	 * erasure must never write back the state it is erasing). Returns `true`
	 * when a replica was dropped. Live holders observe the topic as unloaded
	 * from the next call on; a subsequent `acquire` cold-loads from
	 * persistence - deleting the persisted copy is the `persist`-store
	 * owner's half of a whole-document erasure.
	 */
	drop(topic: string): boolean;
	/** Live references on the topic (0 when absent). */
	refs(topic: string): number;
	/** Number of loaded topics. */
	size(): number;
	/**
	 * Hard-stop: cancel schedules, abort in-flight host I/O, destroy replicas.
	 * Call `persistNow()` first for a graceful path, and check its result -
	 * destroying after a flush that reported `dirty` topics discards them.
	 */
	destroy(): void;
}

/** Create the document authority for one CRDT declaration. */
export function createCrdtAuthority(options?: CrdtAuthorityOptions): CrdtAuthority;
