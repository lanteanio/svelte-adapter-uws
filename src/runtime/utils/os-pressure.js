/**
 * Kernel-level pressure sources for the protection posture: PSI stall time
 * and cgroup CPU-quota throttling.
 *
 * The existing pressure inputs (heap ratio, publish rate, subscriber ratio)
 * are process-local proxies. The kernel publishes two sharper signals this
 * module samples at the same 1 Hz cadence:
 *
 * - PSI (/proc/pressure/{cpu,memory,io}): the fraction of wall time tasks
 *   spent STALLED on a contended resource over the last 10s. "some" = at
 *   least one task stalled; "full" = every non-idle task stalled at once
 *   (for memory that is thrash, for io a device saturated). A rising PSI
 *   catches an overload the heap ratio cannot see - CPU contention from a
 *   noisy neighbor, memory pressure absorbed by reclaim before OOM, an io
 *   device pinning the event loop.
 * - cgroup cpu.stat (nr_throttled / throttled_usec): time the container's
 *   CFS quota SUSPENDED the whole process. A quota-throttled worker is not
 *   contended, it is stopped - PSI "some" can miss it entirely, which is
 *   why it is a distinct signal with its own reason.
 *
 * Both sources are probed once: a read failure (non-Linux, PSI compiled
 * out, no cgroup limits) permanently disables that source at zero further
 * cost, so the zero-config path off-Linux is a single failed read per
 * source at startup. Parsers are pure and exported for tests; the sampler
 * takes an injectable read function so tests drive fixture strings.
 *
 * Determinism: no clock, no RNG, no timers - the caller's 1 Hz sampler
 * drives `sample(intervalMs)` and supplies the window length for the
 * throttle-ratio math.
 *
 * @module svelte-adapter-uws/runtime/utils/os-pressure
 */

import { readFileSync } from 'node:fs';

const PSI_FILES = {
	cpu: '/proc/pressure/cpu',
	memory: '/proc/pressure/memory',
	io: '/proc/pressure/io'
};

// cgroup v2 first (the modern default), then the two v1 layouts.
const CPU_STAT_PATHS = [
	'/sys/fs/cgroup/cpu.stat',
	'/sys/fs/cgroup/cpu/cpu.stat',
	'/sys/fs/cgroup/cpu,cpuacct/cpu.stat'
];

/**
 * Which kernel pressure sources this host exposes.
 *
 * Probed once at startup so the metric instruments for these readings can be
 * registered at startup like every other one. Registering them lazily on the
 * first reading instead would move instrument creation into a 1 Hz timer
 * callback, where a registry that throws while creating an instrument - a
 * configuration fault that is meant to fail loudly at boot - becomes an
 * uncaught exception on every tick, and a registry that returns nothing
 * becomes an endless re-registration attempt.
 *
 * Two file reads on Linux, two failed opens elsewhere, once per worker.
 *
 * @param {{ readFile?: (path: string) => string }} [deps]
 * @returns {{ psi: boolean, cpuThrottle: boolean }}
 */
export function probeOsPressureSources(deps) {
	const readFile = deps?.readFile ?? ((path) => readFileSync(path, 'utf8'));
	let psi = false;
	try {
		readFile(PSI_FILES.cpu);
		readFile(PSI_FILES.memory);
		readFile(PSI_FILES.io);
		psi = true;
	} catch { /* not a PSI-enabled kernel */ }
	let cpuThrottle = false;
	for (const path of CPU_STAT_PATHS) {
		try {
			if (parseCpuStat(readFile(path)) !== null) {
				cpuThrottle = true;
				break;
			}
		} catch { /* try the next layout */ }
	}
	return { psi, cpuThrottle };
}

/**
 * Parse one PSI file. Returns the avg10 percentages for the `some` and
 * `full` lines (older kernels omit `full` for cpu - reads as 0).
 *
 * @param {string} content
 * @returns {{ some10: number, full10: number }}
 */
export function parsePsi(content) {
	let some10 = 0;
	let full10 = 0;
	for (const line of String(content).split('\n')) {
		const m = /^(some|full)\s+avg10=([0-9.]+)/.exec(line);
		if (!m) continue;
		const v = parseFloat(m[2]);
		if (!Number.isFinite(v)) continue;
		if (m[1] === 'some') some10 = v; else full10 = v;
	}
	return { some10, full10 };
}

