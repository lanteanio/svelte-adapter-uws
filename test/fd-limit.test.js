// Descriptor-budget probes: the /proc/self/limits parser, the boot advisory
// decision, and the platform-dependent readers. The parser and the advisory
// are pure and covered on every platform; the readers assert their real
// values on Linux and their shape contract (valid or null, never a throw)
// everywhere else.

import { describe, it, expect } from 'vitest';
import {
	parseProcLimits,
	readFdLimits,
	countOpenFds,
	fdPreflightWarning,
	LOW_FD_SOFT_LIMIT
} from '../src/runtime/utils/fd-limit.js';

const PROC_LIMITS_FIXTURE = [
	'Limit                     Soft Limit           Hard Limit           Units     ',
	'Max cpu time              unlimited            unlimited            seconds   ',
	'Max file size             unlimited            unlimited            bytes     ',
	'Max open files            1024                 1048576              files     ',
	'Max locked memory         8388608              8388608              bytes     ',
	''
].join('\n');

describe('parseProcLimits', () => {
	it('extracts the Max open files row', () => {
		expect(parseProcLimits(PROC_LIMITS_FIXTURE)).toEqual({ soft: 1024, hard: 1048576 });
	});

	it('maps unlimited to Infinity', () => {
		const text = 'Max open files            unlimited            unlimited            files\n';
		expect(parseProcLimits(text)).toEqual({ soft: Infinity, hard: Infinity });
	});

	it('returns null when the row is absent', () => {
		expect(parseProcLimits('Max cpu time              unlimited            unlimited            seconds\n')).toBe(null);
		expect(parseProcLimits('')).toBe(null);
	});

	it('returns null on a malformed row instead of guessing', () => {
		expect(parseProcLimits('Max open files            banana               files\n')).toBe(null);
	});
});

describe('fdPreflightWarning', () => {
	it('warns below the low-limit floor with the numbers and the remediation link', () => {
		const message = fdPreflightWarning({ soft: 1024, hard: 1048576 });
		expect(message).toContain('1024');
		expect(message).toContain('1048576');
		expect(message).toContain('EMFILE');
		expect(message).toContain('svti.me/fd-limit');
	});

	it('spells an unlimited hard limit', () => {
		expect(fdPreflightWarning({ soft: 512, hard: Infinity })).toContain('hard limit: unlimited');
	});

	it('stays silent at or above the floor', () => {
		expect(fdPreflightWarning({ soft: LOW_FD_SOFT_LIMIT, hard: Infinity })).toBe(null);
		expect(fdPreflightWarning({ soft: 1048576, hard: 1048576 })).toBe(null);
	});

	it('stays silent when the limit is unreadable or unlimited', () => {
		expect(fdPreflightWarning(null)).toBe(null);
		expect(fdPreflightWarning({ soft: Infinity, hard: Infinity })).toBe(null);
	});
});

describe('platform readers', () => {
	it('return a valid shape or null on any platform, never throw', () => {
		const limits = readFdLimits();
		if (limits !== null) {
			expect(limits.soft).toBeGreaterThan(0);
			expect(limits.hard).toBeGreaterThanOrEqual(limits.soft);
		}
		const open = countOpenFds();
		if (open !== null) expect(open).toBeGreaterThan(0);
	});

	(process.platform === 'linux' ? it : it.skip)('read real values on linux', () => {
		const limits = readFdLimits();
		expect(limits).not.toBe(null);
		expect(Number.isFinite(limits.soft)).toBe(true);
		const open = countOpenFds();
		expect(open).toBeGreaterThan(2);
	});
});
