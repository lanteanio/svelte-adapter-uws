// Deterministic simulation core: a seeded PRNG, a virtual-clock discrete-event
// scheduler that models the event loop's phase boundary, and a seeded fault
// engine. These are the substrate the in-memory simulator installs through the
// runtime seam (src/runtime/runtime.js) so the same framework dispatch that runs over
// real uWS in createTestServer runs reproducibly here: a seed plus a commit is
// the entire bug report.
//
// This file is simulation infrastructure, not framework runtime. It is the one
// place (besides the runtime seam itself) allowed to touch the native event-loop
// primitives directly - it needs the real microtask queue as its drain signal.
// The determinism-allow comments mark those deliberate touches.

/** A fixed default seed so the zero-config smoke run is itself reproducible. */
export const DEFAULT_SEED = 'svti-sim-0';

/**
 * A fixed wall-clock baseline (ms since epoch). The virtual clock starts here so
 * timestamps stamped into the wire transcript reproduce bit-for-bit across runs
 * of the same seed, independent of the real time the run happens to execute at.
 */
export const FIXED_EPOCH = 1_700_000_000_000;

// - Seeded PRNG --------------------------------------------------------------

/**
 * FNV-1a 32-bit string hash - turns a string seed into a 32-bit PRNG state.
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * mulberry32 - a small, fast, well-distributed PRNG. Same family as the
 * realtime test harness's seeded RNG, chosen for reproducibility, not crypto
 * strength: the simulator needs identical draws across runs, not unpredictability.
 * @param {number} a 32-bit seed state
 * @returns {() => number} draw in [0, 1)
 */
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Build a seeded RNG providing the four shapes the runtime seam's `rng` exposes
 * (float / u32 / uuid / bytes) plus an integer helper, all drawn from one
 * deterministic stream. The uuid is an RFC-4122 v4-shaped string derived from
 * the stream (NOT crypto.randomUUID) so request/session ids reproduce.
 *
 * @param {string | number} seed
 */
export function createSeededRng(seed) {
	const next = mulberry32(fnv1a(typeof seed === 'string' ? seed : String(seed)));
	const float = () => next();
	const u32 = () => (next() * 0x100000000) >>> 0;
	/** @param {number} n */
	function bytes(n) {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) out[i] = (next() * 256) & 0xff;
		return out;
	}
	function uuid() {
		const b = bytes(16);
		b[6] = (b[6] & 0x0f) | 0x40; // version 4
		b[8] = (b[8] & 0x3f) | 0x80; // variant 10
		let hex = '';
		for (let i = 0; i < 16; i++) hex += b[i].toString(16).padStart(2, '0');
		return (
			hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
			'-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
		);
	}
	/** @param {number} n integer in [0, n) */
	const int = (n) => Math.floor(next() * n);
	return { float, u32, bytes, uuid, int };
}

// - The discrete-event scheduler ---------------------------------------------

// The real microtask-drain primitive. A callback scheduled here runs only after
// the real microtask queue (native Promise continuations + queueMicrotask) has
// fully drained, and the simulation schedules no real timers or I/O, so this is
// a reliable "microtasks are now empty" signal. It is the ONLY real event-loop
// primitive the scheduler uses; everything time-based goes through the virtual
// heap below.
const realSetImmediate =
	typeof setImmediate === 'function'
		? setImmediate // determinism-allow: sim microtask-drain primitive, not framework runtime
		: (cb) => setTimeout(cb, 0); // determinism-allow: setImmediate fallback for the drain primitive

/**
 * A virtual-clock scheduler that models the load-bearing event-loop phase
 * boundary: per round it (1) drains all microtasks, (2) fires one timers-phase
 * batch, (3) fires one check-phase (setImmediate) batch, then repeats. A
 * `setTimeout(0)` routed through this scheduler lands in a LATER timers phase,
 * never collapsed into the microtask drain - which is exactly what lets the
 * relay / cursor / presence coalescers batch a synchronous burst into one frame.
 * Collapsing the phases would change observable batching and break replay.
 *
 * @param {{ startEpoch?: number, tz?: string }} [opts]
 */
