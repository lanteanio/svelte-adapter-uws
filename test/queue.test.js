import { describe, it, expect, beforeEach } from 'vitest';
import { createQueue } from '../plugins/queue/server.js';

/** Helper: create a task that resolves after a delay with a value. */
function delayed(ms, value) {
	return () => new Promise(resolve => setTimeout(resolve, ms, value));
}

/** Helper: create a task that records execution order. */
function recorder(order, label, ms = 0) {
	return () => new Promise(resolve => {
		order.push(label + ':start');
		setTimeout(() => {
			order.push(label + ':end');
			resolve(label);
		}, ms);
	});
}

describe('queue plugin', () => {
	let queue;

	beforeEach(() => {
		queue = createQueue();
	});

	describe('createQueue', () => {
		it('returns a queue with the expected API', () => {
			expect(typeof queue.push).toBe('function');
			expect(typeof queue.size).toBe('function');
			expect(typeof queue.clear).toBe('function');
			expect(typeof queue.drain).toBe('function');
		});

		it('works with default options', () => {
			expect(() => createQueue()).not.toThrow();
		});

		it('throws on concurrency < 1', () => {
			expect(() => createQueue({ concurrency: 0 })).toThrow('positive integer');
		});

		it('throws on non-integer concurrency', () => {
			expect(() => createQueue({ concurrency: 1.5 })).toThrow('positive integer');
		});

		it('throws on maxSize < 1', () => {
			expect(() => createQueue({ maxSize: 0 })).toThrow('positive number');
		});

		it('throws on non-function onDrop', () => {
			expect(() => createQueue({ onDrop: 'bad' })).toThrow('function');
		});
	});

	describe('push - basic', () => {
		it('single task executes and resolves with return value', async () => {
			const result = await queue.push('key', () => 42);
			expect(result).toBe(42);
		});

		it('async task resolves correctly', async () => {
			const result = await queue.push('key', async () => {
				await new Promise(r => setTimeout(r, 5));
				return 'done';
			});
			expect(result).toBe('done');
		});

		it('task that throws causes push promise to reject', async () => {
			await expect(queue.push('key', () => { throw new Error('boom'); }))
				.rejects.toThrow('boom');
		});

		it('async task that rejects causes push promise to reject', async () => {
			await expect(queue.push('key', async () => { throw new Error('async boom'); }))
				.rejects.toThrow('async boom');
		});

		it('rejects on non-string key', async () => {
			await expect(queue.push(123, () => {})).rejects.toThrow('key must be a string');
		});

		it('rejects on non-function task', async () => {
			await expect(queue.push('key', 'bad')).rejects.toThrow('task must be a function');
		});
	});

	describe('push - ordering (concurrency=1)', () => {
		it('two tasks on same key execute in order', async () => {
			const order = [];
			const p1 = queue.push('k', recorder(order, 'A', 10));
			const p2 = queue.push('k', recorder(order, 'B', 5));

			await Promise.all([p1, p2]);
			expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
		});

		it('three tasks execute sequentially on same key', async () => {
			const order = [];
			await Promise.all([
				queue.push('k', recorder(order, '1', 5)),
				queue.push('k', recorder(order, '2', 5)),
				queue.push('k', recorder(order, '3', 5))
			]);
			expect(order).toEqual([
				'1:start', '1:end',
				'2:start', '2:end',
				'3:start', '3:end'
			]);
		});

		it('different keys execute concurrently', async () => {
			const order = [];
			const p1 = queue.push('A', recorder(order, 'A', 10));
			const p2 = queue.push('B', recorder(order, 'B', 10));

			await Promise.all([p1, p2]);
			// Both should start before either ends
			expect(order[0]).toBe('A:start');
			expect(order[1]).toBe('B:start');
		});
	});

	describe('push - concurrency > 1', () => {
		it('concurrency=2: two tasks start immediately', async () => {
			const q = createQueue({ concurrency: 2 });
			const order = [];

			await Promise.all([
				q.push('k', recorder(order, 'A', 10)),
				q.push('k', recorder(order, 'B', 10))
			]);

			// Both should start before either ends
			expect(order[0]).toBe('A:start');
			expect(order[1]).toBe('B:start');
		});

		it('concurrency=2: third task waits for one to finish', async () => {
			const q = createQueue({ concurrency: 2 });
			const order = [];

			await Promise.all([
				q.push('k', recorder(order, 'A', 10)),
				q.push('k', recorder(order, 'B', 20)),
				q.push('k', recorder(order, 'C', 5))
			]);

			// A and B start first, C starts after A finishes
			expect(order.indexOf('C:start')).toBeGreaterThan(order.indexOf('A:end'));
		});
	});

	describe('push - backpressure (maxSize)', () => {
		it('exceeding maxSize rejects the push promise', async () => {
			const q = createQueue({ maxSize: 1 });

			// First push starts running (not in waiting queue)
			q.push('k', delayed(50, 'first'));

			// Second push goes into waiting queue (size 1 = maxSize)
			q.push('k', delayed(5, 'second'));

			// Third push exceeds maxSize
			await expect(q.push('k', () => 'third')).rejects.toThrow('maxSize exceeded');
		});

		it('onDrop is called when maxSize exceeded', async () => {
			const dropped = [];
			const q = createQueue({
				maxSize: 1,
				onDrop: (d) => dropped.push(d.key)
			});

			q.push('k', delayed(50));
			q.push('k', delayed(5));
			await expect(q.push('k', () => {})).rejects.toThrow('maxSize');

			expect(dropped).toEqual(['k']);
		});
	});

	describe('size', () => {
		it('returns 0 for unknown key', () => {
			expect(queue.size('unknown')).toBe(0);
		});

		it('returns correct count for specific key', async () => {
			const p = queue.push('k', delayed(50));
			queue.push('k', delayed(5));

			expect(queue.size('k')).toBe(2); // 1 running + 1 waiting

			await p; // let first finish
		});

		it('returns total across all keys when no key provided', async () => {
			queue.push('a', delayed(50));
			queue.push('b', delayed(50));

			expect(queue.size()).toBe(2);
		});
	});

	describe('clear', () => {
		it('clears specific key, pending tasks get rejected', async () => {
			const p1 = queue.push('k', delayed(20, 'first'));
			const p2 = queue.push('k', () => 'should not run');

			queue.clear('k');

			await expect(p2).rejects.toThrow('queue cleared');
			// p1 (running) should still complete
			await expect(p1).resolves.toBe('first');
		});

		it('clears all keys', async () => {
			queue.push('a', delayed(20));
			const pa = queue.push('a', () => 'nope');
			queue.push('b', delayed(20));
			const pb = queue.push('b', () => 'nope');

			queue.clear();

			await expect(pa).rejects.toThrow('queue cleared');
			await expect(pb).rejects.toThrow('queue cleared');
		});

		it('safe to call on empty/unknown key', () => {
			expect(() => queue.clear('nope')).not.toThrow();
			expect(() => queue.clear()).not.toThrow();
		});
	});

	describe('drain', () => {
		it('resolves immediately for unknown key', async () => {
			await expect(queue.drain('unknown')).resolves.toBeUndefined();
		});

		it('resolves when all tasks for a key complete', async () => {
			let completed = 0;
			queue.push('k', async () => { await new Promise(r => setTimeout(r, 10)); completed++; });
			queue.push('k', async () => { await new Promise(r => setTimeout(r, 10)); completed++; });

			await queue.drain('k');
			expect(completed).toBe(2);
		});

		it('resolves when all tasks across all keys complete', async () => {
			let completed = 0;
			queue.push('a', async () => { await new Promise(r => setTimeout(r, 10)); completed++; });
			queue.push('b', async () => { await new Promise(r => setTimeout(r, 10)); completed++; });

			await queue.drain();
			expect(completed).toBe(2);
		});

		it('drain with no active queues resolves immediately', async () => {
			await expect(queue.drain()).resolves.toBeUndefined();
		});

		it('waits for all parallel tasks when concurrency > 1', async () => {
			const q = createQueue({ concurrency: 3 });
			let running = 0;
			let maxRunning = 0;
			let completed = 0;

			for (let i = 0; i < 5; i++) {
				q.push('k', async () => {
					running++;
					if (running > maxRunning) maxRunning = running;
					await new Promise(r => setTimeout(r, 20));
					running--;
					completed++;
				});
			}

			await q.drain('k');
			expect(completed).toBe(5);
			expect(running).toBe(0);
			expect(maxRunning).toBeGreaterThan(1);
		});

		it('does not resolve while tasks are still in flight (concurrency=2)', async () => {
			const q = createQueue({ concurrency: 2 });
			let slowDone = false;
			let fastDone = false;

			q.push('k', async () => {
				await new Promise(r => setTimeout(r, 50));
				slowDone = true;
			});
			q.push('k', async () => {
				await new Promise(r => setTimeout(r, 5));
				fastDone = true;
			});

			await q.drain('k');
			expect(fastDone).toBe(true);
			expect(slowDone).toBe(true);
		});
	});

	describe('cleanup', () => {
		it('internal map is cleaned up when queue empties', async () => {
			await queue.push('k', () => 'done');
			// After completion, size should be 0
			expect(queue.size('k')).toBe(0);
		});

		it('failed task does not leave dangling state', async () => {
			await queue.push('k', () => { throw new Error('fail'); }).catch(() => {});
			expect(queue.size('k')).toBe(0);
		});
	});
});
