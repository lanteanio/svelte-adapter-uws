import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ limit: '100' }));
vi.mock('../src/runtime/handler/config.js', () => ({ closeHookRegistered: false }));
vi.mock('../src/runtime/utils/memory-wall.js', async (original) => {
	const actual = await original();
	return { ...actual, createMemoryWallReader: () => actual.createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: 0 }),
		readFile(path) {
			if (path === '/proc/self/cgroup') return '0::/';
			if (path === '/sys/fs/cgroup/memory.max') return fixture.limit;
			throw Object.assign(new Error('absent'), { code: 'ENOENT' });
		}
	}) };
});
import { startPressureSampling, stopPressureSampling, grantSizeFor } from '../src/runtime/handler/pressure-metrics.js';
import { counters, pressureSnapshot } from '../src/runtime/handler/state.js';
import { containMetricInstrument, mirrorRegistry, readMetricMirror, resetMetricMirror } from '../src/runtime/utils/metrics.js';
import { installFakeRuntimeClock, releaseRuntimeClock } from './_helpers.js';

afterEach(() => {
	stopPressureSampling(); counters.metricsSampleHook = null;
	releaseRuntimeClock(); resetMetricMirror(); vi.restoreAllMocks(); vi.useRealTimers();
});
it('keeps unavailable memory silent for pressure while retracting its sampled metric', () => {
	vi.useFakeTimers(); installFakeRuntimeClock();
	vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 60, heapUsed: 10, heapTotal: 12, external: 0, arrayBuffers: 0 });
	let sample;
	const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({
		set(value) { sample = value; }, remove() { sample = undefined; }
	}) }).gauge('heap_used_ratio', 'h'));
	counters.metricsSampleHook = () => gauge.setOptional(counters.lastMeasuredHeapUsedRatio, counters.memoryWallPermanent);
	startPressureSampling({ sampleIntervalMs: 100, memoryHeapUsedRatio: 0.5 }, { psi: false, cpuThrottle: false });
	vi.advanceTimersByTime(100);
	expect(sample).toBe(0.6);
	expect(pressureSnapshot.reason).toBe('MEMORY');
	fixture.limit = 'max';
	vi.advanceTimersByTime(100);
	expect(counters.lastMeasuredHeapUsedRatio).toBeNull();
	expect(counters.lastHeapUsedRatio).toBe(0);
	expect(pressureSnapshot.reason).toBe('NONE');
	expect(pressureSnapshot.value).toBe(0);
	expect(pressureSnapshot.memoryMB).toBeGreaterThan(0);
	expect(grantSizeFor().count).toBe(256);
	expect(sample).toBeUndefined();
	expect(readMetricMirror().filter(s => s.name === 'heap_used_ratio')).toEqual([]);
	fixture.limit = '50';
	vi.advanceTimersByTime(100);
	expect(sample).toBe(1);
	expect(pressureSnapshot.reason).toBe('MEMORY');
	expect(grantSizeFor().count).toBeLessThan(256);
});
