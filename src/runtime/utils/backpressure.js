import { setTimer, clearTimer } from '../runtime.js';

/**
 * Write a chunk to a uWS HttpResponse inside a cork and, if backpressure
 * builds, return a Promise that resolves when the socket drains or the
 * timeout elapses. Returns `true` synchronously when no drain is needed.
 *
 * All uWS response mutations (write + onWritable registration) happen
 * inside the cork callback, which uWS invokes synchronously, so the
 * boolean return value of `res.write()` is captured correctly.
 *
 * @param {{ cork: (fn: () => void) => void, write: (value: any) => boolean, onWritable: (fn: () => boolean) => void }} res
 * @param {any} value
 * @param {number} [timeoutMs]
 * @returns {true | Promise<boolean>} true if the write succeeded without drain; otherwise a promise that resolves true on drain or false on timeout.
 */
export function writeChunkWithBackpressure(res, value, timeoutMs = 30000) {
	let ok = false;
	/** @type {Promise<boolean> | null} */
	let drainPromise = null;
	res.cork(() => {
		ok = res.write(value);
		if (!ok) {
			drainPromise = new Promise((resolve) => {
				const timer = setTimer(() => resolve(false), timeoutMs);
				res.onWritable(() => {
					clearTimer(timer);
					resolve(true);
					return true;
				});
			});
		}
	});
	return ok ? true : /** @type {Promise<boolean>} */ (drainPromise);
}

/**
 * Drain a coalesce-by-key buffer.
 *
 * Iterates entries in insertion order and calls `send` for each. Entries
 * whose send result is SUCCESS (0) are removed from the map. The function
 * stops on the first BACKPRESSURE (1) or DROPPED (2) result, leaving the
 * remaining entries (and the one that just hit pressure, in the DROPPED
 * case) for a later flush.
 *
 * Pure: no I/O of its own, no timers, no globals. The caller supplies
 * `send`, which is the only side-effecting boundary, so this is unit-
 * testable with a mock send fn.
 *
 * Map insertion order is preserved across overwrites: setting an existing
 * key replaces the value but keeps the original slot. Latest value wins,
 * order is stable.
 *
 * @template T
 * @param {Map<string, T>} pending
 * @param {(value: T) => number} send  0 SUCCESS, 1 BACKPRESSURE, 2 DROPPED
 */
export function drainCoalesced(pending, send) {
	for (const [key, value] of pending) {
		const result = send(value);
		if (result === 2) return;
		pending.delete(key);
		if (result === 1) return;
	}
}

/**
 * Collapse events that share a `coalesceKey` so only the latest value
 * survives in the batch. Events without a `coalesceKey` pass through
 * unchanged. The latest occurrence's position is preserved (so the
 * order of non-collapsed events is stable, and the surviving entry
 * appears at the position the latest value arrived in).
 *
 * Use case: high-frequency `publishBatched` calls carrying many
 * cursor / presence / price-tick events, where intermediate values are
 * noise. Tagging each with a `coalesceKey` (e.g. `'cursor:' + userId`)
 * lets a single batch deliver only the latest position per user even
 * if the caller submitted hundreds.
 *
 * Pure helper: returns the input array untouched (same reference) when
 * no event carries a `coalesceKey`, so the common no-coalesce path
 * pays only one linear scan.
 *
 * @template {{ coalesceKey?: string }} T
 * @param {T[]} messages
 * @returns {T[]}
 */
export function collapseByCoalesceKey(messages) {
	let hasCoalesce = false;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].coalesceKey !== undefined) { hasCoalesce = true; break; }
	}
	if (!hasCoalesce) return messages;
	/** @type {Map<string, number>} */
	const lastByKey = new Map();
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key !== undefined) lastByKey.set(key, i);
	}
	const out = [];
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key === undefined || lastByKey.get(key) === i) {
			out.push(messages[i]);
		}
	}
	return out;
}
