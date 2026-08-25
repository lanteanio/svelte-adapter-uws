/**
 * Distance to the nearest memory wall: the basis of the MEMORY signal.
 *
 * `heapUsed / heapTotal` is V8 arena fullness, not memory pressure: V8 keeps
 * the arena sized to current usage plus modest headroom, so an idle process
 * naturally reads 60-90% full of a tiny heap and the MEMORY signal fires on
 * a sleeping server. The quantity that is monotone in real memory pressure
 * is distance to the wall the process can actually die at - and each wall
 * kills on its own quantity, so each is measured with its own numerator:
 *
 * - the V8 wall: `heapUsed` against `v8.getHeapStatistics().heap_size_limit`,
 *   the old-space ceiling allocation failure crashes into;
 * - the container wall: `rss` against the cgroup memory limit, because the
 *   kernel's OOM killer charges the whole resident set - heap, native
 *   allocations, code pages - never the JS heap alone. Measuring `heapUsed`
 *   against this wall would read 0.7-0.8 at the moment of the kill on a
 *   stack that carries native memory, which is a signal that never fires.
 *
 * The reported ratio is the worst of the walls that exist, clamped to
 * 0..1: idle reads a few percent, and it approaches 1 as the worker
 * approaches whichever out-of-memory death is nearest. A slow purely-native
 * leak on an uncontained host is still PSI memory pressure's and
 * `resident_memory_bytes`' job - no cgroup means no rss wall to measure.
 *
 * Discovery follows the os-pressure idiom, once: the cgroup limit file is
 * located on first read - at the cgroup root (the container default, where a
 * private cgroup namespace presents the pod limit there) and, where
 * `/proc/self/cgroup` names a deeper path that is visible (a host cgroup
 * namespace), at the process's own group and its ancestors, latching the
 * file with the tightest limit. A confirmed absence (non-Linux, no memory
 * controller) permanently stops the reads; ANY unresolved read keeps
 * discovery armed, whatever the other candidates said, because a probe that
 * could not see one group cannot know it found the tightest wall - it reports
 * the best wall it did see and looks again next sample. So "once" holds for a
 * clean probe; where a candidate keeps failing in some way other than absence,
 * the probe repeats per sample for as long as that lasts, which is bounded by
 * the candidate count and costs a handful of small reads at the sampler's
 * cadence. After discovery, one file is re-read per sample so a runtime edit
 * of the limit VALUE is tracked; regrouping the process is not, and a latched
 * file that stops reading re-probes on the spot rather than reporting no wall.
 * The V8 limit is latched once and treated as fixed for the process life.
 *
 * Determinism: no clock, no RNG, no timers. The 1 Hz pressure sampler is
 * the only caller; nothing here sits on a frame path.
 *
 * @module svelte-adapter-uws/runtime/utils/memory-wall
 */

import { readFileSync } from 'node:fs';
import v8 from 'node:v8';

const CGROUP_ROOT = '/sys/fs/cgroup';
const SELF_CGROUP = '/proc/self/cgroup';

// cgroup v1 reports "unlimited" as a page-rounded near-2^63 sentinel rather
// than a word. Anything at or above this is no wall at all.
const V1_UNLIMITED_FLOOR = 2 ** 62;

// How many path segments of the process's own cgroup are considered when a
// host cgroup namespace exposes a deep path. A real container nests a
// handful of levels; the cap only bounds a pathological /proc line.
const MAX_CGROUP_DEPTH = 16;

function isConfirmedAbsence(error) {
	const code = error?.code ?? String(error?.message ?? error).split(/[:\s]/, 1)[0];
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENOSYS';
}

/**
 * Parse one cgroup memory-limit file. Returns the limit in bytes, or null
 * when the file says the group is unlimited (`max` in v2, the near-2^63
 * sentinel in v1) or carries anything unparseable.
 *
 * @param {string} content
 * @returns {number | null}
 */
