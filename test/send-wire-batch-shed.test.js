// sendWireBatch reports what happened to the frames it sent.
//
// When the codec declines the batch, each entry goes out as its own frame, and
// a dropped binary frame poisons the connection's wire state so the remaining
// entries fall back to JSON. The call returns the status of the last send.
// When the dropped frame was the LAST entry, nothing follows it - and the
// fallback started its own result at 1, so a call whose final frame was shed
// reported that it was sent. Driven on the built runtime's own platform and on
// createTestServer with the same scripted socket.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { WS_CAPS, WS_SUBSCRIPTIONS } from '../src/runtime/utils.js';

const describeUWS = hasUWS ? describe : describe.skip;
const TOPIC = 'send-wire-batch-shed';
const CAPABILITY = 'probe.batch-shed:1';

/** A codec that declines every batch and encodes each entry on its own. */
function entryOnlyCodec() {
	return {
		capability: CAPABILITY,
		schemaVersion: 1,
		// Per-connection state, as a stateful codec declares it.
		state: { onAttach: () => ({ schemaVersion: 1 }) },
		encode(event) { return event.endsWith('-batch') ? null : new Uint8Array([7]); }
	};
}

/** A capable connection whose sends answer from `script` (uWS statuses). */
function scriptedWs(script) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	ud[WS_CAPS] = new Set([CAPABILITY]);
	const sent = { text: [], binary: 0 };
	return {
		sent,
		getUserData() { return ud; },
		send(payload, isBinary) {
			if (isBinary) sent.binary++;
			else sent.text.push(String(payload));
			return script.length > 0 ? script.shift() : 1;
		},
		getBufferedAmount() { return 0; },
		end() {},
		close() {}
	};
}

function cases(getPlatform) {
	it('reports a dropped frame when it was the last entry', () => {
		// wire-id announce sent, entry 0 sent, entry 1 (the last) dropped.
		const ws = scriptedWs([1, 1, 2]);
		const result = getPlatform().sendWireBatch(ws, TOPIC, 'update', [{ data: { n: 0 } }, { data: { n: 1 } }], entryOnlyCodec());
		expect(ws.sent.binary, 'both entries went out as binary frames').toBe(2);
		expect(result).toBe(2);
	});

	it('reports the last send when a dropped frame is followed by JSON sends', () => {
		// announce sent, entry 0 dropped, entry 1 falls back to JSON and is sent.
		const ws = scriptedWs([1, 2, 1]);
		const result = getPlatform().sendWireBatch(ws, TOPIC, 'update', [{ data: { n: 0 } }, { data: { n: 1 } }], entryOnlyCodec());
		expect(ws.sent.text.some((t) => t.includes('"n":1'))).toBe(true);
		expect(result).toBe(1);
	});
}

describeUWS('sendWireBatch on the built runtime', () => {
	let server;
	let platform;
	beforeAll(async () => {
		server = await startRealRuntime();
		({ platform } = await import('./fixture/build/handler/platform.js'));
	}, 400000);
	afterAll(async () => { await server?.stop(); });
	cases(() => platform);
});

describeUWS('sendWireBatch on createTestServer', () => {
	let server;
	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({});
	});
	afterAll(async () => { await server?.close(); });
	cases(() => server.platform);
});
