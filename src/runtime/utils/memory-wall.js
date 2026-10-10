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
 * Every sample sweeps the candidate limit files and takes the tightest: the
 * cgroup root (the container default, where a private cgroup namespace
 * presents the pod limit there) and, where `/proc/self/cgroup` names a deeper
 * path that is visible (a host cgroup namespace), the process's own group and
 * each ancestor whose limit applies to it (see cgroupMemoryLimitCandidates
 * and bindingCandidates for the two shapes where one does not) - any of
 * which can be the wall. Sweeping rather than latching one file is what keeps
 * the answer right when the groups change under a live process: an ancestor
 * lowered, a group raised above its parent. That costs one small read per
 * candidate each sample - two in the container default, a handful in a host
 * namespace, bounded by MAX_CGROUP_DEPTH - the same order as the PSI and
 * cpu.stat reads the sampler already makes.
 *
 * The group list itself is read far less often. On most kernels in service,
 * reading `/proc/self/cgroup` takes the kernel's global cgroup lock, which
 * cgroup churn elsewhere on the host can hold long enough to stall the event
 * loop this sampler runs on. So the list is read on the first sample, again
 * on each sample after a read of it fails, and every GROUP_LIST_EVERY samples
 * - and at once, with that sample swept again on the list as it then reads,
 * when a file this reader had read is confirmed gone on a pass that did not
 * read the list. A group with members cannot be removed, so that is the
 * process moving, or the memory controller switched off above a group,
 * which costs one extra list read and changes nothing. A move that removes
 * no file this reader had read goes unseen until the next scheduled read, so
 * any change of membership is followed within GROUP_LIST_EVERY samples.
 *
 * A file that fails to read for any reason other than absence stands at the
 * value it was last read at, so the wall it carried holds through the
 * failure instead of dropping out of the fold. A read is most likely to fail
 * under exactly the memory event the signal exists to report, and a dropped
 * wall reads 0 - or a looser ancestor's wall - while every consumer of the
 * reading flaps with it at the sample cadence. Every readable file is re-read
 * each sample, so what stands is current up to the failure. A reading is
 * forgotten when its file is confirmed absent, or when a group list that
 * reads no longer names it: the process left that group. A list that does
 * not read says nothing about where the process lives, so the sweep uses the
 * last list that did.
 *
 * The reads stop for good only where cgroups cannot appear: the group list
 * and every limit file confirmed absent (non-Linux) on a reader that has
 * never read either. A host with cgroups keeps sweeping even with no limit
 * anywhere, because a limit can be set on a running service (`systemctl
 * set-property ... MemoryMax=`) and the reading has to see it; that costs a
 * few failed opens per sample.
 *
 * The engine ceiling, where one exists, is latched once and treated as fixed
 * for the process life.
 *
 * A "sample" below is one read of the reader: a pressure-sampler tick, or a
 * metrics scrape on a build where no sampler runs.
 *
 * Determinism: no clock, no RNG, no timers. The 1 Hz pressure sampler and,
 * where it does not run, the metrics scrape are the callers; nothing here
 * sits on a frame path.
 *
 * @module svelte-adapter-uws/runtime/utils/memory-wall
 */

import { readFileSync } from 'node:fs';
import v8 from 'node:v8';

const CGROUP_ROOT = '/sys/fs/cgroup';
const V2_ROOT = `${CGROUP_ROOT}/memory.max`;
const V1_ROOT = `${CGROUP_ROOT}/memory/memory.limit_in_bytes`;
const SELF_CGROUP = '/proc/self/cgroup';

// cgroup v1 reports "unlimited" as a page-rounded near-2^63 sentinel rather
// than a word. Anything at or above this is no wall at all.
const V1_UNLIMITED_FLOOR = 2 ** 62;

// How many path segments of the process's own cgroup are considered when a
// host cgroup namespace exposes a deep path. A real container nests a
// handful of levels; the cap only bounds a pathological /proc line.
const MAX_CGROUP_DEPTH = 16;

/**
 * Samples between scheduled reads of `/proc/self/cgroup`: a minute at the
 * sampler's 1 Hz, and no less on a build with no sampler, whose scrape reads
 * at most once a second.
 */
