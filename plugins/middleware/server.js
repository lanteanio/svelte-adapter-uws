/**
 * Middleware plugin for svelte-adapter-uws.
 *
 * Composable message processing pipeline. Chain functions that run
 * on inbound WebSocket messages before your handler logic. Each
 * middleware receives a context and a `next` function - call `next()`
 * to pass control to the next middleware, or skip it to stop the chain.
 *
 * Zero impact on the adapter core - this is a standalone utility
 * you call from your `message` hook.
 *
 * @module svelte-adapter-uws/plugins/middleware
 */

/**
 * @typedef {Object} MiddlewareContext
 * @property {any} ws - The WebSocket connection.
 * @property {{ topic: string, event: string, data?: any }} message - The original parsed message.
 * @property {string} topic - Message topic (mutable).
 * @property {string} event - Message event (mutable).
 * @property {any} data - Message data (mutable).
 * @property {import('../../index.js').Platform} platform - Platform reference.
 * @property {Record<string, any>} locals - Scratch space for middleware to attach data.
 */

/**
 * @callback MiddlewareFn
 * @param {MiddlewareContext} ctx - Current context.
 * @param {() => Promise<void>} next - Call to pass control to the next middleware.
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {Object} Middleware
 * @property {(ws: any, message: { topic: string, event: string, data?: any }, platform: import('../../index.js').Platform) => Promise<MiddlewareContext | null>} run -
 *   Execute the pipeline. Returns the context if all middlewares called `next()`,
 *   or `null` if any middleware stopped the chain.
 * @property {(fn: MiddlewareFn) => void} use -
 *   Append a middleware function at runtime.
 */

/**
 * Create a middleware pipeline.
 *
 * @param {...MiddlewareFn} fns - Middleware functions to run in order.
 * @returns {Middleware}
 *
 * @example
 * ```js
 * // src/lib/server/pipeline.js
 * import { createMiddleware } from 'svelte-adapter-uws/plugins/middleware';
 *
 * export const pipeline = createMiddleware(
 *   // logging
 *   async (ctx, next) => {
 *     console.log(`[${ctx.topic}] ${ctx.event}`);
 *     await next();
 *   },
 *   // auth check
 *   async (ctx, next) => {
 *     if (!ctx.ws.getUserData()?.userId) return; // stop chain
 *     ctx.locals.userId = ctx.ws.getUserData().userId;
 *     await next();
 *   }
 * );
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js
 * import { pipeline } from '$lib/server/pipeline';
 *
 * export async function message(ws, { data, platform }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   const ctx = await pipeline.run(ws, msg, platform);
 *   if (!ctx) return; // chain was stopped
 *   // ... handle ctx.topic, ctx.event, ctx.data, ctx.locals
 * }
 * ```
 */
export function createMiddleware(...fns) {
	for (let i = 0; i < fns.length; i++) {
		if (typeof fns[i] !== 'function') {
			throw new Error('middleware: each argument must be a function');
		}
	}

	/** @type {MiddlewareFn[]} */
	const stack = [...fns];

	return {
		async run(ws, message, platform) {
			const ctx = {
				ws,
				message,
				topic: message.topic,
				event: message.event,
				data: message.data,
				platform,
				// Prototype-less so middleware that writes attacker-influenced
				// keys (e.g. `ctx.locals[msg.field] = value`) cannot shadow
				// Object.prototype keys via `__proto__` / `constructor` /
				// `prototype`. The keys still work as data; the prototype
				// chain just doesn't carry them.
				locals: Object.create(null)
			};

			let index = 0;
			let completed = false;

			async function dispatch() {
				if (index >= stack.length) {
					completed = true;
					return;
				}
				const fn = stack[index++];
				let called = false;
				await fn(ctx, async () => {
					if (called) return; // guard against double next()
					called = true;
					await dispatch();
				});
			}

			await dispatch();
			return completed ? ctx : null;
		},

		use(fn) {
			if (typeof fn !== 'function') {
				throw new Error('middleware: use() argument must be a function');
			}
			stack.push(fn);
		}
	};
}
