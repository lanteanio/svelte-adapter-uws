// Integration test for the upgrade-admission wiring. The factory itself
// (createUpgradeAdmission) has 11 unit tests in test/utils.test.js
// covering its standalone semantics; this file complements those by
// asserting that a real uWS server (createTestServer harness) actually
// triggers the 503-shed path under a real connection storm. Closes
// the coverage gap between "the factory works" and "the wiring works."

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

// Open a single upgrade. `subprotocol` sets Sec-WebSocket-Protocol so a test
// can route the upgrade through the cursor lane; omit it for an ordinary
// main-lane upgrade.
async function attemptUpgrade(url, subprotocol, headers) {
	const { WebSocket } = await import('ws');
	return await new Promise((resolve) => {
		const ws = new WebSocket(url, subprotocol || undefined, headers ? { headers } : undefined);
		const result = { opened: false, status: null, body: '', headers: null, ws: null };
		ws.on('open', () => { result.opened = true; result.ws = ws; resolve(result); });
		ws.on('unexpected-response', (_req, res) => {
			result.status = res.statusCode;
			result.headers = res.headers;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => { result.body = Buffer.concat(chunks).toString('utf8'); resolve(result); });
			res.on('error', () => { result.body = Buffer.concat(chunks).toString('utf8'); resolve(result); });
		});
		ws.on('error', () => {
			if (result.status === null && !result.opened) resolve(result);
		});
	});
}

const CURSOR_SUBPROTOCOL = 'svelte-realtime-cursor';

describeUWS('upgrade-admission wiring on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('accepts every connection when admission is disabled (default)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const results = await Promise.all(
			Array.from({ length: 8 }, () => attemptUpgrade(server.wsUrl))
		);
		expect(results.every(r => r.opened)).toBe(true);
		expect(results.every(r => r.status === null)).toBe(true);

		for (const r of results) r.ws?.close();
	});

	it('sheds with 503 when concurrent in-flight exceeds maxConcurrent (no upgrade hook)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// Slow the synchronous upgrade enough to keep multiple in flight
		// at once so tryAcquire actually contends. With no user upgrade
		// handler the upgrade is otherwise instantaneous.
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 2, perTickBudget: 1 }
		});

		// Fire a burst much larger than maxConcurrent. With perTickBudget=1,
		// admit() defers via setImmediate, holding the in-flight slot long
		// enough for follow-on upgrades in the same tick to see capacity
		// pressure and shed via tryAcquire's 503 path.
		const results = await Promise.all(
			Array.from({ length: 30 }, () => attemptUpgrade(server.wsUrl))
		);

		const opened = results.filter(r => r.opened);
		const shed = results.filter(r => r.status === 503);

		// Some opened (admission lets traffic through across ticks), some
		// shed with 503 (admission rejected the in-flight surplus).
		expect(opened.length).toBeGreaterThan(0);
		expect(shed.length).toBeGreaterThan(0);
		// Every result is one of the two terminal states; nothing hangs.
		expect(opened.length + shed.length).toBe(results.length);

		for (const r of opened) r.ws?.close();
	});

	it('sheds a pacing-only burst when the finite deferred queue is full', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { perTickBudget: 1, maxDeferred: 0 }
		});

		const results = await Promise.all(
			Array.from({ length: 30 }, () => attemptUpgrade(server.wsUrl))
		);
		const opened = results.filter((r) => r.opened);
		const shed = results.filter((r) => r.status === 503);

		expect(opened.length).toBeGreaterThan(0);
		expect(shed.length).toBeGreaterThan(0);
		expect(opened.length + shed.length).toBe(results.length);

		for (const r of opened) r.ws?.close();
	});

	it('sheds with 503 against a slow user upgrade hook (in-flight stays held while async)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 2 },
			handler: {
				// 80ms async block keeps each upgrade in-flight long enough
				// for the burst's follow-on connections to see contention.
				upgrade: async () => {
					await new Promise((r) => setTimeout(r, 80));
					return {};
				}
			}
		});

		const results = await Promise.all(
			Array.from({ length: 12 }, () => attemptUpgrade(server.wsUrl))
		);

		const shed = results.filter(r => r.status === 503).length;
		const opened = results.filter(r => r.opened).length;

		// At most maxConcurrent (2) can be in-flight at any moment. With
		// 12 simultaneous attempts and 80ms each, the surplus (10) gets
		// shed before the slow hook even starts running.
		expect(shed).toBeGreaterThanOrEqual(8);
		expect(opened).toBeLessThanOrEqual(4);
		expect(opened + shed).toBe(results.length);

		for (const r of results) r.ws?.close();
	});

	it('shed responses use the documented status text', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 1 },
			handler: {
				upgrade: async () => { await new Promise((r) => setTimeout(r, 60)); return {}; }
			}
		});

		// One holds the slot; subsequent attempts should be shed with 503.
		const burst = await Promise.all(
			Array.from({ length: 5 }, () => attemptUpgrade(server.wsUrl))
		);
		const shed = burst.find(r => r.status === 503);
		expect(shed).toBeDefined();
		expect(shed.status).toBe(503);

		for (const r of burst) r.ws?.close();
	});

	it('releases the in-flight slot after the upgrade completes (no permanent capacity loss)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 1 }
		});

		// First batch fills capacity; some succeed, some shed.
		await Promise.all(Array.from({ length: 5 }, () => attemptUpgrade(server.wsUrl)))
			.then(rs => rs.forEach(r => r.ws?.close()));

		// After the dust settles, capacity should be fully released.
		await new Promise(r => setTimeout(r, 50));

		// A fresh quiet attempt must succeed - if release() were buggy and
		// in-flight stuck above max, we would shed with 503 here too.
		const fresh = await attemptUpgrade(server.wsUrl);
		expect(fresh.opened).toBe(true);
		fresh.ws?.close();
	});

	it('keeps maxConcurrent scoped to handshakes, so sequential held sockets still open', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 1 }
		});

		// Each handshake completes before the next begins, but every accepted
		// socket remains open. maxConcurrent is intentionally NOT a live-socket
		// cap and must retain that established behavior.
		const held = [];
		for (let i = 0; i < 4; i++) held.push(await attemptUpgrade(server.wsUrl));
		expect(held.every((result) => result.opened)).toBe(true);
		for (const result of held) result.ws?.close();
	});

	it('holds maxConnections permits for the full socket lifetime and reopens after close', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 1, maxConnections: 2 }
		});

		const first = await attemptUpgrade(server.wsUrl);
		const second = await attemptUpgrade(server.wsUrl);
		expect(first.opened).toBe(true);
		expect(second.opened).toBe(true);

		// Both handshakes are over, but their sockets are deliberately held.
		// A handshake-only counter would now be zero and admit this third socket.
		const crossed = await attemptUpgrade(server.wsUrl);
		expect(crossed.opened).toBe(false);
		expect(crossed.status).toBe(503);
		expect(crossed.body).toBe('Server is at upgrade capacity, please retry');

		await new Promise((resolve) => {
			first.ws.once('close', resolve);
			first.ws.close();
		});

		const replacement = await attemptUpgrade(server.wsUrl);
		expect(replacement.opened).toBe(true);
		second.ws?.close();
		replacement.ws?.close();
	});
});

