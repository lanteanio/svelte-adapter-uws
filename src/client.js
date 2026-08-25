import { writable, derived } from 'svelte/store';
import { parseBinaryFrame, buildBinaryFrame, requestNFrame } from './runtime/wire.js';
import { decodeValue } from './runtime/wire-value.js';
import { now, monotonicNow, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer, microtask, nextReconnectDelay, dispersedReconnectDelay } from './client-runtime.js';
import { formatDiagnostic } from './runtime/diagnostic-format.js';

/** @type {ReturnType<typeof createConnection> | null} */
let singleton = null;

/** @type {'explicit' | 'implicit' | ''} */
let singletonCreatedBy = '';

/**
 * Client-side binary wire codecs, keyed by topic-name prefix. A plugin (e.g.
 * the cursor client) registers its decoder + capability here at import time;
 * the connection then advertises those capabilities in its `hello` frame and
 * routes inbound `0x03` frames whose resolved topic matches a prefix to the
 * matching decoder. The decoder returns the same `{ event, data }` the JSON
 * path would have dispatched, so the reactive surface is identical.
 *
 * A codec may advertise more than one capability (`capabilities`) - e.g. a
 * cursor client that can decode both the full-string and the short-id wire
 * advertises both tokens so it negotiates the best the server offers while an
 * older server still sends it the form it knows. A codec may also declare a
 * per-connection `state` factory (`state.onAttach` / `state.onDetach`) for a
 * stateful wire (the cursor short-id dictionary, or a future apply-in-place
 * CRDT codec); the decoder then receives that state plus the frame's
 * `schemaVersion` so it can dispatch between schema revisions.
 * @type {Map<string, { capability: string, capabilities?: string[], state?: { onAttach?: () => any, onDetach?: (state: any) => void }, decode: (payload: Uint8Array, state?: any, schemaVersion?: number, seq?: number, topic?: string) => ({ event: string, data: any } | null) }>}
 */
const wireCodecs = new Map();

/**
 * Topics a framework has marked SERVER-MANAGED: the server subscribes the
 * socket itself (via `platform.subscribe`, e.g. from svelte-realtime's stream
 * RPC), so the client must NOT emit its own `subscribe` wire frame for them and
 * must NOT include them in the reconnect resubscribe-batch. Dispatch still
 * flows through the topic store the same way - only the redundant outbound
 * subscribe frame is suppressed, exactly as the client already does for
 * `__`-prefixed framework taps. This keeps the connection quiet (no duplicate
 * subscribe) and, crucially, avoids a reconnect resubscribe racing ahead of the
 * server's re-subscribe under wire-subscribe authorization (where the server
 * would reject a not-yet-authorized topic). Process-global: a topic is managed
 * for whichever connection subscribes it, which for the singleton client is the
 * only one.
 * @type {Set<string>}
 */
const managedTopics = new Set();

/**
 * Mark `topic` as server-managed (see {@link managedTopics}). A framework that
 * subscribes the socket server-side calls this before attaching the client-side
 * store, so the store attach does not also send a client subscribe frame. Safe
 * to call repeatedly (idempotent) and before the connection exists.
 * @param {string} topic
 */
export function setTopicManaged(topic) {
	managedTopics.add(topic);
}

/**
 * Register a binary wire codec for a topic-name prefix. Idempotent per prefix.
 * Plugins call this at module load (before connect) so the first `hello`
 * already advertises the capability; if a connection is already open, its
 * `hello` is re-sent so a lazily-imported plugin still negotiates binary.
 *
 * A codec marked `sink: true` applies each frame in place inside `decode`
 * (e.g. into a local document replica) and drives its own reactive surface;
 * its `decode` return value is ignored and no store event is dispatched. The
 * default (`sink` absent/false) codec returns `{ event, data }` for the shared
 * store ladder. Because a sink dispatches no store event, the framework does
 * NOT track `lastSeenSeqs` for a sink codec's topic, so a sink codec that needs
 * resume must recover its own state (e.g. a CRDT codec resyncs via a
 * state-vector diff, not seq replay). `decode` receives the frame's `seq` as a
 * fourth argument and the resolved topic name as a fifth, for codecs that want
 * them (a multi-document sink routes frames by topic).
 *
 * @param {string} prefix - topic-name prefix the codec owns (e.g. '__cursor:')
 * @param {{ capability: string, capabilities?: string[], sink?: boolean, state?: { onAttach?: () => any, onDetach?: (state: any) => void }, decode: (payload: Uint8Array, state?: any, schemaVersion?: number, seq?: number, topic?: string) => ({ event: string, data: any } | null | void) }} codec
 */
export function registerWireCodec(prefix, codec) {
	wireCodecs.set(prefix, codec);
	if (singleton && typeof singleton._resendHello === 'function') singleton._resendHello();
}

/**
 * Bind a client->server binary ingress destination on the singleton
 * connection. A plugin consumer (e.g. the smooth command channel) calls this
 * to negotiate an id-addressed `0x03` ingress binding for a `kind` + opaque
 * `target`; it returns a handle:
 *
 *   - `send(schemaVersion, payload)` emits a `0x03` frame when the binding is
 *     live (returns true; a volatile drop under backpressure also returns
 *     true), or returns false when the binding is not yet/never live so the
 *     caller uses its existing JSON fallback - a command is never silently
 *     lost.
 *   - `live()` reports whether binary sends are currently accepted.
 *   - `dispose()` releases the binding.
 *
 * The transport is generic (any consumer can encode any payload); the server
 * decodes and routes by the registered `kind`. Auto-connects, like `on()`.
 *
 * @param {string} kind - the binding kind (e.g. `'smooth.command:1'`)
 * @param {any} target - opaque destination the server-side handler interprets
 * @returns {{ send: (schemaVersion: number, payload: Uint8Array) => boolean, live: () => boolean, dispose: () => void }}
 */
export function bindIngress(kind, target) {
	return ensureConnection()._bindIngress(kind, target);
}

/**
 * UTF-8 byte length of a string, allocation-free (no TextEncoder buffer).
 * Runs only inside the inbound size guard's ambiguous band, where the UTF-16
 * code-unit count alone cannot decide the byte cap. A well-formed surrogate
 * pair counts as its four encoded bytes; a lone surrogate counts as the three
 * bytes its replacement character would encode to, matching what any encoder
 * would have produced for it.
 * @param {string} s
 * @returns {number}
 */
function utf8ByteLength(s) {
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * Build the `hello` caps array: `'batch'` plus every capability every
 * registered codec can decode. A client always advertises what it can decode;
 * the wire format is the server's decision (a plugin's codec, or `binary: false`
 * to force JSON). We deliberately do NOT read any URL query parameter to opt
 * out - the app owns its URL namespace, and a client-side force-JSON knob would
 * let a connection inflate its own egress.
 * @returns {string[]}
 */
function buildHelloCaps() {
	const caps = ['batch', 'lease', 'wire.ingress:1', 'game.fanout:1', 'relay.resync:1'];
	for (const codec of wireCodecs.values()) {
		const tokens = codec.capabilities || [codec.capability];
		for (let i = 0; i < tokens.length; i++) caps.push(tokens[i]);
	}
	return caps;
}

/**
 * Resolve a topic name to its registered wire codec (and its prefix, for
 * per-connection state keying) by longest matching prefix.
 * @param {string} topic
 * @returns {{ prefix: string, codec: { capability: string, capabilities?: string[], sink?: boolean, state?: { onAttach?: () => any, onDetach?: (state: any) => void }, decode: (payload: Uint8Array, state?: any, schemaVersion?: number, seq?: number, topic?: string) => ({ event: string, data: any } | null | void) } } | null}
 */
function wireCodecForTopic(topic) {
	let best = null;
	let bestLen = -1;
	for (const [prefix, codec] of wireCodecs) {
		if (topic.startsWith(prefix) && prefix.length > bestLen) {
			best = { prefix, codec };
			bestLen = prefix.length;
		}
	}
	return best;
}

/**
 * Ensure the singleton connection exists.
 * @param {import('./client.js').ConnectOptions} [options]
 * @param {boolean} [explicit]
 * @returns {ReturnType<typeof createConnection>}
 */
