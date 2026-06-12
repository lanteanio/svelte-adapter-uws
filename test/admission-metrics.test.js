// Integration coverage for the admission counters on the upgrade path: a real
// uWS server (createTestServer harness) with a recording registry passed via
// the `metrics` option, asserting that admitted and rejected upgrades land on
// `upgrade_admitted_total` / `upgrade_rejected_total{reason}` with the right
// reason per branch. The harness mirrors the production counters at the
// branches it mirrors; the sampled gauges (posture state, in-flight, waiting
// room depth) ride the production pressure sampler and have no driver here.
// The posture transition counter is unit-covered in
// protection-posture-unit.test.js (the harness never ticks its posture).

import { describe, it, expect, afterEach, vi } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

// Open a single upgrade. `subprotocol` routes through the cursor lane when one
// is configured; `headers` set extra upgrade headers (e.g. Accept).
async function attemptUpgrade(url, subprotocol, headers) {
	const { WebSocket } = await import('ws');
	return await new Promise((resolve) => {
		const ws = new WebSocket(url, subprotocol || undefined, headers ? { headers } : undefined);
		const result = { opened: false, status: null, body: '', ws: null };
		ws.on('open', () => { result.opened = true; result.ws = ws; resolve(result); });
		ws.on('unexpected-response', (_req, res) => {
			result.status = res.statusCode;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => { result.body = Buffer.concat(chunks).toString('utf8'); resolve(result); });
			res.on('error', () => { resolve(result); });
		});
		ws.on('error', () => {
			if (result.status === null && !result.opened) resolve(result);
		});
	});
}

const CURSOR_SUBPROTOCOL = 'svelte-realtime-cursor';

// Recording registry shaped like the `metrics` option contract: positional
// counter/gauge factories, idempotent per name, label sets keyed by their
// JSON form.
function recordingRegistry() {
	const counters = new Map();
	const gauges = new Map();
	return {
		counter(name) {
			let c = counters.get(name);
			if (!c) {
				c = {
					series: new Map(),
					inc(labels) {
						const key = labels ? JSON.stringify(labels) : '';
						this.series.set(key, (this.series.get(key) || 0) + 1);
					}
				};
				counters.set(name, c);
			}
			return c;
		},
		gauge(name) {
			let g = gauges.get(name);
			if (!g) {
				g = { value: null, set(v) { this.value = v; } };
				gauges.set(name, g);
			}
			return g;
		},
		counterTotal(name) {
			const c = counters.get(name);
			if (!c) return 0;
			let sum = 0;
			for (const v of c.series.values()) sum += v;
			return sum;
		},
		reason(name, reason) {
			const c = counters.get(name);
			return c ? (c.series.get(JSON.stringify({ reason })) || 0) : 0;
		}
	};
}

