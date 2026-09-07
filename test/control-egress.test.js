// The control/ack channel is an amplifier, and this is what bounds it.
//
// A client names a topic in a few bytes and is answered with a whole frame.
// Measured on this runtime at the worst legal shape: one 8,121-byte
// `subscribe-batch` of 1,344 shortest-legal topics comes back as 97,484 bytes
// across 1,345 frames - twelve times what it cost to ask, and repeatable,
// because the frame is legal and nothing refuses the next one.
//
// The defences that do not cover it: the 8 KiB control-frame limit bounds one
// frame rather than the rate; every `messageAdmission` limit is zero-by-default,
// so out of the box there is no inbound rate at all; the publish-egress ceilings
// bound application publishes and never see an ack; and `maxBackpressure` bounds
// the queue in MEMORY, which is why this is a CPU and bandwidth problem.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createByteBudget, controlFrameBytes } from '../src/runtime/utils/byte-budget.js';
import { buildBinaryFrame } from '../src/runtime/wire.js';
import { encodeValue } from '../src/runtime/wire-value.js';
import { GAME_INGRESS_SCHEMA_VERSION } from '../src/runtime/handler/game-ingress.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { expectStatement } from './helpers/source-pins.js';

const describeUWS = hasUWS ? describe : describe.skip;

// Spelled out rather than imported from the module under test. These two are
// the documented contract - the budget an operator reads and the close code the
// family clients branch on - so a test that read them from the source would
// follow a change to either instead of reporting it.
const MAX_CONTROL_EGRESS_BYTES = 4 * 1024 * 1024;
const CONTROL_FLOOD_CLOSE_CODE = 4429;

describe('the byte budget', () => {
	function at(times) {
		let i = 0;
		return () => times[Math.min(i++, times.length - 1)];
	}

	it('admits exactly the allowance and refuses the byte after it', () => {
		const budget = createByteBudget(100, 1000, at([0, 0, 0]));
		expect(budget(60)).toBe(true);
		// Inclusive: spending the allowance exactly is within it.
		expect(budget(40)).toBe(true);
		expect(budget(1)).toBe(false);
	});

	it('records a refused charge, so smaller retries cannot walk past the limit', () => {
		// The property that makes the bound hold under an adversary: a caller
		// that is refused and retries with less must not find room that the
		// refused charge would have filled.
		const budget = createByteBudget(100, 1000, at([0, 0, 0, 0]));
		expect(budget(101)).toBe(false);
		expect(budget(1), 'the refused 101 bytes are still on the books').toBe(false);
	});

	it('starts a fresh window only after the window has fully elapsed', () => {
		const budget = createByteBudget(100, 1000, at([0, 1000, 1001]));
		expect(budget(100)).toBe(true);
		// Exactly one window later is still the same window - the reset is on
		// `>`, so a caller cannot double its allowance by landing on the edge.
		expect(budget(1)).toBe(false);
		expect(budget(100), 'past the window, the allowance is whole again').toBe(true);
	});
});