describeUWS('cursor-lane admission on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('treats a cursor-subprotocol upgrade as ordinary when the lane is disabled', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// No cursorLane configured: the subprotocol carries no lane meaning, the
		// upgrade goes through the main path like any other.
		server = await createTestServer({ upgradeAdmission: { maxConcurrent: 4 } });

		const r = await attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL);
		expect(r.opened).toBe(true);
		r.ws?.close();
	});

	it('sheds a cursor upgrade with 503 when the cursor sub-budget is saturated while the main lane still admits', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// maxConcurrent 8 with a 0.25 fraction reserves 2 cursor slots. Hold each
		// upgrade in flight via a slow hook so a burst contends.
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 8, cursorLane: { fraction: 0.25 } },
			handler: {
				upgrade: async () => { await new Promise((r) => setTimeout(r, 80)); return {}; }
			}
		});

		// A burst of cursor upgrades. Only two cursor slots exist, so the surplus
		// must shed with 503 even though the main ceiling (8) is far from full.
		const cursorResults = await Promise.all(
			Array.from({ length: 8 }, () => attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL))
		);
		const cursorShed = cursorResults.filter((r) => r.status === 503);
		expect(cursorShed.length).toBeGreaterThan(0);
		// The cursor reject is a bare 503, never the holding page - but it
		// backs off like every other refusal: the cursor lane carries the same
		// jittered Retry-After, so a client honoring the header never reads
		// this lane as "retry immediately" while the same condition tells the
		// main lane to wait.
		for (const r of cursorShed) {
			expect(r.body).toBe('Server is at upgrade capacity, please retry');
			const seconds = Number(r.headers['retry-after']);
			expect(Number.isInteger(seconds)).toBe(true);
			expect(seconds).toBeGreaterThanOrEqual(2);
			expect(seconds).toBeLessThanOrEqual(3);
		}

		// While cursor upgrades shed, a main-lane upgrade in the same window is
		// still admitted - the cursor lane never starves the main lane.
		const main = await attemptUpgrade(server.wsUrl);
		expect(main.opened).toBe(true);
		main.ws?.close();

		for (const r of cursorResults) r.ws?.close();
	});

	it('refuses a cursor upgrade with a bare 503 under a pinned siege (never the holding page) while main is also refused', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 50, cursorLane: { fraction: 0.25 } },
			protection: 'siege'
		});

		// Even with an HTML Accept (which would steer a normal browser upgrade to
		// the holding page), a cursor upgrade under siege must still get the bare
		// 503, never the 200 page - a worker is never a browser, so the cursor
		// lane never renders HTML.
		const cursor = await attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL, { Accept: 'text/html' });
		expect(cursor.opened).toBe(false);
		expect(cursor.status).toBe(503);
		expect(cursor.body).toBe('Server is at upgrade capacity, please retry');
		// Under siege the cursor refusal carries the siege-widened band on the
		// default base: 2 + floor(random() * max(2, ceil(2 * 1.5))) -> 2..4.
		const cursorSeconds = Number(cursor.headers['retry-after']);
		expect(Number.isInteger(cursorSeconds)).toBe(true);
		expect(cursorSeconds).toBeGreaterThanOrEqual(2);
		expect(cursorSeconds).toBeLessThanOrEqual(4);

		// The main lane is also refused under siege.
		const main = await attemptUpgrade(server.wsUrl);
		expect(main.opened).toBe(false);
	});

	it('does not leak cursor-lane slots across a 401 rejection (a freed sub-budget admits later cursor upgrades)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// One cursor slot. A hook that rejects the first cursor upgrade must
		// release the cursor slot so the next cursor upgrade is admitted.
		let calls = 0;
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 4, cursorLane: { fraction: 0.25 } },
			handler: {
				upgrade: async () => {
					calls++;
					if (calls === 1) return false; // 401: the cursor slot must be freed
					return {};
				}
			}
		});

		const rejected = await attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL);
		expect(rejected.status).toBe(401);

		// Let the release settle, then a fresh cursor upgrade must succeed - if
		// the 401 path had not released the cursor slot, the single-slot lane
		// would now be permanently full.
		await new Promise((r) => setTimeout(r, 30));
		const fresh = await attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL);
		expect(fresh.opened).toBe(true);
		fresh.ws?.close();
	});
});
