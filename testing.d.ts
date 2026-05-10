import type { WebSocket } from 'uWebSockets.js';
import type { Platform, WebSocketHandler, UpgradeContext } from './index.js';

export interface TestServerOptions {
	/** Port to listen on. Defaults to 0 (random available port). */
	port?: number;
	/** WebSocket endpoint path. @default '/ws' */
	wsPath?: string;
	/** WebSocket handler hooks (same shape as hooks.ws.ts exports). */
	handler?: Partial<WebSocketHandler>;
	/**
	 * Two-layer admission control on the WebSocket upgrade path. Same
	 * wiring as the production handler's `wsOptions.upgradeAdmission`
	 * setting. Both layers are opt-in; both default to disabled (`0`).
	 *
	 * - `maxConcurrent` caps how many upgrades may be in flight at once.
	 *   Crossed requests get a fast `503 Service Unavailable` before
	 *   any per-request work (no header walk, no cookie parsing).
	 * - `perTickBudget` caps how many `res.upgrade()` calls run per
	 *   event-loop tick. Once spent, subsequent calls are deferred via
	 *   `setImmediate`.
	 *
	 * Useful in integration tests that want to assert the admission
	 * shed-shape under a real connection storm without booting a full
	 * SvelteKit app. Production users configure the same options via
	 * `adapter({ websocket: { upgradeAdmission: { ... } } })`.
	 */
	upgradeAdmission?: {
		maxConcurrent?: number;
		perTickBudget?: number;
	};
}

/**
 * Chaos / fault-injection scenario passed to `platform.__chaos`.
 *
 * Continuous scenarios (consulted on every outbound frame):
 * - `'drop-outbound'` discards outbound frames before they reach the wire
 *   with the configured `dropRate` (a probability in [0, 1]).
 * - `'slow-drain'` defers outbound frames by `delayMs` milliseconds via
 *   `setTimeout`. Order is preserved (every frame waits the same delay).
 * - `'ipc-reorder'` defers each outbound frame by an independently-random
 *   delay in `[0, maxJitterMs)`. Adjacent frames can arrive out of order,
 *   simulating cross-worker relay reordering or queue jitter. Use to
 *   verify protocol code (seq gap detection, idempotency keys, resume
 *   tokens) handles disordered delivery. `maxJitterMs` is capped at
 *   60_000 ms.
 *
 * One-shot trigger (does NOT change continuous chaos state):
 * - `'worker-flap'` closes every currently-live WebSocket connection
 *   with the configured `code` (default `1012`) and `reason` (default
 *   `'worker restart'`). The server stays alive and accepts new
 *   connections. Use to verify clients reconnect and resume correctly
 *   after a worker process restart in cluster mode.
 *
 * Pass `null` (or call with no argument) to clear the active continuous
 * scenario; the harness returns to its zero-overhead fast paths.
 *
 * **Scope.** This is a WebSocket-frame outbound chokepoint. It intercepts
 * what the test harness sends to its connected WS clients - every frame
 * routed through `sendOutboundT` (`platform.publish`, `platform.send`,
 * `platform.sendTo`, `platform.request`, the welcome envelope, subscribe
 * acks, the resumed ack). It does NOT cover transport-level traffic
 * outside the harness: an ioredis client, a pg connection, a NATS
 * subscription, or any backend you've wired up alongside the adapter
 * stays untouched. For cross-wire fault injection, wrap the transport
 * client at the integration layer using the same `createChaosState`
 * factory exported from `svelte-adapter-uws/testing` - see the README
 * "Wrap your own transport for cross-wire chaos" pattern.
 */
export type ChaosScenario =
	| { scenario: 'drop-outbound'; dropRate: number }
	| { scenario: 'slow-drain'; delayMs: number }
	| { scenario: 'ipc-reorder'; maxJitterMs: number }
	| { scenario: 'worker-flap'; code?: number; reason?: string };

/**
 * Platform exposed by `createTestServer`. Adds the `__chaos` fault-injection
 * setter on top of the production `Platform` surface. Tests can use the
 * harness to simulate broken-network conditions while exercising protocol
 * code (subscribe acks, session resume, sendCoalesced under backpressure,
 * request/reply timeouts, etc).
 */
export interface TestPlatform extends Platform {
	/**
	 * Activate or clear a chaos / fault-injection scenario. Pass `null`
	 * to reset; the harness returns to its zero-overhead fast paths.
	 *
	 * Scope is the WS-frame outbound chokepoint inside the test harness;
	 * see the `ChaosScenario` JSDoc for what is and is not covered.
	 *
	 * @example
	 * ```js
	 * server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 0.5 });
	 * // ... assert client recovers from 50% packet loss ...
	 * server.platform.__chaos(null);
	 * ```
	 */
	__chaos(cfg: ChaosScenario | null): void;
}

