/**
 * Render-in-the-past interpolation for remote entities.
 *
 * Each remote entity keeps a fixed-size ring of `(t, x, y)` samples on the
 * server time axis. A render frame computes one render time - the estimated
 * server "now" minus an interpolation delay - and asks each ring for the
 * position at that instant:
 *
 *   - When two samples straddle the render time, the position is the linear
 *     interpolation between them, found by a backward scan from the newest
 *     sample (one or two steps in the steady state).
 *   - When the buffer has run dry (consecutive missed frames), the position
 *     extrapolates along the last observed velocity, but only up to a hard
 *     cap - past it the entity rests where extrapolation left it rather than
 *     flying off on a stale heading.
 *   - When the straddling pair spans more than `snapGapMs`, the gap is a
 *     discontinuity (the entity left the subscriber's view, an idle pause, a
 *     genuine teleport) and the position snaps to the newer sample instead of
 *     smearing across the screen for the length of the gap.
 *
 * Rendering remote entities slightly in the past is what makes a dropped or
 * late frame invisible: with the delay at two update intervals there is
 * almost always a real pair of samples around the render time. The cost is
 * stated once and plainly: remote entities are drawn `delay` milliseconds
 * behind their newest known position. The `'auto'` delay tracks the measured
 * stamp interval and collapses toward the floor when updates arrive at
 * display rate, so a fast LAN pays almost nothing.
 *
 * The hot path is allocation-free: rings are typed arrays allocated once per
 * entity, sampling writes into a caller-owned scratch point, and the per-key
 * Map is the only dynamic structure (entries appear on first sight of a key
 * and leave on remove/expiry/compaction).
 *
 * Pure: no clocks, no timers, no imports beyond the sibling clock module.
 * Callers pass every time reading in, so worker, main-thread fallback, and a
 * deterministic simulation harness run identical code.
 *
 * @module svelte-adapter-uws/plugins/smooth/interpolate
 */

import { createServerClock } from './clock.js';

/** Ring capacity per entity. At a 16ms stamp interval this holds ~500ms of
 * history - the maximum interpolation delay plus the extrapolation cap with
 * margin. Fixed so a ring is two cache-friendly typed arrays, never grown. */
const RING_CAP = 32;

/** No samples for this key: the caller renders the raw merged position. */
export const SAMPLE_EMPTY = 0;
/** The sampled output is still changing frame-over-frame: keep rendering. */
export const SAMPLE_ACTIVE = 1;
/** The sampled output is at rest until new data arrives. */
export const SAMPLE_SETTLED = 2;

/** One entity's position history on the server time axis. */
export class SampleRing {
	constructor() {
		this.t = new Float64Array(RING_CAP);
		this.x = new Float64Array(RING_CAP);
		this.y = new Float64Array(RING_CAP);
		this.head = 0;
		this.len = 0;
	}

	/**
	 * Append a sample, clamping its time non-decreasing against the newest
	 * entry (an NTP step or an estimator correction must not break the
	 * backward scan's ordering invariant). Overwrites oldest-first at capacity.
	 * @param {number} t @param {number} x @param {number} y
	 */
	push(t, x, y) {
		if (this.len > 0) {
			const newest = this.t[(this.head + this.len - 1) % RING_CAP];
			if (t < newest) t = newest;
		}
		if (this.len === RING_CAP) {
			this.head = (this.head + 1) % RING_CAP;
			this.len--;
		}
		const i = (this.head + this.len) % RING_CAP;
		this.t[i] = t;
		this.x[i] = x;
		this.y[i] = y;
		this.len++;
	}

