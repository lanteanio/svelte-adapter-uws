/**
 * Lock plugin for svelte-adapter-uws.
 *
 * Per-key serialization for critical sections that must not interleave.
 * Backed by a per-key FIFO waiter queue: concurrent `withLock(key, fn)`
 * calls on the same key run one at a time in arrival order; calls on
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
 * @typedef {Object} WithLockOptions
 * @property {number} [maxWaitMs] - When set, the caller is rejected with
 *   a `LOCK_TIMEOUT` error if it does not acquire the lock within this
 *   many milliseconds of the call. The current holder's `fn` is not
 *   interrupted; only the waiting caller gives up. Subsequent waiters
 *   on the same key are unaffected and continue in their original
 *   order.
 */

/**
 * @typedef {Object} Lock
 * @property {<T>(key: string, fn: () => T | Promise<T>, options?: WithLockOptions) => Promise<T>} withLock -
 *   Run `fn` with exclusive access to `key`. Concurrent calls on the same
 *   key queue FIFO; different keys run in parallel. Errors in `fn`
 *   propagate to the caller and do not block subsequent waiters.
 * @property {(key: string) => boolean} held - True iff a lock is currently
 *   in flight for `key` (running `fn` or with at least one queued waiter).
 * @property {() => number} size - Number of keys with any in-flight or
 *   queued activity.
 * @property {() => void} clear - Drop all in-flight tracking AND reject
 *   any pending waiters with a `LOCK_CLEARED` error. Currently-running
 *   `fn` calls are not interrupted (they finish normally); only waiters
 *   that have not yet acquired are rejected. Use in tests/teardown.
 */

// - Internal: per-key state ------------------------------------------------
//
// Each active key carries a `running` flag (true while a caller's `fn` is
// executing) and a FIFO `queue` of pending waiters. When the running
// caller completes, `advance()` pops the next waiter and runs it. Timed
// -out waiters mark themselves cancelled before rejecting; `advance()`
// skips cancelled entries so a timeout never blocks the queue for later
// callers, even if multiple cancellations sit at the head.

/**
 * @typedef {Object} Waiter
 * @property {() => any | Promise<any>} fn
 * @property {(value: any) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {boolean} cancelled
 */

/**
 * @typedef {Object} KeyState
 * @property {boolean} running
 * @property {Array<Waiter>} queue
 */

/**
 * Create an in-process lock primitive.
 *
 * @param {{ maxKeys?: number }} [options]
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
 *
 * @example
 * ```js
 * // Bounded wait: throw if we don't acquire within 5s.
 * try {
 *   await locks.withLock('user:42', work, { maxWaitMs: 5000 });
 * } catch (err) {
 *   if (err.code === 'LOCK_TIMEOUT') return new Response('busy', { status: 503 });
 *   throw err;
 * }
 * ```
 */
