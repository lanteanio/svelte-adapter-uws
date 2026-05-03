/**
 * Lock plugin for svelte-adapter-uws.
 *
 * Per-key serialization for critical sections that must not interleave.
 * Concurrent `withLock(key, fn)` calls on the same key run one at a time
 * in FIFO order; calls on different keys run in parallel.
 */

export interface WithLockOptions {
	/**
	 * Bounded wait. When set, the caller is rejected with a
	 * `LockTimeoutError` (`code: 'LOCK_TIMEOUT'`) if it does not acquire
	 * the lock within this many milliseconds. The current holder's `fn`
	 * is not interrupted; only the waiting caller gives up. Subsequent
	 * waiters on the same key are unaffected and continue in their
	 * original order.
	 *
	 * Pass `0` to fail immediately if any other caller currently holds
	 * or is queued ahead of you. Negative values are rejected.
	 *
	 * @example
	 * ```js
	 * try {
	 *   await locks.withLock('user:42', work, { maxWaitMs: 5000 });
	 * } catch (err) {
	 *   if (err.code === 'LOCK_TIMEOUT') {
	 *     return new Response('busy', { status: 503 });
	 *   }
	 *   throw err;
	 * }
	 * ```
	 */
	maxWaitMs?: number;
}

/**
 * Error thrown into a `withLock` caller's promise when the bounded
 * wait elapses before acquisition. Includes the contended `key` and
 * the configured `maxWaitMs` so error-handler code can surface useful
 * messages without inspecting the message string.
 */
export interface LockTimeoutError extends Error {
	code: 'LOCK_TIMEOUT';
	key: string;
	maxWaitMs: number;
}

/**
 * Error thrown into pending waiters when `lock.clear()` is called.
 * Currently-running `fn` calls are not interrupted; only waiters that
 * had not yet acquired are rejected with this code.
 */
export interface LockClearedError extends Error {
	code: 'LOCK_CLEARED';
}

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
	 * Pass `{ maxWaitMs }` to bound the wait. The caller is rejected
	 * with a `LockTimeoutError` if acquisition does not happen in time.
	 * Subsequent waiters on the same key continue in their original
	 * order; a timeout never blocks the queue for later callers.
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
	withLock<T>(
		key: string,
		fn: () => T | Promise<T>,
		options?: WithLockOptions
	): Promise<T>;

	/**
	 * `true` iff a lock is currently in flight for `key` (running `fn`
	 * or with at least one queued waiter).
	 *
	 * Note: this is observational only. Do not branch on `held(key)` to
	 * decide whether to acquire - by the time you call `withLock` the
	 * answer may have changed. Use `withLock` and let the queue
	 * serialize you.
	 */
	held(key: string): boolean;

	/** Number of keys with any in-flight or queued activity. */
	size(): number;

	/**
	 * Drop all in-flight tracking AND reject any pending waiters with a
	 * `LockClearedError` (`code: 'LOCK_CLEARED'`). Currently-running
	 * `fn` calls are not interrupted; they finish normally. Use in
	 * tests / teardown.
	 *
	 * **Note:** prior versions of this plugin used a chain-of-promises
	 * implementation where `clear()` only cleared the bookkeeping and
	 * pending callers continued to resolve. The waiter-queue
	 * implementation owns the only reference to pending callers, so
	 * `clear()` now rejects them rather than letting them hang. If you
	 * relied on the old "pending calls still resolve normally"
	 * behaviour in a teardown path, catch `LOCK_CLEARED`.
	 */
	clear(): void;
}

export interface LockOptions {
	/**
	 * Hard cap on the number of distinct keys with any in-flight or
	 * queued activity. `withLock(newKey, fn)` rejects synchronously
	 * when the registry is at cap; existing keys can still be entered
	 * (no growth). Protects against unbounded key cardinality on
	 * `lock-${userId}` patterns.
	 *
	 * @default 1_000_000
	 */
	maxKeys?: number;
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
export function createLock(options?: LockOptions): Lock;
