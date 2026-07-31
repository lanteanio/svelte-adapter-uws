/**
 * Queue plugin for svelte-adapter-uws.
 *
 * Per-key async task queue with configurable concurrency and
 * backpressure. With concurrency=1 (default), tasks are processed
 * strictly in order per key. With concurrency > 1, dequeue order
 * is preserved but completion order is not guaranteed.
 *
 * Every bound has an aggregate counterpart, because a per-key bound
 * alone does not bound the queue: N distinct keys each below `maxSize`
 * still add up to N x maxSize waiting tasks, and N keys each below
 * `concurrency` still start N x concurrency tasks at once. `maxKeys`
 * caps how many keys are live, `maxPendingTotal` caps the waiting tasks
 * summed across all keys, and `maxRunningTotal` caps how many tasks are
 * in flight at once.
 *
 * Keys with waiting work are serviced round-robin, one task per visit,
 * so a saturated key cannot starve the others once `maxRunningTotal`
 * binds. A key holds at most one place in that service line at a time,
 * and loses it the moment it stops having startable work - including
 * when `clear()` empties it - so the line is bounded by the number of
 * live keys and cannot outlive the keys it names.
 *
 * The three aggregate bounds default to 1_000_000, far above any real
 * load: they are ceilings that stop a runaway, not working limits, and
 * at the defaults the queue behaves exactly as it did before they
 * existed. A deployment that wants the queue to push back sets its own
 * numbers. `maxRunningTotal` in particular has to be chosen rather than
 * assumed - a task that awaits work pushed later would deadlock under a
 * low in-flight cap the caller never asked for - so `stats()` reports
 * the peaks that tell you where to set it.
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
 * @property {number} [maxKeys=1_000_000] - Maximum number of keys with live work.
 *   A key is live from its first accepted `push()` until it has no waiting and no
 *   running task, so draining a key frees its slot. When exceeded, a `push()` for a
 *   key that is not live rejects; pushes to already-live keys are unaffected. Pass
 *   `Infinity` to disable the cap (not recommended at uWS scale).
 * @property {number} [maxPendingTotal=1_000_000] - Maximum waiting tasks summed
 *   across all keys. When exceeded, `push()` rejects regardless of how much room
 *   the selected key still has under `maxSize`. Pass `Infinity` to disable the cap
 *   (not recommended at uWS scale).
 * @property {number} [maxRunningTotal=1_000_000] - Maximum tasks in flight at once
 *   summed across all keys. This is a scheduling bound, not an admission bound:
 *   work above it waits its turn (and is then subject to `maxPendingTotal`) rather
 *   than being rejected. Pass `Infinity` to disable the cap.
 * @property {number} [maxKeyLength=256] - Reject keys longer than this many
 *   characters at `push()` entry. Defaults to 256, which is generous for typical
 *   queue-key shapes (`user:${userId}`, `inbox:${roomId}`). Caps prevent an
 *   oversized key from anchoring a large internal string in the per-key queue map.
 * @property {(dropped: { key: string, task: Function, reason: 'maxSize' | 'maxKeys' | 'maxPendingTotal' }) => void} [onDrop] -
 *   Called when a task is rejected because a bound was exceeded. `reason` names the
 *   option that tripped. Useful for logging or metrics. A throw from here is
 *   contained and counted as `onDropErrorsTotal`: a metrics sink cannot change the
 *   shed decision, and cannot turn `push()`'s rejection into a synchronous throw.
 */

/**
 * @typedef {Object} QueueStats
 * @property {number} keysCurrent - Keys with live work right now.
 * @property {number} pendingCurrent - Waiting (not-yet-started) tasks across all keys.
 * @property {number} runningCurrent - Tasks in flight across all keys.
 * @property {number} readyCurrent - Keys holding a place in the service line,
 *   waiting for a running slot. Never exceeds `keysCurrent`.
 * @property {number} keysPeak - Highest `keysCurrent` ever observed.
 * @property {number} pendingPeak - Highest `pendingCurrent` ever observed.
 * @property {number} runningPeak - Highest `runningCurrent` ever observed.
 * @property {number} pushedTotal - Tasks accepted by `push()` since creation.
 * @property {number} completedTotal - Tasks that ran and resolved.
 * @property {number} failedTotal - Tasks that ran and threw or rejected.
 * @property {number} clearedTotal - Waiting tasks cancelled by `clear()`.
 * @property {number} onDropErrorsTotal - `onDrop` calls that threw. The throw is
 *   contained, so this is the only trace a broken metrics sink leaves.
 * @property {{ maxSize: number, maxKeys: number, maxPendingTotal: number }} dropped -
 *   Tasks rejected at `push()`, counted per bound that tripped.
 */

