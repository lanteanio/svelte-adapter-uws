// Integration coverage for the content-negotiated waiting room presented
// alongside the upgrade gate when it reaches capacity. Complements
// upgrade-admission-wiring.test.js (which proves the gate sheds with 503) by
// asserting that a real HTTP navigation gets a holding document, every actual
// WebSocket handshake keeps a retry response even with an HTML Accept header,
// the opt-out navigation gets a minimal accessible 503, and the poll endpoint
// reports capacity without ever taking a gate slot.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LIB_ACCEPT = 'application/json';

// The original bare-503 contract, anchored as exact bytes so the opt-out path
// cannot drift. Mirrors the gate reject site's writeStatus / content-type / end.
const BARE_503_BODY = 'Server is at upgrade capacity, please retry';

/**
 * Drive a single HTTP upgrade against the test server and resolve a normalized
 * outcome. A successful handshake resolves `opened: true`; any non-101 status
 * (the gate's 503, or the waiting room's 200 HTML) arrives via the ws client's
 * `unexpected-response` event, whose `res` is a plain http.IncomingMessage - so
 * we drain its body and snapshot its headers for assertions.
 *
 * An upgrade that neither opens nor draws a response within `settleMs` (e.g. a
 * connection deliberately parked inside the held gate to pin capacity) resolves
 * as `{ pending: true }` so a Promise.all over a burst can never hang on it.
 *
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @param {number} [settleMs]
 */
async function attemptUpgrade(url, headers, settleMs = 800) {
	const { WebSocket } = await import('ws');
	return await new Promise((resolve) => {
		const ws = new WebSocket(url, headers ? { headers } : undefined);
		const result = { opened: false, pending: false, status: null, headers: null, body: '', ws };
		let settled = false;
		const done = () => { if (!settled) { settled = true; resolve(result); } };
		const timer = setTimeout(() => { result.pending = true; done(); }, settleMs);
		ws.on('open', () => {
			result.opened = true;
			clearTimeout(timer);
			done();
		});
		ws.on('unexpected-response', (_req, res) => {
			result.status = res.statusCode;
			result.headers = res.headers;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				result.body = Buffer.concat(chunks).toString('utf8');
				clearTimeout(timer);
				done();
			});
			res.on('error', () => {
				result.body = Buffer.concat(chunks).toString('utf8');
				clearTimeout(timer);
				done();
			});
		});
		ws.on('error', () => {
			if (result.status === null && !result.opened) { clearTimeout(timer); done(); }
		});
	});
}

/**
 * A gate-holding upgrade hook. Each in-flight upgrade parks on a shared promise
 * so the caller controls exactly when slots free, making the gate's full/empty
 * state deterministic instead of racing a fixed timer. `release()` lets every
 * parked upgrade complete; `inFlight` reports how many are currently parked.
 *
 * `passFirst` upgrades resolve immediately (their gate slot frees once the
 * handshake completes) so a test can establish a live connection before the
 * gate is pinned full by the parked remainder.
 *
 * @param {{ passFirst?: number }} [opts]
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

/** Fire `n` upgrade attempts at once with the same Accept header. */
function burst(url, n, headers) {
	return Promise.all(Array.from({ length: n }, () => attemptUpgrade(url, headers)));
}

/**
 * Tear down every ws client from a burst. Opened sockets get a clean close;
 * rejected or still-parked sockets get terminated so no handle is left dangling
 * past the test.
 */
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

/** GET the poll endpoint as plain HTTP and parse the JSON body. */
async function poll(baseUrl, path = '/__admit-check') {
	const res = await fetch(baseUrl + path);
	let body = null;
	try { body = await res.json(); } catch { body = null; }
	return { status: res.status, headers: res.headers, body };
}