export function createScheduler(opts = {}) {
	let vnow = opts.startEpoch ?? FIXED_EPOCH;
	let seqCounter = 0;
	let refed = 0; // count of refed pending callbacks; the run loop stops at zero

	/** @type {Array<any>} min-heap of timer entries keyed by (due, seq) */
	const heap = [];
	/** @type {Array<any>} FIFO of check-phase (setImmediate) entries */
	const checkQ = [];

	const less = (a, b) => a.due < b.due || (a.due === b.due && a.seq < b.seq);
	function heapPush(e) {
		heap.push(e);
		let i = heap.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
			else break;
		}
	}
	function heapPop() {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = i * 2 + 1, r = l + 1;
				let s = i;
				if (l < heap.length && less(heap[l], heap[s])) s = l;
				if (r < heap.length && less(heap[r], heap[s])) s = r;
				if (s === i) break;
				[heap[i], heap[s]] = [heap[s], heap[i]];
				i = s;
			}
		}
		return top;
	}

	/** A timer/immediate handle mirroring Node's Timeout: unref/ref/hasRef. */
	function makeHandle(entry) {
		return {
			_entry: entry,
			unref() { if (entry.refed) { entry.refed = false; refed--; } return this; },
			ref() { if (!entry.refed && !entry.cleared) { entry.refed = true; refed++; } return this; },
			hasRef() { return entry.refed; }
		};
	}

	/** @param {Function} cb @param {number} ms @param {any[]} args @param {boolean} interval */
	function scheduleTimer(cb, ms, args, interval) {
		const delay = Math.max(0, Number(ms) || 0);
		const entry = { due: vnow + delay, seq: seqCounter++, cb, args, period: delay, interval: !!interval, cleared: false, refed: true };
		refed++;
		heapPush(entry);
		return makeHandle(entry);
	}
	/** @param {Function} cb @param {any[]} args */
	function scheduleImmediate(cb, args) {
		const entry = { cb, args, seq: seqCounter++, cleared: false, refed: true };
		refed++;
		checkQ.push(entry);
		return makeHandle(entry);
	}
	function clear(handle) {
		const entry = handle && handle._entry;
		if (entry && !entry.cleared) {
			entry.cleared = true;
			if (entry.refed) { entry.refed = false; refed--; }
		}
	}

	/**
	 * The runtime-seam env this scheduler backs. The runner installs it via
	 * `setRuntimeEnv(env, { force: true })`. Microtasks deliberately route to the
	 * REAL queue so native awaits and seam microtasks drain together when the
	 * scheduler flushes the microtask queue between phases.
	 * @param {ReturnType<typeof createSeededRng>} rng
	 */
	function buildEnv(rng) {
		return {
			clock: {
				now: () => vnow,
				monotonic: () => vnow, // virtual wall and monotonic share one strictly-non-decreasing clock
				processMonotonic: () => vnow, // one simulated process, so the cross-thread timeline is that same clock
				wallEpoch: () => vnow
			},
			rng: { float: rng.float, u32: rng.u32, uuid: rng.uuid, bytes: rng.bytes },
			timers: {
				set: (cb, ms, ...a) => scheduleTimer(cb, ms, a, false),
				setInterval: (cb, ms, ...a) => scheduleTimer(cb, ms, a, true),
				setImmediate: (cb, ...a) => scheduleImmediate(cb, a),
				clear,
				clearInterval: clear,
				queueMicrotask: (cb) => queueMicrotask(cb) // determinism-allow: sim routes seam microtasks to the real queue it drains
			},
			tz: opts.tz
		};
	}

	/** Resolve once the real microtask queue has fully drained. */
	function drainMicrotasks() {
		return new Promise((resolve) => realSetImmediate(resolve));
	}

	/** Is the earliest pending timer due at or before the current virtual time? */
	function hasDueTimer() {
		// skip cleared entries lazily at the top of the heap
		while (heap.length > 0 && heap[0].cleared) heapPop();
		return heap.length > 0 && heap[0].due <= vnow;
	}
	/** Advance the virtual clock to the next refed pending timer; false if none. */
	function advanceToNextTimer() {
		while (heap.length > 0 && heap[0].cleared) heapPop();
		if (heap.length === 0) return false;
		if (heap[0].due > vnow) vnow = heap[0].due;
		return true;
	}
	/**
	 * Fire every timer due at the current virtual time, in (due, seq) order, with
	 * a microtask drain after EACH callback (Node drains the microtask queue per
	 * timer callback, not per batch). A timer armed - or an interval rescheduled -
	 * DURING this pass gets a seq at or above the entry-time cutoff and defers to a
	 * later timers phase, mirroring libuv caching loop->time per turn: a
	 * `setTimeout(0)` armed mid-phase lands in the NEXT timers phase, never the
	 * current batch.
	 */
	async function fireDueTimers() {
		const cutoff = seqCounter;
		for (;;) {
			while (heap.length > 0 && heap[0].cleared) heapPop();
			if (heap.length === 0 || heap[0].due > vnow || heap[0].seq >= cutoff) break;
			const e = heapPop();
			if (e.cleared) continue;
			if (e.interval) {
				// interval: stays pending (refed unchanged), reschedule before firing.
				// A 0ms period re-fires in the next timers phase (seq >= cutoff), as Node does.
				e.due = vnow + e.period;
				e.seq = seqCounter++;
				heapPush(e);
			} else if (e.refed) {
				e.refed = false; refed--; // one-shot consumed
			}
			try { e.cb(...e.args); } catch (err) { reportUncaught(err); }
			await drainMicrotasks();
		}
	}
	/**
	 * Fire the check-phase batch queued at the START of the phase (FIFO), draining
	 * microtasks after each callback. A setImmediate armed during the phase runs in
	 * the next round's check phase, as in Node.
	 */
	async function fireCheckPhase() {
		const batch = checkQ.splice(0, checkQ.length);
		for (const e of batch) {
			if (e.cleared) continue;
			if (e.refed) { e.refed = false; refed--; }
			try { e.cb(...e.args); } catch (err) { reportUncaught(err); }
			await drainMicrotasks();
		}
	}

	/** @type {Array<{ error: any }>} */
	const uncaught = [];
	function reportUncaught(err) { uncaught.push({ error: err }); }

	/**
	 * Run the three-phase loop until no refed work remains or `maxSteps` is hit.
	 * `onStep(step)` runs after each completed round (the invariant-check hook).
	 * Returns the number of rounds executed.
	 *
	 * @param {{ maxSteps?: number, onStep?: (step: number) => void }} [runOpts]
	 */
	async function run(runOpts = {}) {
		const maxSteps = runOpts.maxSteps ?? 1_000_000;
		const onStep = runOpts.onStep;
		let step = 0;
		await drainMicrotasks();
		while (step < maxSteps) {
			let didWork = false;
			// Timers phase: fire what's due now, else jump to the next timer - but
			// never jump past pending check work (Node drains the current iteration's
			// check phase before the poll phase advances time to a future deadline).
			if (hasDueTimer()) { await fireDueTimers(); didWork = true; }
			else if (checkQ.length === 0 && refed > 0 && advanceToNextTimer()) { await fireDueTimers(); didWork = true; }
			await drainMicrotasks();
			// Check phase (setImmediate).
			if (checkQ.length > 0) { await fireCheckPhase(); didWork = true; }
			await drainMicrotasks();
			if (onStep) onStep(step);
			step++;
			if (!didWork && refed === 0 && checkQ.length === 0) break;
		}
		return step;
	}

	return {
		buildEnv,
		drainMicrotasks,
		run,
		now: () => vnow,
		/** Pending refed callback count - drives loop termination. */
		pending: () => refed,
		uncaught,
		// Lower-level controls for tests / the runner's custom drive loops.
		_scheduleTimer: scheduleTimer,
		_fireDueTimers: fireDueTimers,
		_fireCheckPhase: fireCheckPhase,
		_advanceToNextTimer: advanceToNextTimer,
		_hasDueTimer: hasDueTimer
	};
}