export function parseCgroupMemoryLimit(content) {
	const text = String(content).trim();
	if (text === 'max') return null;
	if (!/^\d+$/.test(text)) return null;
	const bytes = Number(text);
	if (!Number.isFinite(bytes) || bytes <= 0 || bytes >= V1_UNLIMITED_FLOOR) return null;
	return bytes;
}

/**
 * The candidate limit-file paths for this process, nearest group first. Built
 * from `/proc/self/cgroup` (its v2 `0::` line and v1 `memory` controller
 * line) plus the two root spellings, so the container default (private
 * namespace, limit at the root) and the host-namespace shape (limit at the
 * process's own group or an ancestor) are both covered. Pure: the caller
 * supplies the /proc content (or null when unreadable).
 *
 * @param {string | null} selfCgroupContent
 * @returns {string[]}
 */
export function cgroupMemoryLimitCandidates(selfCgroupContent) {
	/** @type {string[]} */
	const candidates = [];
	const push = (p) => { if (!candidates.includes(p)) candidates.push(p); };
	const ancestorsOf = (raw) => {
		const clean = String(raw).replace(/^\/+|\/+$/g, '');
		if (clean === '') return [];
		const segments = clean.split('/');
		// Deepest prefixes first (the process's own group, then its ancestors);
		// the cap bounds a pathological /proc line while keeping the nearest
		// groups, which are the ones a limit most plausibly sits on.
		const floor = Math.max(0, segments.length - MAX_CGROUP_DEPTH);
		const paths = [];
		for (let i = segments.length; i > floor; i--) paths.push(segments.slice(0, i).join('/'));
		return paths;
	};
	for (const line of String(selfCgroupContent ?? '').split('\n')) {
		const v2 = /^0::(.*)$/.exec(line);
		if (v2) {
			for (const p of ancestorsOf(v2[1])) push(`${CGROUP_ROOT}/${p}/memory.max`);
			continue;
		}
		const v1 = /^\d+:([^:]*):(.*)$/.exec(line);
		if (v1 && v1[1].split(',').includes('memory')) {
			for (const p of ancestorsOf(v1[2])) push(`${CGROUP_ROOT}/memory/${p}/memory.limit_in_bytes`);
		}
	}
	push(`${CGROUP_ROOT}/memory.max`);
	push(`${CGROUP_ROOT}/memory/memory.limit_in_bytes`);
	return candidates;
}

/**
 * The worst-of fold across the walls that exist, clamped to 0..1. Pure and
 * total: an unknown wall contributes nothing, and no known wall reads 0.
 *
 * @param {{ heapUsed: number, rss: number, heapSizeLimit: number | null, cgroupLimitBytes: number | null }} w
 * @returns {number}
 */
export function memoryWallRatio(w) {
	let ratio = 0;
	if (w.heapSizeLimit !== null && w.heapSizeLimit > 0 && w.heapUsed > 0) {
		const r = w.heapUsed / w.heapSizeLimit;
		if (r > ratio) ratio = r;
	}
	if (w.cgroupLimitBytes !== null && w.cgroupLimitBytes > 0 && w.rss > 0) {
		const r = w.rss / w.cgroupLimitBytes;
		if (r > ratio) ratio = r;
	}
	return ratio > 1 ? 1 : ratio;
}

/**
 * Stateful reader the pressure sampler holds. `ratio({ heapUsed, rss })`
 * returns the worst-of wall reading, or 0 when no wall is known.
 *
 * @param {{
 *   readFile?: (path: string) => string,
 *   heapStatistics?: () => { heap_size_limit: number }
 * }} [deps] injectable for tests; defaults read the real cgroup files and
 *   the real isolate.
 */
