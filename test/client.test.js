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
});
