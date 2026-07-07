import { describe, it, expect, afterEach } from 'vitest';
import { dispersedReconnectDelay } from '../src/client-runtime.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

// --- pure helper -------------------------------------------------------------
describe('dispersedReconnectDelay', () => {
	it('returns the floor (afterMs) at randFactor 0', () => {
		expect(dispersedReconnectDelay(1000, 5000, 0)).toBe(1000);
		expect(dispersedReconnectDelay(0, 5000, 0)).toBe(0);
	});

	it('reaches ~afterMs+windowMs as randFactor approaches 1', () => {
		expect(dispersedReconnectDelay(1000, 5000, 0.9998)).toBeCloseTo(1000 + 5000 * 0.9998, 6);
		expect(dispersedReconnectDelay(0, 4000, 0.5)).toBe(2000);
	});

	it('always lands within [afterMs, afterMs + windowMs)', () => {
		for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
			const d = dispersedReconnectDelay(500, 3000, r);
			expect(d).toBeGreaterThanOrEqual(500);
			expect(d).toBeLessThan(500 + 3000);
		}
	});

	it('clamps a non-finite / negative / out-of-range randFactor to the floor', () => {
		expect(dispersedReconnectDelay(1000, 5000, NaN)).toBe(1000);
		expect(dispersedReconnectDelay(1000, 5000, -0.5)).toBe(1000);
		expect(dispersedReconnectDelay(1000, 5000, 1)).toBe(1000); // >= 1 clamps to 0
	});

	it('clamps non-finite / negative afterMs and windowMs to 0', () => {
		expect(dispersedReconnectDelay(NaN, 5000, 0)).toBe(0);
		expect(dispersedReconnectDelay(-100, 5000, 0)).toBe(0);
		expect(dispersedReconnectDelay(1000, NaN, 0.5)).toBe(1000);
		expect(dispersedReconnectDelay(1000, -5000, 0.5)).toBe(1000);
	});
});

// --- server trigger ----------------------------------------------------------
let server;

async function connect(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const state = { closeCode: null, closeReason: '' };
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(data.toString())); } catch { /* control text */ }
	});
	ws.on('close', (code, reasonBuf) => { state.closeCode = code; state.closeReason = reasonBuf ? reasonBuf.toString() : ''; });
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	return { ws, frames, state };
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const advisoryOf = (c) => c.frames.find((f) => f.type === 'reconnect');

describeUWS('platform.adviseReconnect', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('sends a reconnect advisory then a 1001 close (close defaults to true)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const c = await connect(server.wsUrl);
		await tick();

		expect(server.platform.adviseReconnect({ windowMs: 5000 })).toBe(1);
		await tick();

		const advisory = advisoryOf(c);
		expect(advisory).toBeDefined();
		expect(advisory.windowMs).toBe(5000);
		expect('afterMs' in advisory).toBe(false);
		expect(c.state.closeCode).toBe(1001);
	});

	it('carries afterMs when set and leaves the socket open with close:false', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const c = await connect(server.wsUrl);
		await tick();

		expect(server.platform.adviseReconnect({ windowMs: 3000, afterMs: 1000, close: false })).toBe(1);
		await tick();

		expect(advisoryOf(c)).toMatchObject({ type: 'reconnect', afterMs: 1000, windowMs: 3000 });
		expect(c.state.closeCode).toBe(null);
		c.ws.close();
	});

	it('returns 0 and sends nothing for a non-positive window', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const c = await connect(server.wsUrl);
		await tick();

		expect(server.platform.adviseReconnect({ windowMs: 0 })).toBe(0);
		await tick();
		expect(advisoryOf(c)).toBeUndefined();
		c.ws.close();
	});

	it('applies the filter and returns the exact advised count', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const a = await connect(server.wsUrl);
		const b = await connect(server.wsUrl);
		await tick();

		expect(server.platform.adviseReconnect({ windowMs: 5000, filter: () => false })).toBe(0);
		await tick();
		expect(advisoryOf(a)).toBeUndefined();

		expect(server.platform.adviseReconnect({ windowMs: 5000, filter: () => true, close: false })).toBe(2);
		await tick();
		expect(advisoryOf(a)).toBeDefined();
		expect(advisoryOf(b)).toBeDefined();
		a.ws.close();
		b.ws.close();
	});

	it('disperses the advisory to every connection before the 1001 on shutdown', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ reconnectDispersalMs: 5000 });
		const c = await connect(server.wsUrl);
		await tick();

		await server.close();
		server = null;
		await tick();

		const advisory = advisoryOf(c);
		expect(advisory).toBeDefined();
		expect(advisory.windowMs).toBe(5000);
		expect(c.state.closeCode).toBe(1001);
	});
});
