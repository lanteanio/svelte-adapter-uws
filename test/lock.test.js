import { describe, it, expect } from 'vitest';
import { createLock } from '../plugins/lock/server.js';

/**
 * Build a deferred promise + resolvers for ordering tests.
 */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('createLock', () => {
	describe('API surface', () => {
		it('returns the documented surface', () => {
			const locks = createLock();
			expect(typeof locks.withLock).toBe('function');
			expect(typeof locks.held).toBe('function');
			expect(typeof locks.size).toBe('function');
			expect(typeof locks.clear).toBe('function');
		});

		it('starts empty', () => {
			const locks = createLock();
			expect(locks.size()).toBe(0);
			expect(locks.held('any')).toBe(false);
		});
	});

	describe('input validation', () => {
		it('rejects when key is not a non-empty string', async () => {
			const locks = createLock();
			await expect(locks.withLock('', async () => 1)).rejects.toThrow('non-empty string');
			await expect(locks.withLock(undefined, async () => 1)).rejects.toThrow('non-empty string');
			await expect(locks.withLock(42, async () => 1)).rejects.toThrow('non-empty string');
		});

		it('rejects when fn is not a function', async () => {
			const locks = createLock();
			await expect(locks.withLock('k', null)).rejects.toThrow('fn must be a function');
			await expect(locks.withLock('k', 'not a function')).rejects.toThrow('fn must be a function');
		});

		it('rejects invalid maxKeys', () => {
			expect(() => createLock({ maxKeys: 0 })).toThrow('maxKeys must be a positive integer');
			expect(() => createLock({ maxKeys: -1 })).toThrow('maxKeys must be a positive integer');
			expect(() => createLock({ maxKeys: 1.5 })).toThrow('maxKeys must be a positive integer');
		});
	});

	describe('maxKeys cap', () => {
		it('rejects new-key withLock when chain is at cap', async () => {
			const locks = createLock({ maxKeys: 2 });
			const a = deferred();
			const b = deferred();
			const pa = locks.withLock('a', () => a.promise);
			const pb = locks.withLock('b', () => b.promise);
			await expect(locks.withLock('c', () => 'never'))
				.rejects.toThrow('active key count exceeded 2');
			a.resolve(1); b.resolve(2);
			await pa; await pb;
		});

		it('allows re-entering an existing key when at cap', async () => {
			const locks = createLock({ maxKeys: 2 });
			const a = deferred();
			const b = deferred();
			const pa = locks.withLock('a', () => a.promise);
			const pb = locks.withLock('b', () => b.promise);
			// 'a' is already in the chain - chaining off it must NOT trip the cap
			const pa2 = locks.withLock('a', () => 'second a');
			a.resolve(1);
			expect(await pa2).toBe('second a');
			b.resolve(2);
			await pb;
		});
	});

	describe('basic execution', () => {
		it('returns the value fn returns', async () => {
			const locks = createLock();
			const result = await locks.withLock('k', () => 42);
			expect(result).toBe(42);
		});

		it('awaits async fn and returns its resolved value', async () => {
			const locks = createLock();
			const result = await locks.withLock('k', async () => {
				await Promise.resolve();
				return 'ok';
			});
			expect(result).toBe('ok');
		});

		it('propagates errors from fn to the caller', async () => {
			const locks = createLock();
			await expect(
				locks.withLock('k', () => { throw new Error('boom'); })
			).rejects.toThrow('boom');
			await expect(
				locks.withLock('k', async () => { throw new Error('async-boom'); })
			).rejects.toThrow('async-boom');
		});
	});

	describe('serialization on the same key', () => {
		it('runs concurrent calls on the same key one at a time, FIFO', async () => {
			const locks = createLock();
			const order = [];
			const dA = deferred();
			const dB = deferred();
			const dC = deferred();

			const a = locks.withLock('k', async () => {
				order.push('a-start');
				await dA.promise;
				order.push('a-end');
				return 'a';
			});
			const b = locks.withLock('k', async () => {
				order.push('b-start');
				await dB.promise;
				order.push('b-end');
				return 'b';
			});
			const c = locks.withLock('k', async () => {
				order.push('c-start');
				await dC.promise;
				order.push('c-end');
				return 'c';
			});

			// Only A should be running. B and C are queued.
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(['a-start']);

			dA.resolve();
			await a;
			// Now B should start.
			expect(order).toEqual(['a-start', 'a-end', 'b-start']);

			dB.resolve();
			await b;
			expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start']);

			dC.resolve();
			expect(await c).toBe('c');
			expect(order).toEqual([
				'a-start', 'a-end',
				'b-start', 'b-end',
				'c-start', 'c-end'
			]);
		});

		it('an error in one holder does not block subsequent waiters on the same key', async () => {
			const locks = createLock();
			const order = [];

			const a = locks.withLock('k', async () => {
				order.push('a-start');
				throw new Error('a-failed');
			});
			const b = locks.withLock('k', async () => {
				order.push('b-start');
				return 'b';
			});

			await expect(a).rejects.toThrow('a-failed');
			expect(await b).toBe('b');
			expect(order).toEqual(['a-start', 'b-start']);
		});
	});

	describe('parallelism across different keys', () => {
		it('runs holders for different keys in parallel', async () => {
			const locks = createLock();
			const dA = deferred();
			const dB = deferred();
			const order = [];

			const a = locks.withLock('k1', async () => {
				order.push('a-start');
				await dA.promise;
				order.push('a-end');
			});
			const b = locks.withLock('k2', async () => {
				order.push('b-start');
				await dB.promise;
				order.push('b-end');
			});

			await Promise.resolve();
			await Promise.resolve();
			// Both started in parallel - neither has waited for the other.
			expect(order).toEqual(['a-start', 'b-start']);

			// Resolve B first, even though A started first.
			dB.resolve();
			await b;
			expect(order).toEqual(['a-start', 'b-start', 'b-end']);

			dA.resolve();
			await a;
			expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
		});
	});

	describe('held / size / clear', () => {
		it('held(key) reflects current state', async () => {
			const locks = createLock();
			const d = deferred();
			const p = locks.withLock('k', async () => { await d.promise; });

			expect(locks.held('k')).toBe(true);
			expect(locks.held('other')).toBe(false);

			d.resolve();
			await p;

			expect(locks.held('k')).toBe(false);
		});

		it('size reflects the number of currently-held keys', async () => {
			const locks = createLock();
			const dA = deferred();
			const dB = deferred();

			expect(locks.size()).toBe(0);

			const a = locks.withLock('k1', async () => { await dA.promise; });
			const b = locks.withLock('k2', async () => { await dB.promise; });
			expect(locks.size()).toBe(2);

			dA.resolve();
			await a;
			expect(locks.size()).toBe(1);

			dB.resolve();
			await b;
			expect(locks.size()).toBe(0);
		});

		it('multiple waiters on the same key count as one held key', async () => {
			const locks = createLock();
			const d = deferred();
			const a = locks.withLock('k', async () => { await d.promise; });
			const b = locks.withLock('k', async () => 'b');
			const c = locks.withLock('k', async () => 'c');

			expect(locks.size()).toBe(1);
			expect(locks.held('k')).toBe(true);

			d.resolve();
			await Promise.all([a, b, c]);

			expect(locks.size()).toBe(0);
		});

		it('clear() drops the bookkeeping but pending fn calls still run', async () => {
			const locks = createLock();
			const d = deferred();
			const p = locks.withLock('k', async () => { await d.promise; return 'done'; });
			expect(locks.size()).toBe(1);

			locks.clear();
			expect(locks.size()).toBe(0);
			expect(locks.held('k')).toBe(false);

			// The in-flight promise still resolves normally.
			d.resolve();
			expect(await p).toBe('done');
		});
	});

	describe('release ordering', () => {
		it('release is keyed by identity - a later entrant does not get clobbered', async () => {
			// This is the "third entrant" case: A finishes, then B runs;
			// while B is still running, the chain head must be B (not
			// undefined) so a fourth entrant chains off B, not skips ahead.
			const locks = createLock();
			const dA = deferred();
			const dB = deferred();
			const order = [];

			const a = locks.withLock('k', async () => {
				order.push('a-start');
				await dA.promise;
				order.push('a-end');
			});
			const b = locks.withLock('k', async () => {
				order.push('b-start');
				await dB.promise;
				order.push('b-end');
			});

			dA.resolve();
			await a;

			// A is done; B is now running. Chain head must still be B.
			expect(locks.held('k')).toBe(true);

			// Fourth entrant chains off B.
			const c = locks.withLock('k', async () => {
				order.push('c-start');
				return 'c';
			});

			dB.resolve();
			expect(await c).toBe('c');
			expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start']);
			expect(locks.held('k')).toBe(false);
		});
	});

	describe('maxWaitMs', () => {
		it('rejects invalid maxWaitMs', async () => {
			const locks = createLock();
			await expect(locks.withLock('k', () => 1, { maxWaitMs: -1 }))
				.rejects.toThrow('non-negative finite number');
			await expect(locks.withLock('k', () => 1, { maxWaitMs: NaN }))
				.rejects.toThrow('non-negative finite number');
			await expect(locks.withLock('k', () => 1, { maxWaitMs: Infinity }))
				.rejects.toThrow('non-negative finite number');
			await expect(locks.withLock('k', () => 1, { maxWaitMs: 'soon' }))
				.rejects.toThrow('non-negative finite number');
		});

		it('does not fire when caller acquires immediately', async () => {
			const locks = createLock();
			// No prior holder; acquisition is synchronous-ish.
			const result = await locks.withLock('k', () => 'ok', { maxWaitMs: 50 });
			expect(result).toBe('ok');
			expect(locks.held('k')).toBe(false);
		});

		it('does not fire when caller acquires before the timer', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			// b waits 100ms max; resolve A almost immediately so b acquires.
			const b = locks.withLock('k', () => 'b-result', { maxWaitMs: 100 });
			dA.resolve('a-result');
			expect(await a).toBe('a-result');
			expect(await b).toBe('b-result');
		});

		it('rejects with LOCK_TIMEOUT when wait exceeds maxWaitMs', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('user:42', () => dA.promise);
			let caught;
			try {
				await locks.withLock('user:42', () => 'never', { maxWaitMs: 20 });
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught.code).toBe('LOCK_TIMEOUT');
			expect(caught.key).toBe('user:42');
			expect(caught.maxWaitMs).toBe(20);
			expect(caught.message).toContain('timed out');
			expect(caught.message).toContain('user:42');
			// A still owns the lock; cleanup so the test does not leak
			dA.resolve('a-result');
			expect(await a).toBe('a-result');
		});

		it('maxWaitMs=0 fires immediately when a prior caller holds the key', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			let caught;
			try {
				await locks.withLock('k', () => 'never', { maxWaitMs: 0 });
			} catch (err) {
				caught = err;
			}
			expect(caught.code).toBe('LOCK_TIMEOUT');
			expect(caught.maxWaitMs).toBe(0);
			dA.resolve();
			await a;
		});

		it('a timed-out waiter does not block subsequent waiters', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);

			// b times out fast
			const b = locks.withLock('k', () => 'b-never', { maxWaitMs: 10 });
			// c has a longer timeout and should still get the lock after a
			const c = locks.withLock('k', () => 'c-result', { maxWaitMs: 1000 });

			await expect(b).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });

			// a finishes; advance() must skip b (cancelled) and run c
			dA.resolve('a-result');
			expect(await a).toBe('a-result');
			expect(await c).toBe('c-result');
		});

		it('multiple consecutive timeouts all reject; later untimed-out caller still runs', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			// Three impatient waiters in a row
			const b = locks.withLock('k', () => 'never', { maxWaitMs: 5 });
			const c = locks.withLock('k', () => 'never', { maxWaitMs: 5 });
			const d = locks.withLock('k', () => 'never', { maxWaitMs: 5 });
			// One patient waiter
			const e = locks.withLock('k', () => 'e-result');

			await expect(b).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
			await expect(c).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
			await expect(d).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });

			dA.resolve();
			await a;
			expect(await e).toBe('e-result');
		});

		it('error in fn does not break subsequent waiters (regression)', async () => {
			const locks = createLock();
			const a = locks.withLock('k', async () => { throw new Error('a-failed'); });
			const b = locks.withLock('k', () => 'b-result', { maxWaitMs: 1000 });
			await expect(a).rejects.toThrow('a-failed');
			expect(await b).toBe('b-result');
		});

		it('held() returns true while a waiter is queued, even with no running fn returned yet', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			// b is queued behind a
			const b = locks.withLock('k', () => 'b', { maxWaitMs: 1000 });
			expect(locks.held('k')).toBe(true);
			expect(locks.size()).toBe(1);
			dA.resolve();
			await a;
			await b;
			expect(locks.held('k')).toBe(false);
			expect(locks.size()).toBe(0);
		});
	});

	describe('clear() with pending waiters', () => {
		it('rejects pending waiters with LOCK_CLEARED', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			const b = locks.withLock('k', () => 'b-never');
			const c = locks.withLock('k', () => 'c-never', { maxWaitMs: 10_000 });

			locks.clear();

			await expect(b).rejects.toMatchObject({ code: 'LOCK_CLEARED' });
			await expect(c).rejects.toMatchObject({ code: 'LOCK_CLEARED' });
			// Currently-running fn (a) is NOT interrupted - it finishes normally
			dA.resolve('a-result');
			expect(await a).toBe('a-result');
		});

		it('clear() also clears pending timers (no rogue timer fire after clear)', async () => {
			const locks = createLock();
			const dA = deferred();
			const a = locks.withLock('k', () => dA.promise);
			// b has a long maxWaitMs; clear() should drop the entry AND clear the timer
			const b = locks.withLock('k', () => 'never', { maxWaitMs: 60_000 });

			locks.clear();
			await expect(b).rejects.toMatchObject({ code: 'LOCK_CLEARED' });
			// If clear() did not clear the timer, b would have rejected
			// twice and we would see the second rejection on an unhandled
			// promise - which vitest surfaces as a test failure.
			dA.resolve();
			await a;
		});
	});
});
