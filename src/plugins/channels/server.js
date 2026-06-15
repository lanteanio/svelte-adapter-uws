/**
 * Typed channels plugin for svelte-adapter-uws.
 *
 * Define message schemas per topic so event names and data shapes are
 * validated at publish time. Catches typos and shape mismatches before
 * they reach the wire.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * wraps platform.publish() and platform.send() with validation.
 *
 * @module svelte-adapter-uws/plugins/channels
 */

/**
 * Create a typed channel for a topic.
 *
 * Each event maps to a validator that checks (and optionally transforms)
 * the data before it's published. Unknown event names throw immediately.
 *
 * Validators can be:
 * - A function `(data) => data` that returns validated data or throws
 * - A Zod-like object with a `.parse(data)` method
 *
 * @param {string} topic - Topic name this channel publishes to
 * @param {Record<string, ((data: any) => any) | { parse(data: any): any }>} events -
 *   Map of event names to validators
 * @returns {import('./server.js').Channel}
 *
 * @example
 * ```js
 * // src/lib/server/channels.js
 * import { createChannel } from 'svelte-adapter-uws/plugins/channels';
 *
 * export const todos = createChannel('todos', {
 *   created: (d) => ({ id: d.id, text: d.text, done: d.done }),
 *   updated: (d) => ({ id: d.id, text: d.text, done: d.done }),
 *   deleted: (d) => ({ id: d.id })
 * });
 * ```
 *
 * @example
 * ```js
 * // With Zod schemas
 * import { z } from 'zod';
 * import { createChannel } from 'svelte-adapter-uws/plugins/channels';
 *
 * const Todo = z.object({ id: z.string(), text: z.string(), done: z.boolean() });
 *
 * export const todos = createChannel('todos', {
 *   created: Todo,
 *   updated: Todo,
 *   deleted: z.object({ id: z.string() })
 * });
 * ```
 *
 * @example
 * ```js
 * // In a form action or API route
 * import { todos } from '$lib/server/channels';
 *
 * export async function POST({ request, platform }) {
 *   const data = await request.json();
 *   const todo = await db.save(data);
 *   todos.publish(platform, 'created', todo);  // validated
 *   todos.publish(platform, 'typo', todo);     // throws Error
 * }
 * ```
 */
export function createChannel(topic, events) {
	if (!topic || typeof topic !== 'string') {
		throw new Error('channel: topic must be a non-empty string');
	}
	if (!events || typeof events !== 'object' || Array.isArray(events)) {
		throw new Error('channel: events must be an object mapping event names to validators');
	}

	const eventNames = Object.keys(events);
	if (eventNames.length === 0) {
		throw new Error('channel: events must define at least one event');
	}

	/** @type {Map<string, ((data: any) => any) | null>} */
	const validators = new Map();

	for (const name of eventNames) {
		const schema = events[name];
		if (schema == null) {
			validators.set(name, null);
		} else if (typeof schema === 'function') {
			validators.set(name, schema);
		} else if (typeof schema.parse === 'function') {
			// Zod, superstruct, or any object with .parse()
			const parser = schema;
			validators.set(name, (data) => parser.parse(data));
		} else {
			throw new Error(
				`channel "${topic}": validator for "${name}" must be a function or have a .parse() method`
			);
		}
	}

	/**
	 * Validate event name and data, return the validated data.
	 * @param {string} event
	 * @param {any} data
	 * @returns {any}
	 */
	function validate(event, data) {
		if (!validators.has(event)) {
			throw new Error(
				`channel "${topic}": unknown event "${event}". Valid events: ${eventNames.join(', ')}`
			);
		}
		const fn = validators.get(event);
		if (!fn) return data;
		try {
			return fn(data);
		} catch (err) {
			throw new Error(
				`channel "${topic}": event "${event}" validation failed: ${err.message}`
			);
		}
	}

	return {
		/** The topic this channel publishes to. */
		topic,

		/** The valid event names for this channel. */
		events: eventNames,

		/**
		 * Validate and publish an event to all subscribers.
		 *
		 * @param {import('../../index.js').Platform} platform
		 * @param {string} event - Must be one of the defined event names
		 * @param {any} data - Validated against the event's schema
		 */
		publish(platform, event, data) {
			const validated = validate(event, data);
			return platform.publish(topic, event, validated);
		},

		/**
		 * Validate and send an event to a single connection.
		 *
		 * @param {import('../../index.js').Platform} platform
		 * @param {any} ws
		 * @param {string} event - Must be one of the defined event names
		 * @param {any} data - Validated against the event's schema
		 */
		send(platform, ws, event, data) {
			const validated = validate(event, data);
			return platform.send(ws, topic, event, validated);
		}
	};
}
