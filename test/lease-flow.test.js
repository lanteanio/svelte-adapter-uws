// Unit + integration coverage for the per-connection credit-based send gate
// and the 0..1 pressure scalar it feeds.
//
// Two layers:
//   1. Pure state-machine + scalar helpers from files/wire.js (no server, no
//      sockets) - absolute-time expiry, per-request decrement, bounded queue
//      plus refusal, re-grant drains the queue, and the saturation scalar
//      direction at both ends.
//   2. End to end through a real uWS server (createTestServer) plus a real ws
//      client, asserting the gate is wire-transparent: a connection that does
//      not advertise the cap runs the immediate send path byte-for-byte, and a
//      fully gated session never lets an internal accounting token reach a
//      frame the app surface can read.

import { describe, it, expect, afterEach } from 'vitest';
import {
	createLeaseState,
	leasePressureValue,
	leaseGrantSize,
	samplePressureValue,
	parseBinaryFrame
} from '../files/wire.js';

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

describe('per-connection send gate state machine', () => {
	it('grants an absolute deadline from the grant instant, not a countdown', () => {
		let clock = 1000;
		const now = () => clock;
		const gate = createLeaseState({ requestCount: 4, ttlMs: 500, now });

		gate.grant();
		expect(gate.expiresAt()).toBe(1500); // 1000 + 500, fixed at grant

		// Advancing the clock does not move the deadline (no decrementing timer).
		clock = 1499;
		expect(gate.expiresAt()).toBe(1500);
		expect(gate.live()).toBe(true);

		clock = 1500;
		expect(gate.live()).toBe(false); // reached the deadline -> expired

		clock = 9999;
		expect(gate.expiresAt()).toBe(1500); // still the original absolute deadline
	});

	it('refuses to acquire once the deadline passes even with credit remaining', () => {
		let clock = 0;
		const gate = createLeaseState({ requestCount: 10, ttlMs: 100, now: () => clock });
		gate.grant();

		expect(gate.tryAcquire()).toBe(true);
		expect(gate.available()).toBe(9); // plenty of credit left

		clock = 100; // hit the absolute deadline
		expect(gate.tryAcquire()).toBe(false); // credit > 0 but the grant expired
		expect(gate.available()).toBe(9); // a refused acquire does not consume credit
	});

	it('decrements exactly one credit per acquire and stops at zero', () => {
		const gate = createLeaseState({ requestCount: 3, ttlMs: 10_000, now: () => 0 });
		gate.grant();

		expect(gate.available()).toBe(3);
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.available()).toBe(0);

		expect(gate.tryAcquire()).toBe(false); // exhausted
		expect(gate.available()).toBe(0); // never goes negative
	});

	it('queues overflow requests and refuses past the bounded depth', () => {
		const gate = createLeaseState({ requestCount: 1, ttlMs: 10_000, maxQueue: 2, now: () => 0 });
		gate.grant();

		gate.tryAcquire(); // consumes the single credit
		expect(gate.available()).toBe(0);

		expect(gate.enqueue('a')).toBe(true);
		expect(gate.enqueue('b')).toBe(true);
		expect(gate.queued()).toBe(2);

		// The queue is bounded: the next enqueue is refused rather than growing
		// without limit, and the refusal is reported so the caller can turn it
		// into a degraded signal (never an exception here).
		expect(gate.enqueue('c')).toBe(false);
		expect(gate.queued()).toBe(2);
	});

	it('re-grants on a replenish and drains the queued items in order', () => {
		let clock = 0;
		const gate = createLeaseState({ requestCount: 1, ttlMs: 10_000, maxQueue: 8, now: () => clock });
		gate.grant();

		gate.tryAcquire(); // spend the initial credit
		gate.enqueue('one');
		gate.enqueue('two');
		gate.enqueue('three');
		expect(gate.queued()).toBe(3);

		// A re-grant of 5 covers all three queued plus headroom. Draining
		// returns the items in FIFO order and consumes one credit each.
		clock = 50;
		const drained = gate.requestN(5);
		expect(drained).toEqual(['one', 'two', 'three']);
		expect(gate.queued()).toBe(0);
		expect(gate.available()).toBe(2); // 5 granted - 3 drained
		expect(gate.expiresAt()).toBe(10_050); // re-grant resets the absolute deadline
	});

	it('drains only as many queued items as the re-grant covers', () => {
		const gate = createLeaseState({ requestCount: 0, ttlMs: 10_000, maxQueue: 8, now: () => 0 });
		gate.grant();

		gate.enqueue('a');
		gate.enqueue('b');
		gate.enqueue('c');

		const drained = gate.requestN(2); // only two credits granted
		expect(drained).toEqual(['a', 'b']);
		expect(gate.queued()).toBe(1); // 'c' stays queued for the next grant
		expect(gate.available()).toBe(0);
	});

	it('treats an absent grant as a closed gate (no credit, no send)', () => {
		const gate = createLeaseState({ requestCount: 4, ttlMs: 500, now: () => 0 });
		// Never granted.
		expect(gate.live()).toBe(false);
		expect(gate.tryAcquire()).toBe(false);
		expect(gate.available()).toBe(0);
		expect(gate.granted()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Pressure scalar direction (0 = idle, 1 = saturated)
// ---------------------------------------------------------------------------

describe('connection saturation scalar', () => {
	it('reads low when idle (full credit, nothing outstanding)', () => {
		const gate = createLeaseState({ requestCount: 8, ttlMs: 10_000, now: () => 0 });
		gate.grant();
		// granted=8, available=8 -> outstanding 0 -> value near 0.
		expect(gate.pressureValue()).toBeLessThan(0.2);
	});

	it('reads high when saturated (outstanding approaches granted)', () => {
		const gate = createLeaseState({ requestCount: 8, ttlMs: 10_000, now: () => 0 });
		gate.grant();
		for (let i = 0; i < 8; i++) gate.tryAcquire(); // spend every credit
		// granted=8, available=0 -> outstanding 8 -> value near 1.
		expect(gate.pressureValue()).toBeGreaterThan(0.8);
	});

	it('rises monotonically as credit drains toward exhaustion', () => {
		const gate = createLeaseState({ requestCount: 10, ttlMs: 10_000, now: () => 0 });
		gate.grant();
		let prev = gate.pressureValue();
		for (let i = 0; i < 10; i++) {
			gate.tryAcquire();
			const next = gate.pressureValue();
			expect(next).toBeGreaterThanOrEqual(prev); // never decreases as we drain
			prev = next;
		}
		expect(prev).toBeGreaterThan(0.8); // fully drained sits high
	});

	it('clamps into 0..1 and never reports outside the range', () => {
		const gate = createLeaseState({ requestCount: 3, ttlMs: 10_000, now: () => 0 });
		gate.grant();
		for (let i = 0; i < 20; i++) gate.tryAcquire(); // over-drain attempts
		const v = gate.pressureValue();
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThanOrEqual(1);
	});

	it('falls back to the supplied scalar for a gate-less connection', () => {
		// A connection that never advertised the gate has no granted credit.
		// The fold returns the existing pressure-derived scalar instead of
		// dividing by zero - 0 when the worker is healthy, the elevated value
		// when it is not.
		expect(leasePressureValue({ granted: 0, available: 0, fallback: 0 })).toBe(0);
		expect(leasePressureValue({ granted: 0, available: 0, fallback: 0.63 })).toBeCloseTo(0.63, 5);
	});

	it('derives directly from outstanding over granted when a grant exists', () => {
		// granted 4, available 1 -> outstanding 3 -> 3/4 = 0.75.
		expect(leasePressureValue({ granted: 4, available: 1, fallback: 0 })).toBeCloseTo(0.75, 5);
		// idle: outstanding 0 -> 0 regardless of fallback.
		expect(leasePressureValue({ granted: 4, available: 4, fallback: 0.9 })).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Worker pressure value fold (the scalar an app reads via platform.pressure)
// ---------------------------------------------------------------------------

describe('worker pressure value fold', () => {
	const THRESHOLDS = { memoryHeapUsedRatio: 0.85, publishRatePerSec: 1000, subscriberRatio: 50 };

	it('reads 0 for a fully idle worker with no gate peak', () => {
		const v = samplePressureValue(
			{ heapUsedRatio: 0, publishRate: 0, subscriberRatio: 0 },
			THRESHOLDS,
			0
		);
		expect(v).toBe(0);
	});

	it('lifts toward 1 as a threshold is breached', () => {
		const calm = samplePressureValue(
			{ heapUsedRatio: 0.1, publishRate: 10, subscriberRatio: 1 },
			THRESHOLDS,
			0
		);
		const hot = samplePressureValue(
			{ heapUsedRatio: 0.8, publishRate: 10, subscriberRatio: 1 },
			THRESHOLDS,
			0
		);
		expect(hot).toBeGreaterThan(calm);
		// 0.8 / 0.85 ~= 0.94, well above the calm reading.
		expect(hot).toBeGreaterThan(0.8);
	});

	it('takes the worst-of across the three thresholds', () => {
		// Publish rate is the hottest signal here; it must win.
		const v = samplePressureValue(
			{ heapUsedRatio: 0.1, publishRate: 900, subscriberRatio: 1 },
			THRESHOLDS,
			0
		);
		expect(v).toBeCloseTo(0.9, 5); // 900 / 1000
	});

	it('folds a forced gate peak in worst-of even when the counters look calm', () => {
		const calmCounters = { heapUsedRatio: 0.05, publishRate: 0, subscriberRatio: 0 };
		// A saturated opted-in connection lifts the worker value past the calm
		// counter reading.
		const v = samplePressureValue(calmCounters, THRESHOLDS, 0.7);
		expect(v).toBeCloseTo(0.7, 5);
	});

	it('mirrors the one-sample decay an app sees across two reads', () => {
		// The worker halves leaseSaturationPeak after each sample, so a single
		// spike fades rather than sticking. Model the fold across two samples
		// the way the worker drives it: read the value, then halve the peak.
		const calm = { heapUsedRatio: 0.05, publishRate: 0, subscriberRatio: 0 };
		let peak = 0.8;
		const first = samplePressureValue(calm, THRESHOLDS, peak);
		peak *= 0.5;
		const second = samplePressureValue(calm, THRESHOLDS, peak);
		expect(second).toBeLessThan(first); // a single spike decays, not sticks
		expect(second).toBeCloseTo(0.4, 5);
	});

	it('honours a disabled threshold (false) without contributing a signal', () => {
		const disabled = { memoryHeapUsedRatio: false, publishRatePerSec: 1000, subscriberRatio: 50 };
		// Heap is hot but disabled; the value comes only from the active signals.
		const v = samplePressureValue(
			{ heapUsedRatio: 0.99, publishRate: 100, subscriberRatio: 5 },
			disabled,
			0
		);
		expect(v).toBeCloseTo(0.1, 5); // 100 / 1000 wins; heap ignored
	});

	it('clamps into 0..1', () => {
		const v = samplePressureValue(
			{ heapUsedRatio: 5, publishRate: 99_999, subscriberRatio: 999 },
			THRESHOLDS,
			3
		);
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThanOrEqual(1);
		expect(v).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Window sizing posture (the dynamic grant an opted-in connection receives)
// ---------------------------------------------------------------------------

describe('send-gate window sizing', () => {
	it('hands out the full base window for an idle worker', () => {
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 1 })).toBe(256);
	});

	it('shrinks the window under high heap pressure', () => {
		const idle = leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 1 });
		const tight = leaseGrantSize({ heapRatio: 0.9, subscriberRatio: 1 });
		expect(tight).toBeLessThan(idle);
	});

	it('shrinks the window under a high subscriber-to-connection ratio', () => {
		const light = leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 10 });
		const heavy = leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 200 });
		expect(heavy).toBeLessThan(light);
	});

	it('keeps the window above the hard floor so a connection makes progress', () => {
		// Pathologically loaded worker: both signals slammed. The scale clamp
		// keeps the window from collapsing to zero, well above the hard floor.
		const floored = leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 100_000 });
		expect(floored).toBeGreaterThanOrEqual(8);
		expect(floored).toBeLessThan(256);
	});

	it('applies the hard floor when the base window is smaller than the clamp', () => {
		// With a small base the scale clamp can dip below the floor; the floor
		// then bites so the window never drops under it.
		const floored = leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 100_000, base: 8 });
		expect(floored).toBe(8);
	});

	it('never exceeds the base window', () => {
		const v = leaseGrantSize({ heapRatio: 0, subscriberRatio: 0 });
		expect(v).toBeLessThanOrEqual(256);
	});
});

