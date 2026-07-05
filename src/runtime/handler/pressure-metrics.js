import { computePressureReason, computeTopPublishers, applyCapacityReason, WS_STATS, TOPIC_SEQS_WARN_THRESHOLD, PUBLISH_WARN_DEDUP_MAX } from '../utils.js';
import { DEFAULT_GRANT, leaseGrantSize, samplePressureValue } from '../wire.js';
import { now, setIntervalTimer, clearIntervalTimer } from '../runtime.js';
import { createOsPressureSampler } from '../utils/os-pressure.js';
import { counters, wsConnections, topicSeqs, topicPublishStats, pressureSnapshot, pressureListeners, publishRateListeners, lastPublishWarnAt } from './state.js';
import { closeHookRegistered } from './config.js';

// Kernel pressure sources (PSI + cgroup CPU quota), sampled on the same 1 Hz
// tick as the process-local counters. Probes once; on hosts without the
// source (non-Linux, PSI compiled out, no cgroup limits) the sampler returns
// nulls at zero further cost and the pressure math is byte-identical.
const osPressure = createOsPressureSampler();

/**
 * Bump the per-connection inbound counters. No-op when no `close` hook
 * is registered (zero-cost when the user does not need stats).
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {ArrayBuffer | string} message
 */
export function bumpIn(ws, message) {
	if (!closeHookRegistered) return;
	let stats;
	try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
	if (!stats) return;
	stats.messagesIn++;
	stats.bytesIn += typeof message === 'string' ? message.length : message.byteLength;
}

/**
 * Bump the per-connection outbound counters for a direct send to this
 * connection (welcome / resumed / subscribe-ack / reply / send /
 * sendCoalesced / sendTo). Topic `publish()` fan-out is not counted -
 * uWS does the dispatch in C++ and counting per-recipient would mean
 * walking subscribers in JS on every publish, defeating the fast path.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} payload
 */
export function bumpOut(ws, payload) {
	if (!closeHookRegistered) return;
	let stats;
	try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
	if (!stats) return;
	stats.messagesOut++;
	stats.bytesOut += payload.length;
}

// Fires once when the topic registry first crosses the warn threshold.
// Apps with unbounded topic cardinality (e.g. publishing to a topic
// keyed on a per-user id) leak memory because each entry persists for
// the process lifetime - the resume protocol cannot evict without
// corrupting recovering clients. Surfacing the threshold loudly with
// the topN publishers lets ops identify the source before OOM.
let topicSeqsWarnFired = false;

export function maybeWarnTopicRegistry() {
	if (topicSeqsWarnFired) return;
	if (topicSeqs.size < TOPIC_SEQS_WARN_THRESHOLD) return;
	topicSeqsWarnFired = true;
	let top;
	try { top = computeTopPublishers(topicPublishStats, 0).slice(0, 5); }
	catch { top = []; }
	console.warn(
		'[ws] topic registry has grown to ' + topicSeqs.size +
		' distinct topics. Each entry persists for the process lifetime ' +
		'(required by the resume protocol). Reduce topic cardinality or ' +
		'opt out of seq stamping for high-cardinality publishes via ' +
		'{ seq: false }. Top recent publishers: ' + JSON.stringify(top) +
		'\n  See: https://svti.me/topic-cardinality'
	);
}

// Soft cap on a single batched WebSocket frame produced by
// platform.publishBatched. Above this size, uWS per-message-deflate may
// kick in (depending on user config) and large frames can surprise
// per-CPU-cycle budgets; we emit a throttled console.warn rather than
// hard-rejecting so the call still delivers. Callers chunk via repeated
// publishBatched calls when the warning fires.
export const BATCH_FRAME_WARN_BYTES = 256 * 1024;

let lastBatchOversizeWarnAt = 0;

export function warnLargeBatchFrame(size) {
	const t = now();
	if (t - lastBatchOversizeWarnAt < 60000) return;
	lastBatchOversizeWarnAt = t;
	console.warn('[ws] publishBatched frame is ' + size + ' bytes (>' + BATCH_FRAME_WARN_BYTES +
		'). Large frames may trip per-message-deflate and surprise CPU budgets. ' +
		'Consider chunking the batch into multiple publishBatched calls.' +
		'\n  See: https://svti.me/publish-batched');
}

/** @type {ReturnType<typeof setInterval> | null} */
let pressureTimer = null;

/**
 * Default pressure thresholds. Designed to be safe rather than tight: the
 * goal is "no false positives in the steady state of a healthy small app,"
 * not "perfectly tuned for sustained five-figure publish rates." Override
 * per-deployment via the `pressure` field on the WebSocket options.
 */