/**
 * Parse a cgroup cpu.stat file. Normalizes v1 (`throttled_time`,
 * nanoseconds) and v2 (`throttled_usec`, microseconds) to microseconds.
 * Returns null when the file carries no throttling fields at all (an
 * unlimited cgroup still reports zeros - that parses fine).
 *
 * @param {string} content
 * @returns {{ nrThrottled: number, throttledUsec: number } | null}
 */
export function parseCpuStat(content) {
	let nrThrottled = null;
	let throttledUsec = null;
	for (const line of String(content).split('\n')) {
		const m = /^(nr_throttled|throttled_usec|throttled_time)\s+(\d+)/.exec(line);
		if (!m) continue;
		const v = Number(m[2]);
		if (!Number.isFinite(v)) continue;
		if (m[1] === 'nr_throttled') nrThrottled = v;
		else if (m[1] === 'throttled_usec') throttledUsec = v;
		else throttledUsec = v / 1000; // throttled_time is nanoseconds (v1)
	}
	if (nrThrottled === null && throttledUsec === null) return null;
	return { nrThrottled: nrThrottled ?? 0, throttledUsec: throttledUsec ?? 0 };
}

/**
 * Stateful sampler over both sources. `sample(intervalMs)` returns
 *
 *   {
 *     psi: { cpuSome10, memoryFull10, ioFull10 } | null,
 *     cpuThrottle: { throttledRatio, nrThrottledDelta } | null
 *   }
 *
 * where `throttledRatio` is the fraction of the sampled window the quota
 * held the process suspended (delta of throttled_usec over the window) and
 * null marks a source that is unavailable on this host. The first
 * cpu.stat sample establishes the delta baseline and reports zeros.
 *
 * @param {{ readFile?: (path: string) => string }} [deps]
 */
export function createOsPressureSampler(deps) {
	const readFile = deps?.readFile ?? ((path) => readFileSync(path, 'utf8'));

	/** @type {boolean | null} null = not probed yet */
	let psiAvailable = null;
	/** @type {string | null | false} false = probed, none found */
	let cpuStatPath = null;
	/** @type {{ nrThrottled: number, throttledUsec: number } | null} */
	let lastCpuStat = null;

	function readPsi() {
		if (psiAvailable === false) return null;
		try {
			const cpu = parsePsi(readFile(PSI_FILES.cpu));
			const memory = parsePsi(readFile(PSI_FILES.memory));
			const io = parsePsi(readFile(PSI_FILES.io));
			psiAvailable = true;
			return { cpuSome10: cpu.some10, memoryFull10: memory.full10, ioFull10: io.full10 };
		} catch {
			// Only the startup probe may disable the source for good; a later
			// transient read error keeps the source armed and reports nothing
			// for this sample.
			if (psiAvailable === null) psiAvailable = false;
			return null;
		}
	}

	function readCpuStat() {
		if (cpuStatPath === false) return null;
		if (cpuStatPath === null) {
			for (const path of CPU_STAT_PATHS) {
				try {
					const parsed = parseCpuStat(readFile(path));
					if (parsed !== null) {
						cpuStatPath = path;
						return parsed;
					}
				} catch { /* try the next layout */ }
			}
			cpuStatPath = false;
			return null;
		}
		try {
			return parseCpuStat(readFile(cpuStatPath));
		} catch {
			return null;
		}
	}

	return {
		/**
		 * @param {number} intervalMs the sampled window length
		 */
		sample(intervalMs) {
			const psi = readPsi();
			let cpuThrottle = null;
			const stat = readCpuStat();
			if (stat !== null) {
				if (lastCpuStat !== null && intervalMs > 0) {
					const usecDelta = Math.max(0, stat.throttledUsec - lastCpuStat.throttledUsec);
					const nrDelta = Math.max(0, stat.nrThrottled - lastCpuStat.nrThrottled);
					cpuThrottle = {
						throttledRatio: Math.min(1, usecDelta / (intervalMs * 1000)),
						nrThrottledDelta: nrDelta
					};
				} else {
					cpuThrottle = { throttledRatio: 0, nrThrottledDelta: 0 };
				}
				lastCpuStat = stat;
			}
			return { psi, cpuThrottle };
		}
	};
}