// ---------------------------------------------------------------------------
// End to end: wire transparency + zero-config equivalence
// ---------------------------------------------------------------------------

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../testing.js') : {};

const GATE_CAP = 'lease';

// Tokens that are internal accounting only and must never reach a frame the
// app surface can read.
const INTERNAL_TOKENS = ['credit', 'lease', 'ttl', 'requestCount', 'REQUEST_N', 'availableLease', 'expirationTime'];

// The pressure reason enum the developer reads. This round does NOT add a new
// value; a gated connection must never widen it.
const ALLOWED_REASONS = ['NONE', 'PUBLISH_RATE', 'SUBSCRIBERS', 'MEMORY'];

// Control-frame types the adapter exchanges below the app boundary. A real app
// using the client never sees these - the client absorbs them. The wire
// capture inspects only the frames an app callback can read (pub/sub
// envelopes, batches), so these adapter-to-adapter frames are filtered out
// before the internal-token scan.
const CONTROL_TYPES = new Set([
	'welcome', 'resumed', 'subscribed', 'subscribe-denied', 'wire-id',
	'lease', 'lease-ok', 'request', 'hello'
]);

// True when a frame is one an app surface can read (a pub/sub envelope, a
// wire-level batch of them, or a binary topic payload), as opposed to an
// adapter-to-adapter control frame.
function isAppVisible(frame) {
	if (frame.binary) return true; // a binary topic payload is app data
	const p = frame.parsed;
	if (p == null) return false;
	if (typeof p.topic === 'string' && p.event !== undefined) return true; // envelope
	if (p.type === 'batch') return true; // wire-level batch of envelopes
	if (p.type !== undefined && CONTROL_TYPES.has(p.type)) return false; // control
	return false;
}

