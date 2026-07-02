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
 * The prediction advances one command per simulation tick, but displays
 * refresh faster than tick rate - a 120Hz panel over a 60Hz simulation
 * would render every predicted position twice, and that stair-step reads
 * as a velocity-proportional smear when the eye tracks the moving entity.
 * `renderInto` therefore sweeps each tick's motion across the measured
 * command cadence: at a command's application the rendered position stays
 * where the previous sweep had it and glides to the new prediction over
 * (slightly more than) one command interval, so a faster display samples
 * forward motion on every frame. The sweep engages only on a tick-like
 * cadence (gaps up to 100ms); sporadic commands snap exactly as before.
 * The window over-estimates the cadence by a quarter so a late command
 * lands while the previous sweep is still in flight - the remainder folds
 * into the next sweep and the motion never stalls or overshoots.
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

	// The render sweep (positional): the motion the latest command applied,
	// swept across the measured command cadence so a display refreshing
	// faster than the tick rate samples forward motion on every frame. The
	// rendered position is `predicted` minus the un-swept remainder of this
	// delta (plus the error offset above - the two are orthogonal and the
	// reconciliation continuity proof holds with the sweep term unchanged
	// across an ack). Armed only while commands arrive at a tick-like
	// cadence; cleared by anything that moves `predicted` outside the
	// command stream.
	let sweepDX = 0;
	let sweepDY = 0;
	let sweepAtMono = -1;
	let sweepMs = 0;
	let lastApplyMono = -1;
	let gapEma = -1;
	// A gap beyond this is not a tick cadence - the move snaps, as it always
	// did for sporadic commanders.
	const MAX_SWEEP_GAP_MS = 100;
	// Same-instant catch-up commands (a slow frame paying its tick debt)
	// fold into the running sweep without polluting the cadence estimate.
	const BURST_GAP_MS = 1;

	/** The un-swept fraction of the last tick's motion at `monoNow`,
	 * clearing the sweep once it has fully landed. */
	function sweepRemainder(monoNow) {
		if (sweepAtMono < 0) return 0;
		const a = (monoNow - sweepAtMono) / sweepMs;
		if (a >= 1) {
			sweepAtMono = -1;
			sweepDX = 0;
			sweepDY = 0;
			return 0;
		}
		return a <= 0 ? 1 : 1 - a;
	}

	function clearSweep() {
		sweepDX = 0;
		sweepDY = 0;
		sweepAtMono = -1;
	}

	// The most recent reconciliation error magnitude (computeError on the last
	// acknowledging ack), surfaced for telemetry / devtools. 0 until the first
	// reconciling ack; reset on sync / reset.
	let lastDivergence = 0;

	const rng = createSharedRandom();
	const ctx = { firstTime: true, rng };

	// Discrete one-shot events emitted from `apply` via `ctx.emitEvent`. The
	// `firstTime` gate IS the replay-suppression: an event fires only on a
	// command's initial optimistic application, never on a reconciliation replay,
	// so the shooter sees one muzzle flash and the window reconciling underneath
	// never re-fires it. (The orthogonal half lives on the authority: its echo of
	// the owner's own event is author-excluded, so the owner never double-draws
	// from the broadcast either.) The default correlation key `<commandId>:<ordinal>`
	// is minted from the SAME command id and per-command emit ordinal the authority
	// uses, so the optimistic copy and the authoritative echo of one event share a
	// key with zero coordination (an explicit `opts.key` overrides it).
	let eventSink = [];
	let currentId = 0;
	let eventOrdinal = 0;
	ctx.emitEvent = (type, data, opts) => {
		if (!ctx.firstTime) return undefined;
		const key = opts && opts.key != null ? String(opts.key) : currentId + ':' + eventOrdinal;
		eventOrdinal++;
		eventSink.push({ type: String(type), key, data, id: currentId, opts: opts || null });
		return key;
	};

	function runApply(state, entry, firstTime) {
		ctx.firstTime = firstTime;
		currentId = entry.id;
		eventOrdinal = 0;
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
		clearSweep();
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
			// Capture where the sweep is rendering RIGHT NOW, before the
			// apply moves the prediction: the new sweep starts from this
			// point, so the rendered position is continuous across the
			// command boundary and any un-swept remainder folds forward.
			const prev = predicted;
			const prevPositional =
				prev !== null && typeof prev === 'object' && typeof prev.x === 'number';
			let fromX = 0;
			let fromY = 0;
			if (prevPositional) {
				const rem = sweepRemainder(monoNow);
				fromX = prev.x - sweepDX * rem;
				fromY = prev.y - sweepDY * rem;
			}
			const entry = { id, cmd, sentMono: monoNow };
			pending.push(entry);
			predicted = runApply(predicted, entry, true);
			const next = predicted;
			const gap = lastApplyMono >= 0 ? monoNow - lastApplyMono : -1;
			lastApplyMono = monoNow;
			if (
				prevPositional && gap >= 0 && gap <= MAX_SWEEP_GAP_MS &&
				next !== null && typeof next === 'object' && typeof next.x === 'number'
			) {
				if (gap >= BURST_GAP_MS) {
					gapEma = gapEma < 0 ? gap : gapEma + (gap - gapEma) * 0.2;
				}
				const dx = next.x - fromX;
				const dy = next.y - fromY;
				if (gapEma >= 0 && (dx !== 0 || dy !== 0)) {
					sweepDX = dx;
					sweepDY = dy;
					sweepAtMono = monoNow;
					sweepMs = Math.min(125, Math.max(1, gapEma * 1.25));
				} else {
					clearSweep();
				}
			} else {
				clearSweep();
				if (gap > MAX_SWEEP_GAP_MS) gapEma = -1;
			}
			return id;
		},

		/**
		 * Drain the discrete events `apply` emitted during the most recent
		 * `command()` (its optimistic, first-time application). The caller
		 * delivers them locally (`origin:'local'`) the same frame the command was
		 * issued. A reconciliation replay emits nothing (the `firstTime` gate), so
		 * this only ever carries a single command's optimistic events; it clears
		 * the queue so the next command starts empty.
		 * @returns {Array<{ type: string, key: string, data: any, id: number, opts: any }>}
		 */
		drainEvents() {
			if (eventSink.length === 0) return [];
			const out = eventSink;
			eventSink = [];
			return out;
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
				lastDivergence = 0;
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
			lastDivergence = divergence;
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
			clearSweep();
			lastApplyMono = -1;
			gapEma = -1;
			lastDivergence = 0;
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
			// An adoption outside the command stream moved the prediction
			// discontinuously; a sweep armed for the old motion would render
			// a phantom offset against the new basis.
			clearSweep();
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
		 * the predicted coordinates minus the un-swept remainder of the last
		 * tick's motion, plus the decaying correction offset.
		 * @param {{ x: number, y: number }} out
		 * @param {number} monoNow
		 * @returns {boolean} true while a sweep is in flight or a correction
		 *   is still decaying (the caller's render loop must keep painting)
		 */
		renderInto(out, monoNow) {
			const f = decayFraction(monoNow);
			const rem = sweepRemainder(monoNow);
			const p = predicted;
			if (p !== null && typeof p === 'object' && typeof p.x === 'number') {
				out.x = p.x - sweepDX * rem + errX * f;
				out.y = p.y - sweepDY * rem + errY * f;
			} else {
				out.x = NaN;
				out.y = NaN;
			}
			return errAtMono >= 0 || sweepAtMono >= 0;
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

		/** The un-acked command window cap; exceeding it kills prediction (telemetry). */
		get windowCap() {
			return windowCap;
		},

		/** The most recent reconciliation error magnitude (devtools / telemetry). */
		get lastDivergence() {
			return lastDivergence;
		},

		/** True while a reconciliation correction is still easing in (devtools / telemetry). */
		get correcting() {
			return errAtMono >= 0;
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
			clearSweep();
			lastApplyMono = -1;
			gapEma = -1;
			lastDivergence = 0;
			overflowed = false;
			eventSink = [];
		}
	};
}