export function createMemoryWallReader(deps) {
	const readFile = deps?.readFile ?? ((path) => readFileSync(path, 'utf8'));
	const heapStatistics = deps?.heapStatistics ?? (() => v8.getHeapStatistics());

	/** @type {number | null | undefined} undefined = not latched yet */
	let heapSizeLimit;
	/** @type {string | null | false} false = probed, none found */
	let limitPath = null;

	/**
	 * @param {boolean} [mayConfirmAbsence] false when this probe follows the
	 *   loss of a file that WAS carrying a limit. A wall already observed
	 *   cannot be argued out of existence by one sweep that missed it: the
	 *   group was reconfigured, not proven controller-less, so such a probe
	 *   may report and re-latch but never take the permanent stop.
	 */
	function discoverLimit(mayConfirmAbsence = true) {
		let uncertain = false;
		/** @type {string | null} */
		let selfContent = null;
		try {
			selfContent = readFile(SELF_CGROUP);
		} catch (error) {
			// A hidden candidate LIST is as blinding as a hidden candidate file:
			// only a confirmed absence may let an unlimited-only outcome latch.
			if (!isConfirmedAbsence(error)) uncertain = true;
		}
		/** @type {{ path: string, limit: number | null } | null} */
		let tightest = null;
		for (const path of cgroupMemoryLimitCandidates(selfContent)) {
			try {
				const limit = parseCgroupMemoryLimit(readFile(path));
				if (limit !== null && (tightest === null || tightest.limit === null || limit < tightest.limit)) {
					tightest = { path, limit };
				} else if (tightest === null) {
					// A readable file that says "unlimited": remember it so a
					// clean probe still latches somewhere and later value edits
					// are seen.
					tightest = { path, limit: null };
				}
			} catch (error) {
				if (!isConfirmedAbsence(error)) uncertain = true;
			}
		}
		// A candidate answered, so report the best wall known right now. LATCHING
		// it is a separate decision, and it needs a CLEAN probe: an uncertain
		// read may be hiding a nearer, tighter group's file, and pinning a
		// looser ancestor over it would under-report pressure for the life of
		// the process - the signal would then sit low while the worker walks
		// into the kill its own wall was supposed to predict. The same argument
		// covers an unlimited-only outcome, so both share one rule. An
		// uncertain probe uses the value and stays armed, re-reading the nearer
		// candidates on the next sample; a confirmed absence still stops the
		// reads for good below.
		if (tightest !== null) {
			if (!uncertain) limitPath = tightest.path;
			return tightest.limit;
		}
		// Every candidate confirmed absent: stop reading for good. A transient
		// error keeps discovery armed for the next sample.
		if (!uncertain && tightest === null && mayConfirmAbsence) limitPath = false;
		return null;
	}

	function readCgroupLimit() {
		if (limitPath === false) return null;
		if (limitPath === null) return discoverLimit();
		try {
			return parseCgroupMemoryLimit(readFile(limitPath));
		} catch {
			// The discovered file failed this tick (cgroup reconfigured away).
			// Re-arm discovery rather than pinning a dead path, and probe again
			// NOW: answering null here would drop the container arm for this
			// sample and report only the heap arm - a few percent while the
			// resident set sits against a wall it is about to hit. A read is
			// most likely to fail under exactly the memory event the signal
			// exists to report, so the sample that loses its wall is the one
			// that can least afford to. The probe may not conclude absence: a
			// wall this reader has already seen was reconfigured, not proven
			// never to have existed. discoverLimit never calls back here.
			limitPath = null;
			return discoverLimit(false);
		}
	}

	return {
		/**
		 * @param {{ heapUsed: number, rss: number }} mem bytes, from
		 *   `process.memoryUsage()`
		 * @returns {number} 0..1
		 */
		ratio(mem) {
			if (heapSizeLimit === undefined) {
				try {
					const limit = heapStatistics().heap_size_limit;
					heapSizeLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
				} catch {
					heapSizeLimit = null;
				}
			}
			return memoryWallRatio({
				heapUsed: mem.heapUsed,
				rss: mem.rss,
				heapSizeLimit: heapSizeLimit ?? null,
				cgroupLimitBytes: readCgroupLimit()
			});
		}
	};
}