function ensureConnection(options, explicit = false) {
	if (!singleton) {
		singletonCreatedBy = explicit ? 'explicit' : 'implicit';
		singleton = createConnection(options || {});
	}
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
	if (singleton && singletonCreatedBy === 'implicit' && Object.keys(options).length > 0) {
		console.warn(
			'[ws] connect() was called with options, but the connection already exists ' +
			'(created automatically by on(), status, or ready()). ' +
			'Your options are ignored. Call connect() before using other client functions.\n' +
			'  See: https://svti.me/client-connect'
		);
	}
	return ensureConnection(options, true);
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
 * Create a store that subscribes to a topic derived from a reactive value.
 * When the source store changes, the subscription automatically switches to
 * the new topic and the old one is released.
 *
 * Useful when the topic depends on runtime state like a user ID, selected item,
 * or route parameter  - no manual subscribe/unsubscribe lifecycle to manage.
 *
 * @template T
 * @param {(value: T) => string} topicFn - Maps the source store's value to a topic name
 * @param {import('svelte/store').Readable<T>} store - Reactive input value
 * @returns {import('svelte/store').Readable<import('./client.js').WSEvent | null>}
 *
 * @example
 * ```svelte
 * <script>
 *   import { page } from '$app/stores';
 *   import { onDerived } from 'svelte-adapter-uws/client';
 *   import { derived } from 'svelte/store';
 *
 *   // Subscribe to a topic based on the current page's item ID
 *   const roomId = derived(page, ($page) => $page.params.id);
 *   const messages = onDerived((id) => `room:${id}`, roomId);
 * </script>
 *
 * {#if $messages}
 *   <p>{$messages.event}: {JSON.stringify($messages.data)}</p>
 * {/if}
 * ```
 */
export function onDerived(topicFn, store) {
	return derived(store, ($value, set) => {
		if ($value == null) {
			set(null);
			return;
		}
		// on() is ref-counted  - the returned unsubscribe function decrements
		// the ref count and releases the server subscription when it hits zero.
		// derived() calls this cleanup whenever the source store produces a new
		// value or when all subscribers of the derived store are gone.
		return on(topicFn($value)).subscribe(set);
	}, null);
}

/**
 * Readable store - connection status. Auto-connects on first access.
 *
 * Five states drive distinct UI affordances:
 * - `'connecting'` - establishing a connection (initial attempt or retry)
 * - `'open'` - connected, live data is flowing
 * - `'suspended'` - WS is technically open but the tab is in the background;
 *   server may close idle backgrounded sockets, so live data is best-effort
 * - `'disconnected'` - lost connection, will retry automatically
 * - `'failed'` - terminal: auth denied, max retries exhausted, or `close()` called
 *
 * @type {import('svelte/store').Readable<'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'>}
 */
export const status = {
	subscribe(fn) {
		return ensureConnection().status.subscribe(fn);
	}
};

/**
 * Readable store of the latest subscribe-denied response from the server.
 * Each entry is `{ topic, reason, ref }` where `reason` is one of the
 * built-in codes (`'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`,
 * `'RATE_LIMITED'`) or any custom string the server's `subscribe` hook
 * returned. The store stays at `null` until the first denial.
 *
 * @type {import('svelte/store').Readable<{ topic: string, reason: string, ref: number | string } | null>}
 */
export const denials = {
	subscribe(fn) {
		return ensureConnection().denials.subscribe(fn);
	}
};

/**
 * Readable store - cause of the most recent non-open status transition.
 * `null` while connected (or before any failure has occurred). Set when
 * the connection drops via a recognised close code, when the reconnect
 * cap is hit, or when the auth preflight fails. Cleared on the next
 * successful `'open'`. Does not fire for an intentional `close()` call -
 * `status === 'failed'` plus `failure === null` is the deliberately-ended
 * state.
 *
 * Use this alongside `status` to render targeted UI per failure cause:
 * "Session expired" for `class: 'TERMINAL'`, "Server is busy" for
 * `'THROTTLE'`, generic "Reconnecting" for `'RETRY'`, etc.
 *
 * @type {import('svelte/store').Readable<import('./client.js').Failure | null>}
 */
export const failure = {
	subscribe(fn) {
		return ensureConnection().failure.subscribe(fn);
	}
};

/**
 * Latest established-message shed response from the server. A value names the
 * exceeded worker/connection scope and, for rate limits, when a retry can be
 * attempted. The connection remains open.
 *
 * @type {import('svelte/store').Readable<import('./client.js').MessageOverload | null>}
 */
export const overloads = {
	subscribe(fn) {
		return ensureConnection().overloads.subscribe(fn);
	}
};

/**
 * Keep the compatibility alias byte-identical to the explicit diagnostic field.
 * This text can come from a browser, intermediary, or remote server and is not
 * a localized application message.
 * @param {string} diagnosticReason
 */
function failureDiagnosticText(diagnosticReason) {
	return { diagnosticReason, reason: diagnosticReason };
}

/**
 * Install a handler for server-initiated requests. The server may call
 * `platform.request(ws, event, data)` and await your reply; this is
 * where that lands. Return a value (sync or async) and the framework
 * sends it back as the reply. Throw or reject to send an error reply
 * the server will surface as a Promise rejection.
 *
 * Only one handler may be installed at a time. Calling `onRequest`
 * again replaces the previous handler. Returns an unsubscribe function
 * that clears the handler if it is still the active one. With no
 * handler installed, incoming request frames are dropped and the
 * server's awaiting Promise times out.
 *
 * @param {(event: string, data: unknown) => unknown | Promise<unknown>} handler
 * @returns {() => void}
 */
export function onRequest(handler) {
	return ensureConnection().onRequest(handler);
}

/**
 * Returns a promise that resolves when the WebSocket connection is open.
 * Auto-connects if not already connected.
 *
 * @returns {Promise<void>}
 */
export function ready() {
	if (typeof window === 'undefined' && !(singleton && singleton._hasUrl)) return Promise.resolve();

	const conn = ensureConnection();
	return new Promise((resolve, reject) => {
		let settled = false;
		/** @type {(() => void) | null} */
		let statusUnsub = null;
		/** @type {(() => void) | null} */
		let permaUnsub = null;

		function cleanup() {
			if (settled) return;
			settled = true;
			microtask(() => {
				statusUnsub?.();
				permaUnsub?.();
			});
		}

		statusUnsub = conn.status.subscribe((s) => {
			// 'suspended' means WS is open but tab is in the background -
			// the connection is established, so ready() resolves there too.
			if (s === 'open' || s === 'suspended') { cleanup(); resolve(); }
		});

		permaUnsub = conn._permaClosed.subscribe((dead) => {
			if (dead) {
				cleanup();
				reject(new Error('WebSocket connection permanently closed'));
			}
		});
	});
}

// Storage adapters for the live-CRUD reducer pattern shared by crud()
// and lookup() (with and without maxAge). Each adapter implements
// create / update / delete for a particular collection shape (Array or
// Record). The keyOf(item) extractor lets callers control whether keys
// are coerced to string (e.g. for the maxAge variants whose long-lived
// timestamp Map needs primitive-stable keys) or left as-is.

const arrayCrudStorage = {
	create(list, item, { prepend }) {
		return prepend ? [item, ...list] : [...list, item];
	},
	update(list, item, { keyOf }) {
		const id = keyOf(item);
		return list.map((x) => keyOf(x) === id ? item : x);
	},
	delete(list, item, { keyOf }) {
		const id = keyOf(item);
		return list.filter((x) => keyOf(x) !== id);
	}
};

const recordCrudStorage = {
	create(map, item, { keyOf }) {
		return { ...map, [keyOf(item)]: item };
	},
	update(map, item, { keyOf }) {
		return { ...map, [keyOf(item)]: item };
	},
	delete(map, item, { keyOf }) {
		const id = keyOf(item);
		if (!(id in map)) return map;
		const { [id]: _, ...rest } = map;
		return rest;
	}
};

/**
 * Apply a single created / updated / deleted event to a collection.
 * Returns the new collection, or the original reference if the event
 * was not a CRUD verb or the data was not an object.
 *
 * @template S
 * @param {S} state
 * @param {string} event
 * @param {unknown} data
 * @param {{ create: Function, update: Function, delete: Function }} storage
 * @param {{ keyOf: (item: any) => unknown, prepend?: boolean }} options
 * @returns {S}
 */
function applyCrudReducer(state, event, data, storage, options) {
	if (data == null || typeof data !== 'object') return state;
	if (event === 'created') return storage.create(state, data, options);
	if (event === 'updated') return storage.update(state, data, options);
	if (event === 'deleted') return storage.delete(state, data, options);
	return state;
}

/**
 * Live CRUD list - one line for real-time collections.
 * Auto-connects, auto-subscribes, and auto-handles created/updated/deleted events.
 *
 * When `maxAge` is set, entries that haven't been created or updated
 * within that window are automatically removed from the list.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {T[]} [initial] - Starting data (e.g. from a load function)
 * @param {{ key?: string, prepend?: boolean, maxAge?: number }} [options] - Options
 * @returns {import('svelte/store').Readable<T[]>}
 */
export function crud(topic, initial = [], options = {}) {
	const key = options.key || 'id';
	const prepend = options.prepend || false;
	const maxAge = options.maxAge;

	if (maxAge == null || maxAge <= 0) {
		const opts = { keyOf: (/** @type {any} */ x) => x[key], prepend };
		return on(topic).scan(/** @type {any[]} */ (initial), (list, { event, data }) =>
			applyCrudReducer(list, event, data, arrayCrudStorage, opts)
		);
	}

	// maxAge mode: track timestamps per key, sweep on interval
	const conn = ensureConnection();
	const source = conn.on(topic);
	const keyOf = (/** @type {any} */ x) => String(x[key]);
	const reducerOpts = { keyOf, prepend };

	/** @type {any[]} */
	let list = [...initial];
	/** @type {Map<string, number>} */
	const timestamps = new Map();
	const seededAt = now();
	for (const item of initial) {
		timestamps.set(keyOf(item), seededAt);
	}

	const output = writable(list);
	/** @type {(() => void) | null} */
	let sourceUnsub = null;
	/** @type {ReturnType<typeof setIntervalTimer> | null} */
	let sweepTimer = null;
	let subCount = 0;

	function sweep() {
		const cutoff = now() - /** @type {number} */ (maxAge);
		let changed = false;
		for (const [id, ts] of timestamps) {
			if (ts < cutoff) {
				timestamps.delete(id);
				const before = list.length;
				list = list.filter((item) => keyOf(item) !== id);
				if (list.length !== before) changed = true;
			}
		}
		if (changed) output.set(list);
	}

	function start() {
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;
			const { event: evt, data } = event;
			if (evt !== 'created' && evt !== 'updated' && evt !== 'deleted') return;
			if (data == null || typeof data !== 'object') return;
			const id = keyOf(data);
			if (evt === 'deleted') timestamps.delete(id);
			else timestamps.set(id, now());
			list = applyCrudReducer(list, evt, data, arrayCrudStorage, reducerOpts);
			output.set(list);
		});
		sweepTimer = setIntervalTimer(sweep, Math.max(maxAge / 2, 1000));
	}

	function stop() {
		if (sourceUnsub) { sourceUnsub(); sourceUnsub = null; }
		if (sweepTimer) { clearIntervalTimer(sweepTimer); sweepTimer = null; }
		list = [...initial];
		const seededAt = now();
		timestamps.clear();
		for (const item of initial) {
			timestamps.set(keyOf(item), seededAt);
		}
		output.set(list);
	}

	return {
		subscribe(fn) {
			if (subCount++ === 0) start();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--subCount === 0) stop();
			};
		}
	};
}

/**
 * Live keyed object - like `crud()` but returns a `Record` keyed by ID.
 * Better for dashboards and fast lookups.
 *
 * When `maxAge` is set, entries that haven't been created or updated
 * within that window are automatically removed. Useful for presence,
 * cursors, or any state backed by an external store with TTL expiry.
 *
 * @template T
 * @param {string} topic - Topic to subscribe to
 * @param {T[]} [initial] - Starting data (e.g. from a load function)
 * @param {{ key?: string, maxAge?: number }} [options] - Options
 * @returns {import('svelte/store').Readable<Record<string, T>>}
 */
export function lookup(topic, initial = [], options = {}) {
	const key = options.key || 'id';
	const maxAge = options.maxAge;
	/** @type {Record<string, any>} */
	const initialMap = {};
	for (const item of initial) {
		initialMap[/** @type {any} */ (item)[key]] = item;
	}

	if (maxAge == null || maxAge <= 0) {
		const opts = { keyOf: (/** @type {any} */ x) => x[key] };
		return on(topic).scan(initialMap, (map, { event, data }) =>
			applyCrudReducer(map, event, data, recordCrudStorage, opts)
		);
	}

	// maxAge mode: track timestamps per key, sweep on interval
	const conn = ensureConnection();
	const source = conn.on(topic);
	const keyOf = (/** @type {any} */ x) => x[key];
	const reducerOpts = { keyOf };

	/** @type {Record<string, any>} */
	let map = { ...initialMap };
	/** @type {Map<string, number>} */
	const timestamps = new Map();
	const seededAt = now();
	for (const id in initialMap) {
		timestamps.set(id, seededAt);
	}

	const output = writable(map);
	/** @type {(() => void) | null} */
	let sourceUnsub = null;
	/** @type {ReturnType<typeof setIntervalTimer> | null} */
	let sweepTimer = null;
	let subCount = 0;

	function sweep() {
		const cutoff = now() - /** @type {number} */ (maxAge);
		let changed = false;
		for (const [id, ts] of timestamps) {
			if (ts < cutoff) {
				timestamps.delete(id);
				if (id in map) {
					const { [id]: _, ...rest } = map;
					map = rest;
					changed = true;
				}
			}
		}
		if (changed) output.set(map);
	}

	function start() {
		sourceUnsub = source.subscribe((event) => {
			if (event === null) return;
			const { event: evt, data } = event;
			if (evt !== 'created' && evt !== 'updated' && evt !== 'deleted') return;
			if (data == null || typeof data !== 'object') return;
			const id = keyOf(data);
			if (evt === 'deleted') timestamps.delete(id);
			else timestamps.set(id, now());
			const next = applyCrudReducer(map, evt, data, recordCrudStorage, reducerOpts);
			if (next === map) return;
			map = next;
			output.set(map);
		});
		// Sweep at half the maxAge interval for responsive cleanup
		// without burning cycles on very short intervals
		sweepTimer = setIntervalTimer(sweep, Math.max(maxAge / 2, 1000));
	}

	function stop() {
		if (sourceUnsub) { sourceUnsub(); sourceUnsub = null; }
		if (sweepTimer) { clearIntervalTimer(sweepTimer); sweepTimer = null; }
		map = { ...initialMap };
		const seededAt = now();
		timestamps.clear();
		for (const id in initialMap) {
			timestamps.set(id, seededAt);
		}
		output.set(map);
	}

	return {
		subscribe(fn) {
			if (subCount++ === 0) start();
			const unsub = output.subscribe(fn);
			return () => {
				unsub();
				if (--subCount === 0) stop();
			};
		}
	};
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
		let first = true;
		let timer;

		function cleanup() {
			if (settled) return;
			settled = true;
			if (timer) clearTimer(timer);
			microtask(() => unsub());
		}

		const unsub = store.subscribe((data) => {
			// Skip the synchronous initial emission - stores fire immediately
			// with their current value, which may be stale from a previous event
			if (first) { first = false; return; }
			if (data !== null) {
				cleanup();
				resolve(data);
			}
		});
		if (timeout !== undefined) {
			timer = setTimer(() => {
				cleanup();
				reject(new Error(`once('${topic}'${event ? `, '${event}'` : ''}) timed out after ${timeout}ms`));
			}, timeout);
		}
	});
}

// Close codes that indicate the server has permanently rejected this client.
// Reconnecting would be pointless (credentials invalid, policy violation, etc.).
const TERMINAL_CLOSE_CODES = new Set([
	1008, // Policy Violation
	4401, // Unauthorized (custom)
	4403, // Forbidden (custom)
]);

