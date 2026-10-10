import { afterEach, expect, it, vi } from 'vitest';
import { createPresence } from '../src/plugins/presence/server.js';
import { mockWs, mockPlatform } from './_helpers.js';

const trackers = [];
afterEach(() => {
	for (const tracker of trackers.splice(0)) tracker.clear();
	vi.restoreAllMocks();
});
function joinPair(options) {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const tracker = createPresence({ heartbeat: 0, ...options });
	trackers.push(tracker);
	const platform = mockPlatform();
	tracker.join(mockWs({ id: 'a' }), 'room', platform);
	tracker.join(mockWs({ id: 'b' }), 'room', platform);
	return { tracker, roster: platform.sent.at(-1).data };
}
it.each(['constructor', '__proto__', 'prototype'])('keeps prototype-only key field %s distinct', (key) => {
	const { tracker, roster } = joinPair({ key });
	expect(tracker.count('room')).toBe(2);
	expect(Object.keys(roster)).toHaveLength(2);
});
it('ignores an inherited key from an explicit selector', () => {
	const { tracker, roster } = joinPair({ key: 'id', select: () => Object.create({ id: 'shared' }) });
	expect(tracker.count('room')).toBe(2);
	expect(Object.keys(roster)).toHaveLength(2);
});
it('deduplicates an own key on a null-prototype selected object', () => {
	const { tracker, roster } = joinPair({ key: 'id', select: () => Object.assign(Object.create(null), { id: 'shared' }) });
	expect(tracker.count('room')).toBe(1);
	expect(Object.keys(roster)).toEqual(['shared']);
});