describeUWS('admission metrics on createTestServer', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('counts every accepted upgrade on upgrade_admitted_total', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		server = await createTestServer({ metrics });

		const results = await Promise.all(
			Array.from({ length: 3 }, () => attemptUpgrade(server.wsUrl))
		);
		expect(results.every((r) => r.opened)).toBe(true);
		expect(metrics.counterTotal('upgrade_admitted_total')).toBe(3);
		expect(metrics.counterTotal('upgrade_rejected_total')).toBe(0);

		for (const r of results) r.ws?.close();
	});

	it('counts gate sheds as over_capacity and accounts for every attempt', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 2, perTickBudget: 1 },
			metrics
		});

		const results = await Promise.all(
			Array.from({ length: 30 }, () => attemptUpgrade(server.wsUrl))
		);
		const opened = results.filter((r) => r.opened);
		const shed = results.filter((r) => r.status === 503);
		expect(shed.length).toBeGreaterThan(0);

		expect(metrics.reason('upgrade_rejected_total', 'over_capacity')).toBe(shed.length);
		expect(metrics.counterTotal('upgrade_admitted_total')).toBe(opened.length);
		// In this abort-free run every attempt is exactly one of admitted /
		// rejected and nothing double-counts. (A client that disconnects
		// mid-upgrade is deliberately counted in neither - the counters
		// record server decisions, not client behaviour.)
		expect(metrics.counterTotal('upgrade_admitted_total') + metrics.counterTotal('upgrade_rejected_total'))
			.toBe(results.length);

		for (const r of opened) r.ws?.close();
	});

	it('counts a siege refusal under its own reason, not over_capacity', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 50 },
			protection: 'siege',
			metrics
		});

		const r = await attemptUpgrade(server.wsUrl);
		expect(r.opened).toBe(false);
		expect(r.status).toBe(503);
		expect(metrics.reason('upgrade_rejected_total', 'siege')).toBe(1);
		expect(metrics.reason('upgrade_rejected_total', 'over_capacity')).toBe(0);
		expect(metrics.counterTotal('upgrade_admitted_total')).toBe(0);
	});

	it('counts a saturated cursor lane as cursor_lane while the main lane admits', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 8, cursorLane: { fraction: 0.25 } },
			handler: {
				// Hold each slot long enough for the burst to contend.
				upgrade: async () => { await new Promise((r) => setTimeout(r, 80)); return {}; }
			},
			metrics
		});

		const cursorResults = await Promise.all(
			Array.from({ length: 8 }, () => attemptUpgrade(server.wsUrl, CURSOR_SUBPROTOCOL))
		);
		const cursorShed = cursorResults.filter((r) => r.status === 503);
		expect(cursorShed.length).toBeGreaterThan(0);
		expect(metrics.reason('upgrade_rejected_total', 'cursor_lane')).toBe(cursorShed.length);
		expect(metrics.reason('upgrade_rejected_total', 'over_capacity')).toBe(0);

		for (const r of cursorResults) r.ws?.close();
	});

	it('counts an upgrade hook refusal as auth_rejected', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		server = await createTestServer({
			handler: { upgrade: () => false },
			metrics
		});

		const r = await attemptUpgrade(server.wsUrl);
		expect(r.opened).toBe(false);
		expect(r.status).toBe(401);
		expect(metrics.reason('upgrade_rejected_total', 'auth_rejected')).toBe(1);
		expect(metrics.counterTotal('upgrade_admitted_total')).toBe(0);
	});

	it('counts a throwing upgrade hook as hook_error and never leaks the slot', async () => {
		const { createTestServer } = await import('../testing.js');
		const metrics = recordingRegistry();
		let call = 0;
		server = await createTestServer({
			// A single slot: if either throw shape leaked its in-flight slot,
			// the healthy upgrade below would shed with 503 instead of opening.
			upgradeAdmission: { maxConcurrent: 1 },
			handler: {
				// Plain function on purpose: an async hook would fold the sync
				// throw into a rejection and the two shapes would collapse.
				upgrade: () => {
					call++;
					if (call === 1) throw new Error('sync boom');
					if (call === 2) return Promise.reject(new Error('async boom'));
					return {};
				}
			},
			metrics
		});

		const sync = await attemptUpgrade(server.wsUrl);
		expect(sync.status).toBe(500);
		const async_ = await attemptUpgrade(server.wsUrl);
		expect(async_.status).toBe(500);
		expect(metrics.reason('upgrade_rejected_total', 'hook_error')).toBe(2);

		const healthy = await attemptUpgrade(server.wsUrl);
		expect(healthy.opened).toBe(true);
		expect(metrics.counterTotal('upgrade_admitted_total')).toBe(1);
		healthy.ws?.close();
	});

	it('contains a registry whose emits throw: responses, slots, and the log all survive', async () => {
		const { createTestServer } = await import('../testing.js');
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				protection: 'siege',
				metrics: {
					counter: () => ({ inc() { throw new Error('emit boom'); } }),
					gauge: () => ({ set() { throw new Error('emit boom'); } })
				}
			});

			// Siege reject still serves its refusal despite the throwing emit.
			const rejected = await attemptUpgrade(server.wsUrl);
			expect(rejected.status).toBe(503);

			await server.close();

			// And the accept path still admits with the same broken registry.
			server = await createTestServer({
				upgradeAdmission: { maxConcurrent: 1 },
				metrics: {
					counter: () => ({ inc() { throw new Error('emit boom'); } }),
					gauge: () => ({ set() { throw new Error('emit boom'); } })
				}
			});
			const first = await attemptUpgrade(server.wsUrl);
			expect(first.opened).toBe(true);
			first.ws?.close();
			// A second upgrade proves the throwing emit did not leak the slot.
			const second = await attemptUpgrade(server.wsUrl);
			expect(second.opened).toBe(true);
			second.ws?.close();
		} finally {
			errSpy.mockRestore();
		}
	});

	it('runs exactly as before when no registry is configured', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			upgradeAdmission: { maxConcurrent: 2 },
			protection: 'siege'
		});

		// Siege reject and the bare refusal body, with no registry in play.
		const r = await attemptUpgrade(server.wsUrl);
		expect(r.opened).toBe(false);
		expect(r.status).toBe(503);
	});
});