// - The seeded fault engine --------------------------------------------------

/** Cap on sampled per-frame jitter so a reorder window stays bounded. */
const MAX_DELAY_MS = 60_000;

/**
 * Flip one byte of a payload to a different value, drawn from the seeded RNG.
 * Exercises the envelope-integrity invariants. Strings are corrupted at a
 * character; binary frames at a byte.
 * @param {string | Uint8Array} payload
 * @param {ReturnType<typeof createSeededRng>} rng
 */
function corruptPayload(payload, rng) {
	if (typeof payload === 'string') {
		if (payload.length === 0) return payload;
		const i = rng.int(payload.length);
		const c = (payload.charCodeAt(i) + 1 + rng.int(94)) % 0x10000;
		return payload.slice(0, i) + String.fromCharCode(c) + payload.slice(i + 1);
	}
	if (payload && payload.byteLength > 0) {
		const out = payload.slice();
		const i = rng.int(out.length);
		out[i] = (out[i] + 1 + rng.int(254)) & 0xff;
		return out;
	}
	return payload;
}

/**
 * A seeded fault engine applied per channel operation. Every decision is drawn
 * from the seeded RNG, so the seed fully determines the run. `plan(payload)`
 * returns a list of deliveries (0 = dropped, 1 = normal/delayed/corrupted,
 * 2 = duplicated); each carries the delay the channel should defer it by via the
 * scheduler, so reorder is emergent from independently-sampled per-frame delays.
 *
 * @param {{
 *   rng: ReturnType<typeof createSeededRng>,
 *   faults?: {
 *     drop?: number,            // P(drop) per frame, [0,1]
 *     duplicate?: number,       // P(re-deliver) per frame, [0,1]
 *     corrupt?: number,         // P(byte-flip) per frame, [0,1]
 *     delayMs?: number | [number, number], // fixed or [min,max] sampled latency
 *     reorder?: number          // P(independent jitter in [0, maxJitterMs)) per frame
 *     maxJitterMs?: number
 *   }
 * }} opts
 */