export interface TestServer {
	/** HTTP URL of the test server (e.g. 'http://localhost:12345'). */
	url: string;
	/** WebSocket URL of the test server (e.g. 'ws://localhost:12345/ws'). */
	wsUrl: string;
	/** The port the server is listening on. */
	port: number;
	/** Platform API for publishing, sending, and querying connections. */
	platform: TestPlatform;
	/**
	 * Live set of currently connected uWS WebSocket instances. Useful in
	 * tests that need to call `platform.request(ws, ...)` or otherwise
	 * target a specific connection.
	 */
	wsConnections: Set<import('uWebSockets.js').WebSocket<any>>;
	/** Stop the server and close all connections. */
	close(): void;
	/** Wait for a WebSocket client to connect. */
	waitForConnection(timeout?: number): Promise<void>;
	/** Wait for the next WebSocket message (after subscribe/unsubscribe handling). */
	waitForMessage(timeout?: number): Promise<{ data: string; isBinary: boolean }>;
}

/**
 * Create a lightweight test server backed by a real uWebSockets.js instance.
 *
 * Starts on a random port and provides a Platform-compatible API for
 * publishing, sending, and asserting on WebSocket behavior. The server
 * uses the same subscribe/unsubscribe protocol as the production handler.
 *
 * @example
 * ```js
 * import { createTestServer } from 'svelte-adapter-uws/testing';
 * import { describe, it, expect, afterEach } from 'vitest';
 *
 * let server;
 * afterEach(() => server?.close());
 *
 * it('rejects unauthenticated upgrades', async () => {
 *   server = await createTestServer({
 *     handler: {
 *       upgrade({ cookies }) {
 *         return cookies.session ? { id: 'user-1' } : false;
 *       }
 *     }
 *   });
 *
 *   const res = await fetch(server.wsUrl, {
 *     headers: { upgrade: 'websocket', connection: 'upgrade' }
 *   });
 *   expect(res.status).toBe(401);
 * });
 *
 * it('broadcasts to subscribers', async () => {
 *   server = await createTestServer();
 *   const ws = new WebSocket(server.wsUrl);
 *   await server.waitForConnection();
 *
 *   ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat' }));
 *   // small delay for subscribe to process
 *   await new Promise(r => setTimeout(r, 10));
 *
 *   server.platform.publish('chat', 'new-message', { text: 'hello' });
 *   const msg = await server.waitForMessage();
 *   expect(JSON.parse(msg.data)).toMatchObject({
 *     topic: 'chat', event: 'new-message', data: { text: 'hello' }
 *   });
 * });
 * ```
 */
export function createTestServer(options?: TestServerOptions): Promise<TestServer>;

// - Re-exported pure helpers -----------------------------------------------
// Curated for downstream test code asserting on wire shape, userData
// state, or chaos / fault-injection behavior. Production-internal helpers
// (mime lookup, byte parsing, sampler internals) deliberately stay
// unexported so the test surface can evolve without churning production.

/**
 * JSON-quote a topic or event name for use inside a wire envelope. Throws
 * on control characters, double-quotes, or backslashes - the same
 * validation the production handler enforces. Pure.
 */
export function esc(s: string): string;

/**
 * Append the JSON-encoded `data` (and optional `seq`) plus the closing
 * brace to a prebuilt envelope prefix. Pairs with the wire shape
 * `{topic, event, data, seq?}`. When `seq` is `null` / `undefined` the
 * field is omitted entirely so the envelope matches the legacy
 * `{topic,event,data}` shape verbatim. Pure.
 */
export function completeEnvelope(prefix: string, data: unknown, seq?: number | null): string;

/**
 * Wrap an array of pre-built per-event envelope strings into a single
 * `{"type":"batch","events":[...]}` wire frame. Each input is a complete
 * `{topic, event, data, seq?}` envelope as produced by `completeEnvelope`.
 * The output is the wire format `platform.publishBatched` emits. Pure.
 */
export function wrapBatchEnvelope(eventEnvelopes: string[]): string;

/**
 * True if the topic name is safe to interpolate into a wire envelope:
 * no control characters, no quotes, no backslashes, max 256 chars.
 * Pure helper used to validate subscribe / unsubscribe inputs.
 */
export function isValidWireTopic(topic: unknown): boolean;

