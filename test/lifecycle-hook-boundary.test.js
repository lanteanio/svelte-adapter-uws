// The app `open` and `close` hooks run inside the exception boundary on the two
// in-process surfaces, createTestServer and the dev server, the way they do on
// the built runtime (test/error-registry-hook-crash.test.js drives that one,
// `drain` included).
//
// A throw that escaped either surface lands in this process as an unhandled
// error and fails the run. The assertions are what the failing client sees,
// the indexed console line, and the next connection still being served.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { hasUWS } from './helpers/real-runtime.js';

/** Teardown registered by whichever surface a case booted. */
let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
	vi.restoreAllMocks();
});

/**
 * The app handler every surface is given. `mode` selects the failure for the
 * NEXT connection; a connection opened with both fields null is the healthy
 * control.
 * @param {{ open: string | null, close: string | null }} mode
 * @param {{ platform?: any }} seen
 */
function lifecycleHandler(mode, seen) {
	return {
		open(ws, { platform }) {
			seen.platform = platform;
			const lane = mode.open;
			ws.getUserData().closeLane = mode.close;
			if (lane === 'throws') throw new Error('__OPEN_THROWS__');
			if (lane === 'rejects') return Promise.reject(new Error('__OPEN_REJECTS__'));
			return undefined;
		},
		close(ws) {
			seen.closes = (seen.closes ?? 0) + 1;
			const lane = ws.getUserData().closeLane;
			if (lane === 'throws') throw new Error('__CLOSE_THROWS__');
			if (lane === 'rejects') return Promise.reject(new Error('__CLOSE_REJECTS__'));
			return undefined;
		}
	};
}

async function bootTesting(handler) {
	const { createTestServer } = await import('../src/testing.js');
	const server = await createTestServer({ handler });
	teardown.push(() => server.close());
	return server.wsUrl;
}

async function bootDev(handler) {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
	const httpServer = createServer();
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	teardown.push(() => new Promise((r) => httpServer.close(() => r(undefined))));
	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: handler, ...handler }; }
	});
	return `ws://127.0.0.1:${httpServer.address().port}/ws`;
}

/**
 * A client whose close is observed from before the handshake, since a failing
 * open hook closes the connection inside the callback that accepted it.
 * @param {string} url
 */
async function client(url) {
	const ws = new WebSocket(url);
	ws.on('error', () => {});
	const frames = [];
	ws.on('message', (d) => frames.push(d.toString()));
	const closed = new Promise((resolve) => {
		ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('unexpected-response', () => reject(new Error('upgrade refused')));
		ws.once('close', () => reject(new Error('closed before open')));
	});
	teardown.push(() => ws.terminate());
	return { ws, frames, closed };
}

/** @param {Promise<any>} p @param {number} ms */
function within(p, ms) {
	return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** @param {import('vitest').MockInstance} spy @param {string} id */
async function consoleLine(spy, id, ms = 2000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const hit = spy.mock.calls.find((c) => String(c[0]).includes('[' + id + ']'));
		if (hit || Date.now() >= deadline) return hit ?? null;
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** @param {() => boolean} predicate */
async function until(predicate, ms = 2000) {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	return predicate();
}

async function servesNewConnection(url, mode) {
	mode.open = null;
	mode.close = null;
	const fresh = await client(url);
	const welcomed = await until(() => fresh.frames.some((f) => f.includes('"welcome"')));
	expect(welcomed, 'a new connection is admitted and welcomed').toBe(true);
}

const SURFACES = [
	...(hasUWS ? [{ label: 'createTestServer', boot: bootTesting }] : []),
	{ label: 'dev server', boot: bootDev }
];

describe.each(SURFACES)('lifecycle hook boundary on $label', ({ boot }) => {
	for (const [lane, loggerThrows] of ['throws', 'rejects'].flatMap(lane => [false, true].map(loggerThrows => [lane, loggerThrows]))) {
		it(`an open hook that ${lane} closes that connection 1011 and the next one is served (logger throws: ${loggerThrows})`, async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
			const mode = { open: lane, close: null };
			const seen = {};
			const url = await boot(lifecycleHandler(mode, seen));
			const failing = await client(url);
			const closed = await within(failing.closed, 2000);
			expect(closed, 'the failing connection is closed, not left open').toBeTruthy();
			expect(closed.code).toBe(1011);
			expect(closed.reason).toBe('Open handler error');
			const line = await consoleLine(error, 'ADAPTER-ERR-OPEN-HOOK');
			expect(line, 'the indexed line is printed').toBeTruthy();
			expect(line[1]?.message).toBe(lane === 'throws' ? '__OPEN_THROWS__' : '__OPEN_REJECTS__');
			expect(await until(() => seen.closes === 1), 'the close hook ran for the failed connection').toBe(true);
			await servesNewConnection(url, mode);
		});

		it(`a close hook that ${lane} is logged, the connection is released, and the next one is served (logger throws: ${loggerThrows})`, async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
			const mode = { open: null, close: lane };
			const seen = {};
			const url = await boot(lifecycleHandler(mode, seen));
			const leaving = await client(url);
			expect(await until(() => seen.platform?.connections === 1)).toBe(true);
			leaving.ws.close(1000);
			const line = await consoleLine(error, 'ADAPTER-ERR-CLOSE-HOOK');
			expect(line, 'the indexed line is printed').toBeTruthy();
			expect(line[1]?.message).toBe(lane === 'throws' ? '__CLOSE_THROWS__' : '__CLOSE_REJECTS__');
			// The surface's own teardown after the hook still ran: the closed
			// connection left the live set.
			expect(await until(() => seen.platform.connections === 0), 'the connection is released').toBe(true);
			await servesNewConnection(url, mode);
		});
	}

	it('a healthy open and close print nothing', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mode = { open: null, close: null };
		const url = await boot(lifecycleHandler(mode, {}));
		const c = await client(url);
		expect(await until(() => c.frames.some((f) => f.includes('"welcome"')))).toBe(true);
		c.ws.close(1000);
		expect(await within(c.closed, 2000)).toBeTruthy();
		await new Promise((r) => setTimeout(r, 50));
		const lines = error.mock.calls.filter((c) => /\[ADAPTER-ERR-(OPEN|CLOSE)-HOOK\]/.test(String(c[0])));
		expect(lines).toHaveLength(0);
	});
});
