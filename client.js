import { writable, derived } from 'svelte/store';

/** @type {ReturnType<typeof createConnection> | null} */
let singleton = null;

/** @type {'explicit' | 'implicit' | ''} */
let singletonCreatedBy = '';

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
			'Your options are ignored. Call connect() before using other client functions.'
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
			queueMicrotask(() => {
				statusUnsub?.();
				permaUnsub?.();
			});
		}

		statusUnsub = conn.status.subscribe((s) => {
			if (s === 'open') { cleanup(); resolve(); }
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
	const now = Date.now();
	for (const item of initial) {
		timestamps.set(keyOf(item), now);
	}

	const output = writable(list);
	/** @type {(() => void) | null} */
	let sourceUnsub = null;
	/** @type {ReturnType<typeof setInterval> | null} */
	let sweepTimer = null;
	let subCount = 0;

	function sweep() {
		const cutoff = Date.now() - /** @type {number} */ (maxAge);
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
			else timestamps.set(id, Date.now());
			list = applyCrudReducer(list, evt, data, arrayCrudStorage, reducerOpts);
			output.set(list);
		});
		sweepTimer = setInterval(sweep, Math.max(maxAge / 2, 1000));
	}

	function stop() {
		if (sourceUnsub) { sourceUnsub(); sourceUnsub = null; }
		if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
		list = [...initial];
		const now = Date.now();
		timestamps.clear();
		for (const item of initial) {
			timestamps.set(keyOf(item), now);
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
	const now = Date.now();
	for (const id in initialMap) {
		timestamps.set(id, now);
	}

	const output = writable(map);
	/** @type {(() => void) | null} */
	let sourceUnsub = null;
	/** @type {ReturnType<typeof setInterval> | null} */
	let sweepTimer = null;
	let subCount = 0;

	function sweep() {
		const cutoff = Date.now() - /** @type {number} */ (maxAge);
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
			else timestamps.set(id, Date.now());
			const next = applyCrudReducer(map, evt, data, recordCrudStorage, reducerOpts);
			if (next === map) return;
			map = next;
			output.set(map);
		});
		// Sweep at half the maxAge interval for responsive cleanup
		// without burning cycles on very short intervals
		sweepTimer = setInterval(sweep, Math.max(maxAge / 2, 1000));
	}

	function stop() {
		if (sourceUnsub) { sourceUnsub(); sourceUnsub = null; }
		if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
		map = { ...initialMap };
		const now = Date.now();
		timestamps.clear();
		for (const id in initialMap) {
			timestamps.set(id, now);
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
			if (timer) clearTimeout(timer);
			queueMicrotask(() => unsub());
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
			timer = setTimeout(() => {
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

/**
 * Compute the next reconnect delay using exponential backoff with
 * proportional jitter.
 *
 * The capped delay is `min(base * 2.2^attempt, maxDelay)`. A random factor
 * in `[0.75, 1.25]` is then applied multiplicatively, so the final delay
 * spans +/- 25% of the capped value. Multiplicative jitter keeps spread
 * meaningful at high attempt counts: with 10K clients all reconnecting
 * after a server restart, additive +/- 500ms jitter clusters reconnects
 * inside a 1 second window; proportional jitter spreads them across
 * a window proportional to the current backoff.
 *
 * The 2.2 exponent with a 5 minute cap is aggressive enough to back off
 * fast under sustained server pain (the default 3 second base hits the
 * cap by attempt 6) and gentle enough that a brief restart resolves
 * before the user notices.
 *
 * Pure: no I/O, no globals. Pass a deterministic `randFactor` for
 * reproducible assertions in tests.
 *
 * @param {number} base       base interval in ms (e.g. 3000)
 * @param {number} maxDelay   cap in ms (e.g. 300000)
 * @param {number} attempt    zero-based attempt counter
 * @param {number} [randFactor]  random factor in [0, 1); defaults to Math.random()
 * @returns {number}
 */
export function nextReconnectDelay(base, maxDelay, attempt, randFactor = Math.random()) {
	const capped = Math.min(base * Math.pow(2.2, attempt), maxDelay);
	return capped * (0.75 + randFactor * 0.5);
}

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

	/** @type {ReturnType<typeof setTimeout> | null} */
	let reconnectTimer = null;
	/** @type {ReturnType<typeof setInterval> | null} */
	let activityTimer = null;

	/** @type {Promise<boolean> | null} deduped in-flight auth preflight */
	let authInFlight = null;

	let attempt = 0;
	let intentionallyClosed = false;
	// Set when the server permanently rejects us (terminal close code) or when
	// retries are exhausted. Distinct from intentionallyClosed (user-initiated).
	// Both prevent the visibility handler from triggering a reconnect.
	let terminalClosed = false;
	// Set when the page is hidden  - signals that the next disconnect may be
	// browser-initiated and should reconnect immediately when the tab resumes.
	let hiddenDisconnect = false;
	// Timestamp of the last message received from the server. Used to detect
	// zombie connections  - cases where onclose was suppressed by browser throttling.
	let lastServerMessage = Date.now();
	// 2.5x the server's 120s idle timeout. If the server has been completely
	// silent for this long while the socket appears open, it is likely a zombie.
	const SERVER_TIMEOUT_MS = 150000;

	/** @type {Set<string>} */
	const subscribedTopics = new Set();

	/** @type {Map<string, number>} */
	const topicRefCounts = new Map();

	// Highest seq seen per topic. Sent back to the server on reconnect via
	// the resume frame so the user's resume hook can replay anything we
	// missed during the disconnect window. Only topics that the server is
	// stamping with seq end up here; opted-out topics ({ seq: false }) are
	// skipped.
	/** @type {Map<string, number>} */
	const lastSeenSeqs = new Map();

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
	 * @returns {Promise<'ok' | 'unauthorized' | 'transient'>}
	 */
	function runAuth() {
		if (!authPath) return Promise.resolve('ok');
		if (authInFlight) return authInFlight;
		const target = getAuthUrl();
		if (!target) return Promise.resolve('ok');

		authInFlight = (async () => {
			try {
				const resp = await fetch(target, {
					method: 'POST',
					credentials: 'include',
					headers: { 'x-requested-with': 'svelte-adapter-uws' }
				});
				if (debug) console.log('[ws] auth preflight status=%d', resp.status);
				if (resp.ok) return 'ok';
				if (resp.status >= 400 && resp.status < 500) return 'unauthorized';
				return 'transient';
			} catch (err) {
				if (debug) console.warn('[ws] auth preflight network error:', err);
				return 'transient';
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
			runAuth().then((outcome) => {
				if (intentionallyClosed || terminalClosed) return;
				if (outcome === 'unauthorized') {
					// Server rejected the request with a 4xx. The user is not
					// authenticated and retrying won't help until they log in.
					if (debug) console.warn('[ws] auth preflight rejected (4xx), not opening WebSocket');
					statusStore.set('closed');
					terminalClosed = true;
					permaClosedStore.set(true);
					return;
				}
				if (outcome === 'transient') {
					// Network error or 5xx. Retry via the normal backoff loop so
					// the preflight automatically re-runs on the next attempt.
					if (debug) console.warn('[ws] auth preflight transient failure, scheduling reconnect');
					statusStore.set('closed');
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

		ws.onopen = () => {
			attempt = 0;
			lastServerMessage = Date.now();
			statusStore.set('open');
			if (debug) console.log('[ws] connected');

			// If we have a previous session id and any tracked seqs, ask the
			// server to fill the gap before we resubscribe. The server's
			// resume hook is what actually replays; if no hook is wired, the
			// server just acks with { type: 'resumed' } and we fall through
			// to subscribe-batch + live mode (same as a cold connect). The
			// resume frame is sent before subscribe-batch so any replayed
			// frames arrive ahead of the first live frames.
			const prevSessionId = storedSessionId();
			if (prevSessionId && lastSeenSeqs.size > 0) {
				const seqs = {};
				for (const [topic, seq] of lastSeenSeqs) seqs[topic] = seq;
				if (debug) console.log('[ws] resume sessionId=%s seqs=%o', prevSessionId, seqs);
				ws?.send(JSON.stringify({ type: 'resume', sessionId: prevSessionId, lastSeenSeqs: seqs }));
			}

			// Batch resubscriptions into subscribe-batch messages. The server
			// caps each batch at 256 topics and only parses control messages
			// under 8192 bytes, so we chunk to stay within both limits.
			if (subscribedTopics.size > 0) {
				const allTopics = [...subscribedTopics];
				const encoder = new TextEncoder();
				const ENVELOPE_BYTES = 39; // '{"type":"subscribe-batch","topics":[]}'
				const MAX_BYTES = 8000; // under 8192 server ceiling
				const MAX_TOPICS = 200; // under 256 server cap
				let chunk = [];
				let chunkBytes = ENVELOPE_BYTES;
				for (const t of allTopics) {
					const entryBytes = encoder.encode(JSON.stringify(t)).length + 1;
					if (chunk.length > 0 && (chunk.length >= MAX_TOPICS || chunkBytes + entryBytes > MAX_BYTES)) {
						if (debug) console.log('[ws] resubscribe-batch ->', chunk);
						ws?.send(JSON.stringify({ type: 'subscribe-batch', topics: chunk }));
						chunk = [];
						chunkBytes = ENVELOPE_BYTES;
					}
					chunk.push(t);
					chunkBytes += entryBytes;
				}
				if (chunk.length > 0) {
					if (debug) console.log('[ws] resubscribe-batch ->', chunk);
					ws?.send(JSON.stringify({ type: 'subscribe-batch', topics: chunk }));
				}
			}

			// Flush queued messages
			while (sendQueue.length > 0) {
				const msg = sendQueue.shift();
				if (debug) console.log('[ws] flush ->', msg);
				ws?.send(/** @type {string} */ (msg));
			}
		};

		ws.onmessage = (rawEvent) => {
			lastServerMessage = Date.now();
			try {
				// Reject oversized messages to prevent main-thread blocking
				if (typeof rawEvent.data === 'string' && rawEvent.data.length > 1048576) {
					if (debug) console.warn('[ws] message too large, dropped:', rawEvent.data.length, 'bytes');
					return;
				}
				const msg = JSON.parse(rawEvent.data);
				if (msg.topic && msg.event !== undefined) {
					/** @type {import('./client.js').WSEvent} */
					const wsEvent = { topic: msg.topic, event: msg.event, data: msg.data };
					if (debug) console.log('[ws] <-', msg.topic, msg.event, msg.data);

					// Track the highest seq we have seen per topic so we can
					// present it back on the next reconnect via the resume
					// frame. Server may opt out of seq stamping per call.
					if (typeof msg.seq === 'number') {
						const prev = lastSeenSeqs.get(msg.topic);
						if (prev === undefined || msg.seq > prev) lastSeenSeqs.set(msg.topic, msg.seq);
					}

					// Update global events store
					eventsStore.set(wsEvent);

					// Update topic-level store
					const tStore = topicStores.get(msg.topic);
					if (tStore) tStore.set(wsEvent);

					// Update topic+event filtered stores (wrapped for unique reference)
					const eStore = eventStores.get(`${msg.topic}\0${msg.event}`);
					if (eStore) eStore.set({ data: msg.data });
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
			} catch {
				// Not a valid envelope - ignore
			}
		};

		ws.onclose = (event) => {
			statusStore.set('closed');
			ws = null;
			if (debug) console.log('[ws] disconnected');
			if (intentionallyClosed) return;

			const cls = classifyCloseCode(event?.code);
			if (cls === 'TERMINAL') {
				// Server has permanently rejected this client  - do not retry.
				// Use ws.close(4401) or ws.close(1008) on the server when credentials
				// are invalid or the connection is forbidden, to stop the retry loop.
				if (debug) console.warn('[ws] connection permanently closed by server (code ' + event?.code + ')');
				terminalClosed = true;
				permaClosedStore.set(true);
				return;
			}

			if (cls === 'THROTTLE') {
				// Jump ahead in the backoff curve to avoid hammering a rate-limited server.
				attempt = Math.max(attempt, 5);
			}

			scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose fires after this - reconnect is handled there
		};
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		if (attempt >= maxReconnectAttempts) {
			statusStore.set('closed');
			terminalClosed = true;
			permaClosedStore.set(true);
			return;
		}
		const delay = nextReconnectDelay(reconnectInterval, maxReconnectInterval, attempt);
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
			queueMicrotask(() => {
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
			queueMicrotask(() => {
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
				console.warn('[ws] queue full (' + MAX_QUEUE_SIZE + '), dropping oldest message');
				sendQueue.shift();
			}
			if (debug) console.log('[ws] queued ->', data);
			sendQueue.push(JSON.stringify(data));
		}
	}

	/**
	 * Close the connection permanently.
	 */
	/** @type {(() => void) | null} */
	let visibilityHandler = null;

	function close() {
		intentionallyClosed = true;
		permaClosedStore.set(true);
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (activityTimer) {
			clearInterval(activityTimer);
			activityTimer = null;
		}
		if (visibilityHandler && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', visibilityHandler);
			visibilityHandler = null;
		}
		ws?.close();
		ws = null;
		singleton = null;
		singletonCreatedBy = '';
		statusStore.set('closed');
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
			} else if (!intentionallyClosed && !terminalClosed && (hiddenDisconnect || !ws || ws.readyState !== WebSocket.OPEN)) {
				hiddenDisconnect = false;
				attempt = 0;
				if (reconnectTimer) {
					clearTimeout(reconnectTimer);
					reconnectTimer = null;
				}
				doConnect();
			}
		};
		document.addEventListener('visibilitychange', visibilityHandler);
	}

	// Zombie connection detection: check every 30s whether the server has gone
	// completely silent. If so, the connection is likely a zombie (server dropped
	// us but the client's onclose was suppressed by browser throttling  - common
	// on mobile after wake from sleep). Force a close so onclose fires and the
	// normal reconnect path takes over.
	if (typeof window !== 'undefined') {
		activityTimer = setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN && Date.now() - lastServerMessage > SERVER_TIMEOUT_MS) {
				if (debug) console.log('[ws] server silent for', Date.now() - lastServerMessage, 'ms, reconnecting');
				ws.close();
			}
		}, 30000);
	}

	return {
		events: { subscribe: eventsStore.subscribe },
		status: { subscribe: statusStore.subscribe },
		_permaClosed: { subscribe: permaClosedStore.subscribe },
		_hasUrl: !!url,
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