	/**
	 * Resolve the position at `renderTime` into `out` (a caller-owned
	 * `{ x, y }` scratch). Returns one of the SAMPLE_* statuses.
	 * @param {number} renderTime
	 * @param {{ x: number, y: number }} out
	 * @param {number} extrapolateMs hard cap on dead-reckoning past the newest sample
	 * @param {number} snapGapMs sample gap treated as a discontinuity
	 * @returns {number}
	 */
	sampleInto(renderTime, out, extrapolateMs, snapGapMs) {
		const len = this.len;
		if (len === 0) return SAMPLE_EMPTY;
		const head = this.head;
		const ni = (head + len - 1) % RING_CAP;
		const tn = this.t[ni];

		if (renderTime >= tn) {
			// Past the newest sample: extrapolate along the last observed
			// velocity up to the cap, then rest where extrapolation stopped.
			let vx = 0;
			let vy = 0;
			if (len >= 2) {
				const pi = (head + len - 2) % RING_CAP;
				const span = tn - this.t[pi];
				if (span > 0 && span <= snapGapMs) {
					vx = (this.x[ni] - this.x[pi]) / span;
					vy = (this.y[ni] - this.y[pi]) / span;
				}
			}
			const over = renderTime - tn;
			const dt = over > extrapolateMs ? extrapolateMs : over;
			out.x = this.x[ni] + vx * dt;
			out.y = this.y[ni] + vy * dt;
			const moving = (vx !== 0 || vy !== 0) && over < extrapolateMs;
			return moving ? SAMPLE_ACTIVE : SAMPLE_SETTLED;
		}

		const oi = head;
		if (renderTime <= this.t[oi]) {
			// The whole buffer is ahead of the render time (a fresh ring whose
			// delay has not elapsed yet): hold the oldest sample; motion begins
			// as the render time advances into the buffer.
			out.x = this.x[oi];
			out.y = this.y[oi];
			return SAMPLE_ACTIVE;
		}

		// Straddle search: backward from the newest for the pair around the
		// render time. Steady state terminates in one or two steps.
		let lower = oi;
		let upper = ni;
		for (let k = len - 2; k >= 0; k--) {
			const i = (head + k) % RING_CAP;
			if (this.t[i] <= renderTime) {
				lower = i;
				upper = (head + k + 1) % RING_CAP;
				break;
			}
		}
		const tl = this.t[lower];
		const span = this.t[upper] - tl;
		if (span > snapGapMs) {
			// Discontinuity: snap to the newer side rather than smearing the
			// entity across the gap (view re-entry, idle resume, teleport).
			out.x = this.x[upper];
			out.y = this.y[upper];
			return SAMPLE_ACTIVE;
		}
		const f = span > 0 ? (renderTime - tl) / span : 1;
		out.x = this.x[lower] + (this.x[upper] - this.x[lower]) * f;
		out.y = this.y[lower] + (this.y[upper] - this.y[lower]) * f;
		return SAMPLE_ACTIVE;
	}
}

/**
 * The per-topic smoothing controller: sample rings keyed by entity, the
 * server-clock estimator, the measured stamp interval, and the slewed
 * interpolation delay. One instance per rendering pipeline (one in the
 * worker, or one on the main-thread fallback).
 *
 * @param {{ delayMs: 'auto' | number, extrapolateMs: number, snapGapMs: number }} options
 *   resolved knobs - validation belongs to the caller's public surface.
 */