// Close codes indicating server-side throttling. Reconnect is still attempted
// but we jump ahead in the backoff curve to avoid hammering a rate-limited server.
const THROTTLE_CLOSE_CODES = new Set([
	4429, // Rate limited (custom)
]);

/**
 * Classify a WebSocket close code into one of three reconnect behaviors.
 *
 * - `'TERMINAL'`: the server has permanently rejected this client.
 *   Reconnecting would be pointless. The client store transitions to a
 *   permanently-closed state and stops trying. Codes: 1008 (policy
 *   violation), 4401 (unauthorized), 4403 (forbidden).
 * - `'THROTTLE'`: the server is rate-limiting. Reconnect is still
 *   attempted but the client jumps ahead in the backoff curve to avoid
 *   hammering a busy server. Code: 4429 (too many requests).
 * - `'RETRY'`: every other code, including normal closes (1000/1001) and
 *   abnormal ones (1006/1011/1012). The client reconnects with the
 *   standard backoff curve.
 *
 * Pure: no I/O, no globals. Suitable for unit tests.
 *
 * @param {number | undefined} code
 * @returns {'TERMINAL' | 'THROTTLE' | 'RETRY'}
 */
export function classifyCloseCode(code) {
	if (TERMINAL_CLOSE_CODES.has(code)) return 'TERMINAL';
	if (THROTTLE_CLOSE_CODES.has(code)) return 'THROTTLE';
	return 'RETRY';
}

// Reconnect backoff curve. Defined in client-runtime.js (the worker-safe
// module every socket owner can import); re-exported here so the public
// surface of this module is unchanged.
export { nextReconnectDelay };

/**
 * @param {import('./client.js').ConnectOptions} options
 * @returns {import('./client.js').WSConnection & { _onEvent: (topic: string, event: string) => import('svelte/store').Readable<unknown> }}
 */
