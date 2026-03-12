import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

/**
 * A validator: either a transform function or a Zod-like object with `.parse()`.
 *
 * - Function: `(data: In) => Out` -- return validated/transformed data or throw
 * - Parse object: `{ parse(data: In): Out }` -- Zod, superstruct, valibot, etc.
 */
export type Validator<In = any, Out = In> =
	| ((data: In) => Out)
	| { parse(data: In): Out };

/**
 * Map of event names to their validators.
 */
export type EventMap = Record<string, Validator>;

export interface Channel<E extends EventMap = EventMap> {
	/** The topic this channel publishes to. */
	readonly topic: string;

	/** The valid event names for this channel. */
	readonly events: (keyof E & string)[];

	/**
	 * Validate and publish an event to all subscribers.
	 *
	 * Throws if the event name is not in the channel's event map,
	 * or if the data fails validation.
	 *
	 * @example
	 * ```js
	 * todos.publish(platform, 'created', newTodo);
	 * ```
	 */
	publish<K extends keyof E & string>(platform: Platform, event: K, data: any): boolean;

	/**
	 * Validate and send an event to a single connection.
	 *
	 * Throws if the event name is not in the channel's event map,
	 * or if the data fails validation.
	 *
	 * @example
	 * ```js
	 * todos.send(platform, ws, 'created', newTodo);
	 * ```
	 */
	send<K extends keyof E & string>(platform: Platform, ws: WebSocket<any>, event: K, data: any): number;
}

/**
 * Create a typed channel for a topic.
 *
 * Each event maps to a validator that checks (and optionally transforms)
 * the data before it hits the wire. Unknown event names throw immediately.
 *
 * @example
 * ```js
 * import { createChannel } from 'svelte-adapter-uws/plugins/channels';
 *
 * // Plain functions
 * export const todos = createChannel('todos', {
 *   created: (d) => ({ id: d.id, text: d.text, done: d.done }),
 *   updated: (d) => ({ id: d.id, text: d.text, done: d.done }),
 *   deleted: (d) => ({ id: d.id })
 * });
 * ```
 *
 * @example
 * ```js
 * // Zod schemas
 * import { z } from 'zod';
 *
 * const Todo = z.object({ id: z.string(), text: z.string(), done: z.boolean() });
 *
 * export const todos = createChannel('todos', {
 *   created: Todo,
 *   updated: Todo,
 *   deleted: z.object({ id: z.string() })
 * });
 * ```
 */
export function createChannel<E extends EventMap>(
	topic: string,
	events: E
): Channel<E>;
