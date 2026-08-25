// The MEMORY signal's basis: distance to the nearest memory wall.
//
// Two walls, each measured with the quantity it kills on - heapUsed against
// v8.getHeapStatistics().heap_size_limit, resident set against the cgroup
// memory limit - folded worst-of. Pure-unit: parsers get fixture strings,
// the reader an injected readFile and heap statistics, so every
// availability shape (v2, v1, unlimited, ancestor discovery, absent,
// transient failure, post-latch failure) is driven without a container.

import { describe, it, expect } from 'vitest';
import {
	parseCgroupMemoryLimit,
	cgroupMemoryLimitCandidates,
	memoryWallRatio,
	createMemoryWallReader
} from '../src/runtime/utils/memory-wall.js';

const GiB = 1024 * 1024 * 1024;

describe('parseCgroupMemoryLimit', () => {
	it('reads a v2 byte limit and treats "max" as no wall', () => {
		expect(parseCgroupMemoryLimit('536870912\n')).toBe(536870912);
		expect(parseCgroupMemoryLimit('max\n')).toBe(null);
	});

	it('treats the v1 unlimited sentinel as no wall', () => {
		// v1 reports "unlimited" as a page-rounded near-2^63 number.
		expect(parseCgroupMemoryLimit('9223372036854771712\n')).toBe(null);
	});

	it('collapses zero, negatives, and garbage to no wall', () => {
		expect(parseCgroupMemoryLimit('0')).toBe(null);
		expect(parseCgroupMemoryLimit('-5')).toBe(null);
		expect(parseCgroupMemoryLimit('not a number')).toBe(null);
		expect(parseCgroupMemoryLimit('')).toBe(null);
	});
});

describe('cgroupMemoryLimitCandidates', () => {
	it('walks the v2 self path and its ancestors before the root spellings', () => {
		expect(cgroupMemoryLimitCandidates('0::/kubepods/burstable/pod1\n')).toEqual([
			'/sys/fs/cgroup/kubepods/burstable/pod1/memory.max',
			'/sys/fs/cgroup/kubepods/burstable/memory.max',
			'/sys/fs/cgroup/kubepods/memory.max',
			'/sys/fs/cgroup/memory.max',
			'/sys/fs/cgroup/memory/memory.limit_in_bytes'
		]);
	});

	it('walks a v1 memory-controller path under its own hierarchy', () => {
		expect(cgroupMemoryLimitCandidates('4:memory:/docker/abc\n')).toEqual([
			'/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes',
			'/sys/fs/cgroup/memory/docker/memory.limit_in_bytes',
			'/sys/fs/cgroup/memory.max',
			'/sys/fs/cgroup/memory/memory.limit_in_bytes'
		]);
	});

	it('falls back to the two root spellings for a root path or no /proc line', () => {
		const roots = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
		expect(cgroupMemoryLimitCandidates('0::/\n')).toEqual(roots);
		expect(cgroupMemoryLimitCandidates(null)).toEqual(roots);
		expect(cgroupMemoryLimitCandidates('garbage')).toEqual(roots);
	});

	it('caps a pathological path at the deepest sixteen prefixes plus the roots', () => {
		const segments = Array.from({ length: 20 }, (_, i) => 's' + i);
		const out = cgroupMemoryLimitCandidates('0::/' + segments.join('/') + '\n');
		// The nearest groups are the ones a limit most plausibly sits on, so
		// the cap drops the shallowest prefixes - the root spellings at the
		// tail cover the root regardless.
		expect(out.length).toBe(18);
		expect(out[0]).toBe('/sys/fs/cgroup/' + segments.join('/') + '/memory.max');
		expect(out[15]).toBe('/sys/fs/cgroup/' + segments.slice(0, 5).join('/') + '/memory.max');
		expect(out[16]).toBe('/sys/fs/cgroup/memory.max');
		expect(out[17]).toBe('/sys/fs/cgroup/memory/memory.limit_in_bytes');
	});

	it('ignores v1 lines for other controllers', () => {
		expect(cgroupMemoryLimitCandidates('3:cpu,cpuacct:/docker/abc\n')).toEqual([
			'/sys/fs/cgroup/memory.max',
			'/sys/fs/cgroup/memory/memory.limit_in_bytes'
		]);
	});
});

