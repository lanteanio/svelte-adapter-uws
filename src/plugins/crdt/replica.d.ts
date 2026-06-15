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

/** Durable persistence hooks - the host app owns the I/O, the authority owns the schedule. */
export interface CrdtPersist {
	/** Load the durable full-state blob for a cold topic; null/undefined for a brand-new document. */
	load?: (topic: string) => Promise<Uint8Array | number[] | null | undefined> | Uint8Array | number[] | null | undefined;
	/**
	 * Store the compacted full-state blob. Called on the debounce schedule,
	 * never inline on the message path. Resolve `false` to decline the write
	 * without failing it (e.g. a cluster instance that does not hold the
	 * per-topic persist lease): the topic stays dirty and is re-probed at the
	 * `debounceMaxWait` cadence until a write succeeds, and the replica may
	 * still unload (the data is durable wherever the write does land). Throw
	 * (or reject) to signal a genuine I/O failure, which retries via `onError`.
	 */
	store?: (topic: string, bytes: Uint8Array) => Promise<void | boolean> | void | boolean;
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
	/** Run a final store when the last reference releases. Default true. */
	persistOnEmpty?: boolean;
	/** CRDT garbage collection on the server replicas. Default true. */
	gc?: boolean;
	/** Observe persist I/O failures (the schedule retries; this is the operator signal). */
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
	/** Force persistence of one topic (or every dirty topic) now; resolves when stores settled. */
	persistNow(topic?: string): Promise<void>;
	/** Whether the topic currently holds a loaded replica. */
	has(topic: string): boolean;
	/** Live references on the topic (0 when absent). */
	refs(topic: string): number;
	/** Number of loaded topics. */
	size(): number;
	/** Hard-stop: cancel schedules, destroy replicas. Call `persistNow()` first for a graceful path. */
	destroy(): void;
}

/** Create the document authority for one CRDT declaration. */
export function createCrdtAuthority(options?: CrdtAuthorityOptions): CrdtAuthority;
