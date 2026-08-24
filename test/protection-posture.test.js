// Live coupling for the graduated protection posture on createTestServer:
//
//   - the default is byte-identical to today's reject path (the jittered 503
//     envelope, the bare 503, no CAPACITY reason while normal),
//   - platform.protection reflects the live (here pinned) level and CAPACITY
//     layers onto the pressure reason once engaged,
//   - a pinned siege forces the refuse / static-serve path and an always-202
//     admit-check, even while the gate has free slots,
//   - elevated widens the Retry-After jitter past today's envelope, and
//   - an already-open connection is never disturbed when the posture moves.
//
// The pure createPosture / applyCapacityReason assertions live in
// protection-posture-unit.test.js (no uWebSockets.js import) so they evaluate
// deterministically under every pool worker. This file holds only the live
// integration, and runs its server-backed describe blocks sequentially so two
// uWS instances never contend on port/socket churn within the file.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe.sequential : describe.skip;

let server;

// Every ws client this file opens is tracked here so afterEach can force every
// socket closed before the next server binds. A lingering client racing the
// next listen() is the cross-test contention that made this suite flaky under
// the default pool; draining them in teardown removes the race.
/** @type {Set<import('ws').WebSocket>} */
const liveSockets = new Set();

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LIB_ACCEPT = 'application/json';

const BARE_503_BODY = 'Server is at upgrade capacity, please retry';

/**
 * Drive a single HTTP upgrade and resolve a normalized outcome. A handshake
 * resolves `opened`; any non-101 (the 503 or the 200 holding page) arrives via
 * `unexpected-response` and is drained for body + headers; an attempt that
 * neither opens nor draws a response within `settleMs` resolves `pending` so a
 * burst can never hang on a parked upgrade.
 */
async function attemptUpgrade(url, headers, settleMs = 800) {
	const { WebSocket } = await import('ws');
	return await new Promise((resolve) => {
		const ws = new WebSocket(url, headers ? { headers } : undefined);
		liveSockets.add(ws);
		ws.on('close', () => liveSockets.delete(ws));
		const result = { opened: false, pending: false, status: null, headers: null, body: '', ws };
		let settled = false;
		const done = () => { if (!settled) { settled = true; resolve(result); } };
		const timer = setTimeout(() => { result.pending = true; done(); }, settleMs);
		ws.on('open', () => { result.opened = true; clearTimeout(timer); done(); });
		ws.on('unexpected-response', (_req, res) => {
			result.status = res.statusCode;
			result.headers = res.headers;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => { result.body = Buffer.concat(chunks).toString('utf8'); clearTimeout(timer); done(); });
			res.on('error', () => { result.body = Buffer.concat(chunks).toString('utf8'); clearTimeout(timer); done(); });
		});
		ws.on('error', () => {
			if (result.status === null && !result.opened) { clearTimeout(timer); done(); }
		});
	});
}

/**
 * A gate-holding upgrade hook. Each in-flight upgrade parks on a shared promise
 * so the caller decides exactly when slots free. `passFirst` upgrades resolve
 * immediately so a test can establish a live connection before the gate is
 * pinned full by the parked remainder.
 */
function makeHeldGate(opts = {}) {
	const passFirst = opts.passFirst || 0;
	let releaseAll;
	const gate = new Promise((r) => { releaseAll = r; });
	let seen = 0;
	let inFlight = 0;
	return {
		get inFlight() { return inFlight; },
		release() { releaseAll(); },
		hook: {
			async upgrade() {
				seen++;
				if (seen <= passFirst) return {};
				inFlight++;
				await gate;
				inFlight--;
				return {};
			}
		}
	};
}

function burst(url, n, headers) {
	return Promise.all(Array.from({ length: n }, () => attemptUpgrade(url, headers)));
}

function closeAll(results) {
	for (const r of results) {
		const ws = r && r.ws;
		if (!ws) continue;
		try {
			if (r.opened) ws.close();
			else ws.terminate();
		} catch { /* socket already gone */ }
	}
}

// Force every tracked client socket fully closed and wait for the underlying
// handles to clear. Returning a promise that settles on `close` (or a short
// fallback) keeps a prior test's clients from racing the next server bind.
function drainSockets() {
	const pending = [];
	for (const ws of liveSockets) {
		const settled = new Promise((resolve) => {
			let done = false;
			const fin = () => { if (!done) { done = true; resolve(); } };
			ws.once('close', fin);
			// Fallback: a socket that is already gone never emits another close.
			setTimeout(fin, 50);
		});
		pending.push(settled);
		try { ws.terminate(); } catch { /* already gone */ }
	}
	liveSockets.clear();
	return Promise.all(pending);
}