export function createSmoother(options) {
	const delayOpt = options.delayMs;
	const extrapolateMs = options.extrapolateMs;
	const snapGapMs = options.snapGapMs;

	const clock = createServerClock();
	/** @type {Map<string, SampleRing>} */
	const rings = new Map();

	// Measured server stamp interval (ms), seeded at a 50ms guess. Drives the
	// 'auto' delay; meaningless (and unused) when frames carry no stamps.
	let ewmaIntervalMs = 50;
	let lastStampT = -1;
	// The delay actually applied, slewed toward the target so the render time
	// axis never jumps when the measured interval shifts.
	let appliedDelay = -1;
	let lastFrameMono = -1;
	let motion = false;

	function targetDelay() {
		if (delayOpt !== 'auto') return delayOpt;
		const d = 2 * ewmaIntervalMs;
		return d < 32 ? 32 : d > 250 ? 250 : d;
	}

	/**
	 * Resolve the server-axis timestamp for an inbound position event and
	 * feed the clock/interval estimators from it.
	 * @param {any} event @param {number} recvMono
	 * @returns {number}
	 */
	function stampOf(event, recvMono) {
		const t = event.t;
		if (typeof t === 'number' && Number.isFinite(t)) {
			clock.sample(t, recvMono);
			if (lastStampT >= 0) {
				const d = t - lastStampT;
				if (d > 0 && d < 2000) ewmaIntervalMs += 0.08 * (d - ewmaIntervalMs);
			}
			if (t > lastStampT) lastStampT = t;
			return t;
		}
		// Unstamped frame (older server, JSON-only deployment): place it on
		// the same axis at its estimated server arrival time, degrading to the
		// raw monotonic arrival axis when no stamp has ever been seen.
		const est = clock.estServerNow(recvMono);
		return est === null ? recvMono : est;
	}

	function writeRing(key, data, t) {
		if (typeof key !== 'string' || data === null || typeof data !== 'object') return;
		const x = data.x;
		const y = data.y;
		if (typeof x !== 'number' || typeof y !== 'number') return;
		let ring = rings.get(key);
		if (ring === undefined) {
			ring = new SampleRing();
			rings.set(key, ring);
		}
		ring.push(t, x, y);
	}

	return {
		/**
		 * Feed one decoded cursor-shaped topic event. Position events append
		 * ring samples; `remove` drops the ring; a `time` event is a clock
		 * sample (or, with `sendMono` from the requester, a round-trip seed).
		 * @param {{ event: string, data: any, t?: number } | null} event
		 * @param {number} recvMono client monotonic ms at receipt
		 * @param {number} [sendMono] monotonic send time of the request that
		 *   provoked this reply, when the caller made it and knows it
		 */
		ingest(event, recvMono, sendMono) {
			if (event === null || typeof event !== 'object') return;
			const name = event.event;
			if (name === 'update') {
				if (event.data == null) return;
				writeRing(event.data.key, event.data.data, stampOf(event, recvMono));
				return;
			}
			if (name === 'bulk') {
				const arr = event.data;
				if (!Array.isArray(arr) || arr.length === 0) return;
				const t = stampOf(event, recvMono);
				for (let i = 0; i < arr.length; i++) {
					const e = arr[i];
					if (e) writeRing(e.key, e.data, t);
				}
				return;
			}
			if (name === 'remove') {
				if (event.data != null && typeof event.data.key === 'string') rings.delete(event.data.key);
				return;
			}
			if (name === 'time') {
				const t = event.data != null ? event.data.t : undefined;
				if (typeof t !== 'number' || !Number.isFinite(t)) return;
				if (typeof sendMono === 'number') clock.seed(t, sendMono, recvMono);
				else clock.sample(t, recvMono);
			}
		},

		/**
		 * Start a render frame: advance the delay slew and return the render
		 * time on the server axis. Resets the frame's motion accumulator.
		 * @param {number} monoNow
		 * @returns {number}
		 */
		beginFrame(monoNow) {
			const target = targetDelay();
			if (appliedDelay < 0) {
				appliedDelay = target;
			} else {
				const dt = lastFrameMono >= 0 ? monoNow - lastFrameMono : 0;
				const limit = dt > 0 ? dt * 0.03 : 0;
				const diff = target - appliedDelay;
				appliedDelay += diff > limit ? limit : diff < -limit ? -limit : diff;
			}
			lastFrameMono = monoNow;
			motion = false;
			const est = clock.estServerNow(monoNow);
			return (est === null ? monoNow : est) - appliedDelay;
		},

		/**
		 * Resolve one entity's position at the frame's render time into `out`.
		 * Accumulates the frame's motion-pending flag.
		 * @param {string} key @param {number} renderTime
		 * @param {{ x: number, y: number }} out
		 * @returns {number} a SAMPLE_* status
		 */
		sampleInto(key, renderTime, out) {
			const ring = rings.get(key);
			if (ring === undefined) return SAMPLE_EMPTY;
			const s = ring.sampleInto(renderTime, out, extrapolateMs, snapGapMs);
			if (s === SAMPLE_ACTIVE) motion = true;
			return s;
		},

		/**
		 * True when the last frame's sampling left un-played motion (buffered
		 * samples ahead of the render time, or live extrapolation): the render
		 * loop must keep painting even with no new wire data.
		 */
		get motionPending() {
			return motion;
		},

		/** Number of entities currently holding history. */
		get size() {
			return rings.size;
		},

		/** The applied interpolation delay (ms) - diagnostics. */
		get delay() {
			return appliedDelay < 0 ? targetDelay() : appliedDelay;
		},

		/** The clock estimator - shared with command stamping. */
		clock,

		/**
		 * Drop rings whose key is absent from the live key set (expiry swept
		 * them out of the merged state without a remove event). Called at a
		 * low cadence by the owner, not per frame.
		 * @param {Map<string, any>} liveKeys
		 */
		compact(liveKeys) {
			for (const key of rings.keys()) {
				if (!liveKeys.has(key)) rings.delete(key);
			}
		},

		/** Forget all history and the clock (pause, reconnect, topic switch). */
		reset() {
			rings.clear();
			clock.reset();
			ewmaIntervalMs = 50;
			lastStampT = -1;
			appliedDelay = -1;
			lastFrameMono = -1;
			motion = false;
		}
	};
}
