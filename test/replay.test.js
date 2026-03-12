import { describe, it, expect, beforeEach } from 'vitest';
import { createReplay } from '../plugins/replay/server.js';

describe('replay plugin - server', () => {
	/** @type {ReturnType<typeof createReplay>} */
	let replay;

	/** @type {{ published: Array<{ topic: string, event: string, data: unknown }>, sent: Array<{ topic: string, event: string, data: unknown }> }} */
	let mockPlatform;

	beforeEach(() => {
		replay = createReplay({ size: 5 });
		mockPlatform = {
			published: [],
			sent: [],
			publish(topic, event, data) {
				mockPlatform.published.push({ topic, event, data });
				return true;
			},
			send(ws, topic, event, data) {
				mockPlatform.sent.push({ topic, event, data });
				return 1;
			}
		};
	});

	describe('createReplay', () => {
		it('returns a replay buffer with the expected API', () => {
			expect(typeof replay.publish).toBe('function');
			expect(typeof replay.seq).toBe('function');
			expect(typeof replay.since).toBe('function');
			expect(typeof replay.replay).toBe('function');
			expect(typeof replay.clear).toBe('function');
			expect(typeof replay.clearTopic).toBe('function');
		});

		it('validates size option', () => {
			expect(() => createReplay({ size: 0 })).toThrow('positive integer');
			expect(() => createReplay({ size: -1 })).toThrow('positive integer');
			expect(() => createReplay({ size: 1.5 })).toThrow('positive integer');
			expect(() => createReplay({ size: 'abc' })).toThrow('positive integer');
		});

		it('validates maxTopics option', () => {
			expect(() => createReplay({ maxTopics: 0 })).toThrow('positive integer');
			expect(() => createReplay({ maxTopics: -1 })).toThrow('positive integer');
		});
	});

	describe('publish', () => {
		it('calls platform.publish with the same arguments', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });

			expect(mockPlatform.published).toEqual([
				{ topic: 'chat', event: 'created', data: { id: 1 } }
			]);
		});

		it('returns platform.publish result', () => {
			const result = replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			expect(result).toBe(true);
		});

		it('increments the sequence number', () => {
			expect(replay.seq('chat')).toBe(0);
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			expect(replay.seq('chat')).toBe(1);
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });
			expect(replay.seq('chat')).toBe(2);
		});

		it('tracks sequences independently per topic', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });
			replay.publish(mockPlatform, 'todos', 'created', { id: 1 });

			expect(replay.seq('chat')).toBe(2);
			expect(replay.seq('todos')).toBe(1);
		});
	});

	describe('seq', () => {
		it('returns 0 for unknown topics', () => {
			expect(replay.seq('nonexistent')).toBe(0);
		});
	});

	describe('since', () => {
		it('returns all messages after a sequence number', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 3 });

			const missed = replay.since('chat', 1);
			expect(missed).toHaveLength(2);
			expect(missed[0]).toEqual({ seq: 2, topic: 'chat', event: 'created', data: { id: 2 } });
			expect(missed[1]).toEqual({ seq: 3, topic: 'chat', event: 'created', data: { id: 3 } });
		});

		it('returns empty array when caught up', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			expect(replay.since('chat', 1)).toEqual([]);
		});

		it('returns empty array for unknown topics', () => {
			expect(replay.since('nonexistent', 0)).toEqual([]);
		});

		it('returns all messages when since is 0', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });

			const missed = replay.since('chat', 0);
			expect(missed).toHaveLength(2);
		});
	});

	describe('ring buffer', () => {
		it('overwrites oldest messages when full', () => {
			// Buffer size is 5
			for (let i = 1; i <= 7; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}

			expect(replay.seq('chat')).toBe(7);

			// Since 0 should only return what fits in the buffer (seq 3-7)
			const all = replay.since('chat', 0);
			expect(all).toHaveLength(5);
			expect(all[0].seq).toBe(3);
			expect(all[0].data).toEqual({ id: 3 });
			expect(all[4].seq).toBe(7);
			expect(all[4].data).toEqual({ id: 7 });
		});

		it('handles since value pointing to evicted messages', () => {
			for (let i = 1; i <= 7; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}

			// seq 1 was evicted, but since(1) should return everything in the buffer
			const missed = replay.since('chat', 1);
			expect(missed).toHaveLength(5);
			expect(missed[0].seq).toBe(3);
		});

		it('works correctly at exact buffer boundary', () => {
			for (let i = 1; i <= 5; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}

			const all = replay.since('chat', 0);
			expect(all).toHaveLength(5);
			expect(all[0].seq).toBe(1);
			expect(all[4].seq).toBe(5);
		});
	});

	describe('replay', () => {
		it('sends missed messages on __replay:{topic} then end marker', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 3 });

			const fakeWs = {};
			replay.replay(fakeWs, 'chat', 1, mockPlatform);

			// Should have sent 2 replay messages + 1 end marker
			expect(mockPlatform.sent).toHaveLength(3);

			// First missed message
			expect(mockPlatform.sent[0]).toEqual({
				topic: '__replay:chat',
				event: 'msg',
				data: { seq: 2, event: 'created', data: { id: 2 } }
			});

			// Second missed message
			expect(mockPlatform.sent[1]).toEqual({
				topic: '__replay:chat',
				event: 'msg',
				data: { seq: 3, event: 'created', data: { id: 3 } }
			});

			// End marker
			expect(mockPlatform.sent[2]).toEqual({
				topic: '__replay:chat',
				event: 'end',
				data: null
			});
		});

		it('sends only end marker when caught up', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });

			const fakeWs = {};
			replay.replay(fakeWs, 'chat', 1, mockPlatform);

			expect(mockPlatform.sent).toHaveLength(1);
			expect(mockPlatform.sent[0]).toEqual({
				topic: '__replay:chat',
				event: 'end',
				data: null
			});
		});

		it('sends only end marker for unknown topics', () => {
			const fakeWs = {};
			replay.replay(fakeWs, 'nonexistent', 0, mockPlatform);

			expect(mockPlatform.sent).toHaveLength(1);
			expect(mockPlatform.sent[0]).toEqual({
				topic: '__replay:nonexistent',
				event: 'end',
				data: null
			});
		});

		it('does not affect the publish history', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			mockPlatform.published = [];

			replay.replay({}, 'chat', 0, mockPlatform);

			// replay should not publish - only send to the one client
			expect(mockPlatform.published).toEqual([]);
		});
	});

	describe('clear / clearTopic', () => {
		it('clear resets everything', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'todos', 'created', { id: 1 });

			replay.clear();

			expect(replay.seq('chat')).toBe(0);
			expect(replay.seq('todos')).toBe(0);
			expect(replay.since('chat', 0)).toEqual([]);
		});

		it('clearTopic resets only that topic', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'todos', 'created', { id: 1 });

			replay.clearTopic('chat');

			expect(replay.seq('chat')).toBe(0);
			expect(replay.seq('todos')).toBe(1);
		});
	});

	describe('maxTopics eviction', () => {
		it('evicts oldest topic when maxTopics is reached', () => {
			const small = createReplay({ size: 10, maxTopics: 3 });

			small.publish(mockPlatform, 'topic-a', 'x', 1);
			small.publish(mockPlatform, 'topic-b', 'x', 2);
			small.publish(mockPlatform, 'topic-c', 'x', 3);

			// All three should exist
			expect(small.seq('topic-a')).toBe(1);
			expect(small.seq('topic-b')).toBe(1);
			expect(small.seq('topic-c')).toBe(1);

			// Adding a 4th should evict topic-a
			small.publish(mockPlatform, 'topic-d', 'x', 4);

			expect(small.seq('topic-a')).toBe(0); // evicted
			expect(small.seq('topic-b')).toBe(1);
			expect(small.seq('topic-c')).toBe(1);
			expect(small.seq('topic-d')).toBe(1);
		});
	});

	describe('default options', () => {
		it('works with no options', () => {
			const r = createReplay();
			const p = {
				publish() { return true; },
				send() { return 1; }
			};

			// Should handle 1000 messages without issue
			for (let i = 0; i < 1000; i++) {
				r.publish(p, 'test', 'msg', i);
			}
			expect(r.seq('test')).toBe(1000);
			expect(r.since('test', 999)).toHaveLength(1);
		});
	});
});
