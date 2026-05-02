export interface QueueOptions {
	/**
	 * Maximum concurrent tasks per key.
	 * @default 1
	 */
	concurrency?: number;

	/**
	 * Maximum waiting (not-yet-started) tasks per key.
	 * When exceeded, `push()` rejects and `onDrop` is called. Pass
	 * `Infinity` to disable the cap (not recommended at uWS scale).
	 * @default 1_000_000
	 */
	maxSize?: number;

	/**
	 * Called when a task is rejected due to `maxSize`.
	 * Useful for logging or metrics.
	 */
	onDrop?: (dropped: { key: string; task: () => any }) => void;
}

export interface Queue {
	/**
	 * Enqueue an async task under a key. Returns a promise that resolves
	 * with the task's return value when it completes.
	 *
	 * Tasks with the same key are dequeued in order. With `concurrency: 1`
	 * (default), this means strictly sequential execution. With higher
	 * concurrency, start order is preserved but completion order is not.
	 * Tasks with different keys execute independently.
	 *
	 * @example
	 * ```js
	 * const result = await queue.push('user:123', async () => {
	 *   return await db.update({ ... });
	 * });
	 * ```
	 */
	push<T>(key: string, task: () => T | Promise<T>): Promise<T>;

	/**
	 * Number of tasks (waiting + running) for a key,
	 * or total across all keys if no key is provided.
	 */
	size(key?: string): number;

	/**
	 * Cancel all waiting tasks for a key (or all keys).
	 * Running tasks continue to completion.
	 * Waiting tasks' promises are rejected with "queue cleared".
	 */
	clear(key?: string): void;

	/**
	 * Returns a promise that resolves when all tasks for a key
	 * (or all keys) have completed.
	 */
	drain(key?: string): Promise<void>;
}

/**
 * Create a per-key async task queue with configurable concurrency.
 *
 * @example
 * ```js
 * import { createQueue } from 'svelte-adapter-uws/plugins/queue';
 *
 * const queue = createQueue({ concurrency: 1, maxSize: 100 });
 *
 * // Sequential processing per topic
 * await queue.push('chat', async () => {
 *   await db.insert(message);
 * });
 * ```
 */
export function createQueue(options?: QueueOptions): Queue;
