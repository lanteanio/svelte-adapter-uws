/**
 * Client-side prediction with server-authoritative reconciliation.
 *
 * The invariant, enforced everywhere here: predictions are suggestions; the
 * server's output is truth. The local entity responds to input on the same
 * frame it happens by applying the developer's `apply(state, command, ctx)`
 * immediately, while every applied command waits in a sliding window of
 * un-acknowledged commands. When the server acknowledges command N with its
 * authoritative state, the window drops everything up to N, rebases on the
 * server's state, and REPLAYS the surviving tail through the same `apply` -
 * so the prediction is always "server truth plus exactly the commands the
 * server has not seen yet".
 *
 * With a correctly written `apply` the replayed prediction equals the old
 * one and nothing is visible. When they differ, the divergence is measured
 * by `computeError` and the correction is handled by perceptibility:
 *
 *   - divergence at or below `errorThreshold` snaps silently - a correction
 *     too small to see needs no easing, and easing it would smear precision;
 *   - divergence above the threshold keeps the RENDERED position continuous
 *     by recording the visual error as an offset that decays to zero over
 *     `smoothTimeMs`. The simulation state itself snaps to the corrected
 *     value immediately - only the pixels lag the correction, the next
 *     replay never builds on a lie.
 *
 * Replay re-runs commands many times, so `apply` must be pure with respect
 * to one-shot effects: `ctx.firstTime` is true only on a command's initial
 * application and false on every replay - guard sounds and other one-shot
 * side effects on it. `ctx.rng` is reseeded from the command id before every
 * application, so randomness drawn inside `apply` survives reconciliation
 * (see ./random.js).
 *
 * The window is bounded by count and by age. Exceeding either bound means
 * the server has effectively gone silent: prediction is KILLED rather than
 * allowed to run away - the window clears, the entity renders the last
 * authoritative state, and `overflowed` reads true so the owner can resync
 * (a full-state sync plus the next acknowledgement re-engage prediction).
 * Acknowledgements are idempotent: anything at or below the last applied
 * ack is ignored, so a replayed or stale ack can never double-apply.
 *
 * Command ids are monotonic for the lifetime of the predictor and survive
 * `reset()` - a reconnect rebases state but never reuses an id, so a late
 * acknowledgement from the previous stream can never be confused for one
 * from the current stream.
 *
 * Pure: no clocks, no timers, no imports beyond the sibling random module.
 * Every time reading is a caller-supplied monotonic-milliseconds argument.
 *
 * @module svelte-adapter-uws/plugins/smooth/predict
 */

import { createSharedRandom } from './random.js';

/**
 * Positional divergence: the Euclidean distance between two states' `x`/`y`.
 * States without finite numeric coordinates report zero divergence, so a
 * non-positional state snaps silently unless the caller supplies its own
 * `computeError`.
 * @param {any} a @param {any} b
 * @returns {number}
 */
function positionalError(a, b) {
	if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return 0;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const d = Math.sqrt(dx * dx + dy * dy);
	return Number.isFinite(d) ? d : 0;
}

/**
 * @param {{
 *   apply: (state: any, command: any, ctx: { firstTime: boolean, rng: any }) => any,
 *   initial: any,
 *   computeError?: (before: any, after: any) => number,
 *   errorThreshold?: number,
 *   smoothTimeMs?: number,
 *   windowCap?: number,
 *   windowMaxAgeMs?: number
 * }} options resolved options - validation belongs to the caller's public
 *   surface. `apply` must treat its inputs as immutable and return the next
 *   state (returning the same reference means "unchanged").
 */
