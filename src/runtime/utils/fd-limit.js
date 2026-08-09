import { readFileSync, readdirSync } from 'node:fs';

/**
 * File-descriptor budget probes. Node has no getrlimit binding, so the soft
 * limit comes from /proc/self/limits (Linux) with a process.report fallback
 * (other POSIX), and the open count from /proc/self/fd (Linux) or /dev/fd
 * (macOS). Every probe returns null where its source is unavailable
 * (Windows), so callers no-op instead of guessing. Worker threads share one
 * process-wide descriptor table, so these values are whole-process truths
 * regardless of which thread reads them.
 */

/**
 * Below this soft limit a socket server is one connection storm away from
 * EMFILE: each WebSocket holds one descriptor, and the classic distro default
 * of 1024 caps the process at roughly a thousand connections while the CPU
 * sits idle. 8192 clears every known low default without flagging deployments
 * that raised the limit deliberately.
 */
export const LOW_FD_SOFT_LIMIT = 8192;

/**
 * Coerce a limit value from either source into a number. Both /proc and
 * process.report spell the no-limit case as the string "unlimited".
 *
 * @param {unknown} value
 * @returns {number | null} finite count, Infinity for unlimited, null when unreadable
 */
function coerceLimit(value) {
	if (value === 'unlimited') return Infinity;
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
	return null;
}

/**
 * Parse the "Max open files" row out of /proc/self/limits content. Column
 * values never contain double spaces, so a split on runs of two or more
 * spaces yields [name, soft, hard, units] even though the name itself has
 * single spaces in it.
 *
 * @param {string} text
 * @returns {{ soft: number, hard: number } | null}
 */
export function parseProcLimits(text) {
	for (const line of text.split('\n')) {
		if (!line.startsWith('Max open files')) continue;
		const columns = line.trim().split(/\s{2,}/);
		const soft = coerceLimit(columns[1]);
		const hard = coerceLimit(columns[2]);
		if (soft === null || hard === null) return null;
		return { soft, hard };
	}
	return null;
}

/**
 * Read the process RLIMIT_NOFILE pair. /proc is preferred because it is a
 * cheap single read; process.report.getReport() collects a full diagnostic
 * report, so it only runs when /proc is absent (macOS) and only once per
 * caller. Returns null on platforms without either source (Windows).
 *
 * @returns {{ soft: number, hard: number } | null}
 */
export function readFdLimits() {
	try {
		const parsed = parseProcLimits(readFileSync('/proc/self/limits', 'utf8'));
		if (parsed !== null) return parsed;
	} catch {
		// fall through to process.report
	}
	try {
		const limits = process.report?.getReport?.()?.userLimits;
		const row = limits?.open_files ?? limits?.max_open_files;
		if (row != null) {
			const soft = coerceLimit(row.soft);
			const hard = coerceLimit(row.hard);
			if (soft !== null && hard !== null) return { soft, hard };
		}
	} catch {
		// report generation can be disabled by embedders; treat as unavailable
	}
	return null;
}

/**
 * Count the descriptors currently open by the process. The directory read
 * itself briefly opens one descriptor, which the count excludes. Returns
 * null where no fd directory exists (Windows).
 *
 * @returns {number | null}
 */
export function countOpenFds() {
	for (const dir of ['/proc/self/fd', '/dev/fd']) {
		try {
			return Math.max(0, readdirSync(dir).length - 1);
		} catch {
			// try the next source
		}
	}
	return null;
}

/**
 * Build the boot advisory for an EMFILE-prone soft limit, or null when the
 * limit is healthy or unreadable. Pure so the decision is unit-testable; the
 * caller owns the console.warn.
 *
 * @param {{ soft: number, hard: number } | null} limits
 * @returns {string | null}
 */
export function fdPreflightWarning(limits) {
	if (limits === null || !Number.isFinite(limits.soft)) return null;
	if (limits.soft >= LOW_FD_SOFT_LIMIT) return null;
	const hard = limits.hard === Infinity ? 'unlimited' : String(limits.hard);
	return (
		`the soft file-descriptor limit for this process is ${limits.soft} ` +
		`(hard limit: ${hard}). Every WebSocket connection holds one descriptor, so new ` +
		'sockets fail with EMFILE at that count even while CPU is idle. Raise it in the launcher:\n' +
		'  ulimit -n <n>              (shell)\n' +
		'  LimitNOFILE=<n>            (systemd unit)\n' +
		'  ulimits: nofile: <n>       (docker compose)\n' +
		'  See: https://svti.me/fd-limit'
	);
}