/**
 * @typedef {Object} Queue
 * @property {<T>(key: string, task: () => T | Promise<T>) => Promise<T>} push -
 *   Enqueue an async task. Returns a promise that resolves with the task's return
 *   value when it completes, or rejects if the task throws or a bound is exceeded.
 * @property {(key?: string) => number} size -
 *   Number of tasks (waiting + running) for a key, or total across all keys.
 * @property {(key?: string) => void} clear -
 *   Cancel all waiting tasks for a key (or all keys). Running tasks continue.
 *   Waiting tasks' promises are rejected with "queue cleared".
 * @property {(key?: string) => Promise<void>} drain -
 *   Returns a promise that resolves when all tasks for a key (or all keys) complete.
 * @property {() => QueueStats} stats -
 *   Snapshot of live gauges and cumulative totals. Always available, near-zero cost.
 */

/**
 * @typedef {Object} WaitingTask
 * @property {Function} task
 * @property {Function} resolve
 * @property {Function} reject
 * @property {WaitingTask | null} next - Link field. The waiting list threads
 *   itself through the tasks instead of wrapping each one in a node, so a
 *   queued task costs a single object.
 */

/**
 * @typedef {Object} Fifo
 * @property {WaitingTask | null} head
 * @property {WaitingTask | null} tail
 * @property {number} size
 */

/**
 * @typedef {Object} LineNode
 * @property {string} key
 * @property {LineNode | null} prev
 * @property {LineNode | null} next
 */

/**
 * @typedef {Object} Line
 * @property {LineNode | null} head
 * @property {LineNode | null} tail
 * @property {number} size
 */

// - Internal: FIFO ---------------------------------------------------------
//
// Singly linked rather than an array, because `Array#shift` is O(n) in the
// backlog length and the backlog is longest exactly when the queue is
// saturated - the state where the scheduler runs most often. This one holds
// the per-key waiting tasks; the service line below is a separate structure
// because it needs removal from the middle.

/** @returns {Fifo} */
function fifoCreate() {
	return { head: null, tail: null, size: 0 };
}

/**
 * @param {Fifo} fifo
 * @param {WaitingTask} node
 */
function fifoPush(fifo, node) {
	node.next = null;
	if (fifo.tail) fifo.tail.next = node;
	else fifo.head = node;
	fifo.tail = node;
	fifo.size++;
}

/**
 * @param {Fifo} fifo
 * @returns {WaitingTask | undefined} The oldest task, or undefined when empty.
 */
function fifoShift(fifo) {
	const node = fifo.head;
	if (!node) return undefined;
	fifo.head = node.next;
	if (!fifo.head) fifo.tail = null;
	fifo.size--;
	// Unlink so a caller holding the returned task cannot pin the rest of
	// the drained chain.
	node.next = null;
	return node;
}

// - Internal: service line -------------------------------------------------
//
// Doubly linked, and each queue holds the node that names it, so a key can be
// taken out of the line in O(1) from anywhere. A singly linked line can only
// drop its head, which leaves an entry behind for every key that stops being
// startable while the running budget is saturated - and the scheduler, the
// only other consumer, cannot reach those entries precisely because the budget
// is what is blocking it. That is unbounded growth in the structure whose job
// is to bound.

/** @returns {Line} */
function lineCreate() {
	return { head: null, tail: null, size: 0 };
}

/**
 * @param {Line} line
 * @param {string} key
 * @returns {LineNode} The node to hand back to `lineRemove`.
 */
function lineAppend(line, key) {
	/** @type {LineNode} */
	const node = { key, prev: line.tail, next: null };
	if (line.tail) line.tail.next = node;
	else line.head = node;
	line.tail = node;
	line.size++;
	return node;
}

/**
 * @param {Line} line
 * @param {LineNode} node - Must currently be linked into `line`.
 */
function lineRemove(line, node) {
	if (node.prev) node.prev.next = node.next;
	else line.head = node.next;
	if (node.next) node.next.prev = node.prev;
	else line.tail = node.prev;
	node.prev = null;
	node.next = null;
	line.size--;
}

/**
 * @param {string} name
 * @param {any} value
 */
function assertCap(name, value) {
	if (typeof value !== 'number' || (!Number.isFinite(value) && value !== Infinity) || value < 1) {
		throw new Error('queue: ' + name + ' must be a positive number or Infinity');
	}
}

/**
 * Build a typed overload error. Callers match on `err.code` to decide whether
 * to retry, shed, or answer 503; the bound that tripped is attached under its
 * own option name so a handler can log the actual ceiling without parsing the
 * message.
 *
 * @param {string} code
 * @param {string} key
 * @param {string} bound - The option name that tripped.
 * @param {number} limit
 */
