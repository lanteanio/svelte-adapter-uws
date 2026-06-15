/**
 * Queue plugin for svelte-adapter-uws.
 *
 * Per-key async task queue with configurable concurrency and
 * backpressure. With concurrency=1 (default), tasks are processed
 * strictly in order per key. With concurrency > 1, dequeue order
 * is preserved but completion order is not guaranteed.
 *
 * Zero impact on the adapter core - this is a standalone utility.
 *
 * @module svelte-adapter-uws/plugins/queue
 */

/**
 * @typedef {Object} QueueOptions
 * @property {number} [concurrency=1] - Maximum concurrent tasks per key. Must be a positive integer.
 * @property {number} [maxSize=1_000_000] - Maximum waiting (not-yet-started) tasks per key.
 *   When exceeded, `push()` rejects and `onDrop` is called (if provided). Pass
 *   `Infinity` to disable the cap (not recommended at uWS scale).
 * @property {number} [maxKeyLength=256] - Reject keys longer than this many
 *   characters at `push()` entry. Defaults to 256, which is generous for typical
 *   queue-key shapes (`user:${userId}`, `inbox:${roomId}`). Caps prevent an
 *   oversized key from anchoring a large internal string in the per-key queue map.
 * @property {(dropped: { key: string, task: Function }) => void} [onDrop] -
 *   Called when a task is rejected due to `maxSize`. Useful for logging or metrics.
 */

/**
 * @typedef {Object} Queue
 * @property {<T>(key: string, task: () => T | Promise<T>) => Promise<T>} push -
 *   Enqueue an async task. Returns a promise that resolves with the task's return
 *   value when it completes, or rejects if the task throws or the queue is full.
 * @property {(key?: string) => number} size -
 *   Number of tasks (waiting + running) for a key, or total across all keys.
 * @property {(key?: string) => void} clear -
 *   Cancel all waiting tasks for a key (or all keys). Running tasks continue.
 *   Waiting tasks' promises are rejected with "queue cleared".
 * @property {(key?: string) => Promise<void>} drain -
 *   Returns a promise that resolves when all tasks for a key (or all keys) complete.
 */

/**
 * Create a per-key task queue.
 *
 * @param {QueueOptions} [options]
 * @returns {Queue}
 *
 * @example
 * ```js
 * // src/lib/server/queue.js
 * import { createQueue } from 'svelte-adapter-uws/plugins/queue';
 *
 * export const queue = createQueue({ concurrency: 1 });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js
 * import { queue } from '$lib/server/queue';
 *
 * export async function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   await queue.push(msg.topic, async () => {
 *     await db.update(msg.data);
 *     platform.publish(msg.topic, 'updated', msg.data);
 *   });
 * }
 * ```
 */
export function createQueue(options = {}) {
	const concurrency = options.concurrency ?? 1;
	const maxSize = options.maxSize ?? 1_000_000;
	const maxKeyLength = options.maxKeyLength ?? 256;
	const onDrop = options.onDrop ?? null;

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error('queue: concurrency must be a positive integer');
	}
	if (typeof maxSize !== 'number' || (!Number.isFinite(maxSize) && maxSize !== Infinity) || maxSize < 1) {
		throw new Error('queue: maxSize must be a positive number or Infinity');
	}
	if (!Number.isInteger(maxKeyLength) || maxKeyLength < 1) {
		throw new Error('queue: maxKeyLength must be a positive integer');
	}
	if (onDrop != null && typeof onDrop !== 'function') {
		throw new Error('queue: onDrop must be a function');
	}

	/**
	 * Per-key queue state.
	 * @type {Map<string, { items: Array<{ task: Function, resolve: Function, reject: Function }>, running: number, drains: Function[] }>}
	 */
	const queues = new Map();

	function getQueue(key) {
		let q = queues.get(key);
		if (!q) {
			q = { items: [], running: 0, drains: [] };
			queues.set(key, q);
		}
		return q;
	}

	function process(key) {
		const q = queues.get(key);
		if (!q) return;

		while (q.running < concurrency && q.items.length > 0) {
			const { task, resolve, reject } = q.items.shift();
			q.running++;

			Promise.resolve()
				.then(() => task())
				.then(
					(val) => {
						q.running--;
						resolve(val);
						process(key);
						cleanup(key);
					},
					(err) => {
						q.running--;
						reject(err);
						process(key);
						cleanup(key);
					}
				);
		}
	}

	function cleanup(key) {
		const q = queues.get(key);
		if (q && q.running === 0 && q.items.length === 0) {
			const drains = q.drains;
			queues.delete(key);
			for (const resolve of drains) resolve();
		}
	}

	return {
		push(key, task) {
			if (typeof key !== 'string') {
				return Promise.reject(new Error('queue: key must be a string'));
			}
			if (key.length > maxKeyLength) {
				return Promise.reject(new Error(
					'queue: key length ' + key.length +
					' exceeds maxKeyLength ' + maxKeyLength
				));
			}
			if (typeof task !== 'function') {
				return Promise.reject(new Error('queue: task must be a function'));
			}

			const q = getQueue(key);

			if (q.items.length >= maxSize) {
				if (onDrop) onDrop({ key, task });
				return Promise.reject(new Error(`queue "${key}": maxSize exceeded`));
			}

			return new Promise((resolve, reject) => {
				q.items.push({ task, resolve, reject });
				process(key);
			});
		},

		size(key) {
			if (key != null) {
				const q = queues.get(key);
				return q ? q.items.length + q.running : 0;
			}
			let total = 0;
			for (const [, q] of queues) {
				total += q.items.length + q.running;
			}
			return total;
		},

		clear(key) {
			if (key != null) {
				const q = queues.get(key);
				if (q) {
					for (const item of q.items) {
						item.reject(new Error('queue cleared'));
					}
					q.items.length = 0;
					cleanup(key);
				}
				return;
			}
			for (const [k, q] of queues) {
				for (const item of q.items) {
					item.reject(new Error('queue cleared'));
				}
				q.items.length = 0;
				cleanup(k);
			}
		},

		drain(key) {
			if (key != null) {
				const q = queues.get(key);
				if (!q || (q.items.length === 0 && q.running === 0)) {
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					q.drains.push(resolve);
				});
			}
			// Drain all keys
			const promises = [];
			for (const [k] of queues) {
				promises.push(this.drain(k));
			}
			if (promises.length === 0) return Promise.resolve();
			return Promise.all(promises).then(() => {});
		}
	};
}