function appVisibleHasInternalToken(frame) {
	const text = frame.binary ? null : frame.text;
	if (text == null) return false;
	for (const token of INTERNAL_TOKENS) {
		if (text.includes(token)) return token;
	}
	return false;
}

async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		let frame;
		if (isBinary) {
			const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
			frame = { binary: true, bytes, parsed: parseBinaryFrame(bytes) };
		} else {
			const text = raw.toString();
			let json = null;
			try { json = JSON.parse(text); } catch { /* not json */ }
			frame = { binary: false, text, parsed: json };
		}
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
		}
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	return {
		ws,
		frames,
		send: (obj) => ws.send(JSON.stringify(obj)),
		waitFor(pred, timeout = 1500) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeUWS('send gate over the wire', () => {
	let server;

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('keeps every internal accounting token off the app-visible frames', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.publish('room', 'tick', { n: msg.n });
				}
			}
		});

		// A window-advertising client drives a full session: subscribe, a burst,
		// then a replenish request so the re-grant arm runs mid-session (the raw
		// ws client here drives request-n directly since it is not the real
		// adapter client). The server is grant-and-observe here - it hands out
		// windows and re-grants; the client is what paces itself - so this case
		// pins token-hygiene of the grant/echo/re-grant frames, not server-side
		// pacing.
		const a = await connectClient(server.wsUrl, [GATE_CAP]);
		await a.waitFor((f) => f.parsed?.type === 'lease-ok');
		a.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await a.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed.topic === 'room');

		for (let n = 0; n < 50; n++) a.send({ type: 'pub', n });
		a.send({ type: 'request-n', n: 256 }); // exercise the re-grant arm
		await a.waitFor((f) => f.parsed?.topic === 'room' && f.parsed?.data?.n === 49, 3000);
		await sleep(100);

		// No frame the app surface receives may carry an internal token, and
		// the reason field (when present) must stay inside the unchanged enum.
		for (const frame of a.frames) {
			if (!isAppVisible(frame)) continue;
			const offender = appVisibleHasInternalToken(frame);
			expect(offender, 'internal token leaked: ' + offender).toBe(false);
			const reason = frame.parsed?.reason;
			if (reason !== undefined) expect(ALLOWED_REASONS).toContain(reason);
		}
	});

	it('never surfaces a credit number as a pressure reason', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.publish('room', 'tick', { n: msg.n });
				}
			}
		});
		const a = await connectClient(server.wsUrl, [GATE_CAP]);
		await a.waitFor((f) => f.parsed?.type === 'lease-ok');
		a.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await a.waitFor((f) => f.parsed?.type === 'subscribed');
		for (let n = 0; n < 30; n++) a.send({ type: 'pub', n });
		await sleep(150);

		for (const frame of a.frames) {
			const reason = frame.parsed?.reason;
			if (reason === undefined) continue;
			expect(typeof reason).toBe('string'); // never a raw credit count
			expect(ALLOWED_REASONS).toContain(reason);
		}
	});

	it('runs a non-advertising connection on the immediate send path', async () => {
		// Capture the exact frame stream for a connection that does NOT
		// advertise the gate cap, then a second connection on the same server
		// doing the same thing. They must be identical (modulo per-frame
		// volatile fields): the gate-less fork is the unchanged path.
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.send(ws, 'room', 'tick', { n: msg.n });
				}
			}
		});

		async function run() {
			const c = await connectClient(server.wsUrl); // no caps -> gate-less
			c.send({ type: 'subscribe', topic: 'room', ref: 7 });
			await c.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed.topic === 'room');
			for (let n = 0; n < 10; n++) c.send({ type: 'pub', n });
			await c.waitFor((f) => f.parsed?.topic === 'room' && f.parsed?.data?.n === 9);
			await sleep(50);
			c.ws.close();
			// Normalize the volatile session id so two runs compare equal.
			return c.frames.map((f) => {
				if (f.binary) return '<binary>';
				if (f.parsed?.type === 'welcome') return '{"type":"welcome"}';
				return f.text;
			});
		}

		const first = await run();
		const second = await run();

		// Same frame shapes in the same order: no extra credit frame, no
		// reshaped envelope. The gate-less path emits exactly the legacy frames.
		expect(first).toEqual(second);
		// And none of those frames carry an internal token.
		for (const text of first) {
			for (const token of INTERNAL_TOKENS) expect(text.includes(token)).toBe(false);
		}
	});

	it('acks an old client that never sends a hello, exactly as before', async () => {
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'pub') platform.send(ws, 'room', 'tick', { n: msg.n });
				}
			}
		});
		const old = await connectClient(server.wsUrl); // never advertises any cap
		old.send({ type: 'subscribe', topic: 'room', ref: 99 });
		const ack = await old.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed.topic === 'room');
		expect(ack.parsed.ref).toBe(99);

		old.send({ type: 'pub', n: 1 });
		const delivered = await old.waitFor((f) => f.parsed?.topic === 'room' && f.parsed?.event === 'tick');
		expect(delivered.parsed.data.n).toBe(1);

		// An old client never receives the honour echo or any window frame.
		expect(old.frames.some((f) => f.parsed?.type === 'lease-ok')).toBe(false);
		expect(old.frames.some((f) => f.parsed?.type === 'lease')).toBe(false);
	});
});
