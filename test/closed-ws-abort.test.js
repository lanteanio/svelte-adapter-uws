// Regression tests for the closed-WS race in platform.* methods.
//
// Background: uWS WebSocket methods (subscribe, unsubscribe, send,
// getUserData, etc.) throw "Invalid access of closed uWS.WebSocket"
// when called on a freed native handle. Under churn (mass-connect
// kernel/uWS backpressure, mid-async-setup tab close) the platform's
// ws-targeted methods routinely run after the underlying socket has
// closed - via a captured `ws` reference held over an `await`.
//
// The platform contract is: every ws-targeted public method
// (subscribe, unsubscribe, send, sendCoalesced, sendTo, request) and
// the wire-level subscribe / subscribe-batch handlers swallow the
// uWS exception, bump `platform.closedWsAborts`, and return a
// success-shaped no-op sentinel. Plugin and user code can fire-and-
// forget without per-site try/catch.
//
// These tests cover the deterministic case: take a known-good ws,
// close it, wait for the close event to land, then call each
// platform method on the now-stale reference. The race-during-await
// case is harder to make deterministic but reduces to the same code
// path - if these pass, the race is also safe.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return ws;
}

// Open a client, capture the server-side ws, then close the client and
// wait until uWS has fired its close event (which is what flips the
// native handle to "invalid access throws" mode). Returns the stale
// server-side ws reference for the test to abuse.
async function captureClosedServerWs(handler) {
	let captured = null;
	let closedFired = false;
	const onClosePromise = new Promise((resolve) => {
		const userClose = handler.close;
		handler.close = (ws, code, message) => {
			closedFired = true;
			userClose?.(ws, code, message);
			resolve();
		};
	});

	const { createTestServer } = await import('../src/testing.js');
	server = await createTestServer({
		handler: {
			...handler,
			open(ws) {
				captured = ws;
				handler.open?.(ws);
			}
		}
	});

	const client = await connectClient(server.wsUrl);
	// Wait for the open event to populate `captured`.
	while (captured === null) await new Promise(r => setTimeout(r, 5));
	client.close();
	await onClosePromise;
	// One extra tick to let uWS finalize internal cleanup so subsequent
	// method calls on `captured` reliably throw "Invalid access".
	await new Promise(r => setTimeout(r, 10));
	expect(closedFired).toBe(true);
	return captured;
}

describeUWS('closed-WS race: platform methods do not throw on freed sockets', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('platform.subscribe returns null and bumps closedWsAborts on closed WS', async () => {
		const staleWs = await captureClosedServerWs({});
		const before = server.platform.closedWsAborts;

		const result = await server.platform.subscribe(staleWs, 'feed');

		expect(result).toBeNull();
		expect(server.platform.closedWsAborts).toBeGreaterThan(before);
	});

	it('platform.subscribe handles WS that closes DURING the async hook gate', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let captured = null;
		let releaseGate;
		const gateHeld = new Promise((resolve) => { releaseGate = resolve; });

		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				async subscribe() {
					// Block the gate until the test releases it. This
					// reproduces the production scenario where a server-
					// side caller has invoked platform.subscribe with a
					// live ws, the subscribe hook is awaiting (auth,
					// session lookup, RPC handshake), and the client
					// closes the socket during the wait.
					await gateHeld;
					return undefined;
				}
			}
		});

		const client = await connectClient(server.wsUrl);
		while (captured === null) await new Promise(r => setTimeout(r, 5));

		// Fire platform.subscribe but do not await yet. The hook is now
		// awaiting `gateHeld`.
		const subscribePromise = server.platform.subscribe(captured, 'feed');

		// Close the client. Wait long enough for uWS to fire the close
		// event and free the native handle.
		client.close();
		await new Promise(r => setTimeout(r, 50));

		const before = server.platform.closedWsAborts;
		// Now release the gate. The platform.subscribe continuation
		// will try ws.subscribe() on the freed handle - this is the
		// exact crash path the demo's joinBoard RPC hit at 1000-cursor
		// load. With the fix, it returns null and bumps the counter.
		releaseGate();

		const result = await subscribePromise;
		expect(result).toBeNull();
		expect(server.platform.closedWsAborts).toBeGreaterThan(before);
	});

	it('platform.send returns DROPPED (2) and bumps closedWsAborts on closed WS', async () => {
		const staleWs = await captureClosedServerWs({});
		const before = server.platform.closedWsAborts;

		const result = server.platform.send(staleWs, 'feed', 'tick', { v: 1 });

		expect(result).toBe(2);
		expect(server.platform.closedWsAborts).toBeGreaterThan(before);
	});

	it('platform.unsubscribe returns false and bumps closedWsAborts on a previously-subscribed closed WS', async () => {
		// uWS's `getUserData()` does not always throw on closed sockets
		// (the JS-side userData object survives the native handle), so
		// the bump fires from the actual `ws.unsubscribe()` call. That
		// only runs when the subscription was present at close time.
		const { createTestServer } = await import('../src/testing.js');
		let captured = null;
		server = await createTestServer({
			handler: { open(ws) { captured = ws; } }
		});
		const client = await connectClient(server.wsUrl);
		while (captured === null) await new Promise(r => setTimeout(r, 5));

		// Subscribe BEFORE close so unsubscribe has work to do.
		expect(await server.platform.subscribe(captured, 'feed')).toBeNull();
		const before = server.platform.closedWsAborts;

		client.close();
		await new Promise(r => setTimeout(r, 30));

		const result = server.platform.unsubscribe(captured, 'feed');
		expect(result).toBe(false);
		expect(server.platform.closedWsAborts).toBeGreaterThan(before);
	});

	it('platform.request rejects with "connection closed" and bumps closedWsAborts', async () => {
		const staleWs = await captureClosedServerWs({});
		const before = server.platform.closedWsAborts;

		await expect(server.platform.request(staleWs, 'ping', null))
			.rejects.toThrow(/connection closed/);
		expect(server.platform.closedWsAborts).toBeGreaterThan(before);
	});

	it('closedWsAborts is monotonic across send + subscribe aborts on the same WS', async () => {
		const staleWs = await captureClosedServerWs({});
		const before = server.platform.closedWsAborts;

		// Each ws-touching call on a stale handle should bump exactly
		// once. subscribe and send both reach a uWS native call that
		// throws; the increments must compose monotonically.
		await server.platform.subscribe(staleWs, 't1');
		const aSub = server.platform.closedWsAborts;
		expect(aSub).toBeGreaterThan(before);

		server.platform.send(staleWs, 't1', 'e', null);
		const aSend = server.platform.closedWsAborts;
		expect(aSend).toBeGreaterThan(aSub);
	});
});