describe('memoryWallRatio', () => {
	it('measures each wall with the quantity it kills on and takes the worst', () => {
		// Heap comfortably clear of the V8 wall, but rss near the cgroup wall:
		// the container arm must win, because the kernel kills on rss.
		const v = memoryWallRatio({ heapUsed: GiB / 4, rss: 0.9 * GiB, heapSizeLimit: 4 * GiB, cgroupLimitBytes: GiB });
		expect(v).toBeCloseTo(0.9, 6);
		// And the reverse: a tight heap under a roomy container.
		const h = memoryWallRatio({ heapUsed: 3.5 * GiB, rss: GiB, heapSizeLimit: 4 * GiB, cgroupLimitBytes: 8 * GiB });
		expect(h).toBeCloseTo(0.875, 6);
	});

	it('reads the V8 wall alone without a cgroup limit', () => {
		expect(memoryWallRatio({ heapUsed: GiB / 2, rss: GiB, heapSizeLimit: 2 * GiB, cgroupLimitBytes: null })).toBeCloseTo(0.25, 6);
	});

	it('clamps to 1 and reads 0 with no known wall or no usage', () => {
		expect(memoryWallRatio({ heapUsed: 3 * GiB, rss: 0, heapSizeLimit: GiB, cgroupLimitBytes: null })).toBe(1);
		expect(memoryWallRatio({ heapUsed: GiB, rss: GiB, heapSizeLimit: null, cgroupLimitBytes: null })).toBe(0);
		expect(memoryWallRatio({ heapUsed: 0, rss: 0, heapSizeLimit: GiB, cgroupLimitBytes: GiB })).toBe(0);
	});
});