export function createLock(options = {}) {
	const maxKeys = options.maxKeys ?? 1_000_000;
	const maxKeyLength = options.maxKeyLength ?? 256;
	const maxWaitersPerKey = options.maxWaitersPerKey ?? 1000;
	if (!Number.isInteger(maxKeys) || maxKeys < 1) {
		throw new Error('lock: maxKeys must be a positive integer');
	}
	if (!Number.isInteger(maxKeyLength) || maxKeyLength < 1) {
		throw new Error('lock: maxKeyLength must be a positive integer');
	}
	if (!Number.isInteger(maxWaitersPerKey) || maxWaitersPerKey < 1) {
		throw new Error('lock: maxWaitersPerKey must be a positive integer');
	}

	/** @type {Map<string, KeyState>} */
	const states = new Map();

	/**
	 * Run `fn` as the currently-acquired holder for `key`. When `fn`
	 * settles, advance the queue. Used both for the initial acquirer
	 * (called directly from `withLock`) and for waiters being promoted
	 * to head by `advance`.
	 *
	 * @template T
	 * @param {string} key
	 * @param {KeyState} state
	 * @param {() => T | Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async function runHead(key, state, fn) {
		try {
			return await fn();
		} finally {
			advance(key, state);
		}
	}

	/**
	 * Promote the next non-cancelled waiter to head, or release the key
	 * entirely if the queue has drained. Called from the `finally` of
	 * `runHead`.
	 *
	 * @param {string} key
	 * @param {KeyState} state
	 */
	function advance(key, state) {
		while (state.queue.length > 0) {
			const waiter = /** @type {Waiter} */ (state.queue.shift());
			if (waiter.cancelled) continue;
			if (waiter.timer != null) {
				clearTimeout(waiter.timer);
				waiter.timer = null;
			}
			// Promote: run waiter as the new head, plumb its result back
			// into the original caller's promise. We deliberately do not
			// `await` here - returning lets the previous head's `finally`
			// unwind cleanly.
			runHead(key, state, waiter.fn).then(waiter.resolve, waiter.reject);
			return;
		}
		// Queue drained. Release the key from the registry.
		state.running = false;
		states.delete(key);
	}

	/**
	 * @template T
	 * @param {string} key
	 * @param {() => T | Promise<T>} fn
	 * @param {WithLockOptions} [opts]
	 * @returns {Promise<T>}
	 */
	function withLock(key, fn, opts) {
		if (typeof key !== 'string' || key.length === 0) {
			return Promise.reject(new Error('lock: key must be a non-empty string'));
		}
		if (key.length > maxKeyLength) {
			return Promise.reject(new Error(
				'lock: key length ' + key.length +
				' exceeds maxKeyLength ' + maxKeyLength
			));
		}
		if (typeof fn !== 'function') {
			return Promise.reject(new Error('lock: fn must be a function'));
		}
		const maxWaitMs = opts?.maxWaitMs;
		if (maxWaitMs != null) {
			if (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
				return Promise.reject(new Error(
					'lock: maxWaitMs must be a non-negative finite number'
				));
			}
		}

		let state = states.get(key);
		if (!state) {
			// New key. Cap check before allocating state.
			if (states.size >= maxKeys) {
				return Promise.reject(new Error(
					'lock: active key count exceeded ' + maxKeys
				));
			}
			state = { running: false, queue: [] };
			states.set(key, state);
		}

		if (!state.running) {
			// Acquire immediately - no waiters, no holder.
			state.running = true;
			return runHead(key, state, fn);
		}

		// Cap the waiter queue per key. A flood of contenders on a single
		// hot key (e.g. every authenticated client racing for `lock-${roomId}`
		// at once) would otherwise grow the queue without bound; the cap
		// protects memory and turns the failure mode from "OOM" into a
		// typed rejection the caller can shed.
		if (state.queue.length >= maxWaitersPerKey) {
			const err = /** @type {Error & { code: string, key: string, maxWaitersPerKey: number }} */ (
				new Error(
					'lock: waiter queue for key \'' + key + '\' exceeded ' +
					maxWaitersPerKey
				)
			);
			err.code = 'LOCK_QUEUE_FULL';
			err.key = key;
			err.maxWaitersPerKey = maxWaitersPerKey;
			return Promise.reject(err);
		}

		// Queue up. The caller's promise resolves / rejects when their
		// `fn` later runs as head, OR when their timeout fires first.
		return new Promise((resolve, reject) => {
			/** @type {Waiter} */
			const waiter = { fn, resolve, reject, timer: null, cancelled: false };
			if (maxWaitMs != null) {
				waiter.timer = setTimeout(() => {
					if (waiter.cancelled) return;
					waiter.cancelled = true;
					waiter.timer = null;
					const err = /** @type {Error & { code: string, key: string, maxWaitMs: number }} */ (
						new Error(
							'lock: timed out after ' + maxWaitMs +
							'ms waiting for key \'' + key + '\''
						)
					);
					err.code = 'LOCK_TIMEOUT';
					err.key = key;
					err.maxWaitMs = maxWaitMs;
					reject(err);
				}, maxWaitMs);
			}
			state.queue.push(waiter);
		});
	}

	return {
		withLock,
		held(key) {
			return states.has(key);
		},
		size() {
			return states.size;
		},
		clear() {
			// Reject all pending waiters with a typed error and drop the
			// registry. The waiter-queue holds the only references to the
			// caller-facing promises, so without a rejection here the
			// callers would hang forever. Currently-running `fn` calls are
			// untouched and finish normally; their `finally` -> advance()
			// will see an empty / removed state and no-op.
			for (const state of states.values()) {
				for (const waiter of state.queue) {
					if (waiter.cancelled) continue;
					waiter.cancelled = true;
					if (waiter.timer != null) {
						clearTimeout(waiter.timer);
						waiter.timer = null;
					}
					const err = /** @type {Error & { code: string }} */ (
						new Error('lock: cleared')
					);
					err.code = 'LOCK_CLEARED';
					waiter.reject(err);
				}
			}
			states.clear();
		}
	};
}
