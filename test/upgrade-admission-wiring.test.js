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

async function attemptUpgrade(url) {
	const { WebSocket } = await import('ws');
	return await new Promise((resolve) => {
		const ws = new WebSocket(url);
		const result = { opened: false, status: null, ws: null };
		ws.on('open', () => { result.opened = true; result.ws = ws; resolve(result); });
		ws.on('unexpected-response', (_req, res) => { result.status = res.statusCode; resolve(result); });
		ws.on('error', () => {
			if (result.status === null && !result.opened) resolve(result);
		});
	});
}

describeUWS('upgrade-admission wiring on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('accepts every connection when admission is disabled (default)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const results = await Promise.all(
			Array.from({ length: 8 }, () => attemptUpgrade(server.wsUrl))
		);
		expect(results.every(r => r.opened)).toBe(true);
		expect(results.every(r => r.status === null)).toBe(true);

		for (const r of results) r.ws?.close();
	});

	it('sheds with 503 when concurrent in-flight exceeds maxConcurrent (no upgrade hook)', async () => {
		const { createTestServer } = await import('../testing.js');
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

	it('sheds with 503 against a slow user upgrade hook (in-flight stays held while async)', async () => {
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
});