const DEFAULT_PRESSURE_THRESHOLDS = {
	memoryHeapUsedRatio: 0.85,
	publishRatePerSec: 10000,
	subscriberRatio: 50,
	sampleIntervalMs: 1000,
	// Per-topic runaway-publisher thresholds. A topic that crosses
	// either of these in a sample window fires the configured callback
	// (or a throttled console.warn by default). Both can be set to
	// false to disable per-topic tracking entirely; in that case the
	// hot-path bump is skipped.
	topicPublishRatePerSec: 5000,
	topicPublishBytesPerSec: 10 * 1024 * 1024,
	// Kernel pressure thresholds, active only where the source exists
	// (/proc/pressure on a PSI-enabled Linux kernel; cgroup cpu.stat inside
	// a quota-limited container) - on any other host the sample fields are
	// absent and these never fire. PSI values are avg10 percentages of
	// wall time stalled: cpu 'some' 60% means most of the last 10s had at
	// least one runnable task waiting for a CPU; memory/io use the 'full'
	// line (everyone stalled at once - thrash / device saturation), which
	// fires meaningfully earlier than an OOM-adjacent heap ratio.
	// cpuThrottledRatio is the fraction of the sample window the CFS quota
	// held the whole process suspended.
	psiCpuSome: 60,
	psiMemoryFull: 15,
	psiIoFull: 50,
	cpuThrottledRatio: 0.25
};

/**
 * Sample once: read counters, fold them into the snapshot, fire listeners
 * iff `reason` changed. Called by the 1 Hz timer; also extracted so a test
 * harness can drive samples directly without spinning real timers.
 *
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, sampleIntervalMs: number, topicPublishRatePerSec: number | false, topicPublishBytesPerSec: number | false }} thresholds
 */
function samplePressure(thresholds) {
	const interval = thresholds.sampleIntervalMs / 1000;
	const publishRate = interval > 0 ? counters.publishCountWindow / interval : 0;
	counters.publishCountWindow = 0;

	const connections = wsConnections.size;
	const subscriberRatio = connections > 0 ? counters.totalSubscriptions / connections : 0;

	const mem = process.memoryUsage();
	const heapUsedRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
	const memoryMB = mem.rss / (1024 * 1024);

	// Kernel signals for this window. Null per source when unavailable; the
	// sample fields stay absent then, so every downstream comparison and the
	// saturation fold skip them without a branch of their own.
	const os = osPressure.sample(thresholds.sampleIntervalMs);
	/** @type {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number, psiCpuSome10?: number, psiMemoryFull10?: number, psiIoFull10?: number, cpuThrottledRatio?: number }} */
	const sampleReadings = { heapUsedRatio, publishRate, subscriberRatio };
	if (os.psi !== null) {
		sampleReadings.psiCpuSome10 = os.psi.cpuSome10;
		sampleReadings.psiMemoryFull10 = os.psi.memoryFull10;
		sampleReadings.psiIoFull10 = os.psi.ioFull10;
	}
	if (os.cpuThrottle !== null) {
		sampleReadings.cpuThrottledRatio = os.cpuThrottle.throttledRatio;
	}

	// Drain per-topic counters into per-second rates. The pure helper
	// reads but does not mutate; we clear the source map after to start
	// the next window fresh.
	const { topPublishers, overThreshold } = computeTopPublishers(
		topicPublishStats, interval, thresholds
	);
	topicPublishStats.clear();

	const reason = computePressureReason(sampleReadings, thresholds);
	counters.lastBasePressureReason = reason;
	// Layer the protection posture's CAPACITY reason on top of the pure
	// pressure reason. When no posture is engaged this is byte-identical to
	// the base reason. The level read here is the one the gate enforced during
	// the window just measured; the posture advances for the NEXT sample below.
	const effectiveReason = counters.activePosture !== null
		? applyCapacityReason(reason, counters.activePosture.level)
		: reason;

	// Fold a worker-global 0..1 saturation scalar into `value`. Each active
	// threshold contributes its sample's distance toward the threshold
	// (worst-of), clamped to 0..1; a fully healthy worker reads 0. The worst
	// per-connection send-gate reading observed since the last sample is
	// folded in worst-of too, so a saturated opted-in connection lifts the
	// worker value even while the global counters look calm. The peak is then
	// decayed so a single spike does not stick across samples.
	const value = samplePressureValue(
		sampleReadings,
		thresholds,
		counters.leaseSaturationPeak
	);
	counters.leaseSaturationPeak *= 0.5;

	const transitioned = effectiveReason !== pressureSnapshot.reason;
	pressureSnapshot.value = value;
	pressureSnapshot.subscriberRatio = subscriberRatio;
	pressureSnapshot.publishRate = publishRate;
	pressureSnapshot.memoryMB = memoryMB;
	pressureSnapshot.reason = effectiveReason;
	pressureSnapshot.active = effectiveReason !== 'NONE';
	pressureSnapshot.topPublishers = topPublishers;
	// Kernel readings ride the snapshot (platform.pressure / introspect /
	// the posture export) as small stable objects; null when unavailable.
	pressureSnapshot.psi = os.psi;
	pressureSnapshot.cpuThrottle = os.cpuThrottle;

	// Advance the posture once per sample, AFTER folding the snapshot - the
	// level just read drove this sample's reason; the tick decides the next.
	// Rides the existing pressure timer, so no new timer is introduced. The
	// posture must read the BASE pressure signal, not the CAPACITY-layered one:
	// once the level is engaged, `effectiveReason` is forced to CAPACITY every
	// sample, so feeding the layered activity back would mean the relaxation
	// dwell never sees a calm sample and the level could never relax. The base
	// `reason` is the true load signal that drives both directions.
	if (counters.activePosture !== null) counters.activePosture.tick({ active: reason !== 'NONE' });

	// Sample the admission gauges on the same cadence. Null unless a metrics
	// registry is configured, so the zero-config sampler is unchanged.
	if (counters.metricsSampleHook !== null) counters.metricsSampleHook();

	// Push the posture line to export subscribers on the same cadence (the
	// 1 Hz heartbeat is the export contract: silence means the adapter is
	// gone). Null unless a posture export is configured.
	if (counters.postureExportHook !== null) counters.postureExportHook();

	if (transitioned) {
		for (const cb of pressureListeners) {
			try {
				cb(pressureSnapshot);
			} catch (err) {
				console.error('[pressure] listener threw:', err);
			}
		}
	}

	if (overThreshold.length > 0) {
		if (publishRateListeners.size > 0) {
			for (const cb of publishRateListeners) {
				try {
					cb(overThreshold);
				} catch (err) {
					console.error('[pressure] publish-rate listener threw:', err);
				}
			}
		} else {
			// Default: throttled console.warn per topic so a sustained
			// runaway does not flood the log. Suppressed entirely when
			// the user has registered an onPublishRate callback - they
			// own the surface at that point.
			const t = now();
			for (const e of overThreshold) {
				const last = lastPublishWarnAt.get(e.topic) || 0;
				if (t - last < 60_000) continue;
				// FIFO-evict the oldest entry once at cap. Pure dedup
				// state, so dropping the oldest just resets the warn
				// throttle for that topic on its next over-threshold
				// publish - no correctness impact.
				if (lastPublishWarnAt.size >= PUBLISH_WARN_DEDUP_MAX && !lastPublishWarnAt.has(e.topic)) {
					const oldest = lastPublishWarnAt.keys().next().value;
					if (oldest !== undefined) lastPublishWarnAt.delete(oldest);
				}
				lastPublishWarnAt.set(e.topic, t);
				console.warn(
					'[ws] runaway publisher topic=%s msg/s=%d bytes/s=%d\n  See: https://svti.me/pressure',
					e.topic, Math.round(e.messagesPerSec), Math.round(e.bytesPerSec)
				);
			}
		}
	}
}