export const GROUP_LIST_EVERY = 60;

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
 * A hierarchy whose path starts with `..` contributes nothing, its root
 * included: the kernel spells a group outside the reader's cgroup namespace
 * that way. The path is relative to a namespace root the process is not
 * under, so it maps to no file, and that root's limit does not apply to the
 * process. Where the mount shows the host root instead, that root carries no
 * limit (v2 has no memory.max there, and v1 cannot set one), so dropping it
 * loses nothing.
 *
 * Only the first line of each hierarchy counts, as a real kernel writes one,
 * so the list is bounded at MAX_CGROUP_DEPTH per hierarchy plus the two roots
 * whatever the content.
 *
 * @param {string | null} selfCgroupContent
 * @returns {string[]}
 */
export function cgroupMemoryLimitCandidates(selfCgroupContent) {
	/** @type {string[]} */
	const candidates = [];
	const push = (p) => { if (!candidates.includes(p)) candidates.push(p); };
	/** @param {string} raw @returns {string[] | null} null when outside the namespace */
	const ancestorsOf = (raw) => {
		const clean = String(raw).replace(/^\/+|\/+$/g, '');
		if (clean === '') return [];
		const segments = clean.split('/');
		if (segments[0] === '..') return null;
		// Deepest prefixes first (the process's own group, then its ancestors);
		// the cap bounds a pathological /proc line while keeping the nearest
		// groups, which are the ones a limit most plausibly sits on.
		const floor = Math.max(0, segments.length - MAX_CGROUP_DEPTH);
		const paths = [];
		for (let i = segments.length; i > floor; i--) paths.push(segments.slice(0, i).join('/'));
		return paths;
	};
	/** @type {string[] | null | undefined} undefined = no line seen */
	let v2Paths;
	/** @type {string[] | null | undefined} */
	let v1Paths;
	for (const line of String(selfCgroupContent ?? '').split('\n')) {
		const v2 = /^0::(.*)$/.exec(line);
		if (v2) {
			if (v2Paths === undefined) v2Paths = ancestorsOf(v2[1]);
			continue;
		}
		const v1 = /^\d+:([^:]*):(.*)$/.exec(line);
		if (v1 && v1[1].split(',').includes('memory') && v1Paths === undefined) v1Paths = ancestorsOf(v1[2]);
	}
	for (const p of v2Paths ?? []) push(`${CGROUP_ROOT}/${p}/memory.max`);
	for (const p of v1Paths ?? []) push(`${CGROUP_ROOT}/memory/${p}/memory.limit_in_bytes`);
	if (v2Paths !== null) push(V2_ROOT);
	if (v1Paths !== null) push(V1_ROOT);
	return candidates;
}

/**
 * Drop the cgroup v1 ancestors whose limit does not apply to the process. A
 * v1 memory group charges its descendants, and so enforces its limit on
 * them, only in hierarchical mode (`memory.use_hierarchy` 1). systemd turns
 * it on at the root and kernels have since dropped the other mode, but an
 * older host without systemd can leave an ancestor non-hierarchical, and its
 * limit then binds only the tasks directly in it.
 *
 * Two candidates are never checked. The process's own group - the first v1
 * candidate, nearest first - applies whatever its flag. And the v1 root: in a
 * container on the host cgroup namespace, the v1 default, the runtime
 * bind-mounts the container's own group there while `/proc/self/cgroup`
 * keeps the host path, so the root IS the own group and the path-built
 * candidates do not exist; on a host, the v1 root's limit cannot be set, so
 * keeping it never adds a wall. Only an explicit 0 drops a group; a flag that
 * cannot be read, or reads anything else, keeps it - folding in a wall that
 * might not apply is the safer error than missing one that does. The flag
 * cannot change on a group with children, so this runs per group-list read,
 * not per sample.
 *
 * @param {string[]} candidates from cgroupMemoryLimitCandidates
 * @param {(path: string) => string} readFile
 * @returns {string[]}
 */
