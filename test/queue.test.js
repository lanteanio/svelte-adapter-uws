import { describe, it, expect, beforeEach } from 'vitest';
import { createQueue } from '../src/plugins/queue/server.js';

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

/**
 * Helper: a task that records its start and then finishes only when the test
 * says so. Scheduling assertions need this - with timer-driven tasks the
 * observed order is partly the timer wheel's, so a scheduler that picked
 * differently could still produce the expected sequence.
 */
function gated(starts, label) {
	let release;
	const finished = new Promise(resolve => { release = resolve; });
	return {
		label,
		task: () => {
			starts.push(label);
			return finished;
		},
		release: () => release(label)
	};
}

/** Helper: let every pending microtask and timer callback run. */
function flush() {
	return new Promise(resolve => setTimeout(resolve, 0));
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

		it('throws on invalid maxKeyLength', () => {
			expect(() => createQueue({ maxKeyLength: 0 })).toThrow('maxKeyLength must be a positive integer');
			expect(() => createQueue({ maxKeyLength: -1 })).toThrow('maxKeyLength must be a positive integer');
			expect(() => createQueue({ maxKeyLength: 1.5 })).toThrow('maxKeyLength must be a positive integer');
		});

		it('throws on invalid aggregate bounds', () => {
			expect(() => createQueue({ maxKeys: 0 })).toThrow('maxKeys must be a positive number or Infinity');
			expect(() => createQueue({ maxKeys: NaN })).toThrow('maxKeys must be a positive number');
			expect(() => createQueue({ maxPendingTotal: -1 })).toThrow('maxPendingTotal must be a positive number');
			expect(() => createQueue({ maxPendingTotal: 'lots' })).toThrow('maxPendingTotal must be a positive number');
			expect(() => createQueue({ maxRunningTotal: 0 })).toThrow('maxRunningTotal must be a positive number');
			expect(() => createQueue({ maxRunningTotal: -Infinity })).toThrow('maxRunningTotal must be a positive number');
		});

		it('accepts Infinity for the aggregate bounds', () => {
			expect(() => createQueue({
				maxKeys: Infinity,
				maxPendingTotal: Infinity,
				maxRunningTotal: Infinity
			})).not.toThrow();
		});
	});

	describe('maxKeyLength cap', () => {
		it('rejects keys longer than the default 256-char cap', async () => {
			const q = createQueue();
			const tooLong = 'a'.repeat(257);
			await expect(q.push(tooLong, () => 'never'))
				.rejects.toThrow('exceeds maxKeyLength 256');
		});

		it('accepts keys exactly at the cap', async () => {
			const q = createQueue();
			const justFits = 'a'.repeat(256);
			expect(await q.push(justFits, () => 'ok')).toBe('ok');
		});

		it('honors a custom maxKeyLength', async () => {
			const q = createQueue({ maxKeyLength: 16 });
			expect(await q.push('a'.repeat(16), () => 'ok')).toBe('ok');
			await expect(q.push('a'.repeat(17), () => 'never'))
				.rejects.toThrow('exceeds maxKeyLength 16');
		});

		it('error names the actual key length', async () => {
			const q = createQueue();
			await expect(q.push('a'.repeat(800), () => 'x'))
				.rejects.toThrow('key length 800');
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

		it('reuses a key that was cleared while it waited for its turn', async () => {
			const q = createQueue({ maxRunningTotal: 1 });
			const running = q.push('a', delayed(20, 'a'));
			const cancelled = q.push('b', () => 'never');

			q.clear('b');
			await expect(cancelled).rejects.toThrow('queue cleared');
			expect(q.size('b')).toBe(0);

			const revived = q.push('b', () => 'revived');
			expect(await Promise.all([running, revived])).toEqual(['a', 'revived']);
			expect(q.stats().keysCurrent).toBe(0);
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

	describe('key cardinality (maxKeys)', () => {
		it('rejects a push for a new key once maxKeys keys are live', async () => {
			const q = createQueue({ maxKeys: 2 });
			const a = q.push('a', delayed(20, 'a'));
			const b = q.push('b', delayed(20, 'b'));

			await expect(q.push('c', () => 'never')).rejects.toMatchObject({
				code: 'QUEUE_TOO_MANY_KEYS',
				key: 'c',
				maxKeys: 2
			});

			await Promise.all([a, b]);
		});

		it('still accepts work on an already-live key at the cap', async () => {
			const q = createQueue({ maxKeys: 1 });
			const first = q.push('a', delayed(20, 'first'));
			const second = q.push('a', () => 'second');

			expect(await Promise.all([first, second])).toEqual(['first', 'second']);
		});

		it('a drained key frees its slot', async () => {
			const q = createQueue({ maxKeys: 1 });
			expect(await q.push('a', () => 'a')).toBe('a');
			expect(await q.push('b', () => 'b')).toBe('b');
		});

		it('a shed push does not allocate the key it was rejected for', async () => {
			const q = createQueue({ maxKeys: 1 });
			const a = q.push('a', delayed(20, 'a'));

			await expect(q.push('b', () => 'never')).rejects.toThrow('maxKeys exceeded');

			expect(q.size('b')).toBe(0);
			expect(q.stats().keysCurrent).toBe(1);
			await a;
		});
	});

	describe('aggregate backlog (maxPendingTotal)', () => {
		it('rejects once waiting tasks across all keys hit the cap', async () => {
			const q = createQueue({ maxRunningTotal: 1, maxPendingTotal: 2 });
			const running = q.push('a', delayed(30, 'a'));
			const waiting = [
				q.push('b', () => 'b'),
				q.push('c', () => 'c')
			];

			await expect(q.push('d', () => 'never')).rejects.toMatchObject({
				code: 'QUEUE_BACKLOG_FULL',
				key: 'd',
				maxPendingTotal: 2
			});

			await Promise.all([running, ...waiting]);
		});

		it('bounds the aggregate even when every key is under maxSize', async () => {
			const q = createQueue({ maxRunningTotal: 1, maxSize: 100, maxPendingTotal: 3 });
			const running = q.push('a', delayed(30, 'a'));
			const waiting = [];
			for (let i = 0; i < 3; i++) waiting.push(q.push('k' + i, () => i));

			// Each key holds a single waiting task, far below maxSize 100.
			await expect(q.push('k3', () => 'never')).rejects.toThrow('maxPendingTotal exceeded');

			await Promise.all([running, ...waiting]);
		});

		it('a shed push does not allocate the key it was rejected for', async () => {
			const q = createQueue({ maxRunningTotal: 1, maxPendingTotal: 1 });
			const running = q.push('a', delayed(20, 'a'));
			const waiting = q.push('b', () => 'b');

			await expect(q.push('c', () => 'never')).rejects.toThrow('maxPendingTotal exceeded');

			expect(q.size('c')).toBe(0);
			expect(q.stats().keysCurrent).toBe(2);
			await Promise.all([running, waiting]);
		});

		it('frees capacity again as waiting tasks start', async () => {
			const q = createQueue({ maxRunningTotal: 1, maxPendingTotal: 1 });
			const running = q.push('a', delayed(10, 'a'));
			const waiting = q.push('b', () => 'b');

			await Promise.all([running, waiting]);
			expect(await q.push('c', () => 'c')).toBe('c');
		});
	});

	describe('aggregate concurrency (maxRunningTotal)', () => {
		it('caps in-flight tasks across distinct keys instead of rejecting them', async () => {
			const q = createQueue({ maxRunningTotal: 2 });
			let inFlight = 0;
			let peak = 0;
			const pushes = [];

			for (let i = 0; i < 6; i++) {
				pushes.push(q.push('key' + i, async () => {
					inFlight++;
					if (inFlight > peak) peak = inFlight;
					await new Promise(r => setTimeout(r, 10));
					inFlight--;
					return i;
				}));
			}

			expect(await Promise.all(pushes)).toEqual([0, 1, 2, 3, 4, 5]);
			expect(peak).toBe(2);
			expect(inFlight).toBe(0);
		});

		it('caps in-flight tasks below key count x concurrency', async () => {
			const q = createQueue({ concurrency: 4, maxRunningTotal: 3 });
			let inFlight = 0;
			let peak = 0;
			const pushes = [];

			for (let key = 0; key < 3; key++) {
				for (let i = 0; i < 4; i++) {
					pushes.push(q.push('key' + key, async () => {
						inFlight++;
						if (inFlight > peak) peak = inFlight;
						await new Promise(r => setTimeout(r, 5));
						inFlight--;
					}));
				}
			}

			await Promise.all(pushes);
			expect(peak).toBe(3);
		});

		it('hands a freed slot to the next key in line, not back to the key that freed it', async () => {
			// concurrency 2 with a budget of 2 is the case that tells the
			// schedulers apart: when a1 finishes, key a is still allowed a
			// second task of its own, so a scheduler that refills the key it
			// just heard from starts a3 while b waits. Only handing the slot
			// to the next key in line produces the sequence below.
			const q = createQueue({ concurrency: 2, maxRunningTotal: 2 });
			const starts = [];
			const tasks = {
				a1: gated(starts, 'a1'), a2: gated(starts, 'a2'), a3: gated(starts, 'a3'),
				b1: gated(starts, 'b1'), b2: gated(starts, 'b2')
			};
			const pushes = [
				q.push('a', tasks.a1.task),
				q.push('a', tasks.a2.task),
				q.push('a', tasks.a3.task),
				q.push('b', tasks.b1.task),
				q.push('b', tasks.b2.task)
			];

			await flush();
			// Both slots are held by key a, which arrived first; b waits.
			expect(starts).toEqual(['a1', 'a2']);
			expect(q.stats().runningCurrent).toBe(2);
			expect(q.stats().readyCurrent).toBe(1);

			tasks.a1.release();
			await flush();
			expect(starts).toEqual(['a1', 'a2', 'b1']);
			expect(q.stats().runningCurrent).toBe(2);

			tasks.a2.release();
			await flush();
			expect(starts).toEqual(['a1', 'a2', 'b1', 'a3']);

			tasks.b1.release();
			await flush();
			expect(starts).toEqual(['a1', 'a2', 'b1', 'a3', 'b2']);

			tasks.a3.release();
			tasks.b2.release();
			await Promise.all(pushes);
			expect(q.stats().runningCurrent).toBe(0);
			expect(q.stats().readyCurrent).toBe(0);
		});

		it('interleaves keys one task at a time while keeping each key in order', async () => {
			const q = createQueue({ maxRunningTotal: 1 });
			const starts = [];
			const tasks = new Map();
			const pushes = [];

			for (const key of ['a', 'b']) {
				for (let i = 1; i <= 3; i++) {
					const gate = gated(starts, key + i);
					tasks.set(gate.label, gate);
					pushes.push(q.push(key, gate.task));
				}
			}

			// Release one task per round. Nothing overlaps, so the sequence is
			// the scheduler's choice rather than a race between tasks.
			for (let round = 0; round < 6; round++) {
				await flush();
				expect(starts.length).toBe(round + 1);
				expect(q.stats().runningCurrent).toBe(1);
				tasks.get(starts[round]).release();
			}

			await Promise.all(pushes);
			expect(starts).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
			expect(q.stats().readyCurrent).toBe(0);
		});

		it('drains a large same-key backlog in FIFO order', async () => {
			const q = createQueue();
			const order = [];
			const pushes = [];

			for (let i = 0; i < 500; i++) pushes.push(q.push('k', () => { order.push(i); }));

			await Promise.all(pushes);
			expect(order.length).toBe(500);
			expect(order.every((value, index) => value === index)).toBe(true);
			expect(q.size()).toBe(0);
		});
	});

	describe('service line', () => {
		it('gives up a cleared key\'s place instead of accumulating stale ones', async () => {
			const q = createQueue({ maxRunningTotal: 1 });
			const starts = [];
			const held = gated(starts, 'held');
			const running = q.push('held', held.task);

			await flush();
			expect(q.stats().runningCurrent).toBe(1);

			// Cancel-pending-work-on-disconnect, with the running budget
			// saturated the whole time so the scheduler never gets a turn.
			for (let i = 0; i < 500; i++) {
				const cancelled = q.push('user:' + i, () => 'never');
				q.clear('user:' + i);
				await expect(cancelled).rejects.toThrow('queue cleared');
			}

			const saturated = q.stats();
			expect(saturated.keysCurrent).toBe(1);
			expect(saturated.pendingCurrent).toBe(0);
			// Keeping the places would leave 500 entries naming keys that no
			// longer exist, behind the very budget that stops the scheduler
			// from reaching them.
			expect(saturated.readyCurrent).toBe(0);

			held.release();
			expect(await running).toBe('held');
			expect(q.stats()).toMatchObject({ keysCurrent: 0, readyCurrent: 0 });
		});

		it('gives up the place of a key that clear() empties while one of its tasks runs', async () => {
			const q = createQueue({ concurrency: 2, maxRunningTotal: 2 });
			const starts = [];
			const blocker = gated(starts, 'blocker');
			const k1 = gated(starts, 'k1');
			const blocking = q.push('blocker', blocker.task);
			const first = q.push('k', k1.task);

			await flush();
			expect(starts).toEqual(['blocker', 'k1']);

			// Key k is allowed a second concurrent task but the budget is
			// full, so it takes a place in the line and waits.
			const cancelled = q.push('k', () => 'never');
			expect(q.stats().readyCurrent).toBe(1);

			q.clear('k');
			await expect(cancelled).rejects.toThrow('queue cleared');

			const cleared = q.stats();
			expect(cleared.keysCurrent).toBe(2);
			expect(cleared.readyCurrent).toBe(0);

			blocker.release();
			k1.release();
			await Promise.all([blocking, first]);
			expect(q.stats()).toMatchObject({ keysCurrent: 0, readyCurrent: 0 });
		});

		it('never lines up more keys than are live, through push and clear churn', async () => {
			const q = createQueue({ concurrency: 2, maxRunningTotal: 2 });
			const gates = [];
			const settled = [];

			for (let i = 0; i < 60; i++) {
				const key = 'key:' + (i % 8);
				const gate = gated([], 'g' + i);
				gates.push(gate);
				settled.push(q.push(key, gate.task).catch(() => {}));
				if (i % 3 === 0) q.clear(key);
				const s = q.stats();
				expect(s.readyCurrent).toBeLessThanOrEqual(s.keysCurrent);
			}

			for (const gate of gates) gate.release();
			await Promise.all(settled);
			expect(q.stats()).toMatchObject({
				keysCurrent: 0,
				readyCurrent: 0,
				pendingCurrent: 0,
				runningCurrent: 0
			});
		});
	});

	describe('typed rejections', () => {
		it('maxSize rejection carries the code and the bound', async () => {
			const q = createQueue({ maxSize: 1 });
			const first = q.push('k', delayed(30, 'first'));
			const second = q.push('k', () => 'second');

			await expect(q.push('k', () => 'third')).rejects.toMatchObject({
				code: 'QUEUE_FULL',
				key: 'k',
				maxSize: 1
			});

			await Promise.all([first, second]);
		});

		it('clear rejection carries the code and the key', async () => {
			const q = createQueue();
			const running = q.push('k', delayed(20, 'running'));
			const cancelled = q.push('k', () => 'never');

			q.clear('k');

			await expect(cancelled).rejects.toMatchObject({
				code: 'QUEUE_CLEARED',
				key: 'k'
			});
			await running;
		});

		it('onDrop names the bound that shed the task', async () => {
			const bySize = [];
			const perKey = createQueue({ maxSize: 1, onDrop: (d) => bySize.push(d.reason) });
			const sizeRunning = perKey.push('k', delayed(20, 'k'));
			const sizeWaiting = perKey.push('k', () => 'waiting');
			await expect(perKey.push('k', () => 'x')).rejects.toThrow('maxSize exceeded');
			expect(bySize).toEqual(['maxSize']);

			const byKeys = [];
			const keyCount = createQueue({ maxKeys: 1, onDrop: (d) => byKeys.push(d.reason) });
			const keyRunning = keyCount.push('a', delayed(20, 'a'));
			await expect(keyCount.push('b', () => 'x')).rejects.toThrow('maxKeys exceeded');
			expect(byKeys).toEqual(['maxKeys']);

			const byBacklog = [];
			const backlog = createQueue({
				maxRunningTotal: 1,
				maxPendingTotal: 1,
				onDrop: (d) => byBacklog.push({ key: d.key, reason: d.reason, task: typeof d.task })
			});
			const backlogRunning = backlog.push('a', delayed(20, 'a'));
			const backlogWaiting = backlog.push('b', () => 'b');
			await expect(backlog.push('c', () => 'x')).rejects.toThrow('maxPendingTotal exceeded');
			expect(byBacklog).toEqual([{ key: 'c', reason: 'maxPendingTotal', task: 'function' }]);

			await Promise.all([
				sizeRunning, sizeWaiting, keyRunning, backlogRunning, backlogWaiting
			]);
		});

		it('still rejects through the returned promise when onDrop throws', async () => {
			const q = createQueue({
				maxSize: 1,
				onDrop: () => { throw new Error('metrics sink down'); }
			});
			const running = q.push('k', delayed(20, 'running'));
			const waiting = q.push('k', () => 'waiting');

			// A synchronous throw out of push() is not something a caller's
			// .catch() can see, so the sink must not be able to cause one.
			let shed;
			expect(() => { shed = q.push('k', () => 'shed'); }).not.toThrow();
			await expect(shed).rejects.toMatchObject({ code: 'QUEUE_FULL', maxSize: 1 });

			const s = q.stats();
			expect(s.onDropErrorsTotal).toBe(1);
			expect(s.dropped.maxSize).toBe(1);

			await Promise.all([running, waiting]);
		});
	});

	describe('stats', () => {
		it('starts empty', () => {
			expect(queue.stats()).toEqual({
				keysCurrent: 0,
				pendingCurrent: 0,
				runningCurrent: 0,
				readyCurrent: 0,
				keysPeak: 0,
				pendingPeak: 0,
				runningPeak: 0,
				pushedTotal: 0,
				completedTotal: 0,
				failedTotal: 0,
				clearedTotal: 0,
				onDropErrorsTotal: 0,
				dropped: { maxSize: 0, maxKeys: 0, maxPendingTotal: 0 }
			});
		});

		it('reports live gauges while work is in flight', async () => {
			const q = createQueue({ maxRunningTotal: 1 });
			const running = q.push('a', delayed(20, 'a'));
			const waiting = q.push('b', () => 'b');

			const live = q.stats();
			expect(live.keysCurrent).toBe(2);
			expect(live.runningCurrent).toBe(1);
			expect(live.pendingCurrent).toBe(1);
			expect(live.pushedTotal).toBe(2);

			await Promise.all([running, waiting]);

			const settled = q.stats();
			expect(settled.keysCurrent).toBe(0);
			expect(settled.runningCurrent).toBe(0);
			expect(settled.pendingCurrent).toBe(0);
			expect(settled.completedTotal).toBe(2);
			expect(settled.keysPeak).toBe(2);
			expect(settled.pendingPeak).toBe(1);
			expect(settled.runningPeak).toBe(1);
		});

		it('counts failures, clears and drops separately', async () => {
			const q = createQueue({ maxSize: 1 });
			await q.push('k', () => { throw new Error('boom'); }).catch(() => {});

			const running = q.push('k', delayed(20, 'running'));
			const cancelled = q.push('k', () => 'never');
			await expect(q.push('k', () => 'shed')).rejects.toThrow('maxSize exceeded');
			q.clear('k');
			await expect(cancelled).rejects.toThrow('queue cleared');
			await running;

			const s = q.stats();
			expect(s.failedTotal).toBe(1);
			expect(s.completedTotal).toBe(1);
			expect(s.clearedTotal).toBe(1);
			expect(s.dropped).toEqual({ maxSize: 1, maxKeys: 0, maxPendingTotal: 0 });
			expect(s.pushedTotal).toBe(3);
		});

		it('returns a snapshot the caller cannot use to mutate counters', () => {
			const q = createQueue();
			const snapshot = q.stats();
			snapshot.dropped.maxSize = 999;
			expect(q.stats().dropped.maxSize).toBe(0);
		});
	});
});