/**
 * Size the next send-gate window for an opted-in connection. Derived from the
 * same inputs that drive pressure: heap headroom and subscriber load narrow
 * the window so a tightening worker hands out smaller windows. Zero-config
 * defaults; never user exposed. Always floors to a window large enough that a
 * connection makes forward progress.
 *
 * @returns {{ count: number, ttlMs: number }}
 */
export function grantSizeFor() {
	const mem = process.memoryUsage();
	const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
	const conns = wsConnections.size || 1;
	const subRatio = counters.totalSubscriptions / conns;
	const count = leaseGrantSize({ heapRatio, subscriberRatio: subRatio });
	return { count, ttlMs: DEFAULT_GRANT.ttlMs };
}

/**
 * Merge user-supplied pressure options on top of the safe defaults. Each
 * threshold accepts `false` to disable that signal. `sampleIntervalMs` is
 * clamped to a sane minimum to avoid pathological tight-loop sampling if
 * a user passes 0 or a negative number.
 *
 * @param {{ memoryHeapUsedRatio?: number | false, publishRatePerSec?: number | false, subscriberRatio?: number | false, sampleIntervalMs?: number, topicPublishRatePerSec?: number | false, topicPublishBytesPerSec?: number | false } | undefined} opts
 */
export function resolvePressureThresholds(opts) {
	const merged = { ...DEFAULT_PRESSURE_THRESHOLDS, ...(opts || {}) };
	if (typeof merged.sampleIntervalMs !== 'number' || merged.sampleIntervalMs < 100) {
		merged.sampleIntervalMs = DEFAULT_PRESSURE_THRESHOLDS.sampleIntervalMs;
	}
	return merged;
}

/**
 * Start the 1 Hz pressure sampler. Idempotent: a second call replaces the
 * existing timer with a new one using the supplied thresholds.
 *
 * @param {Parameters<typeof resolvePressureThresholds>[0]} opts
 */
export function startPressureSampling(opts) {
	const thresholds = resolvePressureThresholds(opts);
	if (pressureTimer) clearIntervalTimer(pressureTimer);
	pressureTimer = setIntervalTimer(() => samplePressure(thresholds), thresholds.sampleIntervalMs);
	if (typeof pressureTimer.unref === 'function') pressureTimer.unref();
}

export function stopPressureSampling() {
	if (pressureTimer) {
		clearIntervalTimer(pressureTimer);
		pressureTimer = null;
	}
}
