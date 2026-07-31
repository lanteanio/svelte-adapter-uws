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
 *     resumed delivery) and the position snaps to the newer sample instead of
 *     smearing across the screen for the length of the gap.
 *   - When the straddling pair covers ground the entity's own neighbouring
 *     samples come nowhere near, it is a discontinuity too: a teleport or a
 *     scripted placement delivered on the ordinary cadence has its samples one
 *     interval apart like any other pair, so the time test above cannot see
 *     it. The comparison is the entity's OWN adjacent motion rather than an
 *     absolute speed, because one interpolator serves a cursor in CSS pixels
 *     and a game entity in arbitrary world units, and because an entity the
 *     app has never moved has no absolute baseline at all while it always has
 *     neighbouring samples. A pair is a jump only when it leaves the pair
 *     behind it - and the sample ahead of it, once one has arrived - behind by
 *     `JUMP_FACTOR`, so uniform motion, acceleration, deceleration and an
 *     abrupt stop all keep interpolating: each of those keeps an adjacent pair
 *     moving at a comparable speed.
 *   - `snapSpeedPerSec` names an absolute bound on top of that, for a topic
 *     that knows its own scale and wants an exact ceiling; `snapSpeedPerSec:
 *     0` turns both tests off and restores pure interpolation everywhere.
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
 * margin. Fixed so a ring is a few cache-friendly typed arrays, never grown.
 * Must not exceed 32: the per-slot jump verdicts are one bit each in a single
 * 32-bit field. */
const RING_CAP = 32;

/** No samples for this key: the caller renders the raw merged position. */
export const SAMPLE_EMPTY = 0;
/** The sampled output is still changing frame-over-frame: keep rendering. */
export const SAMPLE_ACTIVE = 1;
/** The sampled output is at rest until new data arrives. */
export const SAMPLE_SETTLED = 2;

// Per-entity freshness, written into the sample scratch alongside x/y so the
// render layer can tell a live position from a coasted or frozen one. The
// magnitude is `over = renderTime - newestSampleTime`: at or behind the newest
// sample the position is real (LIVE); past it but within the extrapolation cap
// the position is dead-reckoned (COASTING); past the cap the entity is frozen
// where extrapolation left it, no fresh data covering this instant (STALE). The
// SAMPLE_* status drives the render loop's motion gate; freshness is orthogonal
// telemetry about data recency and never changes what is painted.
/** The rendered position is covered by real samples. */
export const FRESH_LIVE = 0;
/** The position is extrapolated past the newest sample, within the cap. */
export const FRESH_COASTING = 1;
/** Extrapolation is exhausted: the entity is frozen on stale data. */
export const FRESH_STALE = 2;

/**
 * How far a sample pair must outrun its immediate neighbours before it counts
 * as a discontinuity rather than travel. Dimensionless on purpose: the
 * comparison is the entity's own adjacent motion, so one factor serves a
 * cursor in CSS pixels and a game entity in arbitrary world units. Eight is
 * far outside what either produces between consecutive samples - a pointer
 * and a physical simulation are both continuous in velocity at the sample
 * cadence, and the widest honest step (a full stop, a dead start) reaches the
 * factor only against a neighbour that has already been left behind on the
 * other side - and far inside a placement, which moves an entity by a screen
 * in one interval.
 */
const JUMP_FACTOR = 8;

/** `JUMP_FACTOR` squared: the comparisons work on squared speeds so the frame
 * path never takes a square root. */
const JUMP_FACTOR_SQ = JUMP_FACTOR * JUMP_FACTOR;

/**
 * True when a displacement covers more ground than `perMs` allows over
 * `span`. `perMs <= 0` means no absolute bound was configured.
 * @param {number} dx @param {number} dy @param {number} span
 * @param {number} perMs bound in position units per millisecond
 */
function overSpeed(dx, dy, span, perMs) {
	if (!(perMs > 0)) return false;
	const lim = perMs * span;
	return dx * dx + dy * dy > lim * lim;
}