describeUWS('upgrade waiting room on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	describe('content negotiation at capacity', () => {
		it('serves a 200 HTML holding page to a real browser navigation', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: { admitCheckPath: '/__admit-check' } },
				handler: held.hook
			});

			const pending = attemptUpgrade(server.wsUrl, { accept: LIB_ACCEPT });
			await waitFor(() => held.inFlight >= 1);
			const page = await fetch(server.url + '/__waiting-room', {
				headers: { accept: HTML_ACCEPT }
			});
			const body = await page.text();

			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			expect(page.headers.get('content-language')).toBe('en');
			expect(page.headers.get('vary')).toBeNull();
			// The holding page must wire the browser to the poll endpoint.
			expect(body).toContain('/__admit-check');
			// A holding page is never a bare 503 refusal.
			expect(page.headers.get('retry-after')).toBeNull();

			held.release();
			closeAll([await pending]);
		});

		it('keeps a 503 with Retry-After for a real WebSocket even with HTML Accept', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const base = 10;
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: { retryAfterSeconds: base } },
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);

			expect(shed.length).toBeGreaterThan(0);
			for (const r of shed) {
				const retryAfter = r.headers['retry-after'];
				expect(retryAfter).toBeDefined();
				const seconds = Number(retryAfter);
				expect(Number.isInteger(seconds)).toBe(true);
				// jitter = base + floor(random() * base * 0.5) -> [base, base + floor(base*0.5)]
				expect(seconds).toBeGreaterThanOrEqual(base);
				expect(seconds).toBeLessThanOrEqual(base + Math.floor(base * 0.5));
				// A library refusal is a 503, never an HTML page.
				expect(String(r.headers['content-type'])).not.toContain('text/html');
			}

			held.release();
			closeAll(results);
		});
	});

	describe('opt-out preserves one content-negotiated document baseline', () => {
		it('serves a minimal accessible HTML 503 when waitingRoom is false', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: false },
				handler: held.hook
			});

			const pending = attemptUpgrade(server.wsUrl, { accept: LIB_ACCEPT });
			await waitFor(() => held.inFlight >= 1);
			const response = await fetch(server.url + '/ws', {
				headers: { accept: HTML_ACCEPT }
			});
			const body = await response.text();

			expect(response.status).toBe(503);
			expect(response.headers.get('content-type')).toContain('text/html');
			expect(response.headers.get('content-language')).toBe('en');
			expect(body).toMatch(/^<!doctype html><html lang="en" dir="ltr"/);
			expect(body).toContain('<title>Service unavailable</title>');
			expect(body).toContain('<main>');
			expect(body).toContain('role="status"');
			expect(body).toContain('<form method="get">');
			expect(response.headers.get('retry-after')).toBeNull();

			held.release();
			closeAll([await pending]);
		});

		it('keeps the exact bare text 503 for a non-HTML client', async () => {
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
				expect(r.headers['content-language']).toBeUndefined();
				expect(r.headers['retry-after']).toBeUndefined();
			}

			held.release();
			closeAll(results);
		});
	});

	describe('zero-config default-on', () => {
		it('engages the waiting room with maxConcurrent set and waitingRoom omitted', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			const pending = attemptUpgrade(server.wsUrl, { accept: LIB_ACCEPT });
			await waitFor(() => held.inFlight >= 1);
			const page = await fetch(server.url + '/__waiting-room', {
				headers: { accept: HTML_ACCEPT }
			});
			const body = await page.text();

			// Default-on: a browser navigation gets the holding page without any
			// explicit waitingRoom config.
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			expect(body).toContain('/__admit-check');

			held.release();
			closeAll([await pending]);
		});

		it('refines the non-HTML refusal with a Retry-After under zero config', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);

			expect(shed.length).toBeGreaterThan(0);
			for (const r of shed) {
				expect(r.headers['retry-after']).toBeDefined();
				expect(Number.isInteger(Number(r.headers['retry-after']))).toBe(true);
			}

			held.release();
			closeAll(results);
		});
	});

	describe('per-request localization renderer', () => {
		const renderer = ({ request }) => {
			const acceptLanguage = request.headers.get('accept-language') || '';
			const arabic = acceptLanguage.toLowerCase().startsWith('ar');
			return {
				body: '<!doctype html><html lang="stale" dir="ltr"><head><title>Hold</title></head>' +
					'<body><main><h1>Hold</h1><p role="status" aria-live="polite">' +
					(arabic ? 'Localized ar' : 'Localized en') + '</p>' +
					'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
				lang: arabic ? 'ar' : 'en',
				dir: arabic ? 'rtl' : 'ltr',
				headers: {
					'x-waiting-room-method': request.method,
					'x-waiting-room-url': request.url
				}
			};
		};

		it('localizes direct holding-page navigation and writes language variation headers', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: {
					maxConcurrent: 1,
					waitingRoom: { renderer }
				}
			});

			const response = await fetch(server.url + '/__waiting-room?source=direct', {
				headers: { 'accept-language': 'ar-EG,ar;q=0.9' }
			});
			const body = await response.text();
			expect(response.status).toBe(200);
			expect(response.headers.get('content-language')).toBe('ar');
			expect(response.headers.get('vary')).toBe('Accept-Language');
			expect(response.headers.get('x-waiting-room-method')).toBe('GET');
			expect(response.headers.get('x-waiting-room-url')).toBe('/__waiting-room?source=direct');
			expect(body).toContain('<html lang="ar" dir="rtl">');
			expect(body).toContain('Localized ar');
			expect(body).not.toContain('lang="stale"');
		});

		it('does not render localized HTML for a real WebSocket handshake', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: {
					maxConcurrent: 1,
					waitingRoom: { renderer }
				},
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, {
				accept: HTML_ACCEPT,
				'accept-language': 'ar'
			});
			const shed = results.filter((result) => result.status === 503);
			expect(shed.length).toBeGreaterThan(0);
			for (const refusal of shed) {
				expect(String(refusal.headers['content-type'])).toContain('text/plain');
				expect(refusal.headers['content-language']).toBeUndefined();
				expect(refusal.headers['x-waiting-room-method']).toBeUndefined();
				expect(refusal.body).toBe(BARE_503_BODY);
			}

			held.release();
			closeAll(results);
		});

		it('keeps the exact bare text 503 for a non-HTML client', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1, waitingRoom: false },
				handler: held.hook
			});

			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			const shed = results.filter((r) => r.status === 503);
			expect(shed.length).toBeGreaterThan(0);
			for (const r of shed) {
				expect(r.body).toBe(BARE_503_BODY);
				expect(String(r.headers['content-type'])).toContain('text/plain');
				expect(r.headers['content-language']).toBeUndefined();
				expect(r.headers['retry-after']).toBeUndefined();
			}

			held.release();
			closeAll(results);
		});
	});

	describe('admit-check poll endpoint', () => {
		it('returns 202 admit:false with queue context while the gate is full', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			// Pin the only slot, then wait until the hook has actually parked so
			// the gate is observably full before polling.
			const pending = attemptUpgrade(server.wsUrl, { accept: HTML_ACCEPT });
			await waitFor(() => held.inFlight >= 1);

			const r = await poll(server.url);
			expect(r.status).toBe(202);
			expect(r.body).toBeTruthy();
			expect(r.body.admit).toBe(false);
			expect(typeof r.body.queueDepth).toBe('number');
			expect(typeof r.body.estimatedSeconds).toBe('number');
			expect(typeof r.body.pollAfterMs).toBe('number');

			held.release();
			const opened = await pending;
			opened.ws?.close();
		});

		it('returns 200 admit:true when the gate has capacity', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 }
			});

			// No upgrades in flight, so the gate is empty.
			const r = await poll(server.url);
			expect(r.status).toBe(200);
			expect(r.body).toBeTruthy();
			expect(r.body.admit).toBe(true);
		});

		it('does not consume a gate slot when polled (capacity unchanged)', async () => {
			const { createTestServer } = await import('../src/testing.js');
			const held = makeHeldGate();
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			// Fill the only slot and confirm it is parked.
			const pending = attemptUpgrade(server.wsUrl, { accept: HTML_ACCEPT });
			await waitFor(() => held.inFlight >= 1);

			// Hammer the poll endpoint while full. If a poll ever acquired and
			// failed to release a slot, the gate would stay full after release
			// and the fresh attempt below would be shed.
			for (let i = 0; i < 5; i++) {
				const r = await poll(server.url);
				expect(r.status).toBe(202);
				expect(r.body.admit).toBe(false);
			}

			// Free the parked upgrade and let in-flight settle.
			held.release();
			const opened = await pending;
			opened.ws?.close();
			await waitFor(() => held.inFlight === 0);
			await new Promise((r) => setTimeout(r, 30));

			// Capacity is fully back: a quiet attempt must open. If a poll had
			// leaked a slot, this would shed with 503 instead.
			const fresh = await attemptUpgrade(server.wsUrl, { accept: HTML_ACCEPT });
			expect(fresh.opened).toBe(true);
			fresh.ws?.close();
		});
	});

	describe('no rejection path means no waiting room', () => {
		it('never engages the waiting room when maxConcurrent is unset', async () => {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer();

			// The gate never rejects, so even a browser-Accept burst opens.
			const results = await burst(server.wsUrl, 8, { accept: HTML_ACCEPT });
			expect(results.every((r) => r.opened)).toBe(true);
			expect(results.some((r) => r.status === 200)).toBe(false);
			expect(results.some((r) => r.status === 503)).toBe(false);

			closeAll(results);
		});
	});

	describe('existing connections are untouched', () => {
		it('leaves an open connection alive when a later upgrade is rejected', async () => {
			const { createTestServer } = await import('../src/testing.js');
			let closedCode = null;
			// passFirst lets the first upgrade complete cleanly (its slot frees on
			// handshake); every later upgrade parks, pinning the single-slot gate
			// full so newcomers are rejected while the first connection lives.
			const held = makeHeldGate({ passFirst: 1 });
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				handler: held.hook
			});

			const first = await attemptUpgrade(server.wsUrl);
			expect(first.opened).toBe(true);

			let firstClosedUnexpectedly = false;
			first.ws.on('close', (code) => {
				closedCode = code;
				// 1000/1001 are clean shutdowns; anything else mid-test is a kill.
				if (code !== 1000 && code !== 1001) firstClosedUnexpectedly = true;
			});

			// A burst overruns the single-slot gate. One parks (pinning the slot,
			// resolving as pending here), the rest are rejected with 503. None of
			// this may disturb the already-open connection.
			const results = await burst(server.wsUrl, 6, { accept: LIB_ACCEPT });
			expect(results.every((r) => r.status === 503 || r.opened || r.pending)).toBe(true);
			expect(results.some((r) => r.status === 503)).toBe(true);

			// The original connection is still open and was not closed by the
			// rejection of newcomers.
			expect(first.ws.readyState).toBe(first.ws.OPEN);
			expect(firstClosedUnexpectedly).toBe(false);
			expect(closedCode).toBeNull();

			held.release();
			first.ws.close();
			closeAll(results);
		});
	});
});

/**
 * Poll a predicate until it is truthy or a deadline passes. Cheap spin used to
 * wait for the held gate to actually park an upgrade before asserting on the
 * gate's full/empty state.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 2000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}