/** One request with the target written verbatim into the request line. */
function connect(url) {
	const ws = new WebSocket(url);
	const state = { bytes: 0, frames: 0, closeCode: null, closeReason: '', last: [] };
	ws.on('message', (data) => {
		state.bytes += data.length ?? data.byteLength;
		state.frames++;
		const text = String(data);
		if (state.last.length >= 4) state.last.shift();
		state.last.push(text.slice(0, 200));
	});
	ws.on('close', (code, reason) => { state.closeCode = code; state.closeReason = String(reason); });
	return new Promise((resolve, reject) => {
		ws.on('open', () => resolve({ ws, state }));
		ws.on('error', reject);
	});
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

describeUWS('the control-egress budget against the real runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('cuts a connection that drives the amplifier past its window', async () => {
		const { ws, state } = await connect(server.wsUrl);

		// The worst legal shape, built to sit just under the 8 KiB control-frame
		// limit: every topic past the batch cap of 256 is answered with its own
		// BATCH_OVERFLOW denial, which is where the twelvefold amplification
		// comes from.
		const topics = [];
		let approx = 40;
		let i = 0;
		while (approx < 8192 - 80) {
			const t = 't' + (i++).toString(36);
			topics.push(t);
			approx += t.length + 3;
		}
		const frame = JSON.stringify({ type: 'subscribe-batch', topics, ref: 1 });
		expect(frame.length, 'the frame must be legal, or this measures the wrong refusal')
			.toBeLessThan(8192);

		// ~97 KB of answers per frame, so the 4 MiB window falls in well under a
		// hundred. The cap is generous enough to prove the cut is the budget
		// rather than the loop running out.
		for (let n = 0; n < 200 && state.closeCode === null; n++) {
			if (ws.readyState !== WebSocket.OPEN) break;
			ws.send(frame);
			await settle(5);
		}
		await settle(500);

		expect(state.closeCode, 'the connection must be cut').toBe(CONTROL_FLOOD_CLOSE_CODE);
		// 4429 and not 1008 on purpose: this repo's own client classes 4429 as
		// THROTTLE and reconnects on an accelerated curve, while 1008 is in its
		// terminal set and stops reconnecting for good. A budget a large enough
		// client could reach must not permanently kill the page.
		expect(state.closeCode).not.toBe(1008);
		// NOTHING is written to the wire but the close. An explanatory `error`
		// frame would need a new `code` value and a field the documented error
		// shape does not carry, and the protocol is frozen at revision 1 - so
		// the operator is told on the diagnostic channel instead. This pins that
		// choice: a later "helpful" frame here is a wire change.
		expect(state.last.join(' ')).not.toContain('CONTROL_EGRESS_EXHAUSTED');
		expect(state.bytes, 'the cut must land near the budget, not far past it')
			.toBeLessThan(MAX_CONTROL_EGRESS_BYTES * 2);
	}, 60000);

	it('leaves a full legitimate resubscribe alone', async () => {
		// The burst the default was derived from: a reconnecting client restores
		// its topics in batches of 256, and this sends twenty of them - about
		// 5,000 topics, far more than an ordinary page holds. It must not come
		// anywhere near the budget, or the default would be closing healthy
		// connections.
		const { ws, state } = await connect(server.wsUrl);
		for (let batch = 0; batch < 20; batch++) {
			const topics = [];
			for (let n = 0; n < 256; n++) topics.push('room:' + batch + ':' + n);
			ws.send(JSON.stringify({ type: 'subscribe-batch', topics, ref: batch + 1 }));
			await settle(10);
		}
		await settle(500);

		expect(state.closeCode, 'a healthy resubscribe must not be cut').toBeNull();
		expect(ws.readyState).toBe(WebSocket.OPEN);
		expect(state.bytes, 'and must sit far under the budget')
			.toBeLessThan(MAX_CONTROL_EGRESS_BYTES / 4);
		ws.close();
	}, 60000);

	it('cuts a connection that floods the binary game lane with frames it holds no grant for', async () => {
		// The other amplifier on this channel: a twelve-byte `0x03` game frame
		// from a connection with no publish grant is answered with a fifty-byte
		// `game-denied`. The denial is built in a module shared by every surface,
		// so it reaches the socket through the surface's own sender or not at
		// all - this drives the production one.
		const { ws, state } = await connect(server.wsUrl);
		await denialFlood(ws, state);
		expect(state.closeCode, 'the connection must be cut').toBe(CONTROL_FLOOD_CLOSE_CODE);
		expect(state.frames, 'the denials flowed before the cut, so the lane was the one answering')
			.toBeGreaterThan(1000);
		expect(state.bytes, 'the cut must land near the budget, not far past it')
			.toBeLessThan(MAX_CONTROL_EGRESS_BYTES * 2);
	}, 60000);
});

/**
 * Bind the game lane and flood it with grant-less frames until the server
 * cuts the connection or the cap is reached. Shared by the production and the
 * published-test-server cases, which must both cut.
 */
