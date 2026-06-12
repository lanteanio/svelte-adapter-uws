/**
 * Client-side channel for one smoothed entity topic: prediction for the
 * local entity, render-in-the-past interpolation for remote entities, and
 * the wire glue between them.
 *
 * A channel composes the pure cores - the predictor (./predict.js), the
 * smoother/clock (./interpolate.js, ./clock.js), and the binary codec
 * (./codec.js) - over the singleton connection, with the TRANSPORT injected:
 * the caller supplies `sendCommand(batch)` (a lossy fire-and-forget send;
 * command loss is recovered by reconciliation, never retransmission) and
 * `sync()` (an awaited request returning the authoritative catalog, the
 * caller's own entity key, its ack watermark, and a server time stamp).
 * Injection keeps this module free of any framework above the adapter, and
 * makes the channel drivable by a deterministic harness with a scripted
 * transport.
 *
 * Lifecycle and recovery:
 *
 *   - On every connection 'open' (first connect and every reconnect) the
 *     channel resyncs: the sync round trip seeds the clock estimator with an
 *     upper bound, rebases the predictor on the server's state and ack
 *     watermark, and rebuilds the remote rings from the catalog at the
 *     reply's server time. Un-acked commands from the old connection are
 *     dropped, never blind-replayed onto a basis the server no longer
 *     shares.
 *   - Every acknowledgement is a clock sample: the predictor remembers when
 *     the acked command was sent, so `ack.t` plus that send time is a full
 *     round-trip bound - the steady-state source that keeps the estimate
 *     honest on the main connection.
 *   - When the un-acked window overflows (the server stopped
 *     acknowledging), prediction is killed and the channel resyncs once per
 *     episode; the overflow state is surfaced through `onOverflow` so the
 *     app's health surface can reflect it.
 *
 * The frame loop runs only while a frame consumer is attached and goes
 * near-free when idle: the gate stays closed unless something is dirty, a
 * ring still holds un-played motion, or a correction is still decaying.
 *
 * Frames sent to `onFrame` carry fresh objects (the reactive layer above
 * needs new identities to notice changes); the channel's own bookkeeping is
 * allocation-free per frame apart from that view.
 *
 * @module svelte-adapter-uws/plugins/smooth/client
 */

import { on, status, registerWireCodec } from '../../client.js';
import { monotonicNow, now, setTimer, clearTimer } from '../../client-runtime.js';
import { createPredictor } from './predict.js';
import { createSmoother, SAMPLE_EMPTY } from './interpolate.js';
import { SMOOTH_CAPABILITY, SMOOTH_TOPIC_PREFIX, SmoothDecodeDict, decodeSmooth } from './codec.js';

// Opt this connection into binary smooth frames: registered at module load so
// the first `hello` already carries the capability (a lazily-added capability
// would not reach a server whose codec state had already attached - the
// attach-once contract). Fully transparent: the decoder yields the identical
// { event, data } envelopes the JSON path produces.
registerWireCodec(SMOOTH_TOPIC_PREFIX, {
	capability: SMOOTH_CAPABILITY,
	state: { onAttach: () => new SmoothDecodeDict() },
	decode: decodeSmooth
});

// Resolve `requestAnimationFrame` at call time so a polyfill installed after
// this module imports (or a test harness substitution) is honored.
function scheduleFrame(cb) {
	if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
	return setTimer(cb, 16);
}

function cancelFrame(handle) {
	if (handle == null) return;
	if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(handle);
	else clearTimer(handle);
}

/**
 * Validate one numeric knob: undefined adopts the default, anything else
 * must be a finite number within the stated bound.
 * @param {any} v @param {string} label @param {number} min
 */
function checkKnob(v, label, min) {
	if (v === undefined) return;
	if (!(typeof v === 'number' && Number.isFinite(v) && v >= min)) {
		throw new Error('smooth: ' + label + ' must be a number >= ' + min);
	}
}

