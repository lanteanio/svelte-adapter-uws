import { writable } from 'svelte/store';

/** @type {ReturnType<typeof createConnection> | null} */
let singleton = null;

/**
 * Ensure the singleton connection exists.
 * @param {import('./client.js').ConnectOptions} [options]
 * @returns {ReturnType<typeof createConnection>}
 */
function ensureConnection(options) {
	if (!singleton) singleton = createConnection(options || {});
	return singleton;
}

/**
 * Connect to the WebSocket server.
 *
 * Returns a singleton - calling `connect()` multiple times returns the same
 * connection. Safe to call from any component or module.
 *
 * Most users don't need this - use `on()` and `status` directly instead.
 *
 * @param {import('./client.js').ConnectOptions} [options]
 * @returns {import('./client.js').WSConnection}
 */
export function connect(options = {}) {
	return ensureConnection(options);
}

/**
 * Get a reactive Svelte store for a topic (and optionally a specific event).
 * Auto-connects and auto-subscribes - this is the only function most users need.
 *
 * @overload
 * @param {string} topic - Topic to subscribe to
 * @returns {import('svelte/store').Readable<import('./client.js').WSEvent | null>}
 * Full event envelope `{ topic, event, data }`.
 *
 * @overload
 * @param {string} topic - Topic to subscribe to
 * @param {string} event - Filter to a specific event name
 * @returns {import('svelte/store').Readable<unknown>}
 * Just the `data` payload - no envelope.
 *
 * @param {string} topic
 * @param {string} [event]
 */
export function on(topic, event) {
	const conn = ensureConnection();
	if (event !== undefined) {
		return conn._onEvent(topic, event);
	}
	const store = conn.on(topic);
	return store;
}

/**
 * Readable store - connection status: `'connecting'` | `'open'` | `'closed'`.
 * Auto-connects on first access.
 *
 * @type {import('svelte/store').Readable<'connecting' | 'open' | 'closed'>}
 */
export const status = {
	subscribe(fn) {
		return ensureConnection().status.subscribe(fn);
	}
};

/**
 * Returns a promise that resolves when the WebSocket connection is open.
 * Auto-connects if not already connected.
 *
 * @returns {Promise<void>}
 */
export function ready() {
	const conn = ensureConnection();
	return new Promise((resolve) => {
		const unsub = conn.status.subscribe((s) => {
			if (s === 'open') {
				// Defer unsubscribe to avoid removing during subscribe callback
				queueMicrotask(() => unsub());
				resolve();
			}
		});
	});
}

/**
 * Live CRUD list - one line for real-time collections.
 * Auto-connects, auto-subscribes, and auto-handles created/updated/deleted events.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {T[]} [initial] - Starting data (e.g. from a load function)
 * @param {{ key?: string, prepend?: boolean }} [options] - Options
 * @returns {import('svelte/store').Readable<T[]>}
 */
export function crud(topic, initial = [], options = {}) {
	const key = options.key || 'id';
	const prepend = options.prepend || false;
	return on(topic).scan(/** @type {any[]} */ (initial), (list, { event, data }) => {
		if (event === 'created') return prepend ? [data, ...list] : [...list, data];
		if (event === 'updated') return list.map((item) => item[key] === data[key] ? data : item);
		if (event === 'deleted') return list.filter((item) => item[key] !== data[key]);
		return list;
	});
}

/**
 * Live keyed object - like `crud()` but returns a `Record` keyed by ID.
 * Better for dashboards and fast lookups.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {T[]} [initial] - Starting data (e.g. from a load function)
 * @param {{ key?: string }} [options] - Options
 * @returns {import('svelte/store').Readable<Record<string, T>>}
 */
export function lookup(topic, initial = [], options = {}) {
	const key = options.key || 'id';
	/** @type {Record<string, any>} */
	const initialMap = {};
	for (const item of initial) {
		initialMap[/** @type {any} */ (item)[key]] = item;
	}
	return on(topic).scan(initialMap, (map, { event, data }) => {
		const id = data[key];
		if (event === 'created' || event === 'updated') return { ...map, [id]: data };
		if (event === 'deleted') {
			const { [id]: _, ...rest } = map;
			return rest;
		}
		return map;
	});
}

