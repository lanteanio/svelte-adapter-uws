/**
 * Session plugin for svelte-adapter-uws.
 *
 * In-process session store with sliding TTL. Every read extends the
 * entry's lifetime by another full ttl window.
 */

export interface SessionOptions {
	/**
	 * Time to live in milliseconds. Each `get` / `touch` call extends
	 * an entry's expiry to `Date.now() + ttl`. Must be positive.
	 */
	ttl: number;

	/**
	 * Soft cap on retained entries. When the map grows past 110% of
	 * this cap, expired entries are pruned in a single pass; if the
	 * map is still over cap after pruning, the oldest entries are
	 * evicted regardless. Default 10000.
	 */
	maxEntries?: number;
}

export interface Session<T = unknown> {
	/**
	 * Look up by token. Returns the stored data if present and not yet
	 * expired, else `null`. On a hit, extends the entry's TTL. Expired
	 * entries are removed lazily on access.
	 */
	get(token: string): T | null;

	/**
	 * Store or replace data for `token`. Resets the TTL.
	 */
	set(token: string, data: T): void;

	/**
	 * Remove an entry. Returns `true` if the token was present and not
	 * yet expired, `false` if it was missing or already expired
	 * (expired entries are still removed by this call).
	 */
	delete(token: string): boolean;

	/**
	 * Extend TTL without reading data. Returns `true` if the entry was
	 * present and refreshed, `false` if the token was missing or
	 * already expired.
	 */
	touch(token: string): boolean;

	/**
	 * Current number of retained entries. May include expired entries
	 * that have not yet been pruned by lazy cleanup.
	 */
	size(): number;

	/** Remove all entries. */
	clear(): void;
}

/**
 * Create an in-process session store with sliding TTL.
 *
 * @example
 * ```js
 * import { createSession } from 'svelte-adapter-uws/plugins/session';
 *
 * const sessions = createSession({ ttl: 30 * 60 * 1000 });
 *
 * sessions.set('abc123', { userId: 42, role: 'admin' });
 * const data = sessions.get('abc123'); // { userId: 42, role: 'admin' }
 * sessions.touch('abc123');             // refresh window
 * sessions.delete('abc123');            // explicit logout
 * ```
 */
export function createSession<T = unknown>(options: SessionOptions): Session<T>;
