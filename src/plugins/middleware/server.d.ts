import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface MiddlewareContext {
	/** The WebSocket connection. */
	ws: WebSocket<any>;
	/** The original parsed message object. */
	message: { topic: string; event: string; data?: unknown };
	/** Message topic (mutable - downstream middlewares see changes). */
	topic: string;
	/** Message event (mutable). */
	event: string;
	/** Message data (mutable). */
	data: unknown;
	/** Platform reference. */
	platform: Platform;
	/** Scratch space for middleware to attach data (e.g. userId, permissions). */
	locals: Record<string, any>;
}

/**
 * A middleware function.
 *
 * Call `next()` to pass control to the next middleware in the chain.
 * Skip calling `next()` to stop the chain (e.g. failed auth).
 */
export type MiddlewareFn = (
	ctx: MiddlewareContext,
	next: () => Promise<void>
) => void | Promise<void>;

export interface Middleware {
	/**
	 * Execute the pipeline for a message.
	 *
	 * Returns the (possibly mutated) context if all middlewares called `next()`,
	 * or `null` if any middleware stopped the chain.
	 */
	run(
		ws: WebSocket<any>,
		message: { topic: string; event: string; data?: unknown },
		platform: Platform
	): Promise<MiddlewareContext | null>;

	/** Append a middleware function at runtime. */
	use(fn: MiddlewareFn): void;
}

/**
 * Create a composable middleware pipeline for WebSocket messages.
 *
 * @example
 * ```js
 * import { createMiddleware } from 'svelte-adapter-uws/plugins/middleware';
 *
 * const pipeline = createMiddleware(
 *   async (ctx, next) => {
 *     console.log(ctx.topic, ctx.event);
 *     await next();
 *   },
 *   async (ctx, next) => {
 *     if (!ctx.ws.getUserData()?.userId) return;
 *     await next();
 *   }
 * );
 * ```
 */
export function createMiddleware(...fns: MiddlewareFn[]): Middleware;
