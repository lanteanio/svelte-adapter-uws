// Every app hook (open, message, drain, close, unsubscribe) is called from a
// transport callback, or from platform.unsubscribe, that never awaits it. A
// throw out of a uWS callback is an uncaughtException and a rejected promise
// from an async hook is an unhandled rejection; under Node's default policy
// either one exits the whole process.
// The boundary in files/utils.js contains both. The unit cases pin the
// boundary itself with a fake socket; the real-server cases pin what a
// failure costs on a live uWebSockets.js server: at most the connection whose
// hook failed.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

function fakeWs() {
	/** @type {Array<[number, string]>} */
	const ends = [];
	return {
		ends,
		end(code, reason) {
			ends.push([code, reason]);
		}
	};
}

/** Let a rejection reach its handler. */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** The captured reports as "<line> <message>" strings, for exact comparison. */
function reports(spy) {
	return spy.mock.calls.map((c) => String(c[0]) + ' ' + String(c[1] && c[1].message !== undefined ? c[1].message : c[1]));
}

describe('runHook and runUnsubscribeHook', () => {
	let runHook;
	let runUnsubscribeHook;
	/** @type {import('vitest').MockInstance} */
	let errorSpy;

	beforeAll(async () => {
		// Imported here rather than at the top so the real-server cases below
		// still load against a files/utils.js that has no boundary.
		({ runHook, runUnsubscribeHook } = await import('../files/utils.js'));
	});

	beforeEach(() => {
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
	});

	it('does nothing for a missing hook', () => {
		const ws = fakeWs();
		runHook({}, 'open', 'Open handler error', ws, {});
		runHook({ open: null }, 'open', 'Open handler error', ws, {});
		runUnsubscribeHook({}, ws, 'topic', {});
		expect(ws.ends).toEqual([]);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('calls the hook as a method of its owner, passes ws and ctx through, and does not await', async () => {
		const ws = fakeWs();
		const ctx = { platform: {} };
		/** @type {unknown[]} */
		const seen = [];
		let resolveLater;
		const pending = new Promise((resolve) => { resolveLater = resolve; });
		const owner = {
			open(w, c) {
				seen.push(this, w, c);
				return pending;
			},
			message() {
				return 42;
			}
		};
		const returned = runHook(owner, 'open', 'Open handler error', ws, ctx);
		expect(returned).toBeUndefined();
		expect(seen).toEqual([owner, ws, ctx]);
		runHook(owner, 'message', 'Message handler error', ws, ctx);
		resolveLater();
		await flush();
		expect(ws.ends).toEqual([]);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('reports a synchronous throw once and closes the connection with 1011', () => {
		const ws = fakeWs();
		const err = new Error('open boom');
		runHook({ open() { throw err; } }, 'open', 'Open handler error', ws, {});
		expect(ws.ends).toEqual([[1011, 'Open handler error']]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith('[ws] open hook threw:', err);
	});

	it('reports a rejected promise once and closes the connection with 1011', async () => {
		const ws = fakeWs();
		const err = new Error('message boom');
		runHook({ async message() { throw err; } }, 'message', 'Message handler error', ws, {});
		expect(ws.ends).toEqual([]);
		await flush();
		expect(ws.ends).toEqual([[1011, 'Message handler error']]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith('[ws] message hook threw:', err);
	});

	it('contains a returned thenable whose then throws', () => {
		const ws = fakeWs();
		const err = new Error('hostile then');
		runHook({ drain() { return { then() { throw err; } }; } }, 'drain', 'Drain handler error', ws, {});
		expect(ws.ends).toEqual([[1011, 'Drain handler error']]);
		expect(errorSpy).toHaveBeenCalledWith('[ws] drain hook threw:', err);
	});

	it('only reports when the close reason is null', async () => {
		const ws = fakeWs();
		const err = new Error('close boom');
		runHook({ close() { throw err; } }, 'close', null, ws, {});
		runHook({ async close() { throw err; } }, 'close', null, ws, {});
		await flush();
		expect(ws.ends).toEqual([]);
		expect(errorSpy).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenNthCalledWith(1, '[ws] close hook threw:', err);
	});

	it('swallows a ws.end that throws because the socket is already closed', () => {
		const ws = {
			end() { throw new Error('Invalid access of closed uWS.WebSocket'); }
		};
		const err = new Error('late');
		expect(() => runHook({ open() { throw err; } }, 'open', 'Open handler error', ws, {})).not.toThrow();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith('[ws] open hook threw:', err);
	});

	it('reports a present export that is not a function instead of crashing', () => {
		const ws = fakeWs();
		runHook({ open: /** @type {any} */ (5) }, 'open', 'Open handler error', ws, {});
		expect(ws.ends).toEqual([[1011, 'Open handler error']]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toBe('[ws] open hook threw:');
		expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(TypeError);
	});

	it('runUnsubscribeHook passes the topic, keeps this, reports a throw or rejection, and never closes', async () => {
		const ws = fakeWs();
		const ctx = { platform: {} };
		/** @type {unknown[]} */
		const seen = [];
		const owner = {
			unsubscribe(w, t, c) {
				seen.push(this, w, t, c);
			}
		};
		runUnsubscribeHook(owner, ws, 'room:1', ctx);
		expect(seen).toEqual([owner, ws, 'room:1', ctx]);
		const err = new Error('unsub boom');
		runUnsubscribeHook({ unsubscribe() { throw err; } }, ws, 'room:1', ctx);
		runUnsubscribeHook({ async unsubscribe() { throw err; } }, ws, 'room:2', ctx);
		await flush();
		expect(ws.ends).toEqual([]);
		expect(errorSpy).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenNthCalledWith(1, '[ws] unsubscribe hook threw:', err);
		expect(errorSpy).toHaveBeenNthCalledWith(2, '[ws] unsubscribe hook threw:', err);
	});
});

describeUWS('hook failures on a real server', () => {
	let server;
	/** @type {import('vitest').MockInstance} */
	let errorSpy;
	/** @type {any[]} */
	let clients = [];

	beforeEach(() => {
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		for (const c of clients) {
			try { c.terminate(); } catch {}
		}
		clients = [];
		server?.close();
		server = null;
		errorSpy.mockRestore();
	});

	async function connect(url) {
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(url);
		clients.push(ws);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('connect timed out')), 3000);
			ws.on('open', () => { clearTimeout(timer); resolve(undefined); });
			ws.on('error', (err) => { clearTimeout(timer); reject(err); });
		});
		return ws;
	}

	/** Resolves with the close code the client reads. */
	function closeCode(ws) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no close frame')), 3000);
			ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
		});
	}

	/** Resolves with the first JSON message matching the predicate. */
	function waitFor(ws, predicate, timeoutMs = 3000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.off('message', handler);
				reject(new Error('timed out waiting for a message'));
			}, timeoutMs);
			function handler(raw) {
				let msg;
				try { msg = JSON.parse(raw.toString()); } catch { return; }
				if (predicate(msg)) {
					clearTimeout(timer);
					ws.off('message', handler);
					resolve(msg);
				}
			}
			ws.on('message', handler);
		});
	}

	async function subscribed(ws, topic, ref) {
		const ack = waitFor(ws, (m) => m.type === 'subscribed' && m.topic === topic && m.ref === ref);
		ws.send(JSON.stringify({ type: 'subscribe', topic, ref }));
		return ack;
	}

	/** Poll until the server's connection count reaches n. */
	async function connectionsSettle(n) {
		for (let i = 0; i < 40; i++) {
			if (server.platform.connections === n) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(server.platform.connections).toBe(n);
	}

	/** Poll until at least n reports have been captured. */
	async function reportsSettle(n) {
		for (let i = 0; i < 40; i++) {
			if (errorSpy.mock.calls.length >= n) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(n);
	}

	it('a throwing open hook closes that connection with 1011 and the next connection is served', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				upgrade({ url }) {
					return { boom: url.includes('boom=1') };
				},
				open(ws) {
					if (ws.getUserData().boom) throw new Error('open boom');
				}
			}
		});

		const victim = await connect(server.wsUrl + '?boom=1');
		expect(await closeCode(victim)).toBe(1011);
		expect(reports(errorSpy)).toEqual(['[ws] open hook threw: open boom']);

		const next = await connect(server.wsUrl);
		await subscribed(next, 'news', 1);
		await connectionsSettle(1);
	});

	it('an async open hook that rejects after the client has gone is contained and the server keeps serving', async () => {
		const { createTestServer } = await import('../testing.js');
		let releaseHook;
		const clientGone = new Promise((resolve) => { releaseHook = resolve; });
		let hookRan = 0;
		server = await createTestServer({
			handler: {
				upgrade({ url }) {
					return { late: url.includes('late=1') };
				},
				async open(ws) {
					// Only the connection under test awaits; the follow-up
					// connection's hook returns at once so nothing is pending when
					// this case tears down.
					if (!ws.getUserData().late) return;
					hookRan++;
					// Released by the case once the server has seen the client
					// leave. The call on the freed handle then throws "Invalid
					// access of closed uWS.WebSocket"; left unhandled, that
					// rejection exits the process under Node's default policy.
					await clientGone;
					ws.send('late');
				}
			}
		});

		const early = await connect(server.wsUrl + '?late=1');
		early.terminate();
		await connectionsSettle(0);
		releaseHook();
		await reportsSettle(1);

		expect(hookRan).toBe(1);
		expect(errorSpy.mock.calls[0][0]).toBe('[ws] open hook threw:');
		expect(String(errorSpy.mock.calls[0][1])).toContain('Invalid access of closed uWS.WebSocket');

		const next = await connect(server.wsUrl);
		await subscribed(next, 'news', 1);
		expect(server.platform.connections).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it('a present open export that is not a function costs that connection a 1011 and is reported as a TypeError', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: { open: /** @type {any} */ (5) }
		});

		const victim = await connect(server.wsUrl);
		expect(await closeCode(victim)).toBe(1011);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toBe('[ws] open hook threw:');
		expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(TypeError);

		const next = await connect(server.wsUrl);
		expect(await closeCode(next)).toBe(1011);
		expect(errorSpy).toHaveBeenCalledTimes(2);
	});

	it('a throwing message hook closes only that connection; a bystander keeps receiving', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				message(ws, { data }) {
					if (Buffer.from(data).toString() === 'boom') throw new Error('message boom');
				}
			}
		});

		const bystander = await connect(server.wsUrl);
		await subscribed(bystander, 'news', 1);
		const victim = await connect(server.wsUrl);
		await connectionsSettle(2);

		const closed = closeCode(victim);
		victim.send('boom');
		expect(await closed).toBe(1011);
		expect(reports(errorSpy)).toEqual(['[ws] message hook threw: message boom']);

		const delivered = waitFor(bystander, (m) => m.topic === 'news' && m.event === 'hello');
		server.platform.publish('news', 'hello', { after: 'boom' });
		expect((await delivered).data).toEqual({ after: 'boom' });
		await connectionsSettle(1);
	});

	it('a rejecting async message hook costs the same single connection', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				async message(ws, { data }) {
					await Promise.resolve();
					if (Buffer.from(data).toString() === 'boom') throw new Error('async message boom');
				}
			}
		});

		const bystander = await connect(server.wsUrl);
		await subscribed(bystander, 'news', 1);
		const victim = await connect(server.wsUrl);

		const closed = closeCode(victim);
		victim.send('boom');
		expect(await closed).toBe(1011);
		expect(reports(errorSpy)).toEqual(['[ws] message hook threw: async message boom']);

		const delivered = waitFor(bystander, (m) => m.topic === 'news' && m.event === 'still');
		server.platform.publish('news', 'still', 1);
		await delivered;
	});

	it('a throwing close hook is logged and the connection count still drops', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				close() {
					throw new Error('close boom');
				}
			}
		});

		const ws = await connect(server.wsUrl);
		await connectionsSettle(1);
		ws.close();
		await connectionsSettle(0);
		expect(reports(errorSpy)).toEqual(['[ws] close hook threw: close boom']);
	});

	it('a rejecting unsubscribe hook reached by the client frame is logged and the connection keeps working', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				async unsubscribe(ws, topic) {
					throw new Error('unsub boom ' + topic);
				}
			}
		});

		const ws = await connect(server.wsUrl);
		await subscribed(ws, 'a', 1);
		ws.send(JSON.stringify({ type: 'unsubscribe', topic: 'a' }));
		// Frames on one connection are handled in order and the rejection
		// handler is a microtask, so the report precedes the next ack.
		await subscribed(ws, 'b', 2);
		expect(reports(errorSpy)).toEqual(['[ws] unsubscribe hook threw: unsub boom a']);
		expect(server.platform.connections).toBe(1);
	});

	it('a rejecting unsubscribe hook reached through platform.unsubscribe is logged and the connection keeps working', async () => {
		const { createTestServer } = await import('../testing.js');
		let serverWs = null;
		server = await createTestServer({
			handler: {
				open(ws) {
					serverWs = ws;
				},
				async unsubscribe(ws, topic) {
					throw new Error('unsub boom ' + topic);
				}
			}
		});

		const ws = await connect(server.wsUrl);
		await subscribed(ws, 'a', 1);
		expect(server.platform.unsubscribe(serverWs, 'a')).toBe(true);
		await reportsSettle(1);
		expect(reports(errorSpy)).toEqual(['[ws] unsubscribe hook threw: unsub boom a']);
		await subscribed(ws, 'b', 2);
		expect(server.platform.connections).toBe(1);
	});
});
