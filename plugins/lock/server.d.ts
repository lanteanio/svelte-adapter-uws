/**
 * Lock plugin for svelte-adapter-uws.
 *
 * Per-key serialization for critical sections that must not interleave.
 * Concurrent `withLock(key, fn)` calls on the same key run one at a time
 * in FIFO order; calls on different keys run in parallel.
 */

export interface Lock {
	/**
	 * Run `fn` with exclusive access to `key`.
	 *
	 * Concurrent calls on the same `key` queue FIFO; calls on different
	 * keys run in parallel. The lock is held until `fn` resolves (or
	 * rejects); errors propagate to the caller of `withLock` but do not
	 * block subsequent waiters.
	 *
	 * Re-entrant calls on the same `key` from inside `fn` will deadlock,
	 * because the inner call queues behind the outer one. Avoid
	 * recursive locking; if you need it, derive a sub-key.
	 *
	 * @example
	 * ```js
	 * await locks.withLock('user:' + userId, async () => {
	 *   const user = await db.getUser(userId);
	 *   user.balance += amount;
	 *   await db.saveUser(user);
	 * });
	 * ```
	 */
	withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T>;

	/**
	 * `true` iff a lock is currently in flight for `key`.
	 *
	 * Note: this is observational only. Do not branch on `held(key)` to
	 * decide whether to acquire - by the time you call `withLock` the
	 * answer may have changed. Use `withLock` and let the chain
	 * serialize you.
	 */
	held(key: string): boolean;

	/** Number of currently-held keys. */
	size(): number;

	/**
	 * Drop all in-flight tracking. Pending `withLock` calls still
	 * resolve normally; this only clears the bookkeeping. Use in
	 * tests/teardown.
	 */
	clear(): void;
}

/**
 * Create an in-process lock primitive.
 *
 * @example
 * ```js
 * import { createLock } from 'svelte-adapter-uws/plugins/lock';
 * export const locks = createLock();
 * ```
 */
export function createLock(): Lock;