/**
 * The resolved sampling bounds. Built once per smoother and handed to every
 * ring by reference, so the frame path sees one hidden class and never packs
 * an argument list whose positional units (`snapGapMs` in milliseconds,
 * `snapSpeedPerMs` per millisecond, both next to each other) could be read
 * for one another.
 * @typedef {{
 *   extrapolateMs: number,
 *   snapGapMs: number,
 *   snapSpeedPerMs: number,
 *   autoSnap: boolean
 * }} SampleBounds
 */

/** One entity's position history on the server time axis. */
export class SampleRing {
	constructor() {
		this.t = new Float64Array(RING_CAP);
		this.x = new Float64Array(RING_CAP);
		this.y = new Float64Array(RING_CAP);
		// The whole jump verdict for the pair ENDING at each slot, resolved as
		// samples land rather than on every frame that straddles them: bit i is
		// set where that pair outruns the pair before it by `JUMP_FACTOR` and
		// the sample after it (once one arrives) did not sustain that speed. One
		// bit per slot, which is why `RING_CAP` is capped at the 32 a bitmask
		// holds - a fourth typed array would cost a cache line per entity per
		// frame, and this field sits beside `head` and `len`, already read.
		// Judging at push time is also what makes the oldest surviving pair
		// judgeable: its verdict was formed while the sample before it still
		// existed, and it stays valid after that sample is overwritten.
		this.spikes = 0;
		// Squared speed of the newest pair (position units per ms, squared), or
		// -1 when there is no usable one - the only history `push` needs to
		// judge the next pair, so no per-slot speed array exists to walk.
		this.lastV2 = -1;
		this.head = 0;
		this.len = 0;
		// Resume-ease overlay: a decaying positional offset added on top of the
		// sampled position so a reconnect resume slides from where the entity was
		// last drawn to the new authoritative basis instead of popping. `offAt`
		// is the render-time the offset was armed at (< 0 = inactive); it decays
		// to zero over `offMs`. `easePending` defers computing the offset until
		// the first post-resync sample renders the real new position (the caller
		// only knows the old position, not where the new basis lands this frame).
		this.offX = 0;
		this.offY = 0;
		this.offAt = -1;
		this.offMs = 0;
		this.easeFromX = 0;
		this.easeFromY = 0;
		this.easePending = false;
		// The fastest honest motion this entity showed before the rebuild that
		// armed the ease (position units per millisecond), captured by
		// `renderedSnapshot` while the old rings still existed. The ease slide
		// is measured against it: a resume that would move the entity faster
		// than it has ever moved is a placement, not a correction.
		this.easeMaxPerMs = 0;
		// The last rendered output (post-offset), so a resume can capture where
		// each entity was drawn before the rings are rebuilt.
		this.lastX = 0;
		this.lastY = 0;
		this.hasLast = false;
	}

