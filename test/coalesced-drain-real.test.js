// sendCoalesced under real backpressure, on the built runtime and on
// createTestServer, through a real client that stops reading.
//
// Serialization waits for the flush. A value JSON cannot carry that was queued
// behind backpressure is first serialized from the uWS drain callback, where a
// throw would take the worker down; it has to be dropped and reported while
// the rest of the queue goes out. On an idle socket the same value flushes
// inside the call and must throw to the caller, as `send` does. The test
// server must queue and drain the same way and run the app's drain hook.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { parseDiagnostic, setOperationalEventSink } from '../src/observability.js';
import { coalescedBadValue, coalescedNameProbe, coalescedReentrantProbe } from './fixture/src/coalesced-probe.js';

let teardown = [];

afterEach(async () => {
	setOperationalEventSink(null);
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
	vi.restoreAllMocks();
});

const describeUWS = hasUWS ? describe : describe.skip;

/** The same probe the built fixture's message hook carries. */
function probeHandler(seen) {
	return {
		message(ws, { data, platform }) {
			const msg = JSON.parse(Buffer.from(data).toString());
			if (msg.type === 'coalesce-reentrant-probe') { coalescedReentrantProbe(ws, platform, msg); return; }
			if (msg.type === 'coalesce-name-probe') { coalescedNameProbe(ws, platform, msg); return; }
			if (msg.type === 'coalesce-probe') {
				const chunk = new Uint8Array(1024 * 1024);
				for (let i = 0; i < 64 && ws.getBufferedAmount() <= 1024 * 1024; i++) ws.send(chunk, true);
				platform.sendCoalesced(ws, { key: 'good', topic: 'probe', event: 'coalesced-good', data: { ok: true } });
				platform.sendCoalesced(ws, { key: 'bad', topic: 'probe', event: 'coalesced-bad', data: coalescedBadValue(msg.kind) });
				return;
			}
			if (msg.type === 'coalesce-now-probe') {
				try {
					platform.sendCoalesced(ws, { key: 'now', topic: 'probe', event: 'coalesced-now', data: coalescedBadValue(msg.kind) });
				} catch (err) {
					platform.send(ws, 'probe', 'coalesce-threw', { name: err?.name });
				}
				return;
			}
			if (msg.type === 'echo') platform.send(ws, 'test-topic', 'echo', msg.payload);
		},
		drain() {
			seen.drains++;
		}
	};
}

async function bootProduction() {
	const server = await startRealRuntime({ variant: 'default' });
	teardown.push(() => server.stop());
	return { url: server.wsUrl, seen: null };
}

async function bootTesting() {
	const { createTestServer } = await import('../src/testing.js');
	const seen = { drains: 0 };
	const server = await createTestServer({ handler: probeHandler(seen) });
	teardown.push(() => server.close());
	return { url: server.wsUrl, seen };
}

/**
 * A real client. With `stall`, it stops reading from the upgrade on and
 * resumes when told, so the server backs up in uWS rather than the kernel.
 */
async function client(url, { stall = false, requestId } = {}) {
	const ws = new WebSocket(url, requestId ? { headers: { 'x-request-id': requestId } } : {});
	const state = { frames: [], binaryBytes: 0, error: null };
	ws.on('error', (err) => { state.error = err.message; });
	ws.on('message', (d, isBinary) => {
		if (isBinary) state.binaryBytes += d.length;
		else state.frames.push(d.toString());
	});
	if (stall) ws.once('upgrade', (response) => response.socket.pause());
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('close', () => reject(new Error('closed before open')));
	});
	if (stall) ws.pause();
	teardown.push(() => ws.terminate());
	return { ws, state, resume: () => ws.resume() };
}

async function until(predicate, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	return predicate();
}

const SURFACES = [
	{ label: 'production', boot: bootProduction },
	{ label: 'createTestServer', boot: bootTesting }
];

