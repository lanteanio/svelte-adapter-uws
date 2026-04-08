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

		it('snapshots data so mutations do not affect buffered messages', () => {
			const obj = { n: 1 };
			replay.publish(mockPlatform, 'chat', 'created', obj);
			obj.n = 999;

			const messages = replay.since('chat', 0);
			expect(messages[0].data.n).toBe(1);
		});

		it('snapshots nested objects', () => {
			const obj = { user: { name: 'Alice' } };
			replay.publish(mockPlatform, 'chat', 'joined', obj);
			obj.user.name = 'Bob';

			const messages = replay.since('chat', 0);
			expect(messages[0].data.user.name).toBe('Alice');
		});

		it('handles primitive data without cloning', () => {
			replay.publish(mockPlatform, 'chat', 'count', 42);
			replay.publish(mockPlatform, 'chat', 'label', 'hello');
			replay.publish(mockPlatform, 'chat', 'flag', null);

			const messages = replay.since('chat', 0);
			expect(messages[0].data).toBe(42);
			expect(messages[1].data).toBe('hello');
			expect(messages[2].data).toBeNull();
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

		it('end marker has null data when replay is complete (not truncated)', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });

			const fakeWs = {};
			replay.replay(fakeWs, 'chat', 0, mockPlatform);

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toBeNull();
		});

		it('end marker has truncated:true when sinceSeq predates the buffer', () => {
			// Buffer size is 5; publish 7 messages so seq 1 and 2 are evicted
			for (let i = 1; i <= 7; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}
			mockPlatform.sent = [];

			// Client asks for since=1, oldest retained is seq=3 (gap: seq 2 is missing)
			const fakeWs = {};
			replay.replay(fakeWs, 'chat', 1, mockPlatform);

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toEqual({ truncated: true });
		});

		it('end marker has null data when sinceSeq is exactly one before the oldest retained', () => {
			// Publish 7, oldest retained is seq 3. sinceSeq=2 means "give me after 2" -> oldest=3, no gap.
			for (let i = 1; i <= 7; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}
			mockPlatform.sent = [];

			// sinceSeq=2, oldest=3: oldestSeq(3) > sinceSeq+1(3) is false -> not truncated
			replay.replay({}, 'chat', 2, mockPlatform);

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toBeNull();
		});
	});

	describe('replay with reqId', () => {
		it('embeds reqId in each msg event', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });

			replay.replay({}, 'chat', 0, mockPlatform, 42);

			const msgs = mockPlatform.sent.filter((s) => s.event === 'msg');
			expect(msgs).toHaveLength(2);
			expect(msgs[0].data).toEqual({ reqId: 42, seq: 1, event: 'created', data: { id: 1 } });
			expect(msgs[1].data).toEqual({ reqId: 42, seq: 2, event: 'created', data: { id: 2 } });
		});

		it('embeds reqId in end event when not truncated', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });

			replay.replay({}, 'chat', 1, mockPlatform, 'abc');

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toEqual({ reqId: 'abc' });
		});

		it('embeds reqId in end event when truncated', () => {
			for (let i = 1; i <= 7; i++) {
				replay.publish(mockPlatform, 'chat', 'created', { id: i });
			}
			mockPlatform.sent = [];

			replay.replay({}, 'chat', 1, mockPlatform, 99);

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toEqual({ reqId: 99, truncated: true });
		});

		it('embeds reqId in end event for unknown topics', () => {
			replay.replay({}, 'nonexistent', 0, mockPlatform, 7);

			expect(mockPlatform.sent).toHaveLength(1);
			expect(mockPlatform.sent[0]).toEqual({
				topic: '__replay:nonexistent',
				event: 'end',
				data: { reqId: 7 }
			});
		});

		it('omitting reqId keeps original null-data end for non-truncated', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });

			replay.replay({}, 'chat', 1, mockPlatform);

			const end = mockPlatform.sent.find((s) => s.event === 'end');
			expect(end.data).toBeNull();
		});

		it('two concurrent requests for same topic produce independent responses', () => {
			replay.publish(mockPlatform, 'chat', 'created', { id: 1 });
			replay.publish(mockPlatform, 'chat', 'created', { id: 2 });

			// Simulate two onReplay() instances sending simultaneous requests
			const ws1 = {};
			const ws2 = {};
			const platform1 = { sent: [], publish() {} };
			const platform2 = { sent: [], publish() {} };
			platform1.send = (ws, topic, event, data) => platform1.sent.push({ topic, event, data });
			platform2.send = (ws, topic, event, data) => platform2.sent.push({ topic, event, data });

			replay.replay(ws1, 'chat', 0, platform1, 1);
			replay.replay(ws2, 'chat', 0, platform2, 2);

			// Each platform receives its own reqId
			const msgs1 = platform1.sent.filter((s) => s.event === 'msg');
			const msgs2 = platform2.sent.filter((s) => s.event === 'msg');

			expect(msgs1.every((m) => m.data.reqId === 1)).toBe(true);
			expect(msgs2.every((m) => m.data.reqId === 2)).toBe(true);

			const end1 = platform1.sent.find((s) => s.event === 'end');
			const end2 = platform2.sent.find((s) => s.event === 'end');
			expect(end1.data.reqId).toBe(1);
			expect(end2.data.reqId).toBe(2);
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

			// Adding a 4th should evict topic-a (least recently used)
			small.publish(mockPlatform, 'topic-d', 'x', 4);

			expect(small.seq('topic-a')).toBe(0); // evicted
			expect(small.seq('topic-b')).toBe(1);
			expect(small.seq('topic-c')).toBe(1);
			expect(small.seq('topic-d')).toBe(1);
		});

		it('LRU: accessing a topic keeps it alive while cold topics are evicted', () => {
			const small = createReplay({ size: 10, maxTopics: 3 });

			small.publish(mockPlatform, 'topic-a', 'x', 1);
			small.publish(mockPlatform, 'topic-b', 'x', 2);
			small.publish(mockPlatform, 'topic-c', 'x', 3);

			// Touch topic-a by reading its seq - marks it as recently used
			small.seq('topic-a');

			// Adding topic-d should evict topic-b (oldest untouched) not topic-a
			small.publish(mockPlatform, 'topic-d', 'x', 4);

			expect(small.seq('topic-a')).toBe(1); // still alive (was touched)
			expect(small.seq('topic-b')).toBe(0); // evicted (was cold)
			expect(small.seq('topic-c')).toBe(1);
			expect(small.seq('topic-d')).toBe(1);
		});

		it('LRU: publishing to an existing topic keeps it alive', () => {
			const small = createReplay({ size: 10, maxTopics: 3 });

			small.publish(mockPlatform, 'topic-a', 'x', 1);
			small.publish(mockPlatform, 'topic-b', 'x', 2);
			small.publish(mockPlatform, 'topic-c', 'x', 3);

			// Publish another message to topic-a, making it the most recently used
			small.publish(mockPlatform, 'topic-a', 'x', 99);

			// Adding topic-d should evict topic-b (now the LRU), not topic-a
			small.publish(mockPlatform, 'topic-d', 'x', 4);

			expect(small.seq('topic-a')).toBe(2); // still alive, seq incremented
			expect(small.seq('topic-b')).toBe(0); // evicted
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