	/**
	 * Append a sample, clamping its time non-decreasing against the newest
	 * entry (an NTP step or an estimator correction must not break the
	 * backward scan's ordering invariant). Overwrites oldest-first at capacity.
	 * @param {number} t @param {number} x @param {number} y
	 */
	push(t, x, y) {
		let prev = -1;
		if (this.len > 0) {
			prev = (this.head + this.len - 1) % RING_CAP;
			const newest = this.t[prev];
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
		let v2 = -1;
		if (prev >= 0) {
			const span = t - this.t[prev];
			if (span > 0) {
				const dx = x - this.x[prev];
				const dy = y - this.y[prev];
				v2 = (dx * dx + dy * dy) / (span * span);
			}
		}
		const back = this.lastV2;
		if (v2 >= 0 && back >= 0 && v2 > JUMP_FACTOR_SQ * back) this.spikes |= 1 << i;
		else this.spikes &= ~(1 << i);
		// The pair before this one now HAS a sample after it. A pair that was
		// flagged but whose successor moves just as fast was sustained motion -
		// a dead start, a hard acceleration - not a placement.
		if (prev >= 0 && v2 >= 0 && back <= JUMP_FACTOR_SQ * v2) this.spikes &= ~(1 << prev);
		this.lastV2 = v2;
		this.len++;
	}

	/**
	 * True when the pair at ring slots `(lo, hi)` is a discontinuity rather
	 * than travel - the positional half of the snap test, shared by the
	 * straddle and the extrapolation-velocity gate so the two can never
	 * disagree about what counts as a jump.
	 *
	 * The absolute bound decides first when the topic set one. Otherwise the
	 * verdict is the one that `push` recorded for this pair, measuring it
	 * against the samples on either side of it - it has to outrun both.
	 *
	 * The pair BEFORE it is required: the entity's motion up to the jump is the
	 * baseline, and the FIRST pair of a ring has none, so an entity that just
	 * appeared always interpolates. Without that rule a ring whose history
	 * begins with motion that then stops would read its own first move as a
	 * placement.
	 *
	 * The sample AFTER the pair is used when one has arrived, and is what keeps
	 * sustained motion intact: a dead start and a hard acceleration both look
	 * like a jump against the pair behind them, and are contradicted by the
	 * pair ahead moving just as fast. It cannot be required, because the
	 * placement this exists for is often the newest sample there is - a server
	 * that places a resting entity sends nothing more until it moves again.
	 *
	 * `lo` and `hi` are adjacent slots at both call sites, so the pair IS the
	 * one `push` already judged: with no absolute bound configured, ordinary
	 * motion costs one bit test here.
	 *
	 * @param {number} lo @param {number} hi adjacent ring slots of the pair
	 * @param {number} dx @param {number} dy the pair's displacement
	 * @param {number} span the pair's duration; callers pass a positive value
	 * @param {SampleBounds} bounds
	 */
	isJump(lo, hi, dx, dy, span, bounds) {
		if (overSpeed(dx, dy, span, bounds.snapSpeedPerMs)) return true;
		return bounds.autoSnap && (this.spikes & (1 << hi)) !== 0;
	}

	/**
	 * The fastest motion this ring's history actually shows, in position units
	 * per millisecond, skipping pairs that span more than `snapGapMs` (their
	 * implied speed is an artifact of the delivery gap, not of the entity).
	 * Scans the whole ring and takes a square root, so it is called once per
	 * resume - never on the frame path.
	 * @param {number} snapGapMs
	 * @returns {number}
	 */
	peakSpeedPerMs(snapGapMs) {
		let best = 0;
		for (let k = 1; k < this.len; k++) {
			const i = (this.head + k) % RING_CAP;
			const p = (this.head + k - 1) % RING_CAP;
			const s = this.t[i] - this.t[p];
			if (!(s > 0) || s > snapGapMs) continue;
			const dx = this.x[i] - this.x[p];
			const dy = this.y[i] - this.y[p];
			const v = Math.sqrt(dx * dx + dy * dy) / s;
			if (v > best) best = v;
		}
		return best;
	}

	/**
	 * Resolve the position at `renderTime` into `out` (a caller-owned
	 * `{ x, y }` scratch). Returns one of the SAMPLE_* statuses.
	 * @param {number} renderTime
	 * @param {{ x: number, y: number }} out
	 * @param {SampleBounds} bounds
	 * @returns {number}
	 */
	sampleInto(renderTime, out, bounds) {
		const extrapolateMs = bounds.extrapolateMs;
		const snapGapMs = bounds.snapGapMs;
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
				const dx = this.x[ni] - this.x[pi];
				const dy = this.y[ni] - this.y[pi];
				// A discontinuity's implied velocity is fiction in both
				// directions: dead-reckoning along a teleport would fling the
				// entity onward at the jump's speed for the whole extrapolation
				// cap - the longest smear the pipeline can paint - which is the
				// same reason a pair spanning more than the gap threshold
				// carries no velocity either.
				if (span > 0 && span <= snapGapMs && !this.isJump(pi, ni, dx, dy, span, bounds)) {
					vx = dx / span;
					vy = dy / span;
				}
			}
			const over = renderTime - tn;
			const dt = over > extrapolateMs ? extrapolateMs : over;
			out.x = this.x[ni] + vx * dt;
			out.y = this.y[ni] + vy * dt;
			// Freshness is the extrapolation magnitude: exactly at the newest
			// sample is LIVE, dead-reckoning within the cap is COASTING, past
			// the cap (resting on stale data) is STALE.
			out.fresh = over > extrapolateMs ? FRESH_STALE : over > 0 ? FRESH_COASTING : FRESH_LIVE;
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
			out.fresh = FRESH_LIVE;
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
		const dx = this.x[upper] - this.x[lower];
		const dy = this.y[upper] - this.y[lower];
		if (span > snapGapMs || (span > 0 && this.isJump(lower, upper, dx, dy, span, bounds))) {
			// Discontinuity: snap to the newer side rather than smearing the
			// entity across it. Either the pair spans a delivery gap (view
			// re-entry, idle resume) or it covers ground no honest motion
			// could, which is a teleport or a scripted placement whatever the
			// cadence that delivered it.
			out.x = this.x[upper];
			out.y = this.y[upper];
			out.fresh = FRESH_LIVE;
			return SAMPLE_ACTIVE;
		}
		const f = span > 0 ? (renderTime - tl) / span : 1;
		out.x = this.x[lower] + dx * f;
		out.y = this.y[lower] + dy * f;
		out.fresh = FRESH_LIVE;
		return SAMPLE_ACTIVE;
	}
}

