import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket before importing the client module
class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];

		// Auto-open after microtask (simulates real connection)
		queueMicrotask(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.();
			}
		});
	}

	send(data) { this._sent.push(data); }

	close() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}

	// Simulate receiving a message
	_receive(data) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}

// Mock svelte/store
function writable(initial) {
	let value = initial;
	const subscribers = new Set();
	return {
		set(v) {
			value = v;
			for (const fn of subscribers) fn(v);
		},
		subscribe(fn) {
			subscribers.add(fn);
			fn(value);
			return () => subscribers.delete(fn);
		},
		get _value() { return value; }
	};
}

// We can't import the actual client module because it depends on `svelte/store`
// and `window`. Instead, we test the core logic patterns.

describe('client store patterns', () => {
	describe('ref-counted subscriptions', () => {
		it('subscribes on first ref, unsubscribes on last release', () => {
			const topicRefCounts = new Map();
			const subscribedTopics = new Set();
			const subscribeActions = [];

			function subscribe(topic) {
				const count = topicRefCounts.get(topic) || 0;
				topicRefCounts.set(topic, count + 1);
				if (count > 0) return;
				subscribedTopics.add(topic);
				subscribeActions.push({ type: 'subscribe', topic });
			}

			function release(topic) {
				const count = topicRefCounts.get(topic) || 0;
				if (count <= 1) {
					topicRefCounts.delete(topic);
					subscribedTopics.delete(topic);
					subscribeActions.push({ type: 'unsubscribe', topic });
				} else {
					topicRefCounts.set(topic, count - 1);
				}
			}

			// First subscription triggers WS subscribe
			subscribe('todos');
			expect(subscribeActions).toEqual([{ type: 'subscribe', topic: 'todos' }]);
			expect(subscribedTopics.has('todos')).toBe(true);

			// Second subscription is ref-counted, no WS message
			subscribe('todos');
			expect(subscribeActions).toHaveLength(1);
			expect(topicRefCounts.get('todos')).toBe(2);

			// Release one ref - still subscribed
			release('todos');
			expect(subscribedTopics.has('todos')).toBe(true);
			expect(topicRefCounts.get('todos')).toBe(1);

			// Release last ref - triggers WS unsubscribe
			release('todos');
			expect(subscribedTopics.has('todos')).toBe(false);
			expect(subscribeActions).toEqual([
				{ type: 'subscribe', topic: 'todos' },
				{ type: 'unsubscribe', topic: 'todos' }
			]);
		});
	});

	describe('scan (reducer pattern)', () => {
		it('accumulates values through a reducer', () => {
			const source = writable(null);
			const values = [];

			// Simulate scan()
			let acc = [];
			const accumulated = writable([]);
			source.subscribe((value) => {
				if (value !== null) {
					acc = [...acc, value];
					accumulated.set(acc);
				}
			});
			accumulated.subscribe((v) => values.push(v));

			source.set({ event: 'created', data: { id: 1 } });
			source.set({ event: 'created', data: { id: 2 } });

			// Initial [] + two events
			expect(values).toHaveLength(3);
			expect(values[2]).toEqual([
				{ event: 'created', data: { id: 1 } },
				{ event: 'created', data: { id: 2 } }
			]);
		});
	});

	describe('crud pattern', () => {
		it('handles created, updated, deleted events', () => {
			const key = 'id';
			let list = [
				{ id: 1, text: 'Buy milk', done: false },
				{ id: 2, text: 'Walk dog', done: false }
			];

			function reducer(list, { event, data }) {
				if (event === 'created') return [...list, data];
				if (event === 'updated') return list.map((item) => item[key] === data[key] ? data : item);
				if (event === 'deleted') return list.filter((item) => item[key] !== data[key]);
				return list;
			}

			// Create
			list = reducer(list, { event: 'created', data: { id: 3, text: 'Clean house', done: false } });
			expect(list).toHaveLength(3);
			expect(list[2].text).toBe('Clean house');

			// Update
			list = reducer(list, { event: 'updated', data: { id: 1, text: 'Buy milk', done: true } });
			expect(list[0].done).toBe(true);

			// Delete
			list = reducer(list, { event: 'deleted', data: { id: 2 } });
			expect(list).toHaveLength(2);
			expect(list.find(t => t.id === 2)).toBeUndefined();

			// Unknown event - no change
			const before = list;
			list = reducer(list, { event: 'unknown', data: {} });
			expect(list).toBe(before);
		});
	});

	describe('lookup pattern', () => {
		it('maintains a keyed record', () => {
			const key = 'id';
			let map = {};

			function reducer(map, { event, data }) {
				const id = data[key];
				if (event === 'created' || event === 'updated') return { ...map, [id]: data };
				if (event === 'deleted') {
					const { [id]: _, ...rest } = map;
					return rest;
				}
				return map;
			}

			map = reducer(map, { event: 'created', data: { id: 'a', name: 'Alice' } });
			map = reducer(map, { event: 'created', data: { id: 'b', name: 'Bob' } });
			expect(Object.keys(map)).toHaveLength(2);
			expect(map['a'].name).toBe('Alice');

			map = reducer(map, { event: 'updated', data: { id: 'a', name: 'Alice Smith' } });
			expect(map['a'].name).toBe('Alice Smith');

			map = reducer(map, { event: 'deleted', data: { id: 'b' } });
			expect(Object.keys(map)).toHaveLength(1);
			expect(map['b']).toBeUndefined();
		});
	});

	describe('count pattern', () => {
		it('handles set, increment, decrement', () => {
			function reducer(n, { event, data }) {
				if (event === 'set') return typeof data === 'number' ? data : n;
				if (event === 'increment') return n + (typeof data === 'number' ? data : 1);
				if (event === 'decrement') return n - (typeof data === 'number' ? data : 1);
				return n;
			}

			let count = 0;
			count = reducer(count, { event: 'increment', data: 1 });
			expect(count).toBe(1);
			count = reducer(count, { event: 'increment', data: 5 });
			expect(count).toBe(6);
			count = reducer(count, { event: 'decrement', data: 2 });
			expect(count).toBe(4);
			count = reducer(count, { event: 'set', data: 42 });
			expect(count).toBe(42);
			count = reducer(count, { event: 'set', data: 'not a number' });
			expect(count).toBe(42); // stays unchanged
		});
	});

	describe('latest (ring buffer) pattern', () => {
		it('keeps only the last N events', () => {
			const max = 3;
			let buffer = [];

			function reducer(buffer, event) {
				const next = [...buffer, event];
				return next.length > max ? next.slice(next.length - max) : next;
			}

			buffer = reducer(buffer, { id: 1 });
			buffer = reducer(buffer, { id: 2 });
			buffer = reducer(buffer, { id: 3 });
			expect(buffer).toHaveLength(3);

			buffer = reducer(buffer, { id: 4 });
			expect(buffer).toHaveLength(3);
			expect(buffer[0].id).toBe(2);
			expect(buffer[2].id).toBe(4);
		});
	});

	describe('exponential backoff', () => {
		it('increases delay with jitter, capped at max', () => {
			const reconnectInterval = 3000;
			const maxReconnectInterval = 30000;

			for (let attempt = 0; attempt < 20; attempt++) {
				const delay = Math.min(
					reconnectInterval * Math.pow(1.5, attempt) + Math.random() * 1000,
					maxReconnectInterval
				);
				expect(delay).toBeLessThanOrEqual(maxReconnectInterval + 1000);
				expect(delay).toBeGreaterThan(0);
			}
		});
	});

	describe('message envelope', () => {
		it('creates correct envelope format', () => {
			const topic = 'todos';
			const event = 'created';
			const data = { id: 1, text: 'test' };

			const envelope = JSON.stringify({ topic, event, data });
			const parsed = JSON.parse(envelope);

			expect(parsed.topic).toBe('todos');
			expect(parsed.event).toBe('created');
			expect(parsed.data).toEqual({ id: 1, text: 'test' });
		});
	});

	describe('presence memoization pattern', () => {
		it('returns the same store for the same topic', () => {
			const cache = new Map();

			function presence(topic) {
				const cached = cache.get(topic);
				if (cached) return cached;

				const output = writable([]);
				let refCount = 0;
				const store = {
					subscribe(fn) {
						refCount++;
						const unsub = output.subscribe(fn);
						return () => { unsub(); refCount--; };
					},
					_refCount: () => refCount
				};
				cache.set(topic, store);
				return store;
			}

			const a1 = presence('room');
			const a2 = presence('room');
			const b = presence('other');

			expect(a1).toBe(a2);
			expect(a1).not.toBe(b);
		});

		it('survives full unsubscribe/resubscribe cycle without losing identity', () => {
			const cache = new Map();
			const output = writable([]);
			let refCount = 0;
			let listenCount = 0;

			function presence(topic) {
				const cached = cache.get(topic);
				if (cached) return cached;

				const store = {
					subscribe(fn) {
						if (refCount++ === 0) listenCount++;
						const unsub = output.subscribe(fn);
						return () => {
							unsub();
							if (--refCount === 0) output.set([]);
						};
					}
				};
				cache.set(topic, store);
				return store;
			}

			const store = presence('room');

			// First subscriber
			const unsub1 = store.subscribe(() => {});
			expect(listenCount).toBe(1);

			// Full unsub
			unsub1();

			// Re-subscribe to the SAME cached store
			const store2 = presence('room');
			expect(store2).toBe(store);

			const unsub2 = store2.subscribe(() => {});
			expect(listenCount).toBe(2);
			unsub2();
		});
	});

	describe('presence maxAge pattern', () => {
		it('sweeps stale entries based on timestamps', () => {
			vi.useFakeTimers();
			const maxAge = 2000;

			/** @type {Map<string, any>} */
			const userMap = new Map();
			/** @type {Map<string, number>} */
			const timestamps = new Map();

			function join(key, data) {
				userMap.set(key, data);
				timestamps.set(key, Date.now());
			}

			function sweep() {
				const cutoff = Date.now() - maxAge;
				let changed = false;
				for (const [key, ts] of timestamps) {
					if (ts < cutoff) {
						timestamps.delete(key);
						if (userMap.delete(key)) changed = true;
					}
				}
				return changed;
			}

			join('1', { name: 'Alice' });
			join('2', { name: 'Bob' });
			expect(userMap.size).toBe(2);

			vi.advanceTimersByTime(1500);
			// Refresh Alice
			timestamps.set('1', Date.now());

			vi.advanceTimersByTime(600);
			const changed = sweep();
			expect(changed).toBe(true);
			expect(userMap.size).toBe(1);
			expect(userMap.has('1')).toBe(true);
			expect(userMap.has('2')).toBe(false);

			vi.useRealTimers();
		});

		it('does not sweep when maxAge is not set', () => {
			const userMap = new Map();
			userMap.set('1', { name: 'Alice' });
			// Without maxAge, no sweep should happen -- entries persist indefinitely
			expect(userMap.size).toBe(1);
		});

		it('leave removes entry and timestamp immediately', () => {
			const userMap = new Map();
			const timestamps = new Map();

			userMap.set('1', { name: 'Alice' });
			timestamps.set('1', Date.now());

			// Explicit leave
			timestamps.delete('1');
			userMap.delete('1');
			expect(userMap.size).toBe(0);
			expect(timestamps.size).toBe(0);
		});
	});

	describe('presence heartbeat pattern', () => {
		it('heartbeat refreshes timestamps for active keys', () => {
			vi.useFakeTimers();
			const maxAge = 5000;

			const userMap = new Map();
			const timestamps = new Map();

			// Simulate initial list
			const now = Date.now();
			userMap.set('1', { name: 'Alice' });
			userMap.set('2', { name: 'Bob' });
			timestamps.set('1', now);
			timestamps.set('2', now);

			// Advance time near maxAge
			vi.advanceTimersByTime(4000);

			// Simulate heartbeat -- refreshes timestamps for listed keys
			const heartbeatKeys = ['1', '2'];
			const heartbeatTime = Date.now();
			for (const key of heartbeatKeys) {
				if (timestamps.has(key)) {
					timestamps.set(key, heartbeatTime);
				}
			}

			// Advance past original maxAge but within heartbeat maxAge
			vi.advanceTimersByTime(2000);
			const cutoff = Date.now() - maxAge;

			// Both should survive (heartbeat refreshed them at T+4000)
			for (const [key, ts] of timestamps) {
				expect(ts).toBeGreaterThanOrEqual(cutoff);
			}

			vi.useRealTimers();
		});

		it('heartbeat does not refresh keys not in the heartbeat', () => {
			vi.useFakeTimers();
			const maxAge = 5000;

			const timestamps = new Map();
			const now = Date.now();
			timestamps.set('1', now);
			timestamps.set('ghost', now);

			vi.advanceTimersByTime(4000);

			// Heartbeat only includes '1', not 'ghost'
			const heartbeatKeys = ['1'];
			const heartbeatTime = Date.now();
			for (const key of heartbeatKeys) {
				if (timestamps.has(key)) {
					timestamps.set(key, heartbeatTime);
				}
			}

			vi.advanceTimersByTime(2000);
			const cutoff = Date.now() - maxAge;

			// '1' survives (refreshed), 'ghost' is stale
			expect(timestamps.get('1')).toBeGreaterThanOrEqual(cutoff);
			expect(timestamps.get('ghost')).toBeLessThan(cutoff);

			vi.useRealTimers();
		});

		it('heartbeat ignores keys not in the local map', () => {
			const timestamps = new Map();
			timestamps.set('1', Date.now());

			// Heartbeat includes unknown key '99' -- should be ignored
			const heartbeatKeys = ['1', '99'];
			const heartbeatTime = Date.now();
			for (const key of heartbeatKeys) {
				if (timestamps.has(key)) {
					timestamps.set(key, heartbeatTime);
				}
			}

			expect(timestamps.has('99')).toBe(false);
			expect(timestamps.size).toBe(1);
		});
	});

	describe('cursor bulk event pattern', () => {
		it('applies all entries from a bulk event in one pass', () => {
			const cursorMap = new Map();

			function handleBulk(entries) {
				for (const { key, user, data } of entries) {
					cursorMap.set(key, { user, data });
				}
			}

			handleBulk([
				{ key: 'c1', user: { name: 'Alice' }, data: { x: 10, y: 20 } },
				{ key: 'c2', user: { name: 'Bob' }, data: { x: 50, y: 60 } }
			]);

			expect(cursorMap.size).toBe(2);
			expect(cursorMap.get('c1').data).toEqual({ x: 10, y: 20 });
			expect(cursorMap.get('c2').data).toEqual({ x: 50, y: 60 });
		});

		it('bulk updates overwrite existing entries', () => {
			const cursorMap = new Map();
			cursorMap.set('c1', { user: { name: 'Alice' }, data: { x: 0, y: 0 } });

			function handleBulk(entries) {
				for (const { key, user, data } of entries) {
					cursorMap.set(key, { user, data });
				}
			}

			handleBulk([
				{ key: 'c1', user: { name: 'Alice' }, data: { x: 99, y: 99 } }
			]);

			expect(cursorMap.get('c1').data).toEqual({ x: 99, y: 99 });
		});

		it('bulk refreshes timestamps for maxAge', () => {
			vi.useFakeTimers();
			const timestamps = new Map();
			const now = Date.now();
			timestamps.set('c1', now);

			vi.advanceTimersByTime(1000);

			function handleBulk(entries) {
				const bulkTime = Date.now();
				for (const { key } of entries) {
					timestamps.set(key, bulkTime);
				}
			}

			handleBulk([{ key: 'c1', user: {}, data: {} }]);

			expect(timestamps.get('c1')).toBe(now + 1000);

			vi.useRealTimers();
		});
	});

	describe('cursor maxAge pattern', () => {
		it('sweeps stale cursor entries', () => {
			vi.useFakeTimers();
			const maxAge = 3000;

			/** @type {Map<string, { user: any, data: any }>} */
			const cursorMap = new Map();
			/** @type {Map<string, number>} */
			const timestamps = new Map();

			function update(key, user, data) {
				cursorMap.set(key, { user, data });
				timestamps.set(key, Date.now());
			}

			function sweep() {
				const cutoff = Date.now() - maxAge;
				let changed = false;
				for (const [key, ts] of timestamps) {
					if (ts < cutoff) {
						timestamps.delete(key);
						if (cursorMap.delete(key)) changed = true;
					}
				}
				return changed;
			}

			update('c1', { name: 'Alice' }, { x: 10, y: 20 });
			update('c2', { name: 'Bob' }, { x: 50, y: 60 });

			vi.advanceTimersByTime(2000);
			// Bob moves
			update('c2', { name: 'Bob' }, { x: 55, y: 65 });

			vi.advanceTimersByTime(1100);
			sweep();
			expect(cursorMap.size).toBe(1);
			expect(cursorMap.has('c1')).toBe(false);
			expect(cursorMap.get('c2').data).toEqual({ x: 55, y: 65 });

			vi.useRealTimers();
		});
	});

	describe('queue management', () => {
		it('drops oldest when full', () => {
			const MAX_QUEUE_SIZE = 5;
			const queue = [];

			for (let i = 0; i < 8; i++) {
				if (queue.length >= MAX_QUEUE_SIZE) {
					queue.shift();
				}
				queue.push(`msg-${i}`);
			}

			expect(queue).toHaveLength(5);
			expect(queue[0]).toBe('msg-3');
			expect(queue[4]).toBe('msg-7');
		});
	});

	describe('batch resubscribe', () => {
		const encoder = new TextEncoder();

		// Mirrors the chunking logic from client.js onopen
		function buildBatches(subscribedTopics) {
			const allTopics = [...subscribedTopics];
			const ENVELOPE_BYTES = 39;
			const MAX_BYTES = 8000;
			const MAX_TOPICS = 200;
			const batches = [];
			let chunk = [];
			let chunkBytes = ENVELOPE_BYTES;
			for (const t of allTopics) {
				const entryBytes = encoder.encode(JSON.stringify(t)).length + 1;
				if (chunk.length > 0 && (chunk.length >= MAX_TOPICS || chunkBytes + entryBytes > MAX_BYTES)) {
					batches.push(JSON.stringify({ type: 'subscribe-batch', topics: chunk }));
					chunk = [];
					chunkBytes = ENVELOPE_BYTES;
				}
				chunk.push(t);
				chunkBytes += entryBytes;
			}
			if (chunk.length > 0) {
				batches.push(JSON.stringify({ type: 'subscribe-batch', topics: chunk }));
			}
			return batches;
		}

		function utf8ByteLength(str) {
			return encoder.encode(str).length;
		}

		it('formats a subscribe-batch message correctly', () => {
			const subscribedTopics = new Set(['todos', 'chat', 'online']);
			const batches = buildBatches(subscribedTopics);
			expect(batches).toHaveLength(1);
			const parsed = JSON.parse(batches[0]);
			expect(parsed.type).toBe('subscribe-batch');
			expect(Array.isArray(parsed.topics)).toBe(true);
			expect(parsed.topics).toHaveLength(3);
			expect(parsed.topics).toContain('todos');
			expect(parsed.topics).toContain('chat');
			expect(parsed.topics).toContain('online');
		});

		it('sends one message for small topic sets', () => {
			const subscribedTopics = new Set(['a', 'b', 'c', 'd', 'e']);
			const batches = buildBatches(subscribedTopics);
			expect(batches).toHaveLength(1);
			expect(JSON.parse(batches[0]).topics).toHaveLength(5);
		});

		it('sends nothing when there are no subscribed topics', () => {
			const batches = buildBatches(new Set());
			expect(batches).toHaveLength(0);
		});

		it('chunks when topic count exceeds 200', () => {
			const topics = new Set();
			for (let i = 0; i < 300; i++) topics.add('t' + i);
			const batches = buildBatches(topics);
			expect(batches.length).toBe(2);

			const first = JSON.parse(batches[0]);
			const second = JSON.parse(batches[1]);
			expect(first.topics).toHaveLength(200);
			expect(second.topics).toHaveLength(100);

			const all = [...first.topics, ...second.topics];
			expect(new Set(all).size).toBe(300);
		});

		it('chunks when byte size approaches 8192 ceiling', () => {
			const topics = new Set();
			for (let i = 0; i < 150; i++) topics.add('x'.repeat(95) + String(i).padStart(5, '0'));
			const batches = buildBatches(topics);
			expect(batches.length).toBeGreaterThan(1);

			for (const batch of batches) {
				expect(utf8ByteLength(batch)).toBeLessThan(8192);
				const parsed = JSON.parse(batch);
				expect(parsed.topics.length).toBeLessThanOrEqual(200);
			}

			const all = batches.flatMap(b => JSON.parse(b).topics);
			expect(new Set(all).size).toBe(150);
		});

		it('accounts for JSON escaping in topic names', () => {
			const topics = new Set();
			for (let i = 0; i < 100; i++) {
				topics.add('room"with\\special' + i);
			}
			const batches = buildBatches(topics);

			for (const batch of batches) {
				expect(utf8ByteLength(batch)).toBeLessThan(8192);
			}

			const all = batches.flatMap(b => JSON.parse(b).topics);
			expect(new Set(all).size).toBe(100);
		});

		it('accounts for multibyte UTF-8 characters in topic names', () => {
			const topics = new Set();
			// Each topic has 40 emoji (4 bytes each in UTF-8) plus a number suffix.
			// This ensures string length != byte length and forces chunking.
			const emoji = '\u{1F600}'; // 4 bytes in UTF-8, 2 code units in JS
			for (let i = 0; i < 100; i++) {
				topics.add(emoji.repeat(40) + i);
			}
			const batches = buildBatches(topics);
			expect(batches.length).toBeGreaterThan(1);

			for (const batch of batches) {
				expect(utf8ByteLength(batch)).toBeLessThan(8192);
			}

			const all = batches.flatMap(b => JSON.parse(b).topics);
			expect(new Set(all).size).toBe(100);
		});
	});

	// -- onDerived logic --------------------------------------------------------
	// Tests the core lifecycle of the reactive topic subscription pattern used
	// by onDerived(). The actual function uses svelte/store derived(), but the
	// behavior it must satisfy is independent of the framework primitive.

	describe('onDerived pattern', () => {
		// Minimal derived() implementation matching the contract used by onDerived()
		function derived(source, fn, initial = undefined) {
			return {
				subscribe(outerFn) {
					let lastValue = initial;
					let cleanup = null;
					outerFn(initial);

					const unsub = source.subscribe((v) => {
						// Call cleanup from previous run before calling fn again
						if (cleanup) { cleanup(); cleanup = null; }
						cleanup = fn(v, (val) => {
							lastValue = val;
							outerFn(val);
						});
					});

					return () => {
						if (cleanup) { cleanup(); cleanup = null; }
						unsub();
					};
				}
			};
		}

		function makeTopicStore(topicName, subscribeCallback, unsubscribeCallback) {
			return {
				subscribe(fn) {
					subscribeCallback(topicName);
					fn(null); // initial value
					return () => unsubscribeCallback(topicName);
				}
			};
		}

		it('subscribes to the initial topic when source store has a value', () => {
			const source = writable('room-1');
			const subscribed = [];
			const unsubscribed = [];

			const derived_ = derived(source, ($value, set) => {
				if ($value == null) { set(null); return; }
				const topic = `room:${$value}`;
				const store = makeTopicStore(topic, (t) => subscribed.push(t), (t) => unsubscribed.push(t));
				return store.subscribe(set);
			}, null);

			const unsub = derived_.subscribe(() => {});
			expect(subscribed).toEqual(['room:room-1']);
			expect(unsubscribed).toEqual([]);
			unsub();
		});

		it('switches topics and releases the old one when the source changes', () => {
			const source = writable('room-1');
			const subscribed = [];
			const unsubscribed = [];

			const derived_ = derived(source, ($value, set) => {
				if ($value == null) { set(null); return; }
				const topic = `room:${$value}`;
				const store = makeTopicStore(topic, (t) => subscribed.push(t), (t) => unsubscribed.push(t));
				return store.subscribe(set);
			}, null);

			const unsub = derived_.subscribe(() => {});
			expect(subscribed).toEqual(['room:room-1']);

			source.set('room-2');
			expect(subscribed).toEqual(['room:room-1', 'room:room-2']);
			// Old topic must be released before new one is subscribed
			expect(unsubscribed).toEqual(['room:room-1']);

			unsub();
			expect(unsubscribed).toEqual(['room:room-1', 'room:room-2']);
		});

		it('releases the current topic when all subscribers leave', () => {
			const source = writable('room-1');
			const unsubscribed = [];

			const derived_ = derived(source, ($value, set) => {
				if ($value == null) { set(null); return; }
				const store = makeTopicStore(`room:${$value}`, () => {}, (t) => unsubscribed.push(t));
				return store.subscribe(set);
			}, null);

			const unsub = derived_.subscribe(() => {});
			expect(unsubscribed).toHaveLength(0);
			unsub();
			expect(unsubscribed).toEqual(['room:room-1']);
		});

		it('sets inner value to null when source is null', () => {
			const source = writable(null);
			const values = [];

			const derived_ = derived(source, ($value, set) => {
				if ($value == null) { set(null); return; }
				const store = makeTopicStore(`room:${$value}`, () => {}, () => {});
				return store.subscribe(set);
			}, null);

			const unsub = derived_.subscribe((v) => values.push(v));
			// Initial value (null) + first source emission (null)  - all nulls
			expect(values.every((v) => v === null)).toBe(true);
			expect(values.length).toBeGreaterThan(0);
			unsub();
		});

		it('forwards messages from the active topic store to subscribers', () => {
			const source = writable('chat');
			const values = [];
			const callbacks = new Map();

			// Topic store that lets us push events manually
			function makeActiveStore(topic) {
				return {
					subscribe(fn) {
						callbacks.set(topic, fn);
						fn(null);
						return () => callbacks.delete(topic);
					}
				};
			}

			const derived_ = derived(source, ($value, set) => {
				if ($value == null) { set(null); return; }
				return makeActiveStore($value).subscribe(set);
			}, null);

			const unsub = derived_.subscribe((v) => { if (v !== null) values.push(v); });

			// Simulate a message on 'chat' topic
			callbacks.get('chat')?.({ topic: 'chat', event: 'message', data: 'hi' });
			expect(values).toEqual([{ topic: 'chat', event: 'message', data: 'hi' }]);

			unsub();
		});
	});
});
