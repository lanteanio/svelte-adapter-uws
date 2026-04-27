/**
 * Lock plugin for svelte-adapter-uws.
 *
 * Per-key serialization for critical sections that must not interleave.
 * Backed by a `Map<string, Promise>` chain: concurrent `withLock(key, fn)`
 * calls on the same key run one at a time in FIFO order; calls on
 * different keys run in parallel.
 *
 * Use this for atomic read-modify-write on user state, "only one
 * in-flight upgrade per resource," or anywhere two requests racing the
 * same record would corrupt it.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * holds its own state and can be created per-process or per-feature.
 *
 * @module svelte-adapter-uws/plugins/lock
 */

/**
 * @typedef {Object} Lock
 * @property {<T>(key: string, fn: () => T | Promise<T>) => Promise<T>} withLock -
 *   Run `fn` with exclusive access to `key`. Concurrent calls on the same
 *   key queue FIFO; different keys run in parallel. Errors in `fn`
 *   propagate to the caller and do not block subsequent waiters.
 * @property {(key: string) => boolean} held - True iff a lock is currently
 *   in flight for `key`.
 * @property {() => number} size - Number of currently-held keys.
 * @property {() => void} clear - Drop all in-flight tracking. Pending
 *   `withLock` calls still resolve normally; this only clears the
 *   bookkeeping. Use in tests/teardown.
 */

/**
 * Create an in-process lock primitive.
 *
 * @returns {Lock}
 *
 * @example
 * ```js
 * // src/lib/server/locks.js
 * import { createLock } from 'svelte-adapter-uws/plugins/lock';
 * export const locks = createLock();
 * ```
 *
 * @example
 * ```js
 * // src/routes/account/+page.server.js
 * import { locks } from '$lib/server/locks';
 *
 * export const actions = {
 *   topUp: async ({ request, locals }) => {
 *     const amount = Number((await request.formData()).get('amount'));
 *     return locks.withLock('user:' + locals.userId, async () => {
 *       const user = await db.getUser(locals.userId);
 *       user.balance += amount;
 *       await db.saveUser(user);
 *       return { balance: user.balance };
 *     });
 *   }
 * };
 * ```
 */
export function createLock() {
	/**
	 * Per-key chain head. Each entry holds the promise of the most recent
	 * caller for that key. New entrants chain off this and replace it
	 * with their own promise so subsequent entrants chain off them.
	 * @type {Map<string, Promise<unknown>>}
	 */
	const chain = new Map();

	/**
	 * @template T
	 * @param {string} key
	 * @param {() => T | Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	function withLock(key, fn) {
		if (typeof key !== 'string' || key.length === 0) {
			return Promise.reject(new Error('lock: key must be a non-empty string'));
		}
		if (typeof fn !== 'function') {
			return Promise.reject(new Error('lock: fn must be a function'));
		}

		const prev = chain.get(key);
		// Build our promise as a chain off prev. Errors in prev are
		// swallowed at the chain boundary - they belong to the previous
		// caller and must not block this one.
		const ours = (async () => {
			if (prev) {
				try { await prev; } catch { /* not our concern */ }
			}
			return fn();
		})();
		chain.set(key, ours);

		// Release: only clear the chain head if no later entrant has
		// replaced us. This prevents us from clobbering a waiter that
		// chained off ours and is now the new head.
		const release = () => {
			if (chain.get(key) === ours) chain.delete(key);
		};
		ours.then(release, release);

		return ours;
	}

	return {
		withLock,
		held(key) {
			return chain.has(key);
		},
		size() {
			return chain.size;
		},
		clear() {
			chain.clear();
		}
	};
}