/**
 * The per-topic smoothing controller: sample rings keyed by entity, the
 * server-clock estimator, the measured stamp interval, and the slewed
 * interpolation delay. One instance per rendering pipeline (one in the
 * worker, or one on the main-thread fallback).
 *
 * @param {{ delayMs: 'auto' | number, extrapolateMs: number, snapGapMs: number,
 *   snapSpeedPerSec?: 'auto' | number }} options
 *   resolved knobs - validation belongs to the caller's public surface.
 *   `snapSpeedPerSec` omitted or `'auto'` detects jumps from each entity's own
 *   neighbouring motion; a positive number adds an absolute ceiling on top;
 *   `0` turns both off.
 */
export function createSmoother(options) {
	const delayOpt = options.delayMs;
	const snapGapMs = options.snapGapMs;
	const perSec = options.snapSpeedPerSec;
	/** @type {SampleBounds} */
	const bounds = {
		extrapolateMs: options.extrapolateMs,
		snapGapMs,
		// Held per millisecond because every ring time is in milliseconds: the
		// render frame's absolute test is then one multiply instead of a divide.
		snapSpeedPerMs: typeof perSec === 'number' && perSec > 0 ? perSec / 1000 : 0,
		autoSnap: perSec !== 0
	};

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
			const s = ring.sampleInto(renderTime, out, bounds);
			// Resume ease: on the first sample after an armed resume, compute the
			// offset from where the entity was last drawn to where the new basis
			// renders it now, then decay that offset to zero over offMs so the
			// entity slides into place instead of popping. The offset is a pure
			// render overlay - the rings and clock already hold the true basis.
			if (ring.easePending) {
				const ox = ring.easeFromX - out.x;
				const oy = ring.easeFromY - out.y;
				ring.easePending = false;
				// The ease is a correction, not a path. An offset that would slide
				// the entity faster than its own motion ever did (or past the
				// configured ceiling) is the server having PLACED it elsewhere
				// while the frames were away, and easing that paints the placement
				// across every frame of the ease window - the same smear the
				// straddle snap removes, just stretched over resumeEaseMs instead
				// of one sample interval. Snap those.
				// The automatic ceiling is the entity's own peak honest speed, so
				// an entity that was at rest before the resume has a ceiling of
				// zero: the two bases should agree about where a resting entity
				// is, and any disagreement is exactly the placement this snaps.
				const auto = ring.easeMaxPerMs * JUMP_FACTOR * ring.offMs;
				if (
					overSpeed(ox, oy, ring.offMs, bounds.snapSpeedPerMs) ||
					(bounds.autoSnap && ox * ox + oy * oy > auto * auto)
				) {
					ring.offAt = -1;
				} else {
					ring.offX = ox;
					ring.offY = oy;
					ring.offAt = renderTime;
				}
			}
			if (ring.offAt >= 0) {
				const f = ring.offMs > 0 ? 1 - (renderTime - ring.offAt) / ring.offMs : 0;
				if (f <= 0) {
					ring.offAt = -1;
				} else {
					out.x += ring.offX * f;
					out.y += ring.offY * f;
					motion = true;
				}
			}
			ring.lastX = out.x;
			ring.lastY = out.y;
			ring.hasLast = true;
			if (s === SAMPLE_ACTIVE) motion = true;
			return s;
		},

		/**
		 * Snapshot each entity's last rendered position (post-ease), for a
		 * resume that is about to rebuild the rings: the caller captures this
		 * BEFORE `reset()`, rebuilds on the new basis, then `armResumeEase`s
		 * back into it. Each entry carries the entity's peak honest speed
		 * (`perMs`) from the history that is about to be discarded, which is
		 * the only surviving evidence of how fast this entity actually moves -
		 * the ease measures its own slide against it. Allocates and scans the
		 * rings; called once per resume, never per frame.
		 * @returns {Map<string, { x: number, y: number, perMs: number }>}
		 */
		renderedSnapshot() {
			const snap = new Map();
			for (const [key, ring] of rings) {
				if (ring.hasLast) {
					snap.set(key, { x: ring.lastX, y: ring.lastY, perMs: ring.peakSpeedPerMs(snapGapMs) });
				}
			}
			return snap;
		},

		/**
		 * Arm a decaying resume ease on every entity present in both `fromMap`
		 * (last-rendered positions captured before the rebuild) and the freshly
		 * rebuilt rings. An entity absent from the new basis is skipped (it left);
		 * a newly appeared entity is skipped (nothing to ease from). No-op when
		 * `easeMs <= 0` (snap). Arming is only an intent: the first eased frame
		 * measures the offset the rebuild actually produced and snaps instead
		 * when that offset is a placement rather than a correction.
		 * @param {Map<string, { x: number, y: number, perMs?: number }>} fromMap
		 * @param {number} easeMs
		 */
		armResumeEase(fromMap, easeMs) {
			if (!(easeMs > 0)) return;
			for (const [key, pos] of fromMap) {
				const ring = rings.get(key);
				if (ring === undefined) continue;
				ring.easeFromX = pos.x;
				ring.easeFromY = pos.y;
				ring.easePending = true;
				ring.offMs = easeMs;
				ring.easeMaxPerMs = typeof pos.perMs === 'number' && pos.perMs > 0 ? pos.perMs : 0;
			}
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

		/**
		 * The latest absolute server-axis stamp this client has observed (the `t`
		 * the server wrote on the freshest position/ack frame), or -1 before any
		 * stamped frame. A shot echoes this back so the server can measure the
		 * round trip against its OWN send time - both ends server-authored - rather
		 * than trusting a client-derived latency. Refreshed from the broadcast
		 * firehose, so it stays fresh even for a still (non-commanding) shooter.
		 */
		get lastServerT() {
			return lastStampT;
		},

		/**
		 * Note a server stamp seen outside a position frame (an acknowledgement
		 * carries a fresh server `t` too), so the echoed `lastServerT` reflects the
		 * freshest server time the client has actually observed - which tightens the
		 * server's round-trip measurement for a commanding shooter whose own updates
		 * are echo-suppressed.
		 * @param {number} t
		 */
		noteServerStamp(t) {
			if (typeof t === 'number' && Number.isFinite(t) && t > lastStampT) lastStampT = t;
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
