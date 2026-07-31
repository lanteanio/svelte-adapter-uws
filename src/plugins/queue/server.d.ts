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
	 * Maximum number of keys with live work. A key is live from its first
	 * accepted `push()` until it has no waiting and no running task, so
	 * draining a key frees its slot. When exceeded, a `push()` for a key
	 * that is not live rejects with `QUEUE_TOO_MANY_KEYS`; pushes to
	 * already-live keys are unaffected. Pass `Infinity` to disable the cap
	 * (not recommended at uWS scale).
	 * @default 1_000_000
	 */
	maxKeys?: number;

	/**
	 * Maximum waiting tasks summed across all keys. `maxSize` bounds one
	 * key; without this, N keys each below `maxSize` still add up to
	 * N x maxSize waiting tasks. When exceeded, `push()` rejects with
	 * `QUEUE_BACKLOG_FULL` regardless of how much room the selected key
	 * still has. Pass `Infinity` to disable the cap (not recommended at
	 * uWS scale).
	 * @default 1_000_000
	 */
	maxPendingTotal?: number;

	/**
	 * Maximum tasks in flight at once summed across all keys.
	 * `concurrency` bounds one key; without this, N keys each below
	 * `concurrency` still start N x concurrency tasks at once. This is a
	 * scheduling bound, not an admission bound: work above it waits its
	 * turn (and is then subject to `maxPendingTotal`) rather than being
	 * rejected, and keys are then serviced round-robin so a saturated key
	 * cannot starve the others. Pass `Infinity` to disable the cap.
	 *
	 * The default is a ceiling, not a working limit: at 1_000_000 the
	 * gate never binds and in-flight work is unbounded in practice, as it
	 * was before this option existed. Pick a real number from
	 * `stats().runningPeak` if you want the queue to push back. It has to
	 * be your number, because a task that awaits work pushed later would
	 * deadlock under a low in-flight cap it never asked for.
	 * @default 1_000_000
	 */
	maxRunningTotal?: number;

	/**
	 * Reject keys longer than this many characters at `push()` entry.
	 * Generous for typical queue-key shapes (`user:${userId}`,
	 * `inbox:${roomId}`). The cap prevents an oversized key from
	 * anchoring a large internal string in the per-key queue map.
	 * @default 256
	 */
	maxKeyLength?: number;

	/**
	 * Called when a task is rejected because a bound was exceeded.
	 * `reason` names the option that tripped. Useful for logging or
	 * metrics.
	 *
	 * A throw from here is contained and counted as
	 * `stats().onDropErrorsTotal`: a metrics sink cannot change the shed
	 * decision, and cannot turn `push()`'s rejection into a synchronous
	 * throw that a caller's `.catch()` would miss.
	 */
	onDrop?: (dropped: {
		key: string;
		task: () => any;
		reason: 'maxSize' | 'maxKeys' | 'maxPendingTotal';
	}) => void;
}

/**
 * Snapshot of queue occupancy and lifetime totals.
 */
export interface QueueStats {
	/** Keys with live work right now. */
	keysCurrent: number;
	/** Waiting (not-yet-started) tasks across all keys. */
	pendingCurrent: number;
	/** Tasks in flight across all keys. */
	runningCurrent: number;
	/**
	 * Keys holding a place in the service line, waiting for a running slot
	 * under `maxRunningTotal`. Never exceeds `keysCurrent`.
	 */
	readyCurrent: number;
	/** Highest `keysCurrent` ever observed. */
	keysPeak: number;
	/** Highest `pendingCurrent` ever observed. */
	pendingPeak: number;
	/** Highest `runningCurrent` ever observed. */
	runningPeak: number;
	/** Tasks accepted by `push()` since creation. */
	pushedTotal: number;
	/** Tasks that ran and resolved. */
	completedTotal: number;
	/** Tasks that ran and threw or rejected. */
	failedTotal: number;
	/** Waiting tasks cancelled by `clear()`. */
	clearedTotal: number;
	/**
	 * `onDrop` calls that threw. The throw is contained, so this is the
	 * only trace a broken metrics sink leaves.
	 */
	onDropErrorsTotal: number;
	/** Tasks rejected at `push()`, counted per bound that tripped. */
	dropped: {
		maxSize: number;
		maxKeys: number;
		maxPendingTotal: number;
	};
}

/**
 * Reason a queue rejection was raised, carried on `err.code`.
 *
 * - `QUEUE_FULL` - the key's waiting list is at `maxSize`.
 * - `QUEUE_TOO_MANY_KEYS` - the key is new and `maxKeys` keys are live.
 * - `QUEUE_BACKLOG_FULL` - waiting tasks across all keys are at `maxPendingTotal`.
 * - `QUEUE_CLEARED` - the task was cancelled by `clear()` before it ran.
 */
export type QueueErrorCode =
	| 'QUEUE_FULL'
	| 'QUEUE_TOO_MANY_KEYS'
	| 'QUEUE_BACKLOG_FULL'
	| 'QUEUE_CLEARED';

/**
 * Error raised when a bound sheds a task or `clear()` cancels it. The bound
 * that tripped is attached under its own option name, so a handler can log
 * the actual ceiling without parsing the message.
 */
export interface QueueError extends Error {
	code: QueueErrorCode;
	key: string;
	maxSize?: number;
	maxKeys?: number;
	maxPendingTotal?: number;
}

export interface Queue {
	/**
	 * Enqueue an async task under a key. Returns a promise that resolves
	 * with the task's return value when it completes.
	 *
	 * Tasks with the same key are dequeued in order. With `concurrency: 1`
	 * (default), this means strictly sequential execution. With higher
	 * concurrency, start order is preserved but completion order is not.
	 * Tasks with different keys execute independently, up to
	 * `maxRunningTotal` in flight at once.
	 *
	 * Rejects with a `QueueError` when a bound sheds the task.
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

	/**
	 * Snapshot of live gauges and cumulative totals. Always available,
	 * near-zero cost. Peaks show how close the queue came to its bounds,
	 * which is what tells you whether to raise one.
	 */
	stats(): QueueStats;
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
 *
 * @example
 * ```js
 * // Bound the whole queue, not just one key.
 * const queue = createQueue({
 *   concurrency: 4,
 *   maxKeys: 10_000,
 *   maxPendingTotal: 50_000,
 *   maxRunningTotal: 64
 * });
 * ```
 */
export function createQueue(options?: QueueOptions): Queue;