export function bindingCandidates(candidates, readFile) {
	let own = true;
	return candidates.filter((path) => {
		if (!path.endsWith('/memory.limit_in_bytes')) return true;
		if (path === V1_ROOT) return true;
		if (own) {
			own = false;
			return true;
		}
		try {
			return readFile(path.replace(/memory\.limit_in_bytes$/, 'memory.use_hierarchy')).trim() !== '0';
		} catch {
			return true;
		}
	});
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
 * Stateful reader. `ratio({ heapUsed, rss })` returns the worst-of wall
 * reading, or 0 when no wall is known.
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
	// Cgroups cannot appear here (no group list, no limit file, nothing ever
	// read), so the sweep stops for good.
	let stopped = false;
	/**
	 * The value each candidate file was last read at (null = unlimited), so a
	 * file that fails to read can stand at it.
	 * @type {Map<string, number | null>}
	 */
	const lastRead = new Map();
	/** @type {string[] | null} the candidates of the last group list that read */
	let lastList = null;
	let listDue = true;
	let sinceList = 0;
	// A group list or a limit file has answered a read: this host has cgroups,
	// and a limit can be set on a running process at any time, so no sweep that
	// finds every file absent may stop the reads.
	let sawCgroups = false;

	/**
	 * One pass: the group list if it is due, then every candidate limit file.
	 * @returns {{ tightest: number | null, uncertain: boolean, listed: boolean, moved: boolean }}
	 */
	function sweep() {
		// A read that failed in a way that proves nothing may have hidden the one
		// file that exists, so a sweep with one can never stop the reads.
		let uncertain = false;
		let listed = false;
		let moved = false;
		/** @type {string[]} */
		let candidates;
		if (listDue) {
			try {
				candidates = bindingCandidates(cgroupMemoryLimitCandidates(readFile(SELF_CGROUP)), readFile);
				listed = true;
				lastList = candidates;
				listDue = false;
				sinceList = 0;
				sawCgroups = true;
				// A list that read is authoritative: a group not on it is one the
				// process has left, and that group's wall no longer applies.
				for (const path of lastRead.keys()) if (!candidates.includes(path)) lastRead.delete(path);
			} catch (error) {
				if (!isConfirmedAbsence(error)) uncertain = true;
				// No list says nothing about where the process lives, so sweep the
				// last one that read rather than collapse to the roots and drop the
				// process's own group. A reader that never read one has the roots.
				candidates = lastList ?? cgroupMemoryLimitCandidates(null);
			}
		} else {
			candidates = /** @type {string[]} */ (lastList);
		}
		/** @type {number | null} */
		let tightest = null;
		for (const path of candidates) {
			/** @type {number | null} */
			let limit;
			try {
				limit = parseCgroupMemoryLimit(readFile(path));
				lastRead.set(path, limit);
				sawCgroups = true;
			} catch (error) {
				if (isConfirmedAbsence(error)) {
					// A group with members cannot be removed, so a file this reader
					// has read going away means the process moved, or the memory
					// controller was switched off above the group: read the list
					// again now. Not on a pass that just read it - that list is
					// current and still names the group.
					if (lastRead.delete(path) && !listed) {
						listDue = true;
						moved = true;
					}
					continue;
				}
				uncertain = true;
				const last = lastRead.get(path);
				if (last === undefined) continue;
				limit = last;
			}
			if (limit !== null && (tightest === null || limit < tightest)) tightest = limit;
		}
		return { tightest, uncertain, listed, moved };
	}

	/** @returns {number | null} the tightest limit in bytes, or null for none */
	function readCgroupLimit() {
		if (stopped) return null;
		if (!listDue && ++sinceList >= GROUP_LIST_EVERY) listDue = true;
		let pass = sweep();
		// A file this reader had read is gone and this pass swept a list that
		// may be the one the process moved from: read the list and sweep again
		// now, so the sample does not go out without the group the process
		// lives in. At most once per sample; if the list cannot be read, the
		// second pass sweeps the old one again.
		if (pass.moved) pass = sweep();
		if (!pass.uncertain && !sawCgroups) stopped = true;
		return pass.tightest;
	}

	function latchEngineLimit() {
		if (heapSizeLimit !== undefined) return;
		try {
			const limit = heapStatistics().heap_size_limit;
			heapSizeLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
		} catch {
			heapSizeLimit = null;
		}
	}

	/**
	 * @param {{ heapUsed: number, rss: number }} mem
	 * @returns {number | null} 0..1, or null when neither wall is known
	 */
	function measure(mem) {
		latchEngineLimit();
		const cgroupLimitBytes = readCgroupLimit();
		if (heapSizeLimit === null && cgroupLimitBytes === null) return null;
		return memoryWallRatio({
			heapUsed: mem.heapUsed,
			rss: mem.rss,
			heapSizeLimit: heapSizeLimit ?? null,
			cgroupLimitBytes
		});
	}

	return {
		measure,
		/** A latched engine ceiling makes wall availability permanent. */
		hasEngineLimit() { latchEngineLimit(); return heapSizeLimit !== null; },
		/** @param {{ heapUsed: number, rss: number }} mem @returns {number} 0..1 */
		ratio(mem) { return measure(mem) ?? 0; }
	};
}