/**
 * Ring buffer of the last N events on a topic.
 * Perfect for chat, activity feeds, and notifications.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {number} [max] - Maximum number of events to keep
 * @param {T[]} [initial] - Starting data
 * @returns {import('svelte/store').Readable<import('./client.js').WSEvent<T>[]>}
 */
export function latest(topic, max = 50, initial = []) {
	return on(topic).scan(/** @type {any[]} */ (initial), (buffer, event) => {
		const next = [...buffer, event];
		return next.length > max ? next.slice(next.length - max) : next;
	});
}

/**
 * Live counter store - handles set/increment/decrement events.
 *
 * @param {string} topic - Topic to subscribe to
 * @param {number} [initial] - Starting value
 * @returns {import('svelte/store').Readable<number>}
 */
export function count(topic, initial = 0) {
	return on(topic).scan(initial, (n, { event, data }) => {
		if (event === 'set') return typeof data === 'number' ? data : n;
		if (event === 'increment') return n + (typeof data === 'number' ? data : 1);
		if (event === 'decrement') return n - (typeof data === 'number' ? data : 1);
		return n;
	});
}

/**
 * Wait for a specific event on a topic. Resolves once and unsubscribes.
 *
 * @param {string} topic - Topic to listen on
 * @param {string} [event] - Optional event name to filter on
 * @param {{ timeout?: number }} [options] - Options
 * @returns {Promise<unknown>}
 */
export function once(topic, event, options) {
	// Allow once(topic, { timeout }) shorthand (skip event)
	if (typeof event === 'object' && event !== null) {
		options = event;
		event = undefined;
	}
	const timeout = options?.timeout;
	const conn = ensureConnection();

	return new Promise((resolve, reject) => {
		const store = event !== undefined ? conn._onEvent(topic, event) : conn.on(topic);
		let settled = false;
		let timer;

		function cleanup() {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			queueMicrotask(() => unsub());
		}

		const unsub = store.subscribe((data) => {
			if (data !== null) {
				cleanup();
				resolve(data);
			}
		});
		if (timeout !== undefined) {
			timer = setTimeout(() => {
				cleanup();
				reject(new Error(`once('${topic}'${event ? `, '${event}'` : ''}) timed out after ${timeout}ms`));
			}, timeout);
		}
	});
}

/**
 * @param {import('./client.js').ConnectOptions} options
 * @returns {import('./client.js').WSConnection & { _onEvent: (topic: string, event: string) => import('svelte/store').Readable<unknown> }}
 */
