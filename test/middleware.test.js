import { describe, it, expect, beforeEach } from 'vitest';
import { createMiddleware } from '../plugins/middleware/server.js';
import { mockWs, mockPlatform } from './_helpers.js';

function msg(topic = 'chat', event = 'message', data = {}) {
	return { topic, event, data };
}

describe('middleware plugin', () => {
	let platform;

	beforeEach(() => {
		platform = mockPlatform();
	});

	describe('createMiddleware', () => {
		it('returns a middleware with run and use', () => {
			const m = createMiddleware();
			expect(typeof m.run).toBe('function');
			expect(typeof m.use).toBe('function');
		});

		it('accepts zero middleware functions', () => {
			expect(() => createMiddleware()).not.toThrow();
		});

		it('throws on non-function argument', () => {
			expect(() => createMiddleware('bad')).toThrow('must be a function');
			expect(() => createMiddleware(() => {}, 42)).toThrow('must be a function');
		});
	});

	describe('run - basic pipeline', () => {
		it('single middleware receives correct context shape', async () => {
			const ws = mockWs({ id: '1' });
			const message = msg('chat', 'send', { text: 'hi' });
			let captured;

			const m = createMiddleware((ctx, next) => {
				captured = ctx;
				return next();
			});

			await m.run(ws, message, platform);

			expect(captured.ws).toBe(ws);
			expect(captured.message).toBe(message);
			expect(captured.topic).toBe('chat');
			expect(captured.event).toBe('send');
			expect(captured.data).toEqual({ text: 'hi' });
			expect(captured.platform).toBe(platform);
			expect(captured.locals).toEqual({});
		});

		it('returns context when all middlewares call next()', async () => {
			const m = createMiddleware(
				(ctx, next) => next(),
				(ctx, next) => next()
			);
			const result = await m.run(mockWs(), msg(), platform);
			expect(result).not.toBeNull();
			expect(result.topic).toBe('chat');
		});

		it('returns null when a middleware does not call next()', async () => {
			const m = createMiddleware(
				(ctx, next) => { /* stop */ }
			);
			const result = await m.run(mockWs(), msg(), platform);
			expect(result).toBeNull();
		});

		it('empty pipeline returns context immediately', async () => {
			const m = createMiddleware();
			const result = await m.run(mockWs(), msg(), platform);
			expect(result).not.toBeNull();
		});
	});

	describe('run - chaining', () => {
		it('middlewares execute in order', async () => {
			const order = [];
			const m = createMiddleware(
				(ctx, next) => { order.push(1); return next(); },
				(ctx, next) => { order.push(2); return next(); },
				(ctx, next) => { order.push(3); return next(); }
			);

			await m.run(mockWs(), msg(), platform);
			expect(order).toEqual([1, 2, 3]);
		});

		it('first middleware not calling next() prevents second from running', async () => {
			const order = [];
			const m = createMiddleware(
				(ctx, next) => { order.push(1); /* no next */ },
				(ctx, next) => { order.push(2); return next(); }
			);

			const result = await m.run(mockWs(), msg(), platform);
			expect(order).toEqual([1]);
			expect(result).toBeNull();
		});

		it('second of three not calling next() prevents third, returns null', async () => {
			const order = [];
			const m = createMiddleware(
				(ctx, next) => { order.push(1); return next(); },
				(ctx, next) => { order.push(2); /* stop */ },
				(ctx, next) => { order.push(3); return next(); }
			);

			const result = await m.run(mockWs(), msg(), platform);
			expect(order).toEqual([1, 2]);
			expect(result).toBeNull();
		});
	});

	describe('run - async', () => {
		it('async middleware works correctly', async () => {
			const m = createMiddleware(
				async (ctx, next) => {
					await new Promise(r => setTimeout(r, 1));
					ctx.locals.touched = true;
					await next();
				}
			);

			const result = await m.run(mockWs(), msg(), platform);
			expect(result.locals.touched).toBe(true);
		});

		it('mixed sync and async middlewares chain properly', async () => {
			const order = [];
			const m = createMiddleware(
				(ctx, next) => { order.push('sync'); return next(); },
				async (ctx, next) => { order.push('async'); await next(); },
				(ctx, next) => { order.push('sync2'); return next(); }
			);

			await m.run(mockWs(), msg(), platform);
			expect(order).toEqual(['sync', 'async', 'sync2']);
		});
	});

	describe('run - context mutation', () => {
		it('middleware can modify ctx.data and downstream sees the change', async () => {
			const m = createMiddleware(
				(ctx, next) => {
					ctx.data = { ...ctx.data, enriched: true };
					return next();
				},
				(ctx, next) => {
					expect(ctx.data.enriched).toBe(true);
					return next();
				}
			);

			const result = await m.run(mockWs(), msg('t', 'e', { original: true }), platform);
			expect(result.data.enriched).toBe(true);
			expect(result.data.original).toBe(true);
		});

		it('middleware can set ctx.locals and downstream reads it', async () => {
			const m = createMiddleware(
				(ctx, next) => { ctx.locals.userId = '42'; return next(); },
				(ctx, next) => { ctx.locals.role = 'admin'; return next(); }
			);

			const result = await m.run(mockWs(), msg(), platform);
			expect(result.locals.userId).toBe('42');
			expect(result.locals.role).toBe('admin');
		});

		it('ctx.locals has no prototype - cannot be poisoned via __proto__ key', async () => {
			let observed;
			const m = createMiddleware(
				(ctx, next) => {
					// A middleware that copies in attacker-influenced data
					// could try to set `__proto__` as an own property. With
					// a plain {} this would mutate Object.prototype. With
					// Object.create(null), it sets a normal own property.
					ctx.locals['__proto__'] = { polluted: true };
					observed = ctx.locals;
					return next();
				}
			);
			await m.run(mockWs(), msg(), platform);

			// Verify ctx.locals is a null-prototype object.
			expect(Object.getPrototypeOf(observed)).toBe(null);
			// Attempting to set __proto__ on a null-prototype object writes
			// it as an own property rather than mutating the prototype chain.
			expect(Object.prototype.hasOwnProperty.call(observed, '__proto__')).toBe(true);
			// Sanity: Object.prototype was not polluted.
			expect(/** @type {any} */ ({}).polluted).toBeUndefined();
		});

		it('middleware can replace ctx.topic and ctx.event', async () => {
			const m = createMiddleware(
				(ctx, next) => {
					ctx.topic = 'rewritten-topic';
					ctx.event = 'rewritten-event';
					return next();
				}
			);

			const result = await m.run(mockWs(), msg('original', 'original'), platform);
			expect(result.topic).toBe('rewritten-topic');
			expect(result.event).toBe('rewritten-event');
		});
	});

	describe('run - error handling', () => {
		it('middleware throwing an error propagates', async () => {
			const m = createMiddleware(
				() => { throw new Error('boom'); }
			);
			await expect(m.run(mockWs(), msg(), platform)).rejects.toThrow('boom');
		});

		it('async middleware rejecting propagates', async () => {
			const m = createMiddleware(
				async () => { throw new Error('async boom'); }
			);
			await expect(m.run(mockWs(), msg(), platform)).rejects.toThrow('async boom');
		});
	});

	describe('run - double next() guard', () => {
		it('calling next() twice does not re-run downstream', async () => {
			const order = [];
			const m = createMiddleware(
				async (ctx, next) => {
					await next();
					await next(); // second call should be no-op
				},
				(ctx, next) => { order.push('downstream'); return next(); }
			);

			await m.run(mockWs(), msg(), platform);
			expect(order).toEqual(['downstream']); // only once
		});
	});

	describe('use - runtime addition', () => {
		it('use() adds middleware that runs on next run() call', async () => {
			const m = createMiddleware();
			let called = false;
			m.use((ctx, next) => { called = true; return next(); });

			await m.run(mockWs(), msg(), platform);
			expect(called).toBe(true);
		});

		it('use() with non-function throws', () => {
			const m = createMiddleware();
			expect(() => m.use(42)).toThrow('must be a function');
		});

		it('multiple use() calls append in order', async () => {
			const order = [];
			const m = createMiddleware();
			m.use((ctx, next) => { order.push(1); return next(); });
			m.use((ctx, next) => { order.push(2); return next(); });
			m.use((ctx, next) => { order.push(3); return next(); });

			await m.run(mockWs(), msg(), platform);
			expect(order).toEqual([1, 2, 3]);
		});
	});
});
