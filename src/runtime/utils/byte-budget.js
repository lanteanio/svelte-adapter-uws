/**
 * Bytes of control frames one connection may be sent per window.
 *
 * Derived from the worst legitimate burst rather than picked. A reconnecting
 * client resubscribes in batches of at most 256 topics, and 256 acks at the
 * ack's own size is roughly 15 KB; a client restoring 5,000 topics sends twenty
 * such batches for roughly 300 KB. This sits about 270 times above the first and
 * about 13 times above the second, while the measured amplifier reaches it from
 * about 34 KB/s of sustained inbound - a rate no real client produces on the
 * control lane, where traffic is bursty at reconnect and quiet after.
 *
 * Here rather than beside the sender because all three socket surfaces need it:
 * the production handler, the published test server and the dev plugin each own
 * their own plumbing, and two spellings of one ceiling is how the surfaces drift.
 */
export const MAX_CONTROL_EGRESS_BYTES = 4 * 1024 * 1024;

/** Window over which the budget above is measured. */
export const CONTROL_EGRESS_WINDOW_MS = 10_000;

/**
 * Close code for a connection cut for exhausting its control-frame budget.
 *
 * 4429, NOT 1008. The bundled client classes 4429 as THROTTLE and reconnects on
 * an accelerated curve, while 1008 is in its terminal set and stops it
 * reconnecting for good. This budget is a ceiling a large enough client could
 * conceivably reach, so cutting the connection must not permanently kill the
 * page.
 */
export const CONTROL_FLOOD_CLOSE_CODE = 4429;

/**
 * What one control frame costs against the budget: its size on the wire.
 *
 * The frames are JSON text, and text frames leave as UTF-8, so a topic echoed
 * back in a denial costs up to three bytes per character that `length` counts
 * as one. Charging code units would let a connection on a runtime that admits
 * non-ASCII topics move up to three times the ceiling before it is cut. A UTF-8
 * measurement of a frame of a few dozen bytes is not a cost anyone can see, and
 * it keeps "bytes" in the ceiling's name true.
 *
 * @param {string} payload
 * @returns {number}
 */
export function controlFrameBytes(payload) {
	return Buffer.byteLength(payload, 'utf8');
}

/**
 * A byte allowance over a rolling window, as one closure.
 *
 * Deliberately not the keyed accountant in `utils/egress-account.js`: that one
 * exists to bound publish egress across many keys at once, with eviction and a
 * bounded map behind it. This bounds ONE subject, holds two numbers, and is
 * created per connection - a Map keyed by connection would be the same data
 * with a lookup in front of it.
 *
 * The window is a fixed period rather than a sliding one. A sliding window
 * needs the timestamps of everything inside it; a fixed one needs the moment it
 * opened. The cost is that a caller can spend one full allowance at the end of
 * a window and another at the start of the next, so the true short-term ceiling
 * is twice the limit. That is the standard trade for a two-number budget, and
 * at the sizes this is used for it does not change what the limit refuses.
 *
 * @param {number} limit bytes allowed per window
 * @param {number} windowMs
 * @param {() => number} clock monotonic milliseconds
 * @returns {(bytes: number) => boolean} false once the window is exhausted
 */
export function createByteBudget(limit, windowMs, clock) {
	let startedAt = -Infinity;
	let used = 0;
	return (bytes) => {
		const now = clock();
		if (now - startedAt > windowMs) {
			startedAt = now;
			used = 0;
		}
		used += bytes;
		// Inclusive: spending exactly the allowance is within it. The charge is
		// recorded even when it is REFUSED, so a caller cannot walk the budget
		// past its limit by retrying with smaller frames.
		return used <= limit;
	};
}