function createConnection(options) {
	const {
		url,
		path = '/ws',
		reconnectInterval = 3000,
		maxReconnectInterval = 300000,
		maxReconnectAttempts = Infinity,
		debug = false,
		auth = false
	} = options;

	// Resolve the auth preflight path. `auth: true` -> default '/__ws/auth',
	// `auth: '/custom'` -> use the provided path, `auth: false` (default) -> disabled.
	/** @type {string | null} */
	const authPath = auth === true ? '/__ws/auth' : (typeof auth === 'string' && auth) ? auth : null;

	/** @type {WebSocket | null} */
	let ws = null;

	/** @type {ReturnType<typeof setTimer> | null} */
	let reconnectTimer = null;
	/** @type {ReturnType<typeof setIntervalTimer> | null} */
	let activityTimer = null;

	/** @type {Promise<boolean> | null} deduped in-flight auth preflight */
	let authInFlight = null;

	let attempt = 0;
	let intentionallyClosed = false;
	// Set when the server permanently rejects us (terminal close code) or when
	// retries are exhausted. Distinct from intentionallyClosed (user-initiated).
	// Both prevent the visibility handler from triggering a reconnect.
	let terminalClosed = false;
	// Stashed server drain advisory ({ afterMs, windowMs, deadline }) received via a
	// `reconnect` control frame just before the server closes this socket. Honored in
	// onclose to disperse the reconnect across the advertised window; cleared on the
	// next successful open and ignored past its validity deadline (which guards an
	// advisory whose close never actually arrives).
	/** @type {{ afterMs: number, windowMs: number, deadline: number } | null} */
	let reconnectAdvisory = null;
	// Set when the page is hidden  - signals that the next disconnect may be
	// browser-initiated and should reconnect immediately when the tab resumes.
	let hiddenDisconnect = false;
	// Timestamp of the last message received from the server. Used to detect
	// zombie connections  - cases where onclose was suppressed by browser throttling.
	let lastServerMessage = now();
	// 2.5x the server's 120s idle timeout. If the server has been completely
	// silent for this long while the socket appears open, it is likely a zombie.
	const SERVER_TIMEOUT_MS = 150000;
	// Cadence of the zombie/activity check. Also the baseline the tick measures
	// itself against: a tick that fired much later than this was throttled by the
	// browser (backgrounded tab), so the observed silence is our own frozen loop.
	const ACTIVITY_INTERVAL_MS = 30000;
	// Paired wall/monotonic reference stamps for suspend detection. The
	// monotonic clock freezes during system sleep while the wall clock keeps
	// counting, so a wall delta far exceeding the monotonic delta over the
	// same span reveals a sleep gap the paused timers never saw - one long
	// enough that the server has likely idle-dropped this socket without a
	// close frame reaching us. Above the threshold the surviving socket is
	// not trusted: it is closed so the reconnect + resume path replays what
	// was missed. Where no monotonic source exists both clocks read the wall
	// and the gate is inert. The threshold sits below the server's idle
	// timeout so the cost of a wrong guess is one cheap resumed reconnect,
	// never a frozen board.
	const SUSPEND_GAP_MS = 60000;
	let gapRefWall = now();
	let gapRefMono = monotonicNow();
	// Wall stamp of the last activity tick, to detect a throttled (late) timer.
	let lastActivityTickWall = now();

	// Sleep-gap excess accumulated since the last reference stamp; re-stamps.
	function readSuspendGap() {
		const wall = now();
		const mono = monotonicNow();
		const excess = (wall - gapRefWall) - (mono - gapRefMono);
		gapRefWall = wall;
		gapRefMono = mono;
		return excess;
	}

	/** @type {Set<string>} */
	const subscribedTopics = new Set();

	/** @type {Map<string, number>} */
	const topicRefCounts = new Map();

	// Inverse of the server's per-connection topic-id map: numeric wireId ->
	// topic name. Populated from `{type:'wire-id'}` control frames; an inbound
	// `0x03` binary frame carries only the numeric id, resolved here back to the
	// topic name the store ladder is keyed on. Per-connection: cleared on each
	// (re)connect since the server reassigns ids fresh on a new connection.
	/** @type {Map<number, string>} */
	const wireIdMap = new Map();

	// Per-connection decoder state for stateful wire codecs (e.g. the cursor
	// short-id dictionary), keyed by codec prefix. Created lazily on the first
	// `0x03` frame for a prefix via the codec's `state.onAttach()`, and cleared
	// (with `state.onDetach()`) on each (re)connect alongside `wireIdMap` since
	// the server resets its matching encoder state on a fresh connection.
	/** @type {Map<string, any>} */
	const wireDecoderStates = new Map();

	// Resolve (lazily creating) the per-connection decoder state for a codec.
	/** @param {string} prefix @param {{ state?: { onAttach?: () => any } }} codec @returns {any} */
	function ensureDecoderState(prefix, codec) {
		if (!codec.state || typeof codec.state.onAttach !== 'function') return null;
		let st = wireDecoderStates.get(prefix);
		if (st === undefined) {
			try { st = codec.state.onAttach(); } catch { st = null; }
			wireDecoderStates.set(prefix, st);
		}
		return st;
	}

	// Dispose every per-connection decoder state, then clear. Called on each
	// (re)connect so a reconnect starts from an empty dictionary in lock-step
	// with the server's reset encoder state.
	function resetWireDecoderStates() {
		for (const [prefix, st] of wireDecoderStates) {
			const codec = wireCodecs.get(prefix);
			if (codec && codec.state && typeof codec.state.onDetach === 'function') {
				try { codec.state.onDetach(st); } catch {}
			}
		}
		wireDecoderStates.clear();
	}

	// - Binary ingress (client->server 0x03) --------------------------------
	//
	// The reverse of the egress wire-id machinery. A consumer (e.g. the smooth
	// command channel) binds a destination via `_bindIngress()`; the manager
	// allocates a client-side per-connection id, announces `id -> destination`
	// to the server (`{type:'ingress-bind'}`) once the server has confirmed it
	// speaks ingress (`{type:'ingress-ok'}`), and - after the server acks the
	// bind (`{type:'ingress-bound'}`) - lets the consumer send `0x03` frames on
	// that id. Until the bind is live (old server, an unknown kind, or a fresh
	// reconnect not yet re-announced) the consumer uses its JSON fallback, so a
	// command is never silently lost. Ids are stable for a binding's life; on
	// each (re)connect the manager resets `supported`/`bound` and re-announces
	// every binding from the same ids (the server reset its map with the fresh
	// connection), mirroring the egress `wireIdMap` reset.
	let ingressSupported = false;
	let ingressNextId = 1;
	/** @type {Map<number, { kind: string, target: any, bound: boolean, seq: number }>} */
	const ingressBindings = new Map();
	// Volatile drop threshold for ingress sends: above it a frame is dropped
	// (recovered by the consumer's own reconciliation) rather than growing the
	// socket buffer unbounded, matching the JSON volatile path.
	const INGRESS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

	function sendIngressAnnounce(id, binding) {
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: 'ingress-bind', id, kind: binding.kind, target: binding.target }));
	}

	// Reset ingress negotiation for a fresh socket. Re-announcing happens once
	// the server's `ingress-ok` confirms support on the new connection.
	function resetIngress() {
		ingressSupported = false;
		for (const b of ingressBindings.values()) { b.bound = false; b.seq = 0; }
	}

	// Server confirmed it speaks ingress on this connection: announce every
	// binding now.
	function onIngressOk() {
		ingressSupported = true;
		for (const [id, b] of ingressBindings) sendIngressAnnounce(id, b);
	}

	// Server acked one binding: the consumer may now send 0x03 frames on it.
	function onIngressBound(id) {
		const b = ingressBindings.get(id);
		if (b) b.bound = true;
	}

	/**
	 * Bind an ingress destination for a consumer. Returns a handle whose
	 * `send(schemaVersion, payload)` emits a `0x03` frame when the binding is
	 * live (returns true; a volatile drop under backpressure also returns true),
	 * or returns false when the binding is not live so the caller uses its JSON
	 * fallback. `live()` reports the current state; `dispose()` drops it.
	 * @param {string} kind
	 * @param {any} target
	 */
	function bindIngressDest(kind, target) {
		const id = ingressNextId++;
		/** @type {{ kind: string, target: any, bound: boolean, seq: number }} */
		const binding = { kind, target, bound: false, seq: 0 };
		ingressBindings.set(id, binding);
		if (ingressSupported) sendIngressAnnounce(id, binding);
		return {
			live() {
				return binding.bound && ws?.readyState === WebSocket.OPEN;
			},
			// Re-send the announce if this binding is not yet live. The first
			// announce (on `ingress-ok`) can lose a race against the server's
			// lazy load of the destination's ingress handler; a consumer that
			// reaches a point where the server is known-ready (the smooth channel
			// after a sync reply) calls this to converge the binding to binary.
			// A no-op once bound, or before the server confirmed ingress support.
			reannounce() {
				if (!binding.bound && ingressSupported) sendIngressAnnounce(id, binding);
			},
			/** @param {number} schemaVersion @param {Uint8Array} payload */
			send(schemaVersion, payload) {
				if (!binding.bound || ws?.readyState !== WebSocket.OPEN) return false;
				if ((ws.bufferedAmount ?? 0) > INGRESS_BACKPRESSURE_BYTES) return true;
				binding.seq++;
				ws.send(buildBinaryFrame(schemaVersion, id, binding.seq, payload));
				return true;
			},
			dispose() {
				ingressBindings.delete(id);
			}
		};
	}

	// Highest seq seen per topic. Sent back to the server on reconnect via
	// the resume frame so the user's resume hook can replay anything we
	// missed during the disconnect window. Only topics that the server is
	// stamping with seq end up here; opted-out topics ({ seq: false }) are
	// skipped.
	/** @type {Map<string, number>} */
	const lastSeenSeqs = new Map();

	// Process generation the server last reported per topic, learned from the
	// subscribe ack. Sent back on resume so the server can tell whether the seq
	// space we last saw still exists; a mismatch means the server reset that
	// topic and we must re-read it from scratch rather than trust our old
	// offset. Topics without a recorded epoch (subscribed before the server
	// reported one, or an old server that sends none) are simply absent, and
	// the server treats absence as a match - the gap-fill path stays
	// byte-identical for an unchanged deployment.
	/** @type {Map<string, number>} */
	const lastSeenEpochs = new Map();

	// sessionStorage key for the previous connection's session id. Scoped
	// by ws path so two clients on different endpoints in the same tab do
	// not collide. Read in-place rather than cached so private-mode tabs
	// (where sessionStorage throws) silently fall back to no-resume.
	const sessionStorageKey = 'svelte-adapter-uws.session.' + path;

	function storedSessionId() {
		try {
			return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(sessionStorageKey) : null;
		} catch { return null; }
	}
	function storeSessionId(id) {
		try {
			if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(sessionStorageKey, id);
		} catch {}
	}

	/** @type {Array<string | ArrayBuffer | ArrayBufferView>} */
	const sendQueue = [];
	const MAX_QUEUE_SIZE = 1000;

	/** @type {import('svelte/store').Writable<import('./client.js').WSEvent | null>} */
	const eventsStore = writable(null);

	/** @type {Map<string, import('svelte/store').Writable<import('./client.js').WSEvent | null>>} */
	const topicStores = new Map();

	/** @type {Map<string, import('svelte/store').Writable<unknown>>} */
	const eventStores = new Map();

	/** @type {import('svelte/store').Writable<'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'>} */
	const statusStore = writable('disconnected');

	// Set status to 'open' normally, or 'suspended' if the tab is in the
	// background. Centralised so onopen and the visibility handler stay
	// in sync without duplicating the document.hidden check.
	function setStatusOpen() {
		if (typeof document !== 'undefined' && document.hidden) {
			statusStore.set('suspended');
		} else {
			statusStore.set('open');
		}
	}

	// Subscribe ref counter and the subscribe-denied surface. Every
	// subscribe / subscribe-batch the client emits carries a numeric ref
	// so the server can reply with a per-topic { type: 'subscribed' } or
	// { type: 'subscribe-denied', reason } ack. The latest denial is
	// exposed via the `denials` Readable for consumers that want to show
	// a banner ("Access denied") or reason-coded retry.
	let nextSubscribeRef = 1;
	/** @type {import('svelte/store').Writable<{ topic: string, reason: string, ref: number | string } | null>} */
	const denialsStore = writable(null);
	/** @type {import('svelte/store').Writable<import('./client.js').MessageOverload | null>} */
	const overloadsStore = writable(null);

	// - Internal flow-control window (client mirror) -----------------------
	// Off until the server echoes acceptance. While off, every send takes the
	// immediate path unchanged (zero-config byte-identical). Once on, a
	// flow-controlled send consumes one permit from the current window; with
	// no permit it queues up to a bound, and the connection reports degraded
	// to the realtime layer. The window is replenished by asking the server
	// for more at a low-water mark. The deadline is absolute (set when the
	// window arrives) and compared against the wall clock; never decremented.
	let _flowActive = false;
	let _flowAvail = 0;
	let _flowExpiresAt = 0;
	const _FLOW_LOW_WATER = 64;
	const _FLOW_REQUEST_N = 256;
	const _FLOW_MAX_QUEUE = 256;
	/** @type {Array<() => void>} */
	const _flowQueue = [];
	let _flowDegraded = false;
	// Latched true once a replenish has been requested for the current window so
	// a low/queued window asks for more exactly once, not on every send. Cleared
	// when a fresh window is applied. Without this a sustained sub-low-water run
	// in a single window would emit one request-n per send, amplifying control
	// frames on the very connection the window exists to protect.
	let _flowReplenishSent = false;
	/** @type {((d: boolean) => void) | null} */
	let _onFlowDegraded = null;

	function _flowFresh() {
		return _flowAvail > 0 && now() < _flowExpiresAt;
	}
	function _setFlowDegraded(d) {
		if (d === _flowDegraded) return;
		_flowDegraded = d;
		if (_onFlowDegraded) _onFlowDegraded(d);
	}
	function _maybeReplenish() {
		if (!_flowActive) return;
		if (_flowReplenishSent) return; // at most one request per window
		if (_flowQueue.length > 0 || !_flowFresh() || _flowAvail <= _FLOW_LOW_WATER) {
			_flowReplenishSent = true;
			if (ws && ws.readyState === WebSocket.OPEN) {
				// Carry the permit-starved backlog so the server's pressure fold
				// sees real client saturation. A low-water replenish has no
				// backlog and emits the historical two-field frame.
				ws.send(requestNFrame(_FLOW_REQUEST_N, _flowQueue.length));
			}
		}
	}
	// Gate one flow-controlled send. Returns true if it went out immediately.
	function _flowSend(doSend) {
		if (!_flowActive) { doSend(); return true; }
		if (_flowFresh()) { _flowAvail--; doSend(); _maybeReplenish(); return true; }
		if (_flowQueue.length < _FLOW_MAX_QUEUE) {
			_flowQueue.push(doSend);
			_setFlowDegraded(true);
			_maybeReplenish();
			return false;
		}
		// Bounded queue full: drop quietly, surface only as degraded.
		_setFlowDegraded(true);
		return false;
	}
	// Apply a fresh window and drain the queue in FIFO order.
	function _applyFlowWindow(count, ttlMs) {
		_flowActive = true;
		_flowExpiresAt = now() + ttlMs;
		_flowAvail = count;
		// A fresh window clears the replenish latch so the next low-water
		// crossing can ask for more again.
		_flowReplenishSent = false;
		while (_flowAvail > 0 && _flowQueue.length > 0) {
			const doSend = _flowQueue.shift();
			_flowAvail--;
			if (doSend) doSend();
		}
		if (_flowQueue.length === 0) _setFlowDegraded(false);
	}

	// Wire-frame ceilings for subscribe-batch chunking. Match the server's
	// control-message limits: 8192 byte parse ceiling and 256-topic batch
	// cap. The envelope-bytes prelude leaves room for the {type, ref}
	// scaffolding around the topics array.
	const SUBSCRIBE_BATCH_ENVELOPE_BYTES = 50;
	const SUBSCRIBE_BATCH_MAX_BYTES = 8000;
	const SUBSCRIBE_BATCH_MAX_TOPICS = 200;
	const subscribeBatchEncoder = new TextEncoder();

	/**
	 * Chunk a list of topics into subscribe-batch payloads bounded by the
	 * server's parse ceiling and topic cap. Pure helper shared by the
	 * reconnect-time resubscribe path and the initial-mount microtask
	 * flush so the two cannot drift on the byte / topic limits.
	 * @param {string[]} topics
	 * @returns {string[][]}
	 */
	function chunkTopicsForBatch(topics) {
		const out = [];
		let chunk = [];
		let chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
		for (const t of topics) {
			const entryBytes = subscribeBatchEncoder.encode(JSON.stringify(t)).length + 1;
			if (chunk.length > 0 && (chunk.length >= SUBSCRIBE_BATCH_MAX_TOPICS || chunkBytes + entryBytes > SUBSCRIBE_BATCH_MAX_BYTES)) {
				out.push(chunk);
				chunk = [];
				chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
			}
			chunk.push(t);
			chunkBytes += entryBytes;
		}
		if (chunk.length > 0) out.push(chunk);
		return out;
	}

	/**
	 * Reconnect resubscribe chunker with recovery. Like chunkTopicsForBatch,
	 * but each chunk also carries a `recover` map of `{ offset, epoch }` for
	 * every topic in the chunk we hold a tracked seq for, and the recover fields
	 * count toward the same byte / topic budget so a chunk never overflows the
	 * control-frame ceiling. That is what lets recovery scale to high
	 * subscription counts where a single all-topics resume frame would overflow
	 * it. `recover` is null for a chunk with no recoverable topics (a plain
	 * resubscribe, byte-identical to before).
	 * @param {string[]} topics
	 * @returns {{ topics: string[], recover: Record<string, { offset: number, epoch?: number }> | null }[]}
	 */
	function chunkResubscribe(topics) {
		const out = [];
		let chunk = [];
		/** @type {Record<string, { offset: number, epoch?: number }> | null} */
		let recover = null;
		let chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
		for (const t of topics) {
			let entryBytes = subscribeBatchEncoder.encode(JSON.stringify(t)).length + 1;
			let entry = null;
			const offset = lastSeenSeqs.get(t);
			if (offset !== undefined) {
				const epoch = lastSeenEpochs.get(t);
				entry = epoch !== undefined ? { offset, epoch } : { offset };
				// The recover map's contribution to the frame: `"topic":{...},`.
				entryBytes += subscribeBatchEncoder.encode(JSON.stringify(t) + ':' + JSON.stringify(entry)).length + 1;
			}
			if (chunk.length > 0 && (chunk.length >= SUBSCRIBE_BATCH_MAX_TOPICS || chunkBytes + entryBytes > SUBSCRIBE_BATCH_MAX_BYTES)) {
				out.push({ topics: chunk, recover });
				chunk = [];
				recover = null;
				chunkBytes = SUBSCRIBE_BATCH_ENVELOPE_BYTES;
			}
			chunk.push(t);
			if (entry !== null) {
				if (recover === null) recover = {};
				recover[t] = entry;
			}
			chunkBytes += entryBytes;
		}
		if (chunk.length > 0) out.push({ topics: chunk, recover });
		return out;
	}

	// Initial-mount subscribe coalescer. Multiple subscribe(topic) calls
	// landing in the same microtask collapse to a single subscribe-batch
	// frame, so a page mounting N streams triggers the server's
	// subscribeBatch hook once instead of the per-topic subscribe hook
	// N times. Single-topic case stays as plain subscribe for the
	// minimal-change wire shape. Topics are also added to subscribedTopics
	// upfront, so a disconnect before the microtask fires loses nothing -
	// the reopen's resubscribe-batch path picks them up.
	/** @type {string[] | null} */
	let pendingSubscribes = null;

	function flushPendingSubscribes() {
		const batch = pendingSubscribes;
		pendingSubscribes = null;
		if (!batch || batch.length === 0) return;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		// Route the flow-controlled SUBSCRIBE through the window. Topics
		// already live in subscribedTopics, so a queued subscribe still
		// resubscribes on the next window or reconnect; nothing is lost and
		// nothing throws. When the window is inactive (zero-config) this is
		// an immediate send, byte-identical to before.
		if (batch.length === 1) {
			const topic = batch[0];
			if (debug) console.log('[ws] subscribe ->', topic);
			_flowSend(() => ws.send(JSON.stringify({ type: 'subscribe', topic, ref: nextSubscribeRef++ })));
			return;
		}
		for (const chunk of chunkTopicsForBatch(batch)) {
			if (debug) console.log('[ws] subscribe-batch ->', chunk);
			_flowSend(() => ws.send(JSON.stringify({ type: 'subscribe-batch', topics: chunk, ref: nextSubscribeRef++ })));
		}
	}

	// Topics the server refused with RATE_LIMITED, waiting to be asked for
	// again. That reason means a per-connection bound was momentarily full,
	// not that the topic is forbidden - the server frees the budget as its
	// in-flight work settles, so the condition clears on its own and the
	// only wrong answer is to stop asking. Every other denial reason is a
	// decision about the topic and is surfaced, never retried.
	//
	// This matters most where the refusal is most likely: a reconnect
	// resubscribe sends every topic at once, so a large subscription set
	// against a slow authorization hook can exceed the server's in-flight
	// budget and have its tail refused. Without the retry those topics stay
	// in `subscribedTopics` - the application believes it is subscribed -
	// while the server never enrolled them, and nothing corrects it until
	// the next reconnect.
	// Topic -> attempts made so far, which is also the backoff step. The
	// reason is not exclusively the transient bound: the landed-subscription
	// cap answers RATE_LIMITED too, and an application hook may return it as
	// its own throttle - and a hook-issued one is re-run by every retry, so
	// an unbounded loop would amplify the very load the app was shedding.
	// Retrying therefore backs off and gives up, leaving the denial surfaced
	// on the `denials` store for the application to act on.
	/** @type {Map<string, number>} */
	const rateLimitedTopics = new Map();
	/** @type {ReturnType<typeof setTimer> | null} */
	let rateLimitedTimer = null;
	const RATE_LIMITED_RETRY_MS = 250;
	const RATE_LIMITED_MAX_ATTEMPTS = 6;

	function flushRateLimitedRetries() {
		rateLimitedTimer = null;
		// Still-wanted topics only: one released between the refusal and here
		// must not be resurrected by its own retry.
		const topics = [...rateLimitedTopics.keys()].filter((t) => subscribedTopics.has(t));
		for (const topic of [...rateLimitedTopics.keys()]) {
			if (!subscribedTopics.has(topic)) rateLimitedTopics.delete(topic);
		}
		if (topics.length === 0) return;
		if (!ws || ws.readyState !== WebSocket.OPEN) return; // the reopen resubscribes everything
		// chunkResubscribe, not the plain chunker: a topic refused during a
		// reconnect resubscribe was asking for its missed tail as well, and the
		// truncated frame served no replay for it. Re-asking without the offset
		// would restore the subscription and silently drop the gap. Outside a
		// reconnect no topic carries a tracked seq, so `recover` is null and the
		// frame is byte-identical to a plain resubscribe.
		for (const { topics: chunk, recover } of chunkResubscribe(topics)) {
			const frame = { type: 'subscribe-batch', topics: chunk, ref: nextSubscribeRef++ };
			if (recover !== null) frame.recover = recover;
			if (debug) console.log('[ws] subscribe-batch retry ->', chunk, recover ? '(+recover)' : '');
			_flowSend(() => ws.send(JSON.stringify(frame)));
		}
	}

	/** @param {string} topic */
	function retryRateLimitedSubscribe(topic) {
		if (!subscribedTopics.has(topic)) return;
		const attempts = (rateLimitedTopics.get(topic) ?? 0) + 1;
		if (attempts > RATE_LIMITED_MAX_ATTEMPTS) {
			// Out of attempts: this is not the transient bound clearing, so stop
			// asking and leave the denial standing on the store.
			rateLimitedTopics.delete(topic);
			return;
		}
		rateLimitedTopics.set(topic, attempts);
		// One timer for the whole refused set, so a refused batch costs one
		// retry frame per chunk rather than one per topic, and it runs at the
		// pace of the LEAST-retried topic in the set - a fresh refusal is never
		// made to wait out another topic's backoff. Jittered, because every
		// connection refused by the same full server would otherwise retry in
		// the same instant and refill it together.
		if (rateLimitedTimer) return;
		let step = attempts;
		for (const n of rateLimitedTopics.values()) if (n < step) step = n;
		const base = RATE_LIMITED_RETRY_MS * Math.pow(2, step - 1);
		rateLimitedTimer = setTimer(flushRateLimitedRetries, base + dispersedReconnectDelay(0, base));
	}

	// Cause of the most recent non-open status transition. Set on
	// TERMINAL/THROTTLE/RETRY close codes, on the reconnect cap being
	// hit (EXHAUSTED), and on auth-preflight failures (AUTH). Cleared
	// on the next successful 'open'. `status === 'failed'` plus
	// `failure === null` is the intentional-close state - the user
	// terminated the connection, not the network.
	/** @type {import('svelte/store').Writable<import('./client.js').Failure | null>} */
	const failureStore = writable(null);
	let lastCloseCode = 0;
	let lastCloseReason = '';

	// Single onRequest handler. Server-initiated push-with-reply lands
	// here: server sends { type: 'request', ref, event, data }, this
	// callback returns the reply value (sync or async) and the framework
	// sends { type: 'reply', ref, data } back. A throwing / rejecting
	// handler turns into { type: 'reply', ref, error: <message> } so the
	// server's awaiting Promise rejects symmetrically. With no handler
	// installed, request frames are dropped silently and the server's
	// request times out.
	/** @type {((event: string, data: unknown) => unknown | Promise<unknown>) | null} */
	let requestHandler = null;

	// Set to true when no more reconnects will ever be attempted.
	// Consumers (ready()) watch this to reject instead of waiting forever.
	/** @type {import('svelte/store').Writable<boolean>} */
	const permaClosedStore = writable(false);

	function getUrl() {
		if (url) return url;
		if (typeof window === 'undefined') return '';
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}${path}`;
	}

	/**
	 * Build the HTTP URL for the auth preflight. Mirrors getUrl() but emits
	 * http/https instead of ws/wss so same-origin cookies flow correctly.
	 * Returns null in SSR or when auth is disabled.
	 */
	function getAuthUrl() {
		if (!authPath) return null;
		if (url) {
			try {
				const wsUrl = new URL(url);
				const httpScheme = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
				return httpScheme + '//' + wsUrl.host + authPath;
			} catch {
				return null;
			}
		}
		if (typeof window === 'undefined') return null;
		return window.location.origin + authPath;
	}

	/**
	 * Run the auth preflight. Returns one of:
	 *  - `'ok'` - request accepted (2xx). Open the socket.
	 *  - `'unauthorized'` - server rejected with 4xx. Terminal: the user is
	 *    not authenticated and retrying won't help without new credentials.
	 *  - `'transient'` - 5xx or network error. Fall back to normal reconnect
	 *    backoff so the preflight retries alongside the socket.
	 *
	 * Deduped: concurrent doConnect() calls share a single in-flight fetch.
	 *
	 * Returns the outcome plus the HTTP status (0 on network error) and a
	 * human-readable reason label, so callers can populate the failure
	 * store without repeating the fetch logic.
	 *
	 * @returns {Promise<{ outcome: 'ok' | 'unauthorized' | 'transient', status: number, reason: string }>}
	 */
	function runAuth() {
		if (!authPath) return Promise.resolve({ outcome: 'ok', status: 0, reason: '' });
		if (authInFlight) return authInFlight;
		const target = getAuthUrl();
		if (!target) return Promise.resolve({ outcome: 'ok', status: 0, reason: '' });

		authInFlight = (async () => {
			try {
				const resp = await fetch(target, {
					method: 'POST',
					credentials: 'include',
					headers: { 'x-requested-with': 'svelte-adapter-uws' }
				});
				if (debug) console.log('[ws] auth preflight status=%d', resp.status);
				if (resp.ok) return { outcome: 'ok', status: resp.status, reason: '' };
				if (resp.status >= 400 && resp.status < 500) {
					return { outcome: 'unauthorized', status: resp.status, reason: resp.statusText || 'unauthorized' };
				}
				return { outcome: 'transient', status: resp.status, reason: resp.statusText || 'service unavailable' };
			} catch (err) {
				if (debug) console.warn('[ws] auth preflight network error:', err);
				return { outcome: 'transient', status: 0, reason: 'network error' };
			} finally {
				authInFlight = null;
			}
		})();
		return authInFlight;
	}

	function doConnect() {
		if (!url && typeof window === 'undefined') return;
		if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

		statusStore.set('connecting');

		if (authPath) {
			runAuth().then((result) => {
				if (intentionallyClosed || terminalClosed) return;
				if (result.outcome === 'unauthorized') {
					// Server rejected the request with a 4xx. The user is not
					// authenticated and retrying won't help until they log in.
					if (debug) console.warn('[ws] auth preflight rejected (4xx), not opening WebSocket');
					failureStore.set({
						kind: 'auth-preflight',
						class: 'AUTH',
						status: result.status,
						...failureDiagnosticText(result.reason)
					});
					statusStore.set('failed');
					terminalClosed = true;
					permaClosedStore.set(true);
					return;
				}
				if (result.outcome === 'transient') {
					// Network error or 5xx. Retry via the normal backoff loop so
					// the preflight automatically re-runs on the next attempt.
					if (debug) console.warn('[ws] auth preflight transient failure, scheduling reconnect');
					failureStore.set({
						kind: 'auth-preflight',
						class: 'AUTH',
						status: result.status,
						...failureDiagnosticText(result.reason)
					});
					statusStore.set('disconnected');
					scheduleReconnect();
					return;
				}
				openSocket();
			});
			return;
		}
		openSocket();
	}

	function openSocket() {
		try {
			ws = new WebSocket(getUrl());
		} catch {
			scheduleReconnect();
			return;
		}
		// Identity capture for the handlers below. A replaced socket's late
		// events must not touch connection state: a forced close (suspend
		// detection, zombie detection) can race the visibility handler's
		// doConnect, and the old socket's onclose would otherwise null out
		// the fresh socket - leaving it open on the wire but mute (no hello,
		// no resume, sends queued forever). Each handler acts only while its
		// socket is still the current one.
		const sock = ws;
		// Read inbound binary frames as ArrayBuffer (default is Blob, which is
		// async to read). Cannot regress the realtime upload layer: that layer
		// only EMITS binary (0x01/0x02) and receives upload results as JSON on
		// the '__upload' topic - it never reads an inbound binary frame.
		ws.binaryType = 'arraybuffer';
		// Topic-ids are per-connection; the server reassigns them on a fresh
		// connection, so drop any stale id -> name mappings from a prior socket.
		// The stateful codec dictionaries reset in lock-step: the server starts a
		// fresh encoder dictionary on the new connection, so a stale client
		// dictionary would resolve ids to the wrong keys.
		wireIdMap.clear();
		resetWireDecoderStates();
		// Ingress ids are stable per binding, but the server reset its binding
		// map with this fresh connection - clear support/bound so every binding
		// re-announces once the new connection's `ingress-ok` arrives.
		resetIngress();

		ws.onopen = () => {
			if (ws !== sock) return;
			attempt = 0;
			// A fresh connection supersedes any pending drain advisory from the old
			// socket - clear it so a stale advisory cannot disperse a future reconnect.
			reconnectAdvisory = null;
			lastServerMessage = now();
			failureStore.set(null);
			setStatusOpen();
			if (debug) console.log('[ws] connected');

			// Advertise client capabilities. Server stores these on the
			// connection's userData and uses them to gate opt-in wire features:
			// 'batch' for publishBatched frames, plus any registered binary wire
			// codec capabilities (e.g. 'cursor.protocol:2'). A client always
			// advertises what it can decode; the wire format is the server's
			// call. Old servers ignore the unknown frame type.
			ws?.send(JSON.stringify({ type: 'hello', caps: buildHelloCaps() }));

			// Resubscribe every tracked topic, attaching per-topic recovery
			// ({ offset, epoch }) for any topic we hold a seq for, so the server
			// gap-fills the disconnect window as part of the resubscribe. The
			// recovery rides the already-chunked subscribe-batch (each chunk
			// stays under the control-frame ceiling), which is what lets it
			// scale to high subscription counts where a single all-topics resume
			// frame would overflow the ceiling and be dropped wholesale. A topic
			// with no tracked seq (a fresh subscribe, or a sink codec) resubscribes
			// plain. The server replays the missed tail on __replay:{topic} ahead
			// of the first live frame - the recovery is merged INTO the resubscribe
			// rather than sent as a separate `resume` frame (which the server still
			// accepts from older / third-party clients).
			if (subscribedTopics.size > 0) {
				for (const { topics, recover } of chunkResubscribe([...subscribedTopics])) {
					const frame = { type: 'subscribe-batch', topics, ref: nextSubscribeRef++ };
					if (recover !== null) frame.recover = recover;
					if (debug) console.log('[ws] resubscribe-batch ->', topics, recover ? '(+recover)' : '');
					ws?.send(JSON.stringify(frame));
				}
			}

			// Flush queued messages. Each entry was already serialized by
			// `serializeForSend` at enqueue time, so strings reach the wire
			// as text frames and ArrayBuffer / ArrayBufferView entries reach
			// the wire as binary frames - no per-flush type branching needed.
			while (sendQueue.length > 0) {
				const msg = sendQueue.shift();
				if (debug) console.log('[ws] flush ->', msg);
				if (msg !== undefined) ws?.send(msg);
			}
		};

		// Dispatch a single inbound event envelope through the per-topic
		// store ladder. Extracted so that a batched frame ({type:'batch',
		// events:[...]}) can drive each contained event through the same
		// path - indistinguishable from N individual frames except for
		// the latency drop and the lower onmessage bill.
		function dispatchEvent(msg) {
			/** @type {import('./client.js').WSEvent} */
			const wsEvent = { topic: msg.topic, event: msg.event, data: msg.data };
			// Additive frame metadata rides the dispatched envelope: `t` is a
			// codec-reconstructed server stamp (the time axis interpolation
			// ingests), `seq` the per-topic sequence. Consumers that never read
			// them are unaffected - the store merges ignore extra fields.
			if (typeof msg.t === 'number') wsEvent.t = msg.t;
			if (typeof msg.seq === 'number') wsEvent.seq = msg.seq;
			// Forward the de-herd window so a consumer (svelte-realtime's stream /
			// health de-herd dispatcher) can defer its reaction by a local random
			// delay. Without this the `j` stamped by `publish({ jitterMs })` is
			// dropped here and the client never staggers.
			if (typeof msg.j === 'number') wsEvent.j = msg.j;
			if (debug) console.log('[ws] <-', msg.topic, msg.event, msg.data);
			if (typeof msg.seq === 'number') {
				const prev = lastSeenSeqs.get(msg.topic);
				if (prev === undefined || msg.seq > prev) lastSeenSeqs.set(msg.topic, msg.seq);
			} else if ((msg.event === 'truncated' || msg.event === 'rehydrate' || msg.event === 'gap') &&
				typeof msg.topic === 'string' && msg.topic.charCodeAt(0) === 95 &&
				msg.topic.charCodeAt(1) === 95 && msg.topic.startsWith('__replay:')) {
				// The server signalled that this topic's history can no longer be
				// trusted from our offset: the seq space reset since we last saw
				// it (`truncated` / `rehydrate` - a process restart or a per-topic
				// authority bump), or the server proved it lost relayed frames we
				// were owed (`gap`, negotiated via the relay.resync:1 cap) - and
				// there our watermark has already stepped PAST the hole, so a
				// resume from it would silently skip frames forever. Drop the
				// stale per-topic offset and recorded epoch so the next live
				// frame re-seeds lastSeenSeqs from scratch, and so a subsequent
				// reconnect does not present an offset the server cannot honor.
				// The frame still dispatches to the store ladder below for any
				// higher-level consumer of the marker.
				const baseTopic = msg.topic.slice('__replay:'.length);
				lastSeenSeqs.delete(baseTopic);
				lastSeenEpochs.delete(baseTopic);
			}
			eventsStore.set(wsEvent);
			const tStore = topicStores.get(msg.topic);
			if (tStore) tStore.set(wsEvent);
			const eStore = eventStores.get(`${msg.topic}\0${msg.event}`);
			if (eStore) eStore.set({ data: msg.data });
		}

		ws.onmessage = (rawEvent) => {
			if (ws !== sock) return;
			lastServerMessage = now();
			try {
				// Inbound binary demux, ahead of the JSON path. A 0x03 frame is
				// a binary topic PAYLOAD: resolve its numeric topic-id to a name,
				// decode via the registered codec, and feed the SAME
				// dispatchEvent the JSON path uses so the reactive surface is
				// byte-for-byte identical (zero JSON.parse on this hot path).
				// Any other binary frame (the realtime layer's outbound-only
				// 0x01/0x02, or a malformed frame) is dropped. Binary frames
				// never fall through to JSON.parse.
				if (rawEvent.data instanceof ArrayBuffer) {
					if (rawEvent.data.byteLength > 1048576) {
						if (debug) console.warn('[ws] binary frame too large, dropped:', rawEvent.data.byteLength, 'bytes');
						return;
					}
					const parsed = parseBinaryFrame(new Uint8Array(rawEvent.data));
					if (parsed) {
						const topic = wireIdMap.get(parsed.topicId);
						if (topic !== undefined) {
							const match = wireCodecForTopic(topic);
							// The resolved topic name rides as the fifth decode argument so a
							// sink codec that serves several documents on one prefix can route
							// the frame to the right replica; per-PREFIX decoder state cannot
							// carry that. Non-sink codecs ignore it.
							const decoded = match
								? match.codec.decode(parsed.payload, ensureDecoderState(match.prefix, match.codec), parsed.schemaVersion, parsed.seq, topic)
								: null;
							// A sink codec applies the frame in place inside decode (e.g.
							// into a local document replica) and drives its own reactive
							// surface, so there is no store event to dispatch even when
							// decode returns a value. A normal codec returns { event, data }
							// for the shared store ladder; a null return from a normal codec
							// is a decode miss (unknown opcode/version) and the frame drops.
							if (decoded && !match.codec.sink) {
								const out = { topic, event: decoded.event, data: decoded.data };
								if (parsed.seq > 0) out.seq = parsed.seq;
								// Additive codec metadata (e.g. the cursor wire's server
								// stamp): rides the dispatched event for consumers that
								// want it; the store merge ignores it.
								if (decoded.t !== undefined) out.t = decoded.t;
								dispatchEvent(out);
							} else if (!match) {
								// Compact game fan-out (PROTOCOL.md 6.7): a 0x03 frame for a
								// known topic with NO prefix codec is the game lane's egress
								// twin - the client advertised game.fanout:1 and the server
								// sends binary only for negotiated caps, so by elimination
								// this is a value-codec [event, data, id?] relay. Decode it
								// and dispatch exactly as the JSON game envelope would (the
								// JSON path drops id at the store, so this one does too - the
								// two paths stay byte-identical).
								let value;
								try { value = decodeValue(parsed.payload); } catch { value = null; }
								if (Array.isArray(value) && typeof value[0] === 'string') {
									const out = { topic, event: value[0], data: value[1] };
									if (parsed.seq > 0) out.seq = parsed.seq;
									dispatchEvent(out);
								}
							}
						} else if (debug) {
							console.warn('[ws] 0x03 frame for unknown topicId', parsed.topicId);
						}
					}
					return;
				}
				// Reject oversized messages to prevent main-thread blocking. The cap
				// is BYTES in either encoding (PROTOCOL.md section 1.3), and a JS
				// string's length is UTF-16 code units, which understates UTF-8 by
				// up to 3x on non-ASCII text - a ~1M-code-unit CJK payload is ~3 MB.
				// Every code unit encodes to at least one and at most three UTF-8
				// bytes (a surrogate pair: four bytes for its two units), so the
				// unit count bounds the byte count on both sides: over the cap in
				// units is over in bytes (reject without measuring), at or under a
				// third of the cap in units cannot exceed it in bytes (accept
				// without measuring). Only the band between measures exactly, with
				// an allocation-free counting loop. The common small message pays
				// one extra integer compare; the reported figure is real bytes.
				if (typeof rawEvent.data === 'string') {
					const units = rawEvent.data.length;
					if (units > 1048576) {
						if (debug) console.warn('[ws] message too large, dropped:', utf8ByteLength(rawEvent.data), 'bytes');
						return;
					}
					if (units * 3 > 1048576) {
						const bytes = utf8ByteLength(rawEvent.data);
						if (bytes > 1048576) {
							if (debug) console.warn('[ws] message too large, dropped:', bytes, 'bytes');
							return;
						}
					}
				}
				const msg = JSON.parse(rawEvent.data);
				if (msg.topic && msg.event !== undefined) {
					dispatchEvent(msg);
					return;
				}
				if (msg.type === 'batch' && Array.isArray(msg.events)) {
					// Wire-level batched frame from platform.publishBatched.
					// Demux: drive each contained event through the same
					// per-topic store ladder a single-event frame would
					// take. Order matches the server's submitted order.
					for (let i = 0; i < msg.events.length; i++) {
						const e = msg.events[i];
						if (e && typeof e.topic === 'string' && e.event !== undefined) {
							dispatchEvent(e);
						}
					}
					return;
				}
				if (msg.type === 'welcome' && typeof msg.sessionId === 'string') {
					storeSessionId(msg.sessionId);
					if (debug) console.log('[ws] welcome sessionId=%s', msg.sessionId);
					return;
				}
				if (msg.type === 'resumed') {
					if (debug) console.log('[ws] resumed');
					return;
				}
				if (msg.type === 'lease-ok') {
					// Server honours internal flow control. Turn the client
					// window on; the first window frame follows. Absorbed here
					// so it never reaches the app surface.
					_flowActive = true;
					return;
				}
				if (msg.type === 'lease' && typeof msg.count === 'number' && typeof msg.ttlMs === 'number') {
					// Fresh window from the server. Apply it and drain any
					// queued flow-controlled sends. Absorbed here; never
					// reaches the app surface.
					_applyFlowWindow(msg.count, msg.ttlMs);
					return;
				}
				if (msg.type === 'subscribed' && typeof msg.topic === 'string') {
					// Record the per-topic generation the server reported so we
					// can present it back on resume. Old servers omit it; the
					// map entry is simply absent and resume treats it as a match.
					if (typeof msg.epoch === 'number') lastSeenEpochs.set(msg.topic, msg.epoch);
					// The topic landed, so its backoff has served its purpose: a
					// later refusal is a new episode and starts from the first step.
					rateLimitedTopics.delete(msg.topic);
					if (debug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.subscription',
						event: 'client.subscription.accepted',
						severity: 'debug',
						message: 'The server accepted a topic subscription.',
						attributes: { topic: msg.topic, ref: msg.ref, epoch: msg.epoch }
					}));
					return;
				}
				if (msg.type === 'wire-id' && typeof msg.topic === 'string' && typeof msg.id === 'number') {
					// Server announced a binary topic-id assignment. Record the
					// inverse mapping so a subsequent 0x03 frame's numeric id
					// resolves to this topic name. Arrives before the first
					// binary frame for the topic (same socket, ordered).
					wireIdMap.set(msg.id, msg.topic);
					if (debug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.wire',
						event: 'client.wire-id.assigned',
						severity: 'debug',
						message: 'The server assigned a binary topic identifier.',
						attributes: { topic: msg.topic, id: msg.id }
					}));
					return;
				}
				if (msg.type === 'ingress-ok') {
					// Server speaks binary ingress. Announce every bound
					// destination now; each is confirmed by an `ingress-bound`.
					// Absorbed here; never reaches the app surface.
					onIngressOk();
					if (debug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.ingress',
						event: 'client.ingress.available',
						severity: 'debug',
						message: 'The server supports binary ingress.',
						attributes: null
					}));
					return;
				}
				if (msg.type === 'ingress-bound' && typeof msg.id === 'number') {
					// Server armed one ingress binding: promote it to binary so
					// the consumer's next send goes as a 0x03 frame. Absorbed here.
					onIngressBound(msg.id);
					if (debug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.ingress',
						event: 'client.ingress.bound',
						severity: 'debug',
						message: 'The server bound a binary ingress destination.',
						attributes: { id: msg.id }
					}));
					return;
				}
				if (msg.type === 'subscribe-denied' && typeof msg.topic === 'string' && typeof msg.reason === 'string') {
					console.warn(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.subscription',
						event: 'client.subscription.denied',
						severity: 'warn',
						message: 'The server denied a topic subscription.',
						attributes: {
							topic: msg.topic,
							reason: msg.reason,
							ref: msg.ref,
							help: 'https://svti.me/subscribe-denied'
						}
					}));
					denialsStore.set({ topic: msg.topic, reason: msg.reason, ref: msg.ref });
					// RATE_LIMITED is a momentarily-full server bound, not a
					// verdict on the topic: ask again shortly rather than
					// leaving the application believing it is subscribed.
					if (msg.reason === 'RATE_LIMITED') retryRateLimitedSubscribe(msg.topic);
					return;
				}
				if (msg.type === 'message-overloaded' && typeof msg.reason === 'string' &&
					(msg.scope === 'connection' || msg.scope === 'global')) {
					const overload = { reason: msg.reason, scope: msg.scope };
					if (Number.isSafeInteger(msg.retryAfterMs) && msg.retryAfterMs > 0) {
						overload.retryAfterMs = msg.retryAfterMs;
					}
					if (debug) console.warn(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.message',
						event: 'client.message.overloaded',
						severity: 'warn',
						message: 'The server shed an application message at its established-message admission boundary.',
						attributes: overload
					}));
					overloadsStore.set(overload);
					return;
				}
				if (msg.type === 'error' && typeof msg.code === 'string') {
					// A protocol-level error from the server (currently only
					// CONTROL_FRAME_TOO_LARGE: a control frame this client sent
					// exceeded the server's control-frame ceiling and was rejected
					// rather than acted on). Surface it; it never reaches the app.
					// `size` names the offending frame's byte length - the frame
					// was rejected without parsing, so the size is the only handle
					// a developer has on which frame overflowed.
					console.warn(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'client.protocol',
						event: 'client.protocol.error',
						severity: 'warn',
						message: 'The server rejected a protocol frame.',
						attributes: {
							code: msg.code,
							limit: typeof msg.limit === 'number' ? msg.limit : null,
							size: typeof msg.size === 'number' ? msg.size : null
						}
					}));
					return;
				}
				if (msg.type === 'request' && (typeof msg.ref === 'number' || typeof msg.ref === 'string') && typeof msg.event === 'string') {
					if (!requestHandler) {
						if (debug) console.warn('[ws] request received but no handler installed - dropping (server will time out)');
						return;
					}
					const ref = msg.ref;
					Promise.resolve()
						.then(() => requestHandler(msg.event, msg.data))
						.then((result) => {
							if (ws?.readyState === WebSocket.OPEN) {
								ws.send(JSON.stringify({ type: 'reply', ref, data: result ?? null }));
							}
						})
						.catch((err) => {
							const message = err && err.message ? String(err.message) : String(err);
							if (ws?.readyState === WebSocket.OPEN) {
								ws.send(JSON.stringify({ type: 'reply', ref, error: message }));
							}
						});
					return;
				}
				if (msg.type === 'reconnect') {
					// Server drain advisory: it is about to close this socket (it is
					// draining or restarting) and wants us to reconnect on a jittered
					// schedule so a whole fleet does not stampede the replacement in one
					// backoff window. Each client rolls its own delay in
					// [afterMs, afterMs + windowMs) - the frame advertises the WINDOW, not
					// a pre-rolled offset. We only STASH it here; the dispersed reconnect
					// is armed in onclose when the close actually arrives.
					const windowMs = typeof msg.windowMs === 'number' && msg.windowMs > 0 ? msg.windowMs : 0;
					if (windowMs > 0) {
						const afterMs = typeof msg.afterMs === 'number' && msg.afterMs > 0 ? msg.afterMs : 0;
						// Validity grace: honor the advisory only if the server's close lands
						// within the dispersal window plus this slack, so a stray advisory
						// whose close never comes goes stale instead of deferring a genuine
						// later reconnect.
						const graceMs = 5000;
						reconnectAdvisory = { afterMs, windowMs, deadline: now() + afterMs + windowMs + graceMs };
					}
					return;
				}
			} catch {
				// Not a valid envelope - ignore
			}
		};

		ws.onclose = (event) => {
			// Dropped BEFORE the identity guard below: a forced close can race a
			// reconnect, and a superseded socket's late onclose returns early. If
			// the retry outlived that return it would fire against the NEW socket
			// and re-send topics the reopen had already resubscribed - with their
			// recovery - burning the very budget this retry exists to wait out.
			// Every close leads to a resubscribe of everything wanted, so a
			// pending retry is never the thing that restores a subscription.
			if (rateLimitedTimer) {
				clearTimer(rateLimitedTimer);
				rateLimitedTimer = null;
			}
			rateLimitedTopics.clear();
			// A replaced socket's close must not null out (or reconnect over)
			// the socket that superseded it.
			if (ws !== sock) return;
			ws = null;
			if (debug) console.log('[ws] disconnected');
			lastCloseCode = event?.code || 0;
			lastCloseReason = event?.reason || '';
			if (intentionallyClosed) {
				// User-initiated termination is not a failure cause; clear
				// any prior failure so the (status='failed', failure=null)
				// pair encodes "deliberately ended."
				failureStore.set(null);
				statusStore.set('failed');
				return;
			}

			const cls = classifyCloseCode(event?.code);
			const code = lastCloseCode;
			const reason = lastCloseReason;
			if (cls === 'TERMINAL') {
				// Server has permanently rejected this client  - do not retry.
				// Use ws.close(4401) or ws.close(1008) on the server when credentials
				// are invalid or the connection is forbidden, to stop the retry loop.
				if (debug) console.warn('[ws] connection permanently closed by server (code ' + event?.code + ')');
				terminalClosed = true;
				permaClosedStore.set(true);
				failureStore.set({ kind: 'ws-close', class: 'TERMINAL', code, ...failureDiagnosticText(reason) });
				statusStore.set('failed');
				return;
			}

			// Server drain advisory: it asked us to reconnect on a jittered schedule
			// before closing (it is draining / restarting), so a whole fleet does not
			// stampede the replacement node. Honor it OVER a normal THROTTLE / RETRY;
			// TERMINAL already returned above, so a permanent close still wins. Only
			// when the advisory is fresh (its close arrived within the validity
			// deadline). Reset the backoff attempt: the client is migrating to a fresh
			// node, not backing off a failure.
			const advisory = reconnectAdvisory;
			reconnectAdvisory = null;
			if (advisory && now() < advisory.deadline) {
				failureStore.set({ kind: 'ws-close', class: 'DRAIN', code, ...failureDiagnosticText(reason) });
				statusStore.set('disconnected');
				attempt = 0;
				scheduleReconnect(dispersedReconnectDelay(advisory.afterMs, advisory.windowMs));
				return;
			}

			if (cls === 'THROTTLE') {
				// Jump ahead in the backoff curve to avoid hammering a rate-limited server.
				attempt = Math.max(attempt, 5);
				failureStore.set({ kind: 'ws-close', class: 'THROTTLE', code, ...failureDiagnosticText(reason) });
			} else {
				failureStore.set({ kind: 'ws-close', class: 'RETRY', code, ...failureDiagnosticText(reason) });
			}

			statusStore.set('disconnected');
			scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose fires after this - reconnect is handled there
		};
	}

	function scheduleReconnect(overrideDelayMs) {
		if (reconnectTimer) return;
		if (attempt >= maxReconnectAttempts) {
			failureStore.set({
				kind: 'ws-close',
				class: 'EXHAUSTED',
				code: lastCloseCode,
				...failureDiagnosticText(lastCloseReason || 'max reconnect attempts exhausted')
			});
			statusStore.set('failed');
			terminalClosed = true;
			permaClosedStore.set(true);
			return;
		}
		let delay;
		if (typeof overrideDelayMs === 'number') {
			// Dispersed reconnect (server drain advisory): the delay is pre-rolled from
			// the advisory window; do NOT advance the backoff attempt - the client is
			// migrating to a fresh node, not backing off a failure.
			delay = overrideDelayMs;
		} else {
			delay = nextReconnectDelay(reconnectInterval, maxReconnectInterval, attempt);
			attempt++;
		}
		reconnectTimer = setTimer(() => {
			reconnectTimer = null;
			doConnect();
		}, delay);
	}

	/**
	 * Subscribe to a topic (ref-counted).
	 * Multiple callers can subscribe; the WS subscription is sent on the first ref.
	 *
	 * Outgoing frames are microtask-batched: N subscribe(topic) calls in
	 * the same microtask collapse to one subscribe-batch frame, so a page
	 * mounting many streams triggers the server's subscribeBatch hook
	 * once instead of N per-topic subscribe hook calls. Single-topic case
	 * stays as a plain subscribe frame.
	 * @param {string} topic
	 */
	function subscribe(topic) {
		const count = topicRefCounts.get(topic) || 0;
		topicRefCounts.set(topic, count + 1);
		if (count > 0) return; // Already subscribed at WS level
		// __-prefixed topics are framework broadcast taps, not wire subscriptions:
		// the plugin or extension that owns the topic manages server-side subscriber
		// membership directly (via ws.subscribe / platform.subscribe), and the client
		// only needs the local topicStores entry that onTopic already registered for
		// inbound dispatch. Skip the wire frame entirely - it would be rejected by
		// the default INVALID_TOPIC gate anyway, and the round-trip adds nothing.
		// Excluded from subscribedTopics for the same reason: the reconnect-resubscribe
		// path must not re-emit a frame the server will deny.
		//
		// Server-MANAGED topics take the identical path: the server already
		// subscribed the socket (its stream RPC ran platform.subscribe), so the
		// client subscribe frame is redundant, and under wire-subscribe
		// authorization a reconnect resubscribe would race ahead of the server's
		// re-subscribe and be denied. Same skip: dispatch via the topic store,
		// never a wire frame, never the resubscribe-batch.
		if ((topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) || managedTopics.has(topic)) return;
		subscribedTopics.add(topic);
		if (ws?.readyState !== WebSocket.OPEN) return;
		if (!pendingSubscribes) {
			pendingSubscribes = [];
			microtask(flushPendingSubscribes);
		}
		pendingSubscribes.push(topic);
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
		// Drop the managed mark (re-added on the next server-driven attach) to keep
		// the set bounded across churn of dynamic topics.
		managedTopics.delete(topic);
		subscribedTopics.delete(topic);
		topicStores.delete(topic);
		// Clean up topic+event filtered stores for this topic
		for (const key of eventStores.keys()) {
			if (key.startsWith(topic + '\0')) eventStores.delete(key);
		}
		if (debug) console.log('[ws] unsubscribe ->', topic);
		// __-prefixed topics are framework broadcast taps: the client never sent a
		// wire subscribe (the server's INVALID_TOPIC gate would reject one) and holds
		// no wire-level subscription state, so there is nothing for the server to
		// release - skip the frame, exactly as subscribe() did.
		if (topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) return;
		// Server-managed topics are the opposite of __-prefixed here. subscribe() skips
		// their wire frame because the server established the subscription itself (its
		// stream RPC ran platform.subscribe: real ws.subscribe membership plus the
		// subscribe hook chain), so a client subscribe would be redundant and would
		// race the server's re-subscribe on reconnect. Release is not symmetric: the
		// client is the only party that knows when the last local ref dropped, so it
		// MUST send the unsubscribe frame. Suppressing it would leave the socket
		// subscribed to a topic nothing consumes (publishes keep flowing, the server's
		// subscription total drifts) and would never fire the app's unsubscribe hook -
		// and everything chained on it - until the socket closes. The frame is not an
		// authorization surface and the server release path is idempotent (an absent
		// subscription unsubscribes to a no-op, the membership delete reports false, and
		// the unsubscribe hook chain is required to be idempotent), so a framework that
		// also sends its own release frame stays correct.
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
		// Register the store immediately so messages dispatched before any
		// Svelte subscriber arrives are captured in the writable's current value.
		let store = topicStores.get(topic);
		if (!store) {
			store = writable(null);
			topicStores.set(topic, store);
			// If nothing subscribes before the next microtask, remove the entry.
			// Guards against accumulating entries for topics that are constructed
			// but never actually used (e.g. dead code paths, conditional renders
			// that never mount). Safe: if another wrapper for the same topic has
			// an active subscriber, topicRefCounts will be non-empty and we skip.
			const ownStore = store;
			microtask(() => {
				if (subs === 0 && !topicRefCounts.has(topic) && topicStores.get(topic) === ownStore) {
					topicStores.delete(topic);
				}
			});
		}

		// Ref-counted: subscribes to WS topic when first Svelte subscriber
		// arrives, releases when last leaves.
		let subs = 0;
		function wrappedSubscribe(fn) {
			if (subs++ === 0) {
				// After a full unsubscribe cycle, release() deletes the store from
				// the map. Re-register (or adopt a concurrent store) so that new
				// messages are dispatched to this wrapper.
				const current = topicStores.get(topic);
				if (!current) {
					store = writable(null);
					topicStores.set(topic, store);
				} else if (current !== store) {
					store = current;
				}
				subscribe(topic);
			}
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
		// Same register-at-call-time and refresh-on-resubscribe pattern as onTopic.
		let store = eventStores.get(key);
		if (!store) {
			store = writable(null);
			eventStores.set(key, store);
			const ownStore = store;
			microtask(() => {
				if (subs === 0 && !topicRefCounts.has(topic) && eventStores.get(key) === ownStore) {
					eventStores.delete(key);
				}
			});
		}

		let subs = 0;
		function wrappedSubscribe(fn) {
			if (subs++ === 0) {
				const current = eventStores.get(key);
				if (!current) {
					store = writable(null);
					eventStores.set(key, store);
				} else if (current !== store) {
					store = current;
				}
				subscribe(topic);
			}
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
	 * Decide how a payload reaches `ws.send`. Strings and JSON-serializable
	 * objects become text frames via JSON.stringify; `ArrayBuffer` and any
	 * `ArrayBufferView` (Uint8Array, DataView, etc) pass through unchanged
	 * so they reach the wire as binary frames. Used by `send`, `sendQueued`,
	 * and the queue flush so all three paths agree on the contract.
	 *
	 * @param {unknown} data
	 * @returns {string | ArrayBuffer | ArrayBufferView}
	 */
	function serializeForSend(data) {
		if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
			return /** @type {ArrayBuffer | ArrayBufferView} */ (data);
		}
		return JSON.stringify(data);
	}

	/**
	 * Send a custom message to the server. Dropped if not connected.
	 *
	 * Strings and JSON-serializable objects are sent as text frames after
	 * `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array,
	 * DataView, etc) are sent as binary frames unchanged.
	 *
	 * @param {unknown} data
	 */
	function send(data) {
		if (ws?.readyState === WebSocket.OPEN) {
			if (debug) console.log('[ws] send ->', data);
			ws.send(serializeForSend(data));
		} else if (debug) {
			console.warn('[ws] send dropped (not connected) - use sendQueued() to queue messages for reconnect:', data, '\n  See: https://svti.me/send-dropped');
		}
	}

	/**
	 * Send a message, queuing it if not currently connected.
	 * Queued messages flush automatically on reconnect (FIFO).
	 *
	 * Strings and JSON-serializable objects are sent as text frames after
	 * `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array,
	 * DataView, etc) are sent as binary frames unchanged. Queued binary
	 * payloads are kept as-is in the in-memory queue and flushed verbatim
	 * on reconnect.
	 *
	 * @param {unknown} data
	 */
	function sendQueued(data) {
		const serialized = serializeForSend(data);
		if (ws?.readyState === WebSocket.OPEN) {
			if (debug) console.log('[ws] send ->', data);
			ws.send(serialized);
		} else {
			if (sendQueue.length >= MAX_QUEUE_SIZE) {
				console.warn('[ws] queue full (' + MAX_QUEUE_SIZE + '), dropping oldest message\n  See: https://svti.me/client-queue');
				sendQueue.shift();
			}
			if (debug) console.log('[ws] queued ->', data);
			sendQueue.push(serialized);
		}
	}

	/**
	 * Close the connection permanently.
	 */
	/** @type {(() => void) | null} */
	let visibilityHandler = null;
	/** @type {(() => void) | null} */
	let offlineHandler = null;
	/** @type {(() => void) | null} */
	let onlineHandler = null;

	function close() {
		intentionallyClosed = true;
		permaClosedStore.set(true);
		if (reconnectTimer) {
			clearTimer(reconnectTimer);
			reconnectTimer = null;
		}
		if (activityTimer) {
			clearIntervalTimer(activityTimer);
			activityTimer = null;
		}
		if (visibilityHandler && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', visibilityHandler);
			visibilityHandler = null;
		}
		if (typeof window !== 'undefined') {
			if (offlineHandler) { window.removeEventListener('offline', offlineHandler); offlineHandler = null; }
			if (onlineHandler) { window.removeEventListener('online', onlineHandler); onlineHandler = null; }
		}
		ws?.close();
		ws = null;
		singleton = null;
		singletonCreatedBy = '';
		// Intentional termination is not a failure cause. Clear any prior
		// value here too because if the user calls close() while we are
		// already disconnected (no live ws), onclose never re-enters and
		// the previous RETRY/EXHAUSTED entry would otherwise stick.
		failureStore.set(null);
		statusStore.set('failed');
	}

	// Auto-connect on creation
	doConnect();

	// Page visibility reconnect: when a tab resumes from background (or the user
	// unlocks their phone), reconnect immediately instead of waiting for the
	// exponential backoff timer. Browsers often close WS connections during hide.
	if (typeof document !== 'undefined') {
		visibilityHandler = () => {
			if (document.hidden) {
				hiddenDisconnect = true;
				// Restart the suspend measurement at hide so only the hidden
				// span - where a device sleep usually happens - counts at
				// resume. The read also surfaces a gap accrued while VISIBLE
				// (lid close on a visible tab, hidden again before the 30s
				// detector tick could read it): act on it here, or the
				// re-stamp would silently swallow it.
				const gapAtHide = readSuspendGap();
				if (intentionallyClosed || terminalClosed) return;
				if (ws?.readyState === WebSocket.OPEN) {
					if (gapAtHide > SUSPEND_GAP_MS && now() - lastServerMessage > 5000) {
						if (debug) console.log('[ws] suspend gap detected at hide, reconnecting');
						attempt = 0;
						ws.close();
						return;
					}
					// Tab moved to the background. Downgrade to 'suspended' as a
					// UI hint - browsers may close idle backgrounded sockets so
					// live data is best-effort.
					statusStore.set('suspended');
				}
				return;
			}
			// Tab is visible.
			if (intentionallyClosed || terminalClosed) return;
			if (ws?.readyState === WebSocket.OPEN) {
				if (readSuspendGap() > SUSPEND_GAP_MS && now() - lastServerMessage > 5000) {
					// The device slept through the hide. The socket still reads
					// OPEN, but the server has likely idle-dropped it with the
					// close suppressed - trusting it would freeze live data
					// until the silence detector caught up. Close it; onclose
					// classifies RETRY and reconnects with a resume. A frame
					// received in the last few seconds proves the socket
					// survived the sleep, so that case is trusted as-is.
					if (debug) console.log('[ws] suspend gap detected on resume, reconnecting');
					hiddenDisconnect = false;
					attempt = 0;
					ws.close();
					return;
				}
				// Connection survived the hide - clear the 'suspended' overlay.
				statusStore.set('open');
				hiddenDisconnect = false;
				return;
			}
			// Connection did not survive (or was never open) - force a reconnect.
			hiddenDisconnect = false;
			attempt = 0;
			if (reconnectTimer) {
				clearTimer(reconnectTimer);
				reconnectTimer = null;
			}
			doConnect();
		};
		document.addEventListener('visibilitychange', visibilityHandler);
	}

	// Network connectivity: the browser fires `offline` / `online` on the window
	// when the OS loses or regains a route. A plain `setOffline(true)` (and many
	// real network drops) does NOT close the socket, so without this the client
	// only learns it is offline via the ~150s silence detector - far too slow to
	// arm the offline queue or show an accurate status. Drive the status machine
	// off these events so a drop is reflected at once and recovery is immediate.
	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		offlineHandler = () => {
			if (intentionallyClosed || terminalClosed) return;
			if (debug) console.log('[ws] browser reported offline, dropping the socket');
			if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
				// Close now so onclose classifies RETRY, flips status to 'disconnected',
				// and schedules the reconnect - which is also what arms the realtime
				// offline queue. The `online` handler skips the backoff on recovery.
				ws.close();
			} else {
				// No live socket to close - surface the drop directly.
				statusStore.set('disconnected');
			}
		};
		onlineHandler = () => {
			if (intentionallyClosed || terminalClosed) return;
			// The socket survived the drop (rare) - nothing to do.
			if (ws?.readyState === WebSocket.OPEN) return;
			if (debug) console.log('[ws] browser reported online, reconnecting now');
			// Connectivity is back: skip the remaining backoff and reconnect now,
			// mirroring the tab-visible recovery branch.
			attempt = 0;
			if (reconnectTimer) {
				clearTimer(reconnectTimer);
				reconnectTimer = null;
			}
			doConnect();
		};
		window.addEventListener('offline', offlineHandler);
		window.addEventListener('online', onlineHandler);
	}

	// Zombie connection detection: check every 30s whether the server has gone
	// completely silent. If so, the connection is likely a zombie (server dropped
	// us but the client's onclose was suppressed by browser throttling  - common
	// on mobile after wake from sleep). Force a close so onclose fires and the
	// normal reconnect path takes over.
	if (typeof window !== 'undefined') {
		activityTimer = setIntervalTimer(() => {
			// The suspend check catches sleeps the visibility handler never
			// sees (lid close on a visible tab, OS suspend without a hide):
			// the first tick after wake reads the whole gap in one delta,
			// where the silence check alone would ignore sleeps shorter than
			// the timeout. Read unconditionally so the reference stamps stay
			// fresh even while disconnected.
			const nowMs = now();
			const suspendGap = readSuspendGap();
			const silence = nowMs - lastServerMessage;
			// If THIS tick fired much later than its interval, the browser
			// throttled our timer (backgrounded tab): the "silence" is our own
			// frozen loop, not a dead server. Suppress ONLY the pure-silence
			// close in that case - a real OS sleep still reconnects via the
			// suspend-gap branch (re-measured on the next on-cadence tick).
			const timerThrottled = (nowMs - lastActivityTickWall) > ACTIVITY_INTERVAL_MS * 1.5;
			lastActivityTickWall = nowMs;
			if (ws?.readyState === WebSocket.OPEN
				&& ((silence > SERVER_TIMEOUT_MS && !timerThrottled) || (suspendGap > SUSPEND_GAP_MS && silence > 5000))) {
				if (debug) console.log('[ws] server silent for', silence, 'ms (suspend gap', suspendGap, 'ms), reconnecting');
				ws.close();
			}
		}, ACTIVITY_INTERVAL_MS);
	}

	function onRequest(handler) {
		requestHandler = typeof handler === 'function' ? handler : null;
		return () => { if (requestHandler === handler) requestHandler = null; };
	}

	// Re-advertise capabilities on an already-open socket. Called by
	// registerWireCodec when a binary plugin is imported after connect so its
	// capability still reaches the server (the common case - import before
	// connect - is covered by buildHelloCaps() reading the registry at open).
	function resendHello() {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'hello', caps: buildHelloCaps() }));
		}
	}

	return {
		events: { subscribe: eventsStore.subscribe },
		status: { subscribe: statusStore.subscribe },
		denials: { subscribe: denialsStore.subscribe },
		overloads: { subscribe: overloadsStore.subscribe },
		failure: { subscribe: failureStore.subscribe },
		_permaClosed: { subscribe: permaClosedStore.subscribe },
		_hasUrl: !!url,
		on: onTopic,
		_onEvent: onEvent,
		_release: release,
		subscribe,
		unsubscribe,
		send,
		sendQueued,
		// Bytes the browser has accepted via `ws.send` but not yet flushed
		// to the OS socket buffer. Mirrors the native WebSocket property.
		// Returns 0 when the underlying socket does not exist (pre-connect
		// or post-close). Use this for client-side paced sending: after
		// each chunk, check `conn.bufferedAmount` against a high-water
		// mark and back off until it drops below a low-water mark.
		get bufferedAmount() { return ws?.bufferedAmount ?? 0; },
		onRequest,
		_resendHello: resendHello,
		// Internal: bind a client->server binary ingress destination. A plugin
		// consumer (e.g. the smooth command channel) calls this to negotiate an
		// id-addressed `0x03` ingress binding and gets back a handle that sends
		// binary when the binding is live and reports when it is not (so the
		// consumer can fall back to its JSON path). See `bindIngressDest`.
		_bindIngress: bindIngressDest,
		// Internal: the resolved WebSocket URL this connection dials. A plugin
		// that opens its own dedicated socket (the cursor render worker) must
		// reach the same endpoint the main connection negotiated - including a
		// custom `url` / `path` option - so the derivation is exposed here
		// rather than re-derived from window.location in the plugin.
		_url: getUrl,
		// Internal-only subscription to the connection's flow-control health.
		// A boolean (degraded yes/no) is the only thing that crosses this
		// accessor - no window count, deadline, or any internal accounting
		// value. The realtime layer folds it into realtime.health. Emits the
		// current value on subscribe; returns an unsubscribe.
		_onLeaseDegraded(cb) {
			_onFlowDegraded = typeof cb === 'function' ? cb : null;
			if (_onFlowDegraded) _onFlowDegraded(_flowDegraded);
			return () => { _onFlowDegraded = null; };
		},
		close
	};
}