async function poll(baseUrl, path = '/__admit-check') {
	const res = await fetch(baseUrl + path);
	let body = null;
	try { body = await res.json(); } catch { body = null; }
	return { status: res.status, headers: res.headers, body };
}

describeUWS('protection posture coupling on createTestServer', () => {
	afterEach(async () => {
		// Drain client sockets first so no lingering ws races the next bind, then
		// close the server and clear the holder. Both are awaited so the next
		// test starts from a fully torn-down state.
		await drainSockets();
		await server?.close();
		server = null;
	});

	describe('zero config is a no-op', () => {
		it('leaves platform.protection at normal when protection is absent', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({ upgradeAdmission: { maxConcurrent: 1 } });
			expect(server.platform.protection).toBe('normal');
		});

		it('serves the identical jittered 503 envelope the waiting room serves today', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const base = 10;
			const held = makeHeldGate();
			// protection absent: the reject path must match today's contract exactly.
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: { retryAfterSeconds: base } },
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);

			expect(shed.length).toBeGreaterThan(0);
			for (const r of shed) {
				const seconds = Number(r.headers['retry-after']);
				expect(Number.isInteger(seconds)).toBe(true);
				// The today envelope: [base, base + floor(base*0.5)].
				expect(seconds).toBeGreaterThanOrEqual(base);
				expect(seconds).toBeLessThanOrEqual(base + Math.floor(base * 0.5));
			}

			held.release();
			closeAll(results);
		});

		it('keeps the bare 503 body byte-for-byte when the waiting room is opted out, with the shared backoff header', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: false },
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, { accept: HTML_ACCEPT });
			const shed = results.filter((r) => r.status === 503);

			expect(shed.length).toBeGreaterThan(0);
			for (const r of shed) {
				expect(r.body).toBe(BARE_503_BODY);
				expect(String(r.headers['content-type'])).toContain('text/plain');
				// At normal posture the opted-out refusal answers the shared
				// default band; the posture cases below pin the widened bands.
				const seconds = Number(r.headers['retry-after']);
				expect(Number.isInteger(seconds)).toBe(true);
				expect(seconds).toBeGreaterThanOrEqual(2);
				expect(seconds).toBeLessThanOrEqual(3);
			}
			expect(results.some((r) => r.status === 200)).toBe(false);

			held.release();
			closeAll(results);
		});

		it('reports no capacity reason while the posture stays normal', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({ upgradeAdmission: { maxConcurrent: 1 } });
			// A healthy idle worker is not under capacity pressure.
			expect(server.platform.protection).toBe('normal');
			expect(server.platform.pressure.reason).not.toBe('CAPACITY');
		});
	});

	describe('platform.protection reflects a pinned level', () => {
		it('reads siege when protection is pinned to siege', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'siege'
			});
			expect(server.platform.protection).toBe('siege');
		});

		it('reads elevated when protection is pinned to elevated', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'elevated'
			});
			expect(server.platform.protection).toBe('elevated');
		});

		it('surfaces CAPACITY on the pressure reason once protection is engaged', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'elevated'
			});
			// CAPACITY layers in once the posture is engaged and no higher-urgency
			// reason (MEMORY) is active on an idle worker.
			expect(server.platform.pressure.reason).toBe('CAPACITY');
		});
	});

	describe('siege drives the waiting room hard', () => {
		it('refuses every real WebSocket handshake under a pinned siege', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 50 },
				protection: 'siege'
			});

			// The gate has ample raw capacity (50), yet a pinned siege refuses
			// new upgrades regardless: nothing in the burst gets a live socket.
			const results = await burst(server.wsUrl, 6, { accept: HTML_ACCEPT });
			expect(results.some((r) => r.opened)).toBe(false);
			expect(results.every((r) => r.status === 503 || r.pending)).toBe(true);

			closeAll(results);
		});

		it('returns 202 from admit-check at siege even while the gate has free slots', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 50 },
				protection: 'siege'
			});

			// hasCapacity() would say yes (no in-flight upgrades), but a sieged
			// poll must always report no-admit so clients keep waiting.
			const r = await poll(server.url);
			expect(r.status).toBe(202);
			expect(r.body).toBeTruthy();
			expect(r.body.admit).toBe(false);
		});

		it('refuses a non-HTML upgrade with a 503 under a pinned siege', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 50 },
				protection: 'siege'
			});

			const results = await burst(server.wsUrl, 4, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);
			expect(shed.length).toBeGreaterThan(0);
			expect(results.some((r) => r.opened)).toBe(false);

			closeAll(results);
		});
	});

	describe('elevated widens the Retry-After jitter', () => {
		it('lifts the refusal Retry-After above the normal envelope at elevated', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const base = 10;
			const held = makeHeldGate();
			// Elevated does not refuse new upgrades on its own - it widens the
			// jitter on the refusal that the FULL gate already produces. Hold the
			// single slot so the library burst lands on the reject path, where
			// the elevated spread widens the Retry-After band past today's.
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: { retryAfterSeconds: base } },
				protection: 'elevated',
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 24, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);
			expect(shed.length).toBeGreaterThan(0);

			const normalCap = base + Math.floor(base * 0.5);
			let sawWider = false;
			for (const r of shed) {
				const seconds = Number(r.headers['retry-after']);
				expect(Number.isInteger(seconds)).toBe(true);
				// Never below the base; a generous DoS-safe upper bound keeps the
				// widened band bounded without locking the exact widen factor.
				expect(seconds).toBeGreaterThanOrEqual(base);
				expect(seconds).toBeLessThanOrEqual(4 * base);
				if (seconds > normalCap) sawWider = true;
			}
			// Across a wide burst the elevated band must reach past the normal cap
			// at least once; a band that never exceeds it has not widened.
			expect(sawWider).toBe(true);

			held.release();
			closeAll(results);
		});
	});

	describe('normal leaves the waiting room behavior unchanged', () => {
		it('serves the 200 holding page to a browser navigation exactly as today', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'normal',
				handler: held.hook
			});

			const page = await fetch(server.url + '/__waiting-room', {
				headers: { accept: HTML_ACCEPT }
			});
			const body = await page.text();
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			expect(body).toContain('/__admit-check');

			held.release();
		});

		it('returns 200 admit:true from admit-check when the gate is idle at normal', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'normal'
			});
			const r = await poll(server.url);
			expect(r.status).toBe(200);
			expect(r.body.admit).toBe(true);
		});
	});

	describe('existing connections survive a posture change', () => {
		it('leaves an open connection alive when the level moves to siege under it', async () => {
			const { createTestServer } = await import('../src/testing.js');
			let closedCode = null;
			const held = makeHeldGate({ passFirst: 1 });
			// Start at normal so the first upgrade opens a live socket, then move
			// the level to siege beneath it and prove the open socket is untouched.
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			const first = await attemptUpgrade(server.wsUrl);
			expect(first.opened).toBe(true);

			let firstClosedUnexpectedly = false;
			first.ws.on('close', (code) => {
				closedCode = code;
				if (code !== 1000 && code !== 1001) firstClosedUnexpectedly = true;
			});

			// Force the level to siege via the harness seam (the same shape as
			// __chaos): every NEW upgrade is now refused, but the live socket must
			// not be reached at all.
			server.platform.__setProtection('siege');
			expect(server.platform.protection).toBe('siege');

			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			expect(results.some((r) => r.opened)).toBe(false);
			expect(results.some((r) => r.status === 503 || r.pending)).toBe(true);

			// The original connection is still open and was never closed by the
			// move to siege.
			expect(first.ws.readyState).toBe(first.ws.OPEN);
			expect(firstClosedUnexpectedly).toBe(false);
			expect(closedCode).toBeNull();

			held.release();
			first.ws.close();
			closeAll(results);
		});

		it('keeps a live connection open while admit-check is polled after siege engages', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate({ passFirst: 1 });
			// Open a live socket at normal, then engage siege beneath it.
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 50 },
				handler: held.hook
			});

			const first = await attemptUpgrade(server.wsUrl);
			expect(first.opened).toBe(true);
			let dropped = false;
			first.ws.on('close', (code) => { if (code !== 1000 && code !== 1001) dropped = true; });

			server.platform.__setProtection('siege');

			// Hammering the poll under siege must report no-admit and must not
			// reach the live socket.
			for (let i = 0; i < 5; i++) {
				const r = await poll(server.url);
				expect(r.status).toBe(202);
				expect(r.body.admit).toBe(false);
			}

			expect(first.ws.readyState).toBe(first.ws.OPEN);
			expect(dropped).toBe(false);

			held.release();
			first.ws.close();
		});
	});
});
