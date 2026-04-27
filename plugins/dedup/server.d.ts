/**
 * Dedup plugin for svelte-adapter-uws.
 *
 * In-process "have I seen this id before?" cache with fixed-window TTL.
 * The natural use is wrapping a side-effecting handler so client retries
 * after a flaky disconnect do not double-execute.
 */

export interface DedupOptions {
	/**
	 * Deduplication window in milliseconds. An id that was claimed
	 * `ttl` ms ago can be claimed again as new. Must be positive.
	 */
	ttl: number;

	/**
	 * Soft cap on retained ids. When the map grows past 110% of this
	 * cap, expired entries are pruned in a single pass; if still over
	 * cap, the oldest insertion-order entries are evicted regardless.
	 * Default 10000.
	 */
	maxEntries?: number;
}

export interface Dedup {
	/**
	 * Try to claim `id` as a first-sight delivery. Returns `true` if
	 * the id was unseen or its previous claim has expired (and records
	 * the new claim with a fresh TTL). Returns `false` if the id is
	 * currently inside its window from a prior claim.
	 *
	 * The TTL is fixed from first sight: a duplicate claim during the
	 * window does NOT extend the window.
	 */
	claim(id: string): boolean;

	/**
	 * `true` iff `id` was claimed and is still within its window.
	 * Lazy-prunes expired ids on access.
	 *
	 * Note: for the "have I seen this; if not, mark it" decision,
	 * always use `claim` - it is atomic. Using `has` followed by
	 * something that records the id has a TOCTOU race in concurrent
	 * code.
	 */
	has(id: string): boolean;

	/**
	 * Explicitly forget an id. Returns `true` if the id was live
	 * (i.e. `claim` would have returned `false`), `false` if it was
	 * missing or already expired (expired entries are still removed
	 * by this call).
	 */
	delete(id: string): boolean;

	/**
	 * Current number of retained ids. May include expired ids that
	 * have not yet been pruned by lazy cleanup.
	 */
	size(): number;

	/** Forget all ids. */
	clear(): void;
}

/**
 * Create an in-process dedup cache with fixed-window TTL.
 *
 * @example
 * ```js
 * import { createDedup } from 'svelte-adapter-uws/plugins/dedup';
 *
 * const dedup = createDedup({ ttl: 5 * 60 * 1000 });
 *
 * if (!dedup.claim(messageId)) return; // duplicate, skip side effects
 * await processMessage(messageId);
 * ```
 */
export function createDedup(options: DedupOptions): Dedup;