async function denialFlood(ws, state) {
	const until = async (pred, label) => {
		for (let i = 0; i < 200 && !pred(); i++) await settle(10);
		if (!pred()) throw new Error(label + ' never arrived');
	};
	ws.send(JSON.stringify({ type: 'hello', caps: ['wire.ingress:1'] }));
	await until(() => state.last.some((t) => t.includes('"ingress-ok"')), 'ingress-ok');
	ws.send(JSON.stringify({ type: 'ingress-bind', id: 1, kind: 'game:1' }));
	await until(() => state.last.some((t) => t.includes('"ingress-bound"')), 'ingress-bound');
	// Bind confirmed; the connection never sent `arm`, so it holds no grant and
	// every frame below is refused.
	const frame = Buffer.from(buildBinaryFrame(GAME_INGRESS_SCHEMA_VERSION, 1, 1, encodeValue(['move', { x: 1 }, 7])));
	for (let chunk = 0; chunk < 60 && state.closeCode === null; chunk++) {
		if (ws.readyState !== WebSocket.OPEN) break;
		for (let n = 0; n < 5000; n++) ws.send(frame);
		await settle(20);
	}
	await settle(500);
}

describeUWS('the control-egress budget on the published test server', () => {
	it('cuts a game-lane denial flood the same way the production handler does', async () => {
		// Same budget, same constants, same shared route - and a bound present
		// in production and absent here is exactly the bug a regression test
		// written against this server would then fail to see.
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({ handler: { message() {} } });
		try {
			const { ws, state } = await connect(server.wsUrl);
			await denialFlood(ws, state);
			expect(state.closeCode).toBe(CONTROL_FLOOD_CLOSE_CODE);
			expect(state.frames).toBeGreaterThan(1000);
			expect(state.bytes).toBeLessThan(MAX_CONTROL_EGRESS_BYTES * 2);
		} finally {
			await server.close();
		}
	}, 60000);
});

describe('the control frame charge', () => {
	it('is the frame\'s size on the wire, not its length in code units', () => {
		// A denial echoes the topic it refuses; a topic of three-byte characters
		// leaves as three bytes per character. Charging `length` would let such
		// a connection move three times the ceiling before it is cut.
		const ascii = '{"type":"subscribe-denied","topic":"room:1"}';
		expect(controlFrameBytes(ascii)).toBe(ascii.length);
		const wide = '{"type":"subscribe-denied","topic":"raum:über"}';
		expect(controlFrameBytes(wide)).toBe(Buffer.byteLength(wide, 'utf8'));
		expect(controlFrameBytes(wide)).toBeGreaterThan(wide.length);
	});
});

describe('every surface hands its control sender to the shared routes', () => {
	// The game denial and the wire-id announces are built in modules shared by
	// the three socket surfaces, which cannot import any one surface's sender
	// without dragging that surface's plumbing into the others. So the sender
	// travels as an argument, and these pins hold each surface to passing it and
	// each shared module to sending through nothing else. A raw `ws.send` in one
	// of these files is an uncharged control frame on every surface at once.
	const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

	it('the three ingress dispatch sites pass the surface sender', () => {
		expectStatement(read('../src/runtime/handler.js'),
			'dispatchIngressFrame(ws, ws.getUserData(), context.data, context.platform, sendControl);', 'handler.js');
		expectStatement(read('../src/testing.js'),
			'dispatchIngressFrame(ws, ws.getUserData(), context.data, context.platform, sendControlT);', 'testing.js');
		expectStatement(read('../src/vite.js'),
			'dispatchIngressFrame(wrapped, wrapped.getUserData(), context.data, context.platform, sendControlWrappedV);', 'vite.js');
	});

	it('the dev plugin refuses an overloaded message through the same sender', () => {
		expectStatement(read('../src/vite.js'), 'sendControlWrappedV(wrapped, messageOverloadedFrame(rejection));', 'vite.js');
	});

	it('the shared modules that answer a client hold no raw send', () => {
		for (const rel of ['../src/runtime/handler/game-ingress.js', '../src/runtime/handler/wire-state.js', '../src/runtime/handler/cohort.js']) {
			expect(read(rel), rel).not.toMatch(/\bws\.send\(/);
		}
	});
});