/**
 * Build a `TopicHelper`-shaped scoped publisher bound to a single topic.
 * Used internally by `platform.topic(name)`; useful in tests that want to
 * exercise the `created` / `updated` / `deleted` / `set` / `increment` /
 * `decrement` shorthands without going through a real platform. Pure.
 */
export function createScopedTopic(
	publish: (topic: string, event: string, data?: unknown) => unknown,
	name: string
): {
	publish(event: string, data?: unknown): void;
	created(data?: unknown): void;
	updated(data?: unknown): void;
	deleted(data?: unknown): void;
	set(value: number): void;
	increment(amount?: number): void;
	decrement(amount?: number): void;
};

/**
 * Collapse events that share a `coalesceKey` so only the latest value
 * survives, preserving the latest occurrence's position. Events without a
 * `coalesceKey` pass through unchanged. Pure helper that drives the
 * coalesce-by-key behavior of `platform.publishBatched`.
 */
export function collapseByCoalesceKey<T extends { coalesceKey?: string }>(messages: T[]): T[];

/**
 * Sanitize a possibly-present `X-Request-ID` header value into a value
 * safe to expose as `platform.requestId`. Returns `null` for absent /
 * empty / over-128-char / control-char inputs; trims and validates
 * printable-ASCII otherwise. Pure.
 */
export function resolveRequestId(value: string | undefined | null): string | null;

/**
 * Chaos / fault-injection state machine consulted by the test harness.
 * The `createTestServer` instance owns one of these; callers normally
 * drive it via `server.platform.__chaos(cfg)`. Exposed directly here for
 * tests that want a unit-level helper with deterministic RNG injection.
 */
export function createChaosState(opts?: { random?: () => number }): {
	readonly scenario: 'drop-outbound' | 'slow-drain' | 'ipc-reorder' | null;
	readonly dropRate: number;
	readonly delayMs: number;
	readonly maxJitterMs: number;
	/**
	 * Activate a continuous scenario (`drop-outbound`, `slow-drain`,
	 * `ipc-reorder`) or pass `null` to clear. The `worker-flap`
	 * one-shot trigger is NOT routed through here; it is handled by
	 * `platform.__chaos` directly inside the test server.
	 */
	set(cfg: Exclude<ChaosScenario, { scenario: 'worker-flap' }> | null): void;
	reset(): void;
	shouldDropOutbound(): boolean;
	getDelayMs(): number;
};

// - Per-connection userData slot constants ---------------------------------
// Symbol-keyed slots the adapter stamps on `ws.getUserData()` for its own
// per-connection bookkeeping. Tests asserting on connection state read
// userData via these to avoid coupling to Symbol identity tricks.
//
// `WS_REQUEST_ID_KEY` is a string (not a Symbol): uWebSockets.js strips
// Symbol-keyed properties from the userData object passed to
// `res.upgrade()`, so the upgrade->open carrier slot has to be a string
// key. The `open` hook moves the value into the Symbol-keyed
// `WS_PLATFORM` slot and deletes the string key, so test code reading
// userData after `open` should read `WS_PLATFORM`, not the string key.

/** Set of topics a connection is subscribed to. Stamped before `open` fires. */
export const WS_SUBSCRIPTIONS: unique symbol;

/** `Map<key, {topic,event,data}>` of pending `sendCoalesced` messages. Lazy. */
export const WS_COALESCED: unique symbol;

/** Per-connection session UUID. Stamped in `open` and announced to the client. */
export const WS_SESSION_ID: unique symbol;

/** `Map<ref, {resolve,reject,timer}>` of in-flight `platform.request()` promises. Lazy. */
export const WS_PENDING_REQUESTS: unique symbol;

/** Per-connection traffic counters. Only allocated when a `close` hook is registered. */
export const WS_STATS: unique symbol;

/** Per-connection `Platform` clone carrying the connection's `requestId`. */
export const WS_PLATFORM: unique symbol;

/** Set of capabilities the client advertised via `{type:'hello', caps:[...]}`. */
export const WS_CAPS: unique symbol;

/**
 * String key (not a Symbol) used to ferry the per-connection requestId
 * across the upgrade->open transition. uWebSockets.js strips Symbol keys
 * from the userData object handed to `res.upgrade()`, so the carrier has
 * to be a string. The `open` hook deletes this slot after promoting the
 * value into the `WS_PLATFORM` Symbol slot, so it never appears in
 * userData while a hook is running.
 */
export const WS_REQUEST_ID_KEY: '__adapter_uws_request_id__';