export function createPredictor(options) {
	const apply = options.apply;
	const computeError = options.computeError === undefined ? positionalError : options.computeError;
	const errorThreshold = options.errorThreshold === undefined ? 1 : options.errorThreshold;
	const smoothTimeMs = options.smoothTimeMs === undefined ? 100 : options.smoothTimeMs;
	const windowCap = options.windowCap === undefined ? 256 : options.windowCap;
	const windowMaxAgeMs = options.windowMaxAgeMs === undefined ? 3000 : options.windowMaxAgeMs;

	/** Last server-acknowledged authoritative state - the replay base. */
	let base = options.initial;
	/** Base plus the un-acked window replayed on top - what the owner renders. */
	let predicted = options.initial;
	let lastAckedId = 0;
	let nextId = 1;
	let overflowed = false;

	/** @type {Array<{ id: number, cmd: any, sentMono: number }>} */
	let pending = [];
	let head = 0;

	// The decaying visual error offset (positional). The rendered position is
	// `predicted` plus this offset scaled by the remaining decay fraction.
	let errX = 0;
	let errY = 0;
	let errAtMono = -1;

	const rng = createSharedRandom();
	const ctx = { firstTime: true, rng };

	function runApply(state, entry, firstTime) {
		ctx.firstTime = firstTime;
		rng.reseed(entry.id);
		return apply(state, entry.cmd, ctx);
	}

	/** The remaining decay fraction at `monoNow`, clearing the offset at zero. */
	function decayFraction(monoNow) {
		if (errAtMono < 0) return 0;
		if (smoothTimeMs <= 0) {
			errAtMono = -1;
			return 0;
		}
		const f = 1 - (monoNow - errAtMono) / smoothTimeMs;
		if (f <= 0) {
			errAtMono = -1;
			errX = 0;
			errY = 0;
			return 0;
		}
		return f;
	}

	function killPrediction() {
		pending = [];
		head = 0;
		predicted = base;
		errX = 0;
		errY = 0;
		errAtMono = -1;
		overflowed = true;
	}

	function compactWindow() {
		if (head > 32 && head * 2 >= pending.length) {
			pending.splice(0, head);
			head = 0;
		}
	}

	return {
		/**
		 * Submit one command: assigns the next id, predicts it immediately
		 * (unless prediction is killed), and records it in the un-acked
		 * window. The caller transmits the command under the returned id.
		 * @param {any} cmd
		 * @param {number} monoNow client monotonic ms
		 * @returns {number} the command id
		 */
		command(cmd, monoNow) {
			const id = nextId++;
			if (overflowed) return id;
			if (
				pending.length - head >= windowCap ||
				(pending.length > head && monoNow - pending[head].sentMono > windowMaxAgeMs)
			) {
				killPrediction();
				return id;
			}
			const entry = { id, cmd, sentMono: monoNow };
			pending.push(entry);
			predicted = runApply(predicted, entry, true);
			return id;
		},

		/**
		 * Apply a server acknowledgement: authoritative state for everything
		 * through `ackedId`. Drops the confirmed window prefix, rebases, and
		 * replays the surviving tail. Idempotent - an ack at or below the
		 * last applied one returns null and changes nothing.
		 * @param {number} ackedId
		 * @param {any} state the authoritative state at `ackedId`
		 * @param {number} monoNow client monotonic ms
		 * @returns {{ divergence: number, sentMono: number | undefined } | null}
		 *   `sentMono` is the acknowledged command's send time when it was
		 *   still in the window - the caller's round-trip clock sample.
		 */
		ack(ackedId, state, monoNow) {
			// Reject ids outside this predictor's own issued space: an id this
			// predictor never issued cannot acknowledge its commands. A fresh
			// view on a live connection can otherwise inherit a foreign or
			// stale watermark (a previous view's surviving server-side entity)
			// and ignore every acknowledgement of its own stream.
			if (typeof ackedId !== 'number' || ackedId <= lastAckedId || ackedId >= nextId) return null;
			lastAckedId = ackedId;
			base = state;

			if (overflowed) {
				// Recovery: the window was dropped when prediction was killed,
				// so the authoritative state is all there is. Snap to it - a
				// multi-second-stale position is a discontinuity, not an error
				// to ease - and re-engage prediction for the next command.
				predicted = state;
				overflowed = false;
				return { divergence: 0, sentMono: undefined };
			}

			let sentMono;
			while (head < pending.length && pending[head].id <= ackedId) {
				if (pending[head].id === ackedId) sentMono = pending[head].sentMono;
				head++;
			}
			compactWindow();

			const before = predicted;
			let next = state;
			for (let i = head; i < pending.length; i++) {
				next = runApply(next, pending[i], false);
			}
			predicted = next;

			const divergence = computeError(before, next);
			if (divergence > errorThreshold && smoothTimeMs > 0) {
				// Keep the RENDERED position continuous: the new offset spans
				// from the previously rendered point (old prediction plus any
				// still-decaying offset) to the corrected prediction. The
				// offset is positional by contract - a custom computeError may
				// flag divergence on a state without coordinates (or a null
				// state), and that correction snaps instead.
				const f = decayFraction(monoNow);
				if (
					before !== null && typeof before === 'object' && typeof before.x === 'number' &&
					next !== null && typeof next === 'object' && typeof next.x === 'number'
				) {
					errX = before.x + errX * f - next.x;
					errY = before.y + errY * f - next.y;
					errAtMono = monoNow;
				}
			}
			return { divergence, sentMono };
		},

		/**
		 * Full-state rebase from a sync reply (reconnect, recovery): drops
		 * the window, adopts the server's state and ack watermark, clears
		 * any correction, and re-engages prediction. The watermark is clamped
		 * into this predictor's own issued id space - a server-side entity
		 * that outlived a previous view reports that view's watermark, which
		 * must never block this stream's acknowledgements.
		 * @param {any} state @param {number} ackedId
		 */
		sync(state, ackedId) {
			base = state;
			predicted = state;
			const watermark = typeof ackedId === 'number' && ackedId >= 0 ? ackedId : 0;
			lastAckedId = Math.min(watermark, nextId - 1);
			pending = [];
			head = 0;
			errX = 0;
			errY = 0;
			errAtMono = -1;
			overflowed = false;
		},

		/**
		 * Adopt an authoritative state outside the acknowledgement stream
		 * (server-side motion between commands, an echoed own-entity frame).
		 * Applies only while NO command awaits acknowledgement - with
		 * commands in flight the acknowledgement is the reconciliation
		 * carrier and an interleaved state would rebase onto the wrong
		 * point in the timeline.
		 * @param {any} state
		 * @returns {boolean} true when adopted
		 */
		rebase(state) {
			if (pending.length > head) return false;
			base = state;
			predicted = state;
			return true;
		},

		/**
		 * Age check for a quiet window: a caller's frame loop invokes this so
		 * a server that stopped acknowledging kills prediction even when no
		 * new command arrives to trigger the bound.
		 * @param {number} monoNow
		 * @returns {boolean} true when prediction is (now) killed
		 */
		checkOverflow(monoNow) {
			if (!overflowed && pending.length > head && monoNow - pending[head].sentMono > windowMaxAgeMs) {
				killPrediction();
			}
			return overflowed;
		},

		/**
		 * Resolve the rendered position into `out` (caller-owned scratch):
		 * the predicted coordinates plus the decaying correction offset.
		 * @param {{ x: number, y: number }} out
		 * @param {number} monoNow
		 * @returns {boolean} true while a correction is still decaying (the
		 *   caller's render loop must keep painting)
		 */
		renderInto(out, monoNow) {
			const f = decayFraction(monoNow);
			const p = predicted;
			if (p !== null && typeof p === 'object' && typeof p.x === 'number') {
				out.x = p.x + errX * f;
				out.y = p.y + errY * f;
			} else {
				out.x = NaN;
				out.y = NaN;
			}
			return errAtMono >= 0;
		},

		/** The current prediction (simulation truth, no visual offset). */
		get predicted() {
			return predicted;
		},

		/** The last authoritative state the server confirmed. */
		get base() {
			return base;
		},

		/** Number of commands awaiting acknowledgement. */
		get windowSize() {
			return pending.length - head;
		},

		get lastAckedId() {
			return lastAckedId;
		},

		/** True while prediction is killed pending recovery. */
		get overflowed() {
			return overflowed;
		},

		/**
		 * Forget state and window but never ids: a reconnect rebases through
		 * `sync()`, and ids stay unique across the predictor's lifetime.
		 * @param {any} [initial] replacement state; defaults to the
		 *   construction-time initial
		 */
		reset(initial) {
			base = initial === undefined ? options.initial : initial;
			predicted = base;
			lastAckedId = 0;
			pending = [];
			head = 0;
			errX = 0;
			errY = 0;
			errAtMono = -1;
			overflowed = false;
		}
	};
}