describeUWS.each(SURFACES)('sendCoalesced on $label', ({ boot }) => {
	it.each([false, true].flatMap((stall) => [{ stall, sameKey: true, fail: false }, { stall, sameKey: false, fail: false }, { stall, sameKey: true, fail: true }]))('delivers reentrant serialization in order, stalled=$stall sameKey=$sameKey throws=$fail', async ({ stall, sameKey, fail }) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url } = await boot();
		const c = await client(url, { stall });
		c.ws.send(JSON.stringify({ type: 'coalesce-reentrant-probe', stall, sameKey, fail }));
		if (stall) { await new Promise((r) => setTimeout(r, 300)); c.resume(); }
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-reentrant-report"')))).toBe(true);
		const frames = c.state.frames.map((f) => JSON.parse(f));
		expect(frames.filter((f) => f.event === 'coalesced-older' || f.event === 'coalesced-latest').map((f) => f.data)).toEqual(sameKey ? [2] : [1, 2]);
		expect(frames.find((f) => f.event === 'coalesced-reentrant-report').data.calls).toBe(1);
		if (stall) expect(c.state.binaryBytes).toBeGreaterThan(1024 * 1024);
		expect(error.mock.calls.some((call) => String(call[0]).includes('COALESCED-UNSERIALIZABLE'))).toBe(false);
	}, 30000);

	it.each(['topic', 'event'].flatMap((field) => ['quote"', 'slash\\', 'control\n'].flatMap((name) => [false, true].map((stall) => ({ field, name, stall })))))('rejects $field with $name before queueing, stalled=$stall', async ({ field, name, stall }) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url } = await boot();
		const c = await client(url, { stall });
		c.ws.send(JSON.stringify({ type: 'coalesce-name-probe', field, name, stall }));
		if (stall) { await new Promise((r) => setTimeout(r, 300)); c.resume(); }
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-name-report"')))).toBe(true);
		const frames = c.state.frames.map((f) => JSON.parse(f));
		expect(frames.find((f) => f.event === 'coalesced-name-report').data.threw).toBe(true);
		expect(frames.filter((f) => f.event === 'coalesced-keep').map((f) => f.data)).toEqual(['original']);
		if (stall) expect(c.state.binaryBytes).toBeGreaterThan(1024 * 1024);
		expect(error.mock.calls.some((call) => String(call[0]).includes('COALESCED-UNSERIALIZABLE'))).toBe(false);
		c.ws.send(JSON.stringify({ type: 'echo', payload: { after: true } }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"after":true')))).toBe(true);
	}, 30000);

	it.each(['capture', 'throw', 'reject'])('delivers a deferred failure to the operational sink (%s)', async (mode) => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const records = [];
		setOperationalEventSink((record) => {
			if (record.event !== 'ws.send-coalesced.unserializable') return;
			records.push(record);
			if (mode === 'throw') throw new Error('sink failed');
			if (mode === 'reject') return Promise.reject(new Error('sink rejected'));
		});
		const { url } = await boot();
		const requestId = 'coalesced-sink-' + mode;
		const c = await client(url, { stall: true, requestId });
		c.ws.send(JSON.stringify({ type: 'coalesce-probe', kind: 'bigint' }));
		await new Promise((r) => setTimeout(r, 300));
		c.resume();
		expect(await until(() => records.length > 0), 'the app operational sink receives the deferred failure').toBe(true);
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record).toMatchObject({ source: 'svelte-adapter-uws', component: 'runtime.websocket', severity: 'error', dataClass: 'pseudonymous' });
		expect(record.attributes).toMatchObject({ errorId: 'ADAPTER-ERR-COALESCED-UNSERIALIZABLE', error: { name: 'TypeError' } });
		expect(record.attributes.requestId).toBe(requestId);
		for (const [field, kind] of [['key', 'coalesced-key'], ['topic', 'topic'], ['event', 'event']]) {
			expect(record.attributes[field]).toMatchObject({ dataClass: 'pseudonymous', kind, valueType: 'string', ref: expect.stringMatching(new RegExp('^' + kind + ':')) });
		}
		expect(JSON.stringify(record)).not.toContain('coalesced-bad');
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-good"')))).toBe(true);
		expect(c.state.binaryBytes).toBeGreaterThan(1024 * 1024);
		expect(c.state.frames.some((f) => f.includes('"coalesced-bad"'))).toBe(false);
		c.ws.send(JSON.stringify({ type: 'echo', payload: { after: true } }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"after":true')))).toBe(true);
	}, 30000);

	it('continues draining when the error reporter throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('reporter failed'); });
		const { url } = await boot();
		const c = await client(url, { stall: true });
		c.ws.send(JSON.stringify({ type: 'coalesce-probe', kind: 'string' }));
		await new Promise((r) => setTimeout(r, 300));
		c.resume();
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-good"')))).toBe(true);
		c.ws.send(JSON.stringify({ type: 'echo', payload: { after: true } }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"after":true')))).toBe(true);
		expect(c.state.frames.some((f) => f.includes('"coalesced-bad"'))).toBe(false);
		expect(c.state.frames.map((f) => JSON.parse(f))).toBeDefined();
	}, 30000);

	it.each(['bigint', 'string', 'null', 'undefined', 'false', 'number', 'error', 'function', 'symbol', 'revoked', 'prototype'])('drops a queued %s failure, sends the rest, and keeps serving', async (kind) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url, seen } = await boot();
		const c = await client(url, { stall: true });
		c.ws.send(JSON.stringify({ type: 'coalesce-probe', kind }));
		await new Promise((r) => setTimeout(r, 300));
		c.resume();

		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-good"'))), 'the serializable value is delivered after the drain').toBe(true);
		expect(c.state.binaryBytes, 'the backlog drained before it').toBeGreaterThan(1024 * 1024);
		expect(await until(() => error.mock.calls.some((call) => String(call[0]).includes('ADAPTER-ERR-COALESCED-UNSERIALIZABLE'))), 'the dropped value is reported').toBe(true);
		const line = error.mock.calls.find((call) => String(call[0]).includes('ADAPTER-ERR-COALESCED-UNSERIALIZABLE'));
		expect(parseDiagnostic(line[0])?.record).toMatchObject({ event: 'ws.send-coalesced.unserializable', attributes: { errorId: 'ADAPTER-ERR-COALESCED-UNSERIALIZABLE', error: { name: 'TypeError' } } });
		expect(c.state.frames.some((f) => f.includes('"coalesced-bad"'))).toBe(false);

		// The worker and the connection are both still serving.
		c.ws.send(JSON.stringify({ type: 'echo', payload: { after: true } }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"after":true')))).toBe(true);
		expect(c.state.error).toBeNull();
		if (seen) expect(seen.drains, 'the app drain hook ran on the test server').toBeGreaterThan(0);
	}, 30000);

	it.each(['bigint', 'string', 'null', 'undefined', 'false', 'number', 'error', 'function', 'symbol', 'revoked', 'prototype'])('throws a %s failure to the caller when the value flushes inside the call', async (kind) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url } = await boot();
		const c = await client(url);
		c.ws.send(JSON.stringify({ type: 'coalesce-now-probe', kind }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesce-threw"')))).toBe(true);
		const report = JSON.parse(c.state.frames.find((f) => f.includes('"coalesce-threw"')));
		expect(report.data.name).toBe('TypeError');
		expect(error.mock.calls.some((call) => String(call[0]).includes('COALESCED-UNSERIALIZABLE')), 'a caller-visible throw is not also logged').toBe(false);
	});
});
