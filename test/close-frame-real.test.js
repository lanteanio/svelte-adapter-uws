// What a client reads when the application closes its socket, on all three
// server surfaces, through a real `ws` client.
//
// The application gets the transport's own socket, so `ws.end(code, reason)`
// used to behave however the transport did: on uWS an unsendable code became
// an empty close (the client read 1005) and a long reason was cut inside a
// character (the client failed the connection and read 1006); under `vite dev`
// the `ws` library threw instead. Each case below drives one app close and
// requires the same answer from every surface.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { isUtf8 } from 'node:buffer';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
});

/**
 * The same probe the built fixture's message hook carries
 * (test/fixture/src/hooks.ws.js, `end-probe` / `drop-probe`).
 */
const probeHandler = {
	message(ws, { data, platform }) {
		const msg = JSON.parse(Buffer.from(data).toString());
		if (msg.type === 'end-probe') {
			const reason = Array.isArray(msg.reasonBytes) ? new Uint8Array(msg.reasonBytes) : msg.reason;
			try {
				ws.end(msg.code, reason);
			} catch (err) {
				platform.send(ws, 'probe', 'end-refused', { name: err?.name, message: err?.message });
			}
			return;
		}
		if (msg.type === 'drop-probe') ws.close();
	}
};

async function bootProduction() {
	const server = await startRealRuntime({ variant: 'default' });
	teardown.push(() => server.stop());
	return server.wsUrl;
}

async function bootTesting() {
	const { createTestServer } = await import('../src/testing.js');
	const server = await createTestServer({ handler: probeHandler });
	teardown.push(() => server.close());
	return server.wsUrl;
}

async function bootDev() {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
	const httpServer = createServer();
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	teardown.push(() => new Promise((r) => httpServer.close(() => r(undefined))));
	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: probeHandler, ...probeHandler }; }
	});
	return `ws://127.0.0.1:${httpServer.address().port}/ws`;
}

/** @param {string} url */
async function client(url) {
	const ws = new WebSocket(url);
	const state = { frames: [], error: null };
	ws.on('error', (err) => { state.error = err.message; });
	ws.on('message', (d) => state.frames.push(d.toString()));
	const closed = new Promise((resolve) => {
		ws.on('close', (code, reason) => resolve({ code, reason: Buffer.from(reason) }));
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('close', () => reject(new Error('closed before open')));
	});
	teardown.push(() => ws.terminate());
	return { ws, state, closed };
}

/** @param {Promise<any>} p @param {number} ms */
function within(p, ms) {
	return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Resolve with the n-th `end-refused` report, or null. */
async function refusal(state, n, ms = 2000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = state.frames.filter((f) => f.includes('"end-refused"')).map((f) => JSON.parse(f).data);
		if (found.length > n) return found[n];
		if (Date.now() >= deadline) return null;
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Close through the probe and return what the client read. */
async function closeWith(url, probe) {
	const c = await client(url);
	c.ws.send(JSON.stringify({ type: 'end-probe', ...probe }));
	const closed = await within(c.closed, 3000);
	return { closed, error: c.state.error };
}

const SURFACES = [
	...(hasUWS ? [{ label: 'production', boot: bootProduction }] : []),
	...(hasUWS ? [{ label: 'createTestServer', boot: bootTesting }] : []),
	{ label: 'vite dev', boot: bootDev }
];

describe.each(SURFACES)('ws.end() on $label', ({ boot }) => {
	it('sends a short reason with its code unchanged', async () => {
		const url = await boot();
		const { closed, error } = await closeWith(url, { code: 4401, reason: 'Unauthorized' });
		expect(closed, 'the connection closed').toBeTruthy();
		expect(closed.code).toBe(4401);
		expect(closed.reason.toString()).toBe('Unauthorized');
		expect(error).toBeNull();
	});

	it('shortens a long reason at a character boundary, so the client reads it', async () => {
		const url = await boot();
		for (const [reason, bytes] of [
			['\u00e9'.repeat(100), 122],
			['a'.repeat(121) + '\u{1F600}tail', 121],
			['\u20ac'.repeat(1000), 123]
		]) {
			const { closed, error } = await closeWith(url, { code: 4001, reason });
			expect(closed, 'the connection closed').toBeTruthy();
			expect(error, 'the client read the close instead of failing the connection').toBeNull();
			expect(closed.code).toBe(4001);
			expect(closed.reason.length).toBe(bytes);
			expect(isUtf8(closed.reason)).toBe(true);
			expect(closed.reason.equals(Buffer.from(reason).subarray(0, bytes))).toBe(true);
		}
	});

	it('sends UTF-8 bytes as the reason', async () => {
		const url = await boot();
		const { closed } = await closeWith(url, { code: 4001, reasonBytes: [...Buffer.from('bin')] });
		expect(closed.code).toBe(4001);
		expect(closed.reason.toString()).toBe('bin');
	});

	it('closes with no status when no code is given', async () => {
		const url = await boot();
		const { closed } = await closeWith(url, {});
		expect(closed.code).toBe(1005);
		expect(closed.reason.length).toBe(0);
	});

	it('refuses what it cannot send with a TypeError and leaves the connection open', async () => {
		const url = await boot();
		const c = await client(url);
		const refused = [
			{ code: 1005, reason: 'x' },
			{ code: 1006 },
			{ code: 0 },
			{ code: 999 },
			{ code: 5000 },
			{ code: 66536, reason: 'x' },
			{ code: 1000.5 },
			{ code: '4401' },
			{ reason: 'no code' },
			{ code: 4001, reasonBytes: [0xff, 0xfe] }
		];
		for (let i = 0; i < refused.length; i++) {
			c.ws.send(JSON.stringify({ type: 'end-probe', ...refused[i] }));
			const report = await refusal(c.state, i);
			expect(report, `refused ${JSON.stringify(refused[i])}`).toBeTruthy();
			expect(report.name).toBe('TypeError');
		}
		expect(c.ws.readyState, 'nothing was closed').toBe(WebSocket.OPEN);
		c.ws.send(JSON.stringify({ type: 'end-probe', code: 1000 }));
		const closed = await within(c.closed, 3000);
		expect(closed.code).toBe(1000);
	});

	it('close() drops the connection without a close frame', async () => {
		const url = await boot();
		const c = await client(url);
		c.ws.send(JSON.stringify({ type: 'drop-probe' }));
		const closed = await within(c.closed, 3000);
		expect(closed, 'the connection closed').toBeTruthy();
		expect(closed.code).toBe(1006);
	});
});