export function createFaultEngine(opts) {
	const rng = opts.rng;
	const f = opts.faults || {};
	const dropRate = clampUnit(f.drop);
	const dupRate = clampUnit(f.duplicate);
	const corruptRate = clampUnit(f.corrupt);
	const reorderRate = clampUnit(f.reorder);
	const maxJitter = Math.min(MAX_DELAY_MS, Math.max(0, f.maxJitterMs ?? 50));
	const delaySpec = f.delayMs ?? 0;

	function baseDelay() {
		if (Array.isArray(delaySpec)) {
			const lo = delaySpec[0] || 0;
			const hi = delaySpec[1] || 0;
			return hi > lo ? lo + rng.float() * (hi - lo) : lo;
		}
		return Math.min(MAX_DELAY_MS, Math.max(0, Number(delaySpec) || 0));
	}
	function sampleDelay() {
		let d = baseDelay();
		if (reorderRate > 0 && rng.float() < reorderRate) d += rng.float() * maxJitter;
		return Math.floor(Math.min(MAX_DELAY_MS, d));
	}

	return {
		/**
		 * @param {string | Uint8Array} payload
		 * @returns {Array<{ delayMs: number, payload: string | Uint8Array }>}
		 */
		plan(payload) {
			if (dropRate > 0 && rng.float() < dropRate) return [];
			let p = payload;
			if (corruptRate > 0 && rng.float() < corruptRate) p = corruptPayload(payload, rng);
			const out = [{ delayMs: sampleDelay(), payload: p }];
			if (dupRate > 0 && rng.float() < dupRate) out.push({ delayMs: sampleDelay(), payload: p });
			return out;
		},
		active: dropRate > 0 || dupRate > 0 || corruptRate > 0 || reorderRate > 0 || baseDelay() > 0
	};
}

/** @param {unknown} v @returns {number} a probability clamped to [0,1], 0 if invalid */
function clampUnit(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n >= 1 ? 1 : n;
}