describe('createMemoryWallReader', () => {
	const enoent = () => { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; };
	const mem = (heapUsed, rss) => ({ heapUsed, rss });

	it('reads heapUsed against the V8 limit when no cgroup limit exists', () => {
		const reader = createMemoryWallReader({
			readFile: enoent,
			heapStatistics: () => ({ heap_size_limit: 2 * GiB })
		});
		expect(reader.ratio(mem(GiB / 2, GiB))).toBeCloseTo(0.25, 6);
	});

	it('stops probing the cgroup files after a confirmed absence', () => {
		let reads = 0;
		const reader = createMemoryWallReader({
			readFile: () => { reads++; return enoent(); },
			heapStatistics: () => ({ heap_size_limit: 2 * GiB })
		});
		reader.ratio(mem(1, 1));
		const after = reads;
		reader.ratio(mem(1, 1));
		reader.ratio(mem(1, 1));
		expect(reads).toBe(after); // absence is permanent, at zero further cost
	});

	it('measures rss against a discovered cgroup limit, worst-of the V8 wall', () => {
		const reader = createMemoryWallReader({
			readFile: (path) => {
				if (path === '/sys/fs/cgroup/memory.max') return String(GiB);
				return enoent();
			},
			heapStatistics: () => ({ heap_size_limit: 4 * GiB })
		});
		// heap arm: 0.125; rss arm: 768 MiB of the 1 GiB wall = 0.75. Worst-of.
		expect(reader.ratio(mem(GiB / 2, 0.75 * GiB))).toBeCloseTo(0.75, 6);
	});

	it('latches the tightest limit across the self-path ancestors', () => {
		const files = {
			'/proc/self/cgroup': '0::/kubepods/pod1\n',
			'/sys/fs/cgroup/kubepods/pod1/memory.max': String(2 * GiB),
			'/sys/fs/cgroup/kubepods/memory.max': String(GiB), // the tighter ancestor
			'/sys/fs/cgroup/memory.max': 'max\n'
		};
		const reader = createMemoryWallReader({
			readFile: (path) => { if (path in files) return files[path]; return enoent(); },
			heapStatistics: () => ({ heap_size_limit: 8 * GiB })
		});
		expect(reader.ratio(mem(1, GiB / 2))).toBeCloseTo(0.5, 6); // rss vs the 1 GiB ancestor wall
	});

	it('ignores an unlimited cgroup and keeps the V8 wall', () => {
		const reader = createMemoryWallReader({
			readFile: (path) => {
				if (path === '/sys/fs/cgroup/memory.max') return 'max\n';
				return enoent();
			},
			heapStatistics: () => ({ heap_size_limit: 2 * GiB })
		});
		expect(reader.ratio(mem(GiB, 3 * GiB))).toBeCloseTo(0.5, 6); // rss has no wall here
	});

	it('keeps discovery armed across a transient failure', () => {
		let fail = true;
		const reader = createMemoryWallReader({
			readFile: (path) => {
				if (fail) { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; }
				if (path === '/sys/fs/cgroup/memory.max') return String(GiB);
				return enoent();
			},
			heapStatistics: () => ({ heap_size_limit: 4 * GiB })
		});
		expect(reader.ratio(mem(GiB / 2, GiB / 2))).toBeCloseTo(0.125, 6); // V8 wall while the read fails
		fail = false;
		expect(reader.ratio(mem(GiB / 2, GiB / 2))).toBeCloseTo(0.5, 6); // cgroup wall once readable
	});

	it('does not latch an unlimited file while another candidate fails transiently', () => {
		let phase = 'blocked';
		const reader = createMemoryWallReader({
			readFile: (path) => {
				if (path === '/proc/self/cgroup') return '0::/pod\n';
				if (path === '/sys/fs/cgroup/pod/memory.max') {
					if (phase === 'blocked') { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; }
					return String(GiB);
				}
				if (path === '/sys/fs/cgroup/memory.max') return 'max\n';
				return enoent();
			},
			heapStatistics: () => ({ heap_size_limit: 8 * GiB })
		});
		// The root answers "unlimited" while the nearer group's file fails
		// transiently: latching the unlimited file would lose that wall for
		// good, so discovery stays armed and only the V8 arm reads this tick.
		expect(reader.ratio(mem(GiB, GiB / 2))).toBeCloseTo(0.125, 6);
		phase = 'open';
		expect(reader.ratio(mem(GiB, GiB / 2))).toBeCloseTo(0.5, 6); // the hidden wall is found
	});

	it('re-arms discovery when the latched file fails after a successful probe', () => {
		let phase = 'discover';
		const reader = createMemoryWallReader({
			readFile: (path) => {
				if (path === '/sys/fs/cgroup/memory.max') {
					if (phase === 'dead') return enoent(); // the latched file vanished
					return String(GiB);
				}
				return enoent();
			},
			heapStatistics: () => ({ heap_size_limit: 4 * GiB })
		});
		expect(reader.ratio(mem(1, GiB / 2))).toBeCloseTo(0.5, 6); // latched
		phase = 'dead';
		expect(reader.ratio(mem(1, GiB / 2))).toBeCloseTo(0, 6); // wall gone, V8 arm tiny
		phase = 'rediscover';
		expect(reader.ratio(mem(1, GiB / 2))).toBeCloseTo(0.5, 6); // found again
	});

	it('reports calm, not NaN, when the isolate reader is broken and no cgroup exists', () => {
		const broken = createMemoryWallReader({
			readFile: enoent,
			heapStatistics: () => { throw new Error('no isolate'); }
		});
		expect(broken.ratio(mem(GiB, GiB))).toBe(0);
	});

	it('latches the V8 limit once', () => {
		let calls = 0;
		const reader = createMemoryWallReader({
			readFile: enoent,
			heapStatistics: () => { calls++; return { heap_size_limit: GiB }; }
		});
		reader.ratio(mem(1, 1));
		reader.ratio(mem(1, 1));
		expect(calls).toBe(1); // treated as fixed for the process life
	});
});
