import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryWallReader } from '../src/runtime/utils/memory-wall.js';
import { containMetricInstrument, mirrorRegistry, readMetricMirror, resetMetricMirror } from '../src/runtime/utils/metrics.js';
import { SIGNALS_BY_NAME } from '../src/runtime/observability-manifest.js';

const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
function wallFixture(engineLimit = 0) {
	let limit = 'max';
	const reader = createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: engineLimit }),
		readFile(path) {
			if (path === '/proc/self/cgroup') return '0::/';
			if (path === '/sys/fs/cgroup/memory.max') return limit;
			return absent();
		}
	});
	return { reader, setLimit(value) { limit = value; } };
}
const readings = () => readMetricMirror().filter((s) => s.name === 'heap_used_ratio');
beforeEach(() => resetMetricMirror());

describe('memory wall availability', () => {
	it('distinguishes a measured zero from no ceiling and retains ratio zero for pressure', () => {
		const { reader, setLimit } = wallFixture();
		expect(reader.measure({ heapUsed: 10, rss: 30 })).toBeNull();
		expect(reader.ratio({ heapUsed: 10, rss: 30 })).toBe(0);
		expect(reader.hasEngineLimit()).toBe(false);
		setLimit('100');
		expect(reader.measure({ heapUsed: 0, rss: 0 })).toBe(0);
		expect(reader.measure({ heapUsed: 10, rss: 30 })).toBe(0.3);
		setLimit('max');
		expect(reader.measure({ heapUsed: 10, rss: 30 })).toBeNull();
		setLimit('50');
		expect(reader.measure({ heapUsed: 10, rss: 30 })).toBe(0.6);
	});
	it('keeps the latched engine ceiling available after the cgroup wall disappears', () => {
		const { reader, setLimit } = wallFixture(100);
		setLimit('20');
		expect(reader.measure({ heapUsed: 10, rss: 15 })).toBe(0.75);
		expect(reader.hasEngineLimit()).toBe(true);
		setLimit('max');
		expect(reader.measure({ heapUsed: 10, rss: 15 })).toBe(0.1);
	});
	it('declares the wall gauge optional', () => {
		expect(SIGNALS_BY_NAME.get('heap_used_ratio').optional).toBe(true);
	});
});

describe('optional gauge samples', () => {
	it('removes an obsolete value from both a capable registry and the worker mirror', () => {
		let external;
		const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({
			set(value) { external = value; }, remove() { external = undefined; }
		}) }).gauge('heap_used_ratio', 'h'));
		gauge.setOptional(0.6, false);
		expect(external).toBe(0.6);
		expect(readings()).toEqual([{ name: 'heap_used_ratio', labels: {}, value: 0.6 }]);
		gauge.setOptional(null, false);
		expect(external).toBeUndefined();
		expect(readings()).toEqual([]);
		gauge.setOptional(0, false);
		expect(external).toBe(0);
		expect(readings()[0].value).toBe(0);
	});
	it('omits uncertain-wall external samples when a legacy registry cannot remove them', () => {
		const set = vi.fn();
		const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({ set }) }).gauge('heap_used_ratio', 'h'));
		for (const value of [0.5, null, 0.2]) gauge.setOptional(value, false);
		expect(set).not.toHaveBeenCalled();
		expect(readings()[0].value).toBe(0.2);
		gauge.setOptional(null, false);
		expect(readings()).toEqual([]);
		gauge.setOptional(0.1, true);
		expect(set).toHaveBeenCalledExactlyOnceWith(0.1);
	});
	it('contains removal failure after clearing the mirror and logs once', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({
				set() {}, remove() { throw new Error('unavailable'); }
			}) }).gauge('heap_used_ratio', 'h'));
			gauge.setOptional(0.5, false);
			expect(() => { gauge.setOptional(null, false); gauge.remove(); }).not.toThrow();
			expect(readings()).toEqual([]);
			expect(log).toHaveBeenCalledTimes(1);
		} finally { log.mockRestore(); }
	});
});