function overloadError(code, key, bound, limit) {
	const err = /** @type {Error & { code: string, key: string, [k: string]: any }} */ (
		new Error('queue "' + key + '": ' + bound + ' exceeded (limit ' + limit + ')')
	);
	err.code = code;
	err.key = key;
	err[bound] = limit;
	return err;
}

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
 *
 * @example
 * ```js
 * // Shed instead of buffering when the whole queue is over capacity.
 * try {
 *   await queue.push('inbox:' + roomId, work);
 * } catch (err) {
 *   if (err.code === 'QUEUE_BACKLOG_FULL') return new Response('busy', { status: 503 });
 *   throw err;
 * }
 * ```
 */
export function createQueue(options = {}) {
	const concurrency = options.concurrency ?? 1;
	const maxSize = options.maxSize ?? 1_000_000;
	const maxKeys = options.maxKeys ?? 1_000_000;
	const maxPendingTotal = options.maxPendingTotal ?? 1_000_000;
	const maxRunningTotal = options.maxRunningTotal ?? 1_000_000;
	const maxKeyLength = options.maxKeyLength ?? 256;
	const onDrop = options.onDrop ?? null;

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error('queue: concurrency must be a positive integer');
	}
	assertCap('maxSize', maxSize);
	assertCap('maxKeys', maxKeys);
	assertCap('maxPendingTotal', maxPendingTotal);
	assertCap('maxRunningTotal', maxRunningTotal);
	if (!Number.isInteger(maxKeyLength) || maxKeyLength < 1) {
		throw new Error('queue: maxKeyLength must be a positive integer');
	}
	if (onDrop != null && typeof onDrop !== 'function') {
		throw new Error('queue: onDrop must be a function');
	}

	/**
	 * Per-key queue state. `lineNode` is the key's place in the service line,
	 * or null when it holds none: it both stops a key taking a second place
	 * and is the handle that gives the place back.
	 * @type {Map<string, { items: Fifo, running: number, drains: Function[], lineNode: LineNode | null }>}
	 */
	const queues = new Map();

	/**
	 * Keys with startable work, oldest first. Every node in here names a key
	 * that is live in `queues` and still has startable work, because every
	 * transition out of that state gives the key's place back.
	 * @type {Line}
	 */
	const serviceLine = lineCreate();

	let pendingCurrent = 0;
	let runningCurrent = 0;
	let keysPeak = 0;
	let pendingPeak = 0;
	let runningPeak = 0;
	let pushedTotal = 0;
	let completedTotal = 0;
	let failedTotal = 0;
	let clearedTotal = 0;
	let onDropErrorsTotal = 0;
	const dropped = { maxSize: 0, maxKeys: 0, maxPendingTotal: 0 };

	/**
	 * Put a key in line for its next turn, unless it is already in line or
	 * has nothing startable.
	 *
	 * @param {string} key
	 * @param {{ items: Fifo, running: number, lineNode: LineNode | null }} q
	 */
	function markReady(key, q) {
		if (q.lineNode || q.items.size === 0 || q.running >= concurrency) return;
		q.lineNode = lineAppend(serviceLine, key);
	}

	/**
	 * Give a key's place back. Called wherever a key stops having startable
	 * work by a route other than the scheduler starting it: without this,
	 * `clear()` on a key waiting behind a saturated `maxRunningTotal` leaves
	 * its place in the line forever, since `pump()` cannot reach it and the
	 * key itself is about to be deleted.
	 *
	 * @param {{ lineNode: LineNode | null }} q
	 */
	function unmarkReady(q) {
		if (!q.lineNode) return;
		lineRemove(serviceLine, q.lineNode);
		q.lineNode = null;
	}

	/**
	 * Give the queue a chance to start work after `key` gained a task or
	 * finished one.
	 *
	 * The first branch is the common case, and it is a shortcut rather than a
	 * second policy: with nobody in line the scheduler would put this key in
	 * and take it straight back out, so the visit is skipped and no node is
	 * allocated. Fairness is untouched because an empty line means no other
	 * key is owed a turn. Whatever the shortcut does not cover falls through
	 * to the scheduler below.
	 *
	 * @param {string} key
	 * @param {{ items: Fifo, running: number, drains: Function[], lineNode: LineNode | null }} q
	 */
	function schedule(key, q) {
		if (
			!serviceLine.head && q.items.size > 0 &&
			q.running < concurrency && runningCurrent < maxRunningTotal
		) {
			start(key, q);
		}
		markReady(key, q);
		pump();
	}

	/**
	 * Start as many tasks as the global bound allows, taking one task per
	 * key per visit and sending the key to the back of the line afterwards.
	 * Round-robin rather than draining a key on the spot is what keeps one
	 * busy key from holding the whole budget once `maxRunningTotal` binds.
	 */
	function pump() {
		while (runningCurrent < maxRunningTotal && serviceLine.head) {
			const node = serviceLine.head;
			const key = node.key;
			lineRemove(serviceLine, node);
			const q = queues.get(key);
			if (!q) continue;
			q.lineNode = null;
			if (q.items.size === 0 || q.running >= concurrency) continue;
			start(key, q);
			markReady(key, q);
		}
	}

	/**
	 * @param {string} key
	 * @param {{ items: Fifo, running: number, drains: Function[], lineNode: LineNode | null }} q
	 */
	function start(key, q) {
		const { task, resolve, reject } = fifoShift(q.items);
		pendingCurrent--;
		q.running++;
		runningCurrent++;
		if (runningCurrent > runningPeak) runningPeak = runningCurrent;

		Promise.resolve()
			.then(() => task())
			.then(
				(val) => {
					q.running--;
					runningCurrent--;
					completedTotal++;
					resolve(val);
					schedule(key, q);
					cleanup(key);
				},
				(err) => {
					q.running--;
					runningCurrent--;
					failedTotal++;
					reject(err);
					schedule(key, q);
					cleanup(key);
				}
			);
	}

	function cleanup(key) {
		const q = queues.get(key);
		if (q && q.running === 0 && q.items.size === 0) {
			const drains = q.drains;
			// A place in the line must never outlive the map entry that names
			// it, so hand it back before the entry goes.
			unmarkReady(q);
			queues.delete(key);
			for (const resolve of drains) resolve();
		}
	}

	/**
	 * @param {string} key
	 * @param {{ items: Fifo, lineNode: LineNode | null }} q
	 */
	function rejectWaiting(key, q) {
		// Nothing is left to start once the waiting tasks are gone, so the key
		// gives its place up whether or not it still has a task running (a key
		// with a running task survives `cleanup`).
		unmarkReady(q);
		while (q.items.size > 0) {
			const item = fifoShift(q.items);
			pendingCurrent--;
			clearedTotal++;
			const err = /** @type {Error & { code: string, key: string }} */ (
				new Error('queue cleared')
			);
			err.code = 'QUEUE_CLEARED';
			err.key = key;
			item.reject(err);
		}
	}

	/**
	 * @param {string} key
	 * @param {Function} task
	 * @param {string} code
	 * @param {'maxSize' | 'maxKeys' | 'maxPendingTotal'} reason
	 * @param {number} limit
	 */
	function shed(key, task, code, reason, limit) {
		dropped[reason]++;
		if (onDrop) {
			// The sink is told about the decision, it does not take part in it.
			// A throw here used to escape `push()` synchronously, which broke
			// the documented `Promise` return: a caller's `.catch()` never saw
			// it. Contain it and count it instead.
			try {
				onDrop({ key, task, reason });
			} catch {
				onDropErrorsTotal++;
			}
		}
		return Promise.reject(overloadError(code, key, reason, limit));
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

			// Every bound is checked before any state is allocated, so a shed
			// push cannot leave an empty key behind - which would itself be a
			// slow leak of the very cardinality `maxKeys` exists to bound.
			let q = queues.get(key);
			if (q && q.items.size >= maxSize) {
				return shed(key, task, 'QUEUE_FULL', 'maxSize', maxSize);
			}
			if (!q && queues.size >= maxKeys) {
				return shed(key, task, 'QUEUE_TOO_MANY_KEYS', 'maxKeys', maxKeys);
			}
			if (pendingCurrent >= maxPendingTotal) {
				return shed(key, task, 'QUEUE_BACKLOG_FULL', 'maxPendingTotal', maxPendingTotal);
			}

			if (!q) {
				q = { items: fifoCreate(), running: 0, drains: [], lineNode: null };
				queues.set(key, q);
				if (queues.size > keysPeak) keysPeak = queues.size;
			}

			return new Promise((resolve, reject) => {
				fifoPush(q.items, { task, resolve, reject, next: null });
				pendingCurrent++;
				if (pendingCurrent > pendingPeak) pendingPeak = pendingCurrent;
				pushedTotal++;
				schedule(key, q);
			});
		},

		size(key) {
			if (key != null) {
				const q = queues.get(key);
				return q ? q.items.size + q.running : 0;
			}
			return pendingCurrent + runningCurrent;
		},

		clear(key) {
			if (key != null) {
				const q = queues.get(key);
				if (q) {
					rejectWaiting(key, q);
					cleanup(key);
				}
				return;
			}
			for (const [k, q] of queues) {
				rejectWaiting(k, q);
				cleanup(k);
			}
		},

		drain(key) {
			if (key != null) {
				const q = queues.get(key);
				if (!q || (q.items.size === 0 && q.running === 0)) {
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
		},

		stats() {
			return {
				keysCurrent: queues.size,
				pendingCurrent,
				runningCurrent,
				readyCurrent: serviceLine.size,
				keysPeak,
				pendingPeak,
				runningPeak,
				pushedTotal,
				completedTotal,
				failedTotal,
				clearedTotal,
				onDropErrorsTotal,
				dropped: { ...dropped }
			};
		}
	};
}
