import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresence } from '../src/plugins/presence/server.js';
import { createCursor } from '../src/plugins/cursor/server.js';
import { mockWs, mockPlatform, installFakeRuntimeClock, releaseRuntimeClock } from './_helpers.js';

const unsafeTopics = ['say "hi"', 'path\\name', ...Array.from({ length: 32 }, (_, n) => `room${String.fromCharCode(n)}`)];
let trackers;
beforeEach(() => {
	vi.useFakeTimers();
	installFakeRuntimeClock();
	trackers = [];
});
afterEach(() => {
	for (const tracker of trackers) tracker.clear();
	releaseRuntimeClock();
	vi.useRealTimers();
});
const presence = () => {
	const p = createPresence({ heartbeat: 100, topicThrottle: 10, select: (ud) => ({ id: ud.id }) });
	trackers.push(p);
	return p;
};
const cursor = () => {
	const c = createCursor({ throttle: 0, topicThrottle: 10, select: (ud) => ({ id: ud.id }) });
	trackers.push(c);
	return c;
};

describe('plugin topic validation before side effects', () => {
	it.each(unsafeTopics)('refuses unsafe topic %j before retaining state', async (topic) => {
		const p = presence();
		const c = cursor();
		const ws = mockWs({ id: 'one' });
		const platform = mockPlatform();
		expect(() => p.join(ws, topic, platform)).toThrow(TypeError);
		expect(p.count(topic)).toBe(0);
		expect(() => c.update(ws, topic, { x: 1, y: 2 }, platform)).toThrow(TypeError);
		expect(c.list(topic)).toEqual([]);
		await expect(p.sync(ws, topic, platform)).resolves.toBeUndefined();
		await expect(c.snapshot(ws, topic, platform)).resolves.toBeUndefined();
		expect(ws._topics.size).toBe(0);
		expect(platform.checkSubscribeCalls).toEqual([]);
		expect(platform.sent).toEqual([]);
		expect(platform.published).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('keeps printable names and Unicode topics available', async () => {
		const p = presence();
		const c = cursor();
		const platform = mockPlatform();
		for (const topic of ['a space', 'caf\u00e9', '\u{1f30d}']) {
			const ws = mockWs({ id: topic });
			p.join(ws, topic, platform);
			c.update(ws, topic, { x: 1, y: 2 }, platform);
			await p.sync(ws, topic, platform);
			await c.snapshot(ws, topic, platform);
			expect(p.count(topic)).toBe(1);
			expect(c.list(topic)).toHaveLength(1);
			expect(ws._topics.has('__presence:' + topic)).toBe(true);
			expect(ws._topics.has('__cursor:' + topic)).toBe(true);
		}
	});
});

describe('plugin periodic publication isolation', () => {
	it('continues presence diffs and heartbeats after one topic throws', () => {
		const p = presence();
		const platform = mockPlatform();
		const publish = platform.publish;
		platform.publish = (topic, event, data) => {
			if (topic === '__presence:broken') throw new Error('transport unavailable');
			return publish(topic, event, data);
		};
		p.join(mockWs({ id: 'broken' }), 'broken', platform);
		p.join(mockWs({ id: 'healthy' }), 'healthy', platform);
		expect(() => vi.advanceTimersByTime(10)).not.toThrow();
		expect(platform.published.filter((e) => e.event === 'diff').map((e) => e.topic)).toEqual(['__presence:healthy']);
		expect(() => vi.advanceTimersByTime(190)).not.toThrow();
		expect(platform.published.filter((e) => e.event === 'heartbeat').map((e) => e.topic)).toEqual(['__presence:healthy', '__presence:healthy']);
		p.join(mockWs({ id: 'later' }), 'later', platform);
		expect(() => vi.advanceTimersByTime(10)).not.toThrow();
		expect(platform.published.at(-1)).toMatchObject({ topic: '__presence:later', event: 'diff' });
	});
	it('continues the cursor tick and re-arms after one topic throws', () => {
		const c = cursor();
		const platform = mockPlatform();
		const publish = platform.publish;
		platform.publish = (topic, event, data) => {
			if (topic === '__cursor:broken' && event === 'update') throw new Error('transport unavailable');
			return publish(topic, event, data);
		};
		const broken = mockWs({ id: 'broken' });
		const healthy = mockWs({ id: 'healthy' });
		c.update(broken, 'broken', { x: 1, y: 2 }, platform);
		c.update(healthy, 'healthy', { x: 1, y: 2 }, platform);
		expect(() => vi.advanceTimersByTime(1)).not.toThrow();
		expect(platform.published.filter((e) => e.event === 'update').map((e) => e.topic)).toEqual(['__cursor:healthy']);
		c.update(broken, 'broken', { x: 2, y: 3 }, platform);
		c.update(healthy, 'healthy', { x: 2, y: 3 }, platform);
		expect(() => vi.advanceTimersByTime(10)).not.toThrow();
		expect(platform.published.filter((e) => e.event === 'update' && e.topic === '__cursor:healthy').map((e) => e.data.data)).toEqual([{ x: 1, y: 2 }, { x: 2, y: 3 }]);
	});
});
