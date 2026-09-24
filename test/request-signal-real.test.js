// `request.signal` on the built runtime aborts when the client goes away before
// its request body has arrived in full - always, for a request without one -
// which is when SvelteKit's own Node adapter aborts it, and when shutdown stops
// waiting for the request. A request whose response completes never sees it.
//
// The runtime runs in this process, so the fixture routes record what their
// signal did on globalThis, including a count of handlers that have begun
// watching it: the client is cut off only after that, or a disconnect could
// land before the handler exists to hear it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** @param {() => boolean} pred @param {string} what */
async function until(pred, what, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** A request left open on a raw socket, so the suite decides when the client goes. */
function openRequest(port, head, body = '') {
	const socket = net.connect(port, '127.0.0.1');
	socket.on('error', () => { /* destroyed on purpose */ });
	socket.on('connect', () => socket.write(head + '\r\n' + body));
	return socket;
}
const get = (path) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n`;
const post = (path, length) => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n`;

describeUWS('request.signal on an SSR route', () => {
	let server;
	let state;
	let lifecycle;
	const aborts = () => globalThis.__slowHoldAborts ?? [];
	const started = () => globalThis.__slowHoldStarted ?? 0;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
		state = await import('./fixture/build/handler/state.js');
		lifecycle = await import('./fixture/build/handler/lifecycle.js');
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	it('aborts when the client goes away mid-request', async () => {
		const before = aborts().length;
		const began = started();
		const socket = openRequest(server.port, get('/slow-hold?ms=1500'));
		await until(() => started() === began + 1, 'the handler to watch its signal');
		socket.destroy();
		await until(() => aborts().length === before + 1, 'the signal to abort');
		expect(aborts().at(-1).name).toBe('AbortError');
		// The handler keeps holding, and its registration goes when it returns.
		await until(() => state.requestSignals.size === 0, 'the handler to finish', 5000);
	});

	it('does not abort a request whose response completes', async () => {
		const before = aborts().length;
		const res = await fetch(server.httpUrl + '/slow-hold?ms=20');
		expect(res.status).toBe(200);
		await res.text();
		await until(() => state.requestSignals.size === 0, 'the registration to be released');
		expect(aborts().length).toBe(before);
	});

	it('does not abort a request whose body arrived in full, as the Node adapter does not', async () => {
		const before = aborts().length;
		const began = started();
		const socket = openRequest(server.port, post('/slow-hold?ms=400', 3), 'abc');
		await until(() => started() === began + 1, 'the handler to read the body and watch its signal');
		socket.destroy();
		await until(() => state.requestSignals.size === 0, 'the handler to finish', 5000);
		expect(aborts().length, 'a form action that has its data finishes what it started').toBe(before);
	});

	it('aborts a request whose body was still arriving', async () => {
		const before = aborts().length;
		const entered = globalThis.__slowHoldEntered ?? 0;
		const socket = openRequest(server.port, post('/slow-hold?ms=400', 10), 'abc');
		await until(() => (globalThis.__slowHoldEntered ?? 0) === entered + 1, 'the handler to watch its signal');
		socket.destroy();
		await until(() => aborts().length === before + 1, 'the signal to abort');
		await until(() => state.requestSignals.size === 0, 'the registration to be released', 5000);
	});

	it('aborts what is still in flight when shutdown stops waiting, with a reason that says so', async () => {
		const before = aborts().length;
		const began = started();
		const socket = openRequest(server.port, get('/slow-hold?ms=1500'));
		try {
			await until(() => started() === began + 1, 'the handler to watch its signal');
			lifecycle.abortInFlightRequests();
			await until(() => aborts().length === before + 1, 'the signal to abort');
			expect(aborts().at(-1)).toMatchObject({ name: 'AbortError', message: 'The server shut down before the request finished' });
			expect(state.requestSignals.size).toBe(0);
		} finally {
			socket.destroy();
		}
	});
});

describeUWS('request.signal on the admin route', () => {
	let server;
	let state;
	const aborts = () => globalThis.__adminHoldAborts ?? [];
	const started = () => globalThis.__adminHoldStarted ?? 0;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
		state = await import('./fixture/build-hook-crash/handler/state.js');
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	it('aborts when the client goes away, and releases the registration', async () => {
		const before = aborts().length;
		const began = started();
		const socket = openRequest(server.port, get('/__realtime/hold'));
		await until(() => started() === began + 1, 'the admin handler to watch its signal');
		socket.destroy();
		await until(() => aborts().length === before + 1, 'the signal to abort');
		expect(aborts().at(-1)).toBe('AbortError');
		await until(() => state.requestSignals.size === 0, 'the registration to be released');
	});
});

describeUWS('request.signal on the createTestServer admin route', () => {
	it('aborts when the client goes away, as production does', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let startedHold = 0;
		const reasons = [];
		const server = await createTestServer({
			handler: {
				admin(request) {
					return new Promise((resolve) => {
						const timer = setTimeout(() => resolve(new Response('held')), 3000);
						startedHold++;
						request.signal.addEventListener('abort', () => {
							clearTimeout(timer);
							reasons.push(request.signal.reason?.name);
							resolve(new Response('aborted'));
						}, { once: true });
					});
				}
			}
		});
		try {
			const socket = openRequest(server.port, get('/__realtime/hold'));
			await until(() => startedHold === 1, 'the admin handler to watch its signal');
			socket.destroy();
			await until(() => reasons.length === 1, 'the signal to abort');
			expect(reasons[0]).toBe('AbortError');
		} finally {
			await server.close();
		}
	});
});
