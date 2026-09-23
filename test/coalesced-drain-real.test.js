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

let teardown = [];

afterEach(async () => {
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
			if (msg.type === 'coalesce-probe') {
				const chunk = new Uint8Array(1024 * 1024);
				for (let i = 0; i < 64 && ws.getBufferedAmount() <= 1024 * 1024; i++) ws.send(chunk, true);
				platform.sendCoalesced(ws, { key: 'good', topic: 'probe', event: 'coalesced-good', data: { ok: true } });
				platform.sendCoalesced(ws, { key: 'bad', topic: 'probe', event: 'coalesced-bad', data: { n: 1n } });
				return;
			}
			if (msg.type === 'coalesce-now-probe') {
				try {
					platform.sendCoalesced(ws, { key: 'now', topic: 'probe', event: 'coalesced-now', data: { n: 1n } });
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
async function client(url, { stall = false } = {}) {
	const ws = new WebSocket(url);
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
	it('drops a queued value JSON cannot carry, sends the rest, and keeps serving', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url, seen } = await boot();
		const c = await client(url, { stall: true });
		c.ws.send(JSON.stringify({ type: 'coalesce-probe' }));
		await new Promise((r) => setTimeout(r, 300));
		c.resume();

		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesced-good"'))), 'the serializable value is delivered after the drain').toBe(true);
		expect(c.state.binaryBytes, 'the backlog drained before it').toBeGreaterThan(1024 * 1024);
		expect(await until(() => error.mock.calls.some((call) => String(call[0]).includes('[ADAPTER-ERR-COALESCED-UNSERIALIZABLE]'))), 'the dropped value is reported').toBe(true);
		const line = error.mock.calls.find((call) => String(call[0]).includes('[ADAPTER-ERR-COALESCED-UNSERIALIZABLE]'));
		expect(line[1]).toBeInstanceOf(TypeError);
		expect(c.state.frames.some((f) => f.includes('"coalesced-bad"'))).toBe(false);

		// The worker and the connection are both still serving.
		c.ws.send(JSON.stringify({ type: 'echo', payload: { after: true } }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"after":true')))).toBe(true);
		expect(c.state.error).toBeNull();
		if (seen) expect(seen.drains, 'the app drain hook ran on the test server').toBeGreaterThan(0);
	}, 30000);

	it('throws to the caller when the value flushes inside the call', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { url } = await boot();
		const c = await client(url);
		c.ws.send(JSON.stringify({ type: 'coalesce-now-probe' }));
		expect(await until(() => c.state.frames.some((f) => f.includes('"coalesce-threw"')))).toBe(true);
		const report = JSON.parse(c.state.frames.find((f) => f.includes('"coalesce-threw"')));
		expect(report.data.name).toBe('TypeError');
		expect(error.mock.calls.some((call) => String(call[0]).includes('COALESCED-UNSERIALIZABLE')), 'a caller-visible throw is not also logged').toBe(false);
	});
});
