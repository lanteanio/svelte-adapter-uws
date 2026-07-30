import { describe, it, expect, vi } from 'vitest';
import { createPresence } from '../src/plugins/presence/server.js';
import { createCursor } from '../src/plugins/cursor/server.js';
import { mockPlatform, mockWs } from './_helpers.js';

describe('presence/cursor observer lanes fail closed', () => {
	it('ask the Platform for the explicit requireGrant observer decision', async () => {
		const presence = createPresence({ heartbeat: 0 });
		const cursor = createCursor({ throttle: 0, topicThrottle: 0 });
		const presenceWs = mockWs({ id: 'presence-viewer' });
		const cursorWs = mockWs({ id: 'cursor-viewer' });
		const presencePlatform = mockPlatform();
		const cursorPlatform = mockPlatform();

		await presence.sync(presenceWs, 'presence-room', presencePlatform);
		await cursor.snapshot(cursorWs, 'cursor-room', cursorPlatform);

		expect(presencePlatform.checkSubscribeCalls).toEqual([{
			ws: presenceWs,
			topic: 'presence-room',
			options: { requireGrant: true }
		}]);
		expect(cursorPlatform.checkSubscribeCalls).toEqual([{
			ws: cursorWs,
			topic: 'cursor-room',
			options: { requireGrant: true }
		}]);
	});

	it('refuse snapshot membership when the Platform authorization method is absent', async () => {
		const presence = createPresence({ heartbeat: 0 });
		const cursor = createCursor({ throttle: 0, topicThrottle: 0 });
		const presenceWs = mockWs({ id: 'presence-viewer' });
		const cursorWs = mockWs({ id: 'cursor-viewer' });
		const presencePlatform = mockPlatform();
		const cursorPlatform = mockPlatform();
		delete presencePlatform.checkSubscribe;
		delete cursorPlatform.checkSubscribe;

		await presence.sync(presenceWs, 'private-room', presencePlatform);
		await cursor.snapshot(cursorWs, 'private-room', cursorPlatform);

		expect(presenceWs.isSubscribed('__presence:private-room')).toBe(false);
		expect(cursorWs.isSubscribed('__cursor:private-room')).toBe(false);
		expect(presencePlatform.sent).toHaveLength(0);
		expect(cursorPlatform.sent).toHaveLength(0);
	});

	it('refuse client-named internal topics before they can mint a doubly-prefixed tap', async () => {
		const presence = createPresence({ heartbeat: 0 });
		const cursor = createCursor({ throttle: 0, topicThrottle: 0 });
		const presenceWs = mockWs({ id: 'presence-viewer' });
		const cursorWs = mockWs({ id: 'cursor-viewer' });
		const presencePlatform = mockPlatform();
		const cursorPlatform = mockPlatform();
		presencePlatform.checkSubscribe = vi.fn(async () => null);
		cursorPlatform.checkSubscribe = vi.fn(async () => null);

		await presence.sync(presenceWs, '__presence:room', presencePlatform);
		await cursor.snapshot(cursorWs, '__cursor:room', cursorPlatform);

		expect(presencePlatform.checkSubscribe).not.toHaveBeenCalled();
		expect(cursorPlatform.checkSubscribe).not.toHaveBeenCalled();
		expect(presenceWs.isSubscribed('__presence:__presence:room')).toBe(false);
		expect(cursorWs.isSubscribed('__cursor:__cursor:room')).toBe(false);
		expect(presencePlatform.sent).toHaveLength(0);
		expect(cursorPlatform.sent).toHaveLength(0);
	});

	it('refuse cursor mutation frames when membership cannot be queried', () => {
		const cursor = createCursor({ throttle: 0, topicThrottle: 0 });
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ id: 'attacker' }) };
		const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

		expect(cursor.hooks.message(ws, {
			data: encode({ type: 'cursor', topic: 'private-room', data: { x: 1, y: 2 } }),
			platform
		})).toBe(true);
		expect(cursor.hooks.message(ws, {
			data: encode({ type: 'cursor-viewport', topic: 'private-room', rect: { x: 0, y: 0, w: 10, h: 10 } }),
			platform
		})).toBe(true);

		expect(cursor.list('private-room')).toEqual([]);
		expect(cursor.viewportFor(ws, 'private-room')).toBeNull();
		expect(platform.published).toHaveLength(0);
	});
});
