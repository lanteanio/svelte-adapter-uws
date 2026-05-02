import type { WebSocket } from 'uWebSockets.js';
import type { Platform, WebSocketHandler, UpgradeContext } from './index.js';

export interface TestServerOptions {
	/** Port to listen on. Defaults to 0 (random available port). */
	port?: number;
	/** WebSocket endpoint path. @default '/ws' */
	wsPath?: string;
	/** WebSocket handler hooks (same shape as hooks.ws.ts exports). */
	handler?: Partial<WebSocketHandler>;
}

/**
 * Chaos / fault-injection scenario passed to `platform.__chaos`.
 *
 * - `'drop-outbound'` discards outbound frames before they reach the wire
 *   with the configured `dropRate` (a probability in [0, 1]).
 * - `'slow-drain'` defers outbound frames by `delayMs` milliseconds via
 *   `setTimeout`, simulating a slow consumer or congested network.
 *
 * Pass `null` (or call with no argument) to clear the active scenario;
 * the harness returns to its zero-overhead fast paths.
 */
export type ChaosScenario =
	| { scenario: 'drop-outbound'; dropRate: number }
	| { scenario: 'slow-drain'; delayMs: number };

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