/**
 * Create the channel for one smoothed topic.
 *
 * The wire topic is announced by the first sync reply (the topic resolves
 * server-side), so the inbound tap binds on the first successful sync;
 * commands are path-routed and flow regardless.
 *
 * @param {{
 *   apply: (state: any, command: any, ctx: { firstTime: boolean, rng: any }) => any,
 *   initial: any,
 *   transport: {
 *     sendCommand: (batch: Array<{ id: number, cmd: any }>) => void,
 *     sync: () => Promise<{ topic?: string, t?: number, you?: string, ack?: number, states?: Array<{ key: string, state: any }> } | null | undefined>
 *   },
 *   computeError?: (before: any, after: any) => number,
 *   errorThreshold?: number,
 *   smoothTimeMs?: number,
 *   windowCap?: number,
 *   windowMaxAgeMs?: number,
 *   interpolationMs?: 'auto' | number,
 *   extrapolateMs?: number,
 *   snapGapMs?: number,
 *   cmdRate?: number
 * }} options
 */
export function createSmoothChannel(options) {
	if (options === null || typeof options !== 'object') {
		throw new Error('smooth: an options object with apply and initial is required');
	}
	if (typeof options.apply !== 'function') {
		throw new Error('smooth: apply must be the shared (state, command, ctx) => state function');
	}
	if (options.initial === undefined) {
		throw new Error('smooth: initial state is required');
	}
	const transport = options.transport;
	if (!transport || typeof transport.sendCommand !== 'function' || typeof transport.sync !== 'function') {
		throw new Error('smooth: transport with sendCommand and sync is required');
	}
	if (options.computeError !== undefined && typeof options.computeError !== 'function') {
		throw new Error('smooth: computeError must be a function (before, after) => number');
	}
	checkKnob(options.errorThreshold, 'errorThreshold', 0);
	checkKnob(options.smoothTimeMs, 'smoothTimeMs', 0);
	checkKnob(options.windowCap, 'windowCap', 1);
	checkKnob(options.windowMaxAgeMs, 'windowMaxAgeMs', 1);
	if (options.interpolationMs !== undefined && options.interpolationMs !== 'auto') {
		checkKnob(options.interpolationMs, 'interpolationMs', 0);
	}
	checkKnob(options.extrapolateMs, 'extrapolateMs', 0);
	checkKnob(options.snapGapMs, 'snapGapMs', 1);
	checkKnob(options.cmdRate, 'cmdRate', 0);

	const cmdRate = options.cmdRate === undefined ? 60 : options.cmdRate;
	const minFlushMs = cmdRate > 0 ? 1000 / cmdRate : 0;

	const predictor = createPredictor({
		apply: options.apply,
		initial: options.initial,
		computeError: options.computeError,
		errorThreshold: options.errorThreshold,
		smoothTimeMs: options.smoothTimeMs,
		windowCap: options.windowCap,
		windowMaxAgeMs: options.windowMaxAgeMs
	});
	const smoother = createSmoother({
		delayMs: options.interpolationMs === undefined ? 'auto' : options.interpolationMs,
		extrapolateMs: options.extrapolateMs === undefined ? 250 : options.extrapolateMs,
		snapGapMs: options.snapGapMs === undefined ? 500 : options.snapGapMs
	});

	/** Latest merged remote states (positions interpolate, other fields are
	 * latest-value). The local entity never lives here. */
	const merged = new Map();
	let selfKey = null;
	let destroyed = false;
	let dirty = true;
	let wasOverflowed = false;
	/** The resolved wire topic, learned from the first sync reply. */
	let wireTopic = null;
	/** @type {(() => void) | null} */
	let tapUnsub = null;

	/** @type {Array<{ id: number, cmd: any }>} */
	let outQueue = [];
	let lastFlushMono = -Infinity;

	/** @type {((local: any, remote: Map<string, any>) => void) | null} */
	let frameCb = null;
	/** @type {((overflowed: boolean) => void) | null} */
	let overflowCb = null;
	let raf = null;

	const localPoint = { x: 0, y: 0 };
	const samplePoint = { x: 0, y: 0 };

	function ingest(ev) {
		if (ev === null || typeof ev !== 'object') return;
		const recvMono = monotonicNow();
		if (ev.event === 'ack') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.id !== 'number') return;
			const res = predictor.ack(d.id, d.state, recvMono);
			if (res !== null) {
				if (typeof d.t === 'number' && Number.isFinite(d.t)) {
					if (typeof res.sentMono === 'number') smoother.clock.seed(d.t, res.sentMono, recvMono);
					else smoother.clock.sample(d.t, recvMono);
				}
				if (wasOverflowed && !predictor.overflowed) notifyOverflow(false);
				dirty = true;
			}
			return;
		}
		if (ev.event === 'update') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			// An own-key update never enters the remote set (no ghost twin).
			// While commands are in flight the acknowledgement is the
			// reconciliation carrier and the frame is dropped; with nothing
			// pending it is adopted as authoritative continuation - the
			// server moves command-less entities (onMissing) and those
			// updates are the owner's only feedback.
			if (selfKey !== null && d.key === selfKey) {
				if (predictor.rebase(d.data)) dirty = true;
				return;
			}
			merged.set(d.key, d.data);
			smoother.ingest(ev, recvMono);
			dirty = true;
			return;
		}
		if (ev.event === 'remove') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			merged.delete(d.key);
			smoother.ingest(ev, recvMono);
			dirty = true;
			return;
		}
		// Any other event (the sync-time 'time' seed rides the sync reply
		// instead; additive future events) feeds the clock path only.
		smoother.ingest(ev, recvMono);
	}

	function notifyOverflow(state) {
		wasOverflowed = state;
		if (overflowCb) overflowCb(state);
	}

	let syncInFlight = false;
	let lastSyncAttemptMono = -Infinity;
	function resync() {
		if (destroyed || syncInFlight) return;
		syncInFlight = true;
		lastSyncAttemptMono = monotonicNow();
		const sendMono = lastSyncAttemptMono;
		Promise.resolve()
			.then(() => transport.sync())
			.then((reply) => {
				syncInFlight = false;
				if (destroyed || reply === null || typeof reply !== 'object') return;
				const recvMono = monotonicNow();
				if (tapUnsub === null && typeof reply.topic === 'string') {
					// First successful sync names the wire topic; the tap binds
					// once and survives reconnects (topic stores are name-keyed).
					wireTopic = SMOOTH_TOPIC_PREFIX + reply.topic;
					tapUnsub = on(wireTopic).subscribe(ingest);
				}
				if (typeof reply.you === 'string') selfKey = reply.you;
				merged.clear();
				// Reset BEFORE seeding: a resync may follow a reconnect onto a
				// different machine, so the old offset estimate and ring axis
				// must not survive into the new seed.
				smoother.reset();
				if (typeof reply.t === 'number' && Number.isFinite(reply.t)) {
					smoother.clock.seed(reply.t, sendMono, recvMono);
				}
				let own;
				const states = Array.isArray(reply.states) ? reply.states : [];
				const bulk = [];
				for (let i = 0; i < states.length; i++) {
					const s = states[i];
					if (!s || typeof s.key !== 'string') continue;
					if (selfKey !== null && s.key === selfKey) {
						own = s.state;
						continue;
					}
					merged.set(s.key, s.state);
					bulk.push({ key: s.key, data: s.state });
				}
				if (bulk.length > 0) {
					smoother.ingest({ event: 'bulk', data: bulk, t: typeof reply.t === 'number' ? reply.t : undefined }, recvMono);
				}
				predictor.sync(own === undefined ? options.initial : own, typeof reply.ack === 'number' ? reply.ack : 0);
				if (wasOverflowed) notifyOverflow(false);
				dirty = true;
			})
			.catch(() => {
				// A failed sync (offline, server restarting) leaves the channel
				// on its current basis; the next 'open' or overflow retries.
				syncInFlight = false;
			});
	}

	function flush(monoNow) {
		if (outQueue.length === 0) return;
		if (monoNow - lastFlushMono < minFlushMs) return;
		lastFlushMono = monoNow;
		const batch = outQueue;
		outQueue = [];
		transport.sendCommand(batch);
	}

	// A channel without a frame consumer (headless commanding) still flushes:
	// the render loop is the flush pump only while it runs.
	let flushTimer = null;
	function scheduleFlush() {
		if (raf !== null || flushTimer !== null || destroyed) return;
		flushTimer = setTimer(() => {
			flushTimer = null;
			const mono = monotonicNow();
			flush(mono);
			if (outQueue.length > 0) scheduleFlush();
		}, Math.max(minFlushMs, 16));
	}

	function loop() {
		if (destroyed) return;
		raf = scheduleFrame(loop);
		const mono = monotonicNow();
		flush(mono);
		if (predictor.checkOverflow(mono)) {
			// The server went silent past the window bound: surface it and
			// run a recovery sync - retried at a modest cadence while the
			// episode persists, so a sync that failed during the same stall
			// does not strand the channel on a healthy connection.
			if (!wasOverflowed) {
				notifyOverflow(true);
				resync();
			} else if (!syncInFlight && mono - lastSyncAttemptMono > 1000) {
				resync();
			}
		}
		const renderTime = smoother.beginFrame(mono);
		const decayActive = predictor.renderInto(localPoint, mono);
		if (!dirty && !smoother.motionPending && !decayActive) return;
		dirty = false;
		if (frameCb === null) return;

		const predicted = predictor.predicted;
		let local = predicted;
		if (predicted !== null && typeof predicted === 'object' && typeof predicted.x === 'number') {
			local = { ...predicted, x: localPoint.x, y: localPoint.y };
		}
		const remote = new Map();
		for (const [key, state] of merged) {
			if (state !== null && typeof state === 'object' && typeof state.x === 'number') {
				const s = smoother.sampleInto(key, renderTime, samplePoint);
				remote.set(key, s === SAMPLE_EMPTY ? state : { ...state, x: samplePoint.x, y: samplePoint.y });
			} else {
				remote.set(key, state);
			}
		}
		frameCb(local, remote);
	}

	// The status store delivers the current value on subscribe, so a channel
	// constructed on an already-open connection syncs immediately.
	const statusUnsub = status.subscribe((s) => {
		if (s === 'open') resync();
	});

	return {
		/**
		 * Submit one command: predicted locally this frame, transmitted on
		 * the next flush, reconciled when its acknowledgement returns.
		 * @param {any} cmd
		 * @returns {number} the command id
		 */
		command(cmd) {
			const mono = monotonicNow();
			const id = predictor.command(cmd, mono);
			if (predictor.overflowed && !wasOverflowed) {
				notifyOverflow(true);
				resync();
			}
			outQueue.push({ id, cmd });
			scheduleFlush();
			dirty = true;
			return id;
		},

		/**
		 * Attach the per-frame consumer and start the render loop. One
		 * consumer per channel; the reactive wrapper above owns fan-out.
		 * @param {(local: any, remote: Map<string, any>) => void} cb
		 */
		onFrame(cb) {
			frameCb = cb;
			dirty = true;
			if (raf === null && !destroyed) raf = scheduleFrame(loop);
		},

		/**
		 * Observe prediction-killed transitions (window overflow and its
		 * recovery) - the app health surface's input.
		 * @param {(overflowed: boolean) => void} cb
		 */
		onOverflow(cb) {
			overflowCb = cb;
		},

		/** Re-request the authoritative catalog (also runs on every 'open'). */
		resync,

		/**
		 * The estimated server wall-clock time, for stamping commands and
		 * compensated actions with the same clock the smoothing runs on.
		 * Falls back to the local wall clock before the first sample. Safe
		 * alongside the render loop: every estimator reading here and in the
		 * loop is a fresh monotonic sample, so the slew limiter only ever
		 * advances.
		 * @returns {number}
		 */
		now() {
			const est = smoother.clock.estServerNow(monotonicNow());
			return est === null ? now() : est;
		},

		/** The caller's own entity key, once the sync reply announced it. */
		get self() {
			return selfKey;
		},

		/** The current prediction (simulation truth, no easing offset). */
		get predicted() {
			return predictor.predicted;
		},

		/** Commands awaiting acknowledgement. */
		get windowSize() {
			return predictor.windowSize;
		},

		/** True while prediction is killed pending recovery. */
		get overflowed() {
			return predictor.overflowed;
		},

		/** The applied interpolation delay (ms) - diagnostics. */
		get delay() {
			return smoother.delay;
		},

		/** The applied clock offset (ms), or null - diagnostics. */
		get clockOffset() {
			return smoother.clock.offset();
		},

		/** The resolved wire topic, or null before the first sync reply. */
		get topic() {
			return wireTopic;
		},

		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (tapUnsub !== null) tapUnsub();
			statusUnsub();
			cancelFrame(raf);
			raf = null;
			if (flushTimer !== null) {
				clearTimer(flushTimer);
				flushTimer = null;
			}
			frameCb = null;
			overflowCb = null;
			outQueue = [];
			merged.clear();
			smoother.reset();
			predictor.reset();
		}
	};
}