function createConnection(options) {
	const {
		path = '/ws',
		reconnectInterval = 3000,
		maxReconnectInterval = 30000,
		maxReconnectAttempts = Infinity,
		debug = false
	} = options;

	/** @type {WebSocket | null} */
	let ws = null;

	/** @type {ReturnType<typeof setTimeout> | null} */
	let reconnectTimer = null;

	let attempt = 0;
	let intentionallyClosed = false;

	/** @type {Set<string>} */
	const subscribedTopics = new Set();

	/** @type {Map<string, number>} */
	const topicRefCounts = new Map();

	/** @type {string[]} */
	const sendQueue = [];
	const MAX_QUEUE_SIZE = 1000;

	/** @type {import('svelte/store').Writable<import('./client.js').WSEvent | null>} */
	const eventsStore = writable(null);

	/** @type {Map<string, import('svelte/store').Writable<import('./client.js').WSEvent | null>>} */
	const topicStores = new Map();

	/** @type {Map<string, import('svelte/store').Writable<unknown>>} */
	const eventStores = new Map();

	/** @type {import('svelte/store').Writable<'connecting' | 'open' | 'closed'>} */
	const statusStore = writable('closed');

	function getUrl() {
		if (typeof window === 'undefined') return '';
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}${path}`;
	}

	function doConnect() {
		if (typeof window === 'undefined') return;
		if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

		statusStore.set('connecting');

		try {
			ws = new WebSocket(getUrl());
		} catch {
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			attempt = 0;
			statusStore.set('open');
			if (debug) console.log('[ws] connected');

			// Re-subscribe to all topics after reconnect
			for (const topic of subscribedTopics) {
				if (debug) console.log('[ws] resubscribe ->', topic);
				ws?.send(JSON.stringify({ type: 'subscribe', topic }));
			}

			// Flush queued messages
			while (sendQueue.length > 0) {
				const msg = sendQueue.shift();
				if (debug) console.log('[ws] flush ->', msg);
				ws?.send(/** @type {string} */ (msg));
			}
		};

		ws.onmessage = (rawEvent) => {
			try {
				const msg = JSON.parse(rawEvent.data);
				if (msg.topic && msg.event !== undefined) {
					/** @type {import('./client.js').WSEvent} */
					const wsEvent = { topic: msg.topic, event: msg.event, data: msg.data };
					if (debug) console.log('[ws] <-', msg.topic, msg.event, msg.data);

					// Update global events store
					eventsStore.set(wsEvent);

					// Update topic-level store
					const tStore = topicStores.get(msg.topic);
					if (tStore) tStore.set(wsEvent);

					// Update topic+event filtered stores (data only)
					const eStore = eventStores.get(`${msg.topic}\0${msg.event}`);
					if (eStore) eStore.set(msg.data);
				}
			} catch {
				// Not a valid envelope - ignore
			}
		};

		ws.onclose = () => {
			statusStore.set('closed');
			ws = null;
			if (debug) console.log('[ws] disconnected');
			if (!intentionallyClosed) {
				scheduleReconnect();
			}
		};

		ws.onerror = () => {
			// onclose fires after this - reconnect is handled there
		};
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		if (attempt >= maxReconnectAttempts) {
			statusStore.set('closed');
			return;
		}
		const delay = Math.min(
			reconnectInterval * Math.pow(1.5, attempt) + Math.random() * 1000,
			maxReconnectInterval
		);
		attempt++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			doConnect();
		}, delay);
	}

	/**
	 * Subscribe to a topic (ref-counted).
	 * Multiple callers can subscribe; the WS subscription is sent on the first ref.
	 * @param {string} topic
	 */
	function subscribe(topic) {
		const count = topicRefCounts.get(topic) || 0;
		topicRefCounts.set(topic, count + 1);
		if (count > 0) return; // Already subscribed at WS level
		subscribedTopics.add(topic);
		if (debug) console.log('[ws] subscribe ->', topic);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'subscribe', topic }));
		}
	}

	/**
	 * Release a ref-counted subscription. Unsubscribes at WS level when count hits 0.
	 * @param {string} topic
	 */
	function release(topic) {
		const count = topicRefCounts.get(topic) || 0;
		if (count <= 1) {
			topicRefCounts.delete(topic);
			doUnsubscribe(topic);
		} else {
			topicRefCounts.set(topic, count - 1);
		}
	}

	/**
	 * Force-unsubscribe from a topic (public API - ignores ref count).
	 * @param {string} topic
	 */
	function unsubscribe(topic) {
		topicRefCounts.delete(topic);
		doUnsubscribe(topic);
	}

	/**
	 * Internal: actually send unsubscribe and clean up stores.
	 * @param {string} topic
	 */
	function doUnsubscribe(topic) {
		subscribedTopics.delete(topic);
		topicStores.delete(topic);
		// Clean up topic+event filtered stores for this topic
		for (const key of eventStores.keys()) {
			if (key.startsWith(topic + '\0')) eventStores.delete(key);
		}
		if (debug) console.log('[ws] unsubscribe ->', topic);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'unsubscribe', topic }));
		}
	}

	/**
	 * Create a .scan() method bound to a source store.
	 * @param {{ subscribe: (fn: (value: any) => void) => () => void }} source
	 */
	function makeScan(source) {
		/**
		 * @template A
		 * @param {A} initial
		 * @param {(acc: A, value: any) => A} reducer
		 * @returns {import('svelte/store').Readable<A>}
		 */
		return function scan(initial, reducer) {
			let acc = initial;
			const accumulated = writable(initial);
			/** @type {(() => void) | null} */
			let sourceUnsub = null;
			let subCount = 0;

			return {
				subscribe(fn) {
					// Start listening to source when first subscriber arrives
					if (subCount === 0) {
						sourceUnsub = source.subscribe((value) => {
							if (value !== null) {
								acc = reducer(acc, value);
								accumulated.set(acc);
							}
						});
					}
					subCount++;
					const unsub = accumulated.subscribe(fn);
					return () => {
						unsub();
						subCount--;
						// Stop listening when last subscriber leaves
						if (subCount === 0 && sourceUnsub) {
							sourceUnsub();
							sourceUnsub = null;
						}
					};
				}
			};
		};
	}

	/**
	 * Get a reactive store for a topic (all events).
	 * @param {string} topic
	 * @returns {import('./client.js').TopicStore<import('./client.js').WSEvent>}
	 */
	function onTopic(topic) {
		let store = topicStores.get(topic);
		if (!store) {
			store = writable(null);
			topicStores.set(topic, store);
		}

		// Ref-counted: subscribes to WS topic when first Svelte subscriber
		// arrives, releases when last leaves
		let subs = 0;
		function wrappedSubscribe(fn) {
			if (subs++ === 0) subscribe(topic);
			const unsub = store.subscribe(fn);
			return () => {
				unsub();
				if (--subs === 0) release(topic);
			};
		}

		const wrapped = { subscribe: wrappedSubscribe };
		return { subscribe: wrappedSubscribe, scan: makeScan(wrapped) };
	}

	/**
	 * Get a reactive store for a specific topic+event combo (data only).
	 * @param {string} topic
	 * @param {string} event
	 * @returns {import('./client.js').TopicStore<unknown>}
	 */
	function onEvent(topic, event) {
		const key = `${topic}\0${event}`;
		let store = eventStores.get(key);
		if (!store) {
			store = writable(null);
			eventStores.set(key, store);
		}

		let subs = 0;
		function wrappedSubscribe(fn) {
			if (subs++ === 0) subscribe(topic);
			const unsub = store.subscribe(fn);
			return () => {
				unsub();
				if (--subs === 0) release(topic);
			};
		}

		const wrapped = { subscribe: wrappedSubscribe };
		return { subscribe: wrappedSubscribe, scan: makeScan(wrapped) };
	}

	/**
	 * Send a custom message to the server. Dropped if not connected.
	 * @param {unknown} data
	 */
	function send(data) {
		if (ws?.readyState === WebSocket.OPEN) {
			if (debug) console.log('[ws] send ->', data);
			ws.send(JSON.stringify(data));
		} else if (debug) {
			console.warn('[ws] send dropped (not connected) - use sendQueued() to queue messages for reconnect:', data);
		}
	}

	/**
	 * Send a message, queuing it if not currently connected.
	 * Queued messages flush automatically on reconnect (FIFO).
	 * @param {unknown} data
	 */
	function sendQueued(data) {
		if (ws?.readyState === WebSocket.OPEN) {
			if (debug) console.log('[ws] send ->', data);
			ws.send(JSON.stringify(data));
		} else {
			if (sendQueue.length >= MAX_QUEUE_SIZE) {
				if (debug) console.warn('[ws] queue full, dropping oldest message');
				sendQueue.shift();
			}
			if (debug) console.log('[ws] queued ->', data);
			sendQueue.push(JSON.stringify(data));
		}
	}

	/**
	 * Close the connection permanently.
	 */
	function close() {
		intentionallyClosed = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		ws?.close();
		ws = null;
		singleton = null;
		statusStore.set('closed');
	}

	// Auto-connect on creation
	doConnect();

	return {
		events: { subscribe: eventsStore.subscribe },
		status: { subscribe: statusStore.subscribe },
		on: onTopic,
		_onEvent: onEvent,
		_release: release,
		subscribe,
		unsubscribe,
		send,
		sendQueued,
		close
	};
}
