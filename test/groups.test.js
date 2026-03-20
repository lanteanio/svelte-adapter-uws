import { describe, it, expect, beforeEach } from 'vitest';
import { createGroup } from '../plugins/groups/server.js';

/**
 * Create a mock WebSocket.
 * @param {Record<string, any>} userData
 */
function mockWs(userData = {}) {
	const topics = new Set();
	return {
		getUserData: () => userData,
		subscribe: (topic) => { topics.add(topic); return true; },
		unsubscribe: (topic) => { topics.delete(topic); return true; },
		isSubscribed: (topic) => topics.has(topic),
		_topics: topics
	};
}

/**
 * Create a mock platform that records publish/send calls.
 */
function mockPlatform() {
	const p = {
		published: [],
		sent: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data });
			return 1;
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
		}
	};
	return p;
}

describe('groups plugin - server', () => {
	let group;
	let platform;

	beforeEach(() => {
		group = createGroup('lobby', { maxMembers: 5 });
		platform = mockPlatform();
	});

	describe('createGroup', () => {
		it('returns a group with the expected API', () => {
			expect(typeof group.join).toBe('function');
			expect(typeof group.leave).toBe('function');
			expect(typeof group.publish).toBe('function');
			expect(typeof group.send).toBe('function');
			expect(typeof group.members).toBe('function');
			expect(typeof group.count).toBe('function');
			expect(typeof group.has).toBe('function');
			expect(typeof group.close).toBe('function');
			expect(group.name).toBe('lobby');
		});

		it('throws on empty/non-string name', () => {
			expect(() => createGroup('')).toThrow('non-empty string');
			expect(() => createGroup(null)).toThrow('non-empty string');
			expect(() => createGroup(42)).toThrow('non-empty string');
		});

		it('default options work', () => {
			const g = createGroup('test');
			expect(g.count()).toBe(0);
		});

		it('throws on invalid maxMembers', () => {
			expect(() => createGroup('x', { maxMembers: 0 })).toThrow('positive number');
			expect(() => createGroup('x', { maxMembers: -1 })).toThrow('positive number');
		});

		it('throws on non-function hooks', () => {
			expect(() => createGroup('x', { onJoin: 'bad' })).toThrow('function');
			expect(() => createGroup('x', { onLeave: 42 })).toThrow('function');
			expect(() => createGroup('x', { onFull: {} })).toThrow('function');
			expect(() => createGroup('x', { onClose: [] })).toThrow('function');
		});

		it('meta is shallow-copied from options', () => {
			const meta = { game: 'chess' };
			const g = createGroup('test', { meta });
			expect(g.meta).toEqual({ game: 'chess' });
			expect(g.meta).not.toBe(meta); // different object
		});
	});

	describe('join', () => {
		it('adds member and subscribes to internal topic', () => {
			const ws = mockWs();
			const result = group.join(ws, platform);

			expect(result).toBe(true);
			expect(ws.isSubscribed('__group:lobby')).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('sends members list to joining ws', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__group:lobby');
			expect(platform.sent[0].event).toBe('members');
			expect(platform.sent[0].data).toEqual([{ role: 'member' }]);
		});

		it('publishes join event before subscribing', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('join');
			expect(platform.published[0].data).toEqual({ role: 'member', count: 1 });
		});

		it('default role is member', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(group.members()[0].role).toBe('member');
		});

		it('accepts admin and viewer roles', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			group.join(ws1, platform, 'admin');
			group.join(ws2, platform, 'viewer');

			const roles = group.members().map(m => m.role);
			expect(roles).toContain('admin');
			expect(roles).toContain('viewer');
		});

		it('throws on invalid role', () => {
			const ws = mockWs();
			expect(() => group.join(ws, platform, 'superuser')).toThrow('invalid role');
		});

		it('is idempotent -- joining twice returns true, no extra broadcast', () => {
			const ws = mockWs();
			group.join(ws, platform);
			const pubCount = platform.published.length;

			expect(group.join(ws, platform)).toBe(true);
			expect(platform.published.length).toBe(pubCount); // no new publish
			expect(group.count()).toBe(1);
		});

		it('returns false when group is full', () => {
			const g = createGroup('small', { maxMembers: 2 });
			g.join(mockWs(), platform);
			g.join(mockWs(), platform);

			expect(g.join(mockWs(), platform)).toBe(false);
			expect(g.count()).toBe(2);
		});

		it('calls onFull when full', () => {
			const fullCalls = [];
			const g = createGroup('small', {
				maxMembers: 1,
				onFull: (ws, role) => fullCalls.push(role)
			});
			g.join(mockWs(), platform);
			g.join(mockWs(), platform); // rejected

			expect(fullCalls).toEqual(['member']);
		});

		it('calls onJoin hook', () => {
			const joinCalls = [];
			const g = createGroup('test', {
				onJoin: (ws, role) => joinCalls.push(role)
			});
			g.join(mockWs(), platform, 'admin');
			expect(joinCalls).toEqual(['admin']);
		});

		it('returns false when group is closed', () => {
			group.close(platform);
			expect(group.join(mockWs(), platform)).toBe(false);
		});
	});

	describe('leave', () => {
		it('removes member and unsubscribes', () => {
			const ws = mockWs();
			group.join(ws, platform);
			group.leave(ws, platform);

			expect(group.count()).toBe(0);
			expect(ws.isSubscribed('__group:lobby')).toBe(false);
		});

		it('publishes leave event with count', () => {
			const ws = mockWs();
			group.join(ws, platform);
			platform.reset();

			group.leave(ws, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('leave');
			expect(platform.published[0].data).toEqual({ role: 'member', count: 0 });
		});

		it('calls onLeave hook', () => {
			const leaveCalls = [];
			const g = createGroup('test', {
				onLeave: (ws, role) => leaveCalls.push(role)
			});
			const ws = mockWs();
			g.join(ws, platform);
			g.leave(ws, platform);

			expect(leaveCalls).toEqual(['member']);
		});

		it('is safe for non-member', () => {
			expect(() => group.leave(mockWs(), platform)).not.toThrow();
			expect(platform.published).toHaveLength(0);
		});
	});

	describe('publish', () => {
		it('broadcasts to all members via internal topic', () => {
			group.join(mockWs(), platform);
			platform.reset();

			group.publish(platform, 'chat', { text: 'hello' });

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].topic).toBe('__group:lobby');
			expect(platform.published[0].event).toBe('chat');
			expect(platform.published[0].data).toEqual({ text: 'hello' });
		});

		it('filtered by role: only matching role members receive', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			const ws3 = mockWs();
			group.join(ws1, platform, 'admin');
			group.join(ws2, platform, 'member');
			group.join(ws3, platform, 'admin');
			platform.reset();

			group.publish(platform, 'admin-msg', { secret: true }, 'admin');

			// Should use send() for each admin, not publish()
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(2);
			expect(platform.sent[0].ws).toBe(ws1);
			expect(platform.sent[1].ws).toBe(ws3);
		});

		it('is no-op when group is closed', () => {
			group.join(mockWs(), platform);
			group.close(platform);
			platform.reset();

			group.publish(platform, 'chat', {});
			expect(platform.published).toHaveLength(0);
		});
	});

	describe('send', () => {
		it('sends to a single member', () => {
			const ws = mockWs();
			group.join(ws, platform);
			platform.reset();

			group.send(platform, ws, 'whisper', { text: 'hi' });

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].ws).toBe(ws);
			expect(platform.sent[0].event).toBe('whisper');
		});

		it('throws for non-member ws', () => {
			expect(() => group.send(platform, mockWs(), 'msg', {}))
				.toThrow('not a member');
		});
	});

	describe('members / count / has', () => {
		it('members() returns array with ws and role', () => {
			const ws = mockWs();
			group.join(ws, platform, 'admin');

			const m = group.members();
			expect(m).toHaveLength(1);
			expect(m[0].ws).toBe(ws);
			expect(m[0].role).toBe('admin');
		});

		it('count() returns member count', () => {
			expect(group.count()).toBe(0);
			group.join(mockWs(), platform);
			expect(group.count()).toBe(1);
			group.join(mockWs(), platform);
			expect(group.count()).toBe(2);
		});

		it('has() returns true for members, false otherwise', () => {
			const ws = mockWs();
			expect(group.has(ws)).toBe(false);

			group.join(ws, platform);
			expect(group.has(ws)).toBe(true);

			group.leave(ws, platform);
			expect(group.has(ws)).toBe(false);
		});
	});

	describe('meta', () => {
		it('get/set metadata', () => {
			expect(group.meta).toEqual({});

			group.meta = { game: 'chess', round: 1 };
			expect(group.meta).toEqual({ game: 'chess', round: 1 });
		});

		it('initial meta from options is independent', () => {
			const opts = { game: 'chess' };
			const g = createGroup('test', { meta: opts });
			g.meta.game = 'go';
			expect(opts.game).toBe('chess'); // unchanged
		});
	});

	describe('leave (defensive)', () => {
		it('does not throw if ws.unsubscribe throws during leave', () => {
			const ws = mockWs();
			ws.unsubscribe = () => { throw new Error('socket closed'); };
			group.join(ws, platform);
			expect(() => group.leave(ws, platform)).not.toThrow();
		});
	});

	describe('close', () => {
		it('publishes close event', () => {
			group.join(mockWs(), platform);
			platform.reset();

			group.close(platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('close');
		});

		it('unsubscribes all members', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			group.join(ws1, platform);
			group.join(ws2, platform);

			group.close(platform);

			expect(ws1.isSubscribed('__group:lobby')).toBe(false);
			expect(ws2.isSubscribed('__group:lobby')).toBe(false);
		});

		it('clears member list', () => {
			group.join(mockWs(), platform);
			group.close(platform);

			expect(group.count()).toBe(0);
			expect(group.members()).toEqual([]);
		});

		it('calls onClose hook', () => {
			let called = false;
			const g = createGroup('test', { onClose: () => { called = true; } });
			g.close(platform);

			expect(called).toBe(true);
		});

		it('subsequent joins return false', () => {
			group.close(platform);
			expect(group.join(mockWs(), platform)).toBe(false);
		});

		it('subsequent publish is no-op', () => {
			group.close(platform);
			platform.reset();
			group.publish(platform, 'chat', {});
			expect(platform.published).toHaveLength(0);
		});

		it('closing twice is safe (idempotent)', () => {
			group.close(platform);
			expect(() => group.close(platform)).not.toThrow();
		});
	});

	describe('hooks', () => {
		it('exposes subscribe, unsubscribe, and close functions', () => {
			expect(typeof group.hooks.subscribe).toBe('function');
			expect(typeof group.hooks.unsubscribe).toBe('function');
			expect(typeof group.hooks.close).toBe('function');
		});

		it('hooks.subscribe calls join for __group:{name} topic', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:lobby', { platform });

			expect(result).not.toBe(false);
			expect(group.has(ws)).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('hooks.subscribe returns false when group is full', () => {
			const g = createGroup('tiny', { maxMembers: 1 });
			g.join(mockWs(), platform);

			const ws = mockWs();
			const result = g.hooks.subscribe(ws, '__group:tiny', { platform });

			expect(result).toBe(false);
			expect(g.has(ws)).toBe(false);
		});

		it('hooks.subscribe returns false when group is closed', () => {
			group.close(platform);

			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:lobby', { platform });

			expect(result).toBe(false);
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.subscribe passes through unrelated topics', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, 'chat', { platform });

			expect(result).toBeUndefined();
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.subscribe passes through other __group: topics', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:other', { platform });

			expect(result).toBeUndefined();
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.unsubscribe calls leave for __group:{name}', () => {
			const ws = mockWs();
			group.join(ws, platform);
			expect(group.count()).toBe(1);

			group.hooks.unsubscribe(ws, '__group:lobby', { platform });

			expect(group.count()).toBe(0);
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.unsubscribe ignores unrelated topics', () => {
			const ws = mockWs();
			group.join(ws, platform);

			group.hooks.unsubscribe(ws, 'chat', { platform });

			expect(group.has(ws)).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('hooks.close calls leave', () => {
			const ws = mockWs();
			group.join(ws, platform);
			expect(group.count()).toBe(1);

			group.hooks.close(ws, { platform });

			expect(group.count()).toBe(0);
			expect(group.has(ws)).toBe(false);
		});

		it('destructured hooks work correctly', () => {
			const { subscribe, unsubscribe, close } = group.hooks;
			const ws = mockWs();

			subscribe(ws, '__group:lobby', { platform });
			expect(group.has(ws)).toBe(true);

			unsubscribe(ws, '__group:lobby', { platform });
			expect(group.has(ws)).toBe(false);
		});
	});
});
