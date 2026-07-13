import { describe, it, expect } from 'vitest';
import { classifyWorkerHealth, resolveBootTimeout, routeWorkerMessage } from '../src/runtime/worker-watchdog.js';

// The primary's per-worker health verdict, driven directly (index.js spawns real
// worker threads, so its is_primary block is not unit-drivable; this is the exact
// decision it - and the deterministic cluster sim - call). Times are plain
// monotonic-clock numbers; the two knobs are the tight steady-state timeout and the
// generous, separate boot deadline.
const OPTS = { steadyTimeoutMs: 30000, bootTimeoutMs: 60000 };

describe('classifyWorkerHealth - steady-state regime (ready worker)', () => {
	it('does not escalate a ready worker that acked within the steady timeout', () => {
		const meta = { ready: true, lastHeartbeat: 100000, spawnedAt: 0 };
		expect(classifyWorkerHealth(meta, 100000 + 30000, OPTS)).toEqual({ escalate: false });
	});

	it('escalates a ready worker gone silent past the steady timeout', () => {
		const meta = { ready: true, lastHeartbeat: 100000, spawnedAt: 0 };
		const v = classifyWorkerHealth(meta, 100000 + 30001, OPTS);
		expect(v.escalate).toBe(true);
		expect(v.regime).toBe('steady');
		expect(v.reason).toContain('no heartbeat ack');
	});

	it('judges a ready worker by lastHeartbeat only - an ancient spawnedAt never triggers the boot deadline', () => {
		// Ready + freshly acking, but spawned an hour ago. The boot deadline must not
		// apply once a worker is ready (the regime flips at ready, not at first ack).
		const meta = { ready: true, lastHeartbeat: 3_600_000, spawnedAt: 0 };
		expect(classifyWorkerHealth(meta, 3_600_000 + 5000, OPTS)).toEqual({ escalate: false });
	});
});

describe('classifyWorkerHealth - boot regime (still-booting worker)', () => {
	it('does not escalate an init that has never acked while under the boot deadline', () => {
		// lastHeartbeat 0 (never acked) - the reference clock is spawnedAt.
		const meta = { ready: false, lastHeartbeat: 0, spawnedAt: 1000 };
		expect(classifyWorkerHealth(meta, 1000 + 60000, OPTS)).toEqual({ escalate: false });
	});

	it('escalates an init wedged from its first instruction (never acked) past the boot deadline', () => {
		const meta = { ready: false, lastHeartbeat: 0, spawnedAt: 1000 };
		const v = classifyWorkerHealth(meta, 1000 + 60001, OPTS);
		expect(v.escalate).toBe(true);
		expect(v.regime).toBe('boot');
		expect(v.reason).toContain('wedged during init');
		expect(v.reason).toContain('WORKER_BOOT_TIMEOUT_MS');
	});

	it('never escalates a slow-but-healthy async init that keeps acking, however old its spawn', () => {
		// Spawned long ago but still acking every heartbeat: reference is the fresh
		// lastHeartbeat, so a genuinely slow warmup that stays responsive is safe.
		const meta = { ready: false, lastHeartbeat: 500000, spawnedAt: 0 };
		expect(classifyWorkerHealth(meta, 500000 + 10000, OPTS)).toEqual({ escalate: false });
	});

	it('escalates an init that acked at least once then wedged (stale lastHeartbeat past the boot deadline)', () => {
		const meta = { ready: false, lastHeartbeat: 500000, spawnedAt: 0 };
		const v = classifyWorkerHealth(meta, 500000 + 60001, OPTS);
		expect(v.escalate).toBe(true);
		expect(v.regime).toBe('boot');
	});
});

describe('classifyWorkerHealth - regime separation (no false-kill of slow boots)', () => {
	it('does NOT apply the tight steady timeout to a still-booting worker', () => {
		// A booting worker silent for longer than the steady timeout but under the
		// generous boot deadline must survive - this is the false-kill the two
		// distinct regimes exist to prevent.
		const meta = { ready: false, lastHeartbeat: 0, spawnedAt: 0 };
		const midway = OPTS.steadyTimeoutMs + 1; // 30001ms: past steady, well under boot
		expect(classifyWorkerHealth(meta, midway, OPTS)).toEqual({ escalate: false });
	});
});

describe('classifyWorkerHealth - boot deadline disabled (bootTimeoutMs <= 0)', () => {
	const DISABLED = { steadyTimeoutMs: 30000, bootTimeoutMs: 0 };

	it('never escalates a still-booting worker, however long it has been wedged', () => {
		const meta = { ready: false, lastHeartbeat: 0, spawnedAt: 0 };
		expect(classifyWorkerHealth(meta, 10_000_000, DISABLED)).toEqual({ escalate: false });
	});

	it('still escalates a ready worker on the steady timeout - disabling the boot deadline does not touch steady-state', () => {
		const meta = { ready: true, lastHeartbeat: 0, spawnedAt: 0 };
		const v = classifyWorkerHealth(meta, 30001, DISABLED);
		expect(v.escalate).toBe(true);
		expect(v.regime).toBe('steady');
	});
});

describe('resolveBootTimeout - the knob cannot be mis-sized into a false-kill', () => {
	// The floor the primary passes is two heartbeat intervals (2 * 10000).
	const FLOOR = 20000;

	it('0 stays 0 (disabled), unclamped', () => {
		expect(resolveBootTimeout(0, FLOOR)).toEqual({ bootTimeoutMs: 0, clamped: false });
	});

	it('raises a positive value below the floor to the floor, and flags the clamp', () => {
		// A worker cannot ack before its first ping and its clock trails by up to one
		// interval between pings, so a below-floor deadline could false-kill a healthy
		// boot at a sweep boundary; the floor (two intervals) is the safe minimum.
		expect(resolveBootTimeout(5000, FLOOR)).toEqual({ bootTimeoutMs: FLOOR, clamped: true });
		expect(resolveBootTimeout(1, FLOOR)).toEqual({ bootTimeoutMs: FLOOR, clamped: true });
		expect(resolveBootTimeout(19999, FLOOR)).toEqual({ bootTimeoutMs: FLOOR, clamped: true });
	});

	it('leaves a value at or above the floor untouched', () => {
		expect(resolveBootTimeout(FLOOR, FLOOR)).toEqual({ bootTimeoutMs: FLOOR, clamped: false });
		expect(resolveBootTimeout(60000, FLOOR)).toEqual({ bootTimeoutMs: 60000, clamped: false });
	});
});

describe('routeWorkerMessage - the worker boot-time control gate', () => {
	it('answers liveness heartbeats whether or not boot has completed', () => {
		expect(routeWorkerMessage('heartbeat', false)).toBe('ack');
		expect(routeWorkerMessage('heartbeat', true)).toBe('ack');
	});

	it('honors terminate whether or not boot has completed (a boot-deadline escalation must land during init)', () => {
		expect(routeWorkerMessage('terminate', false)).toBe('terminate');
		expect(routeWorkerMessage('terminate', true)).toBe('terminate');
	});

	it('buffers relay / shutdown / tls-reload while still booting, dispatches them once booted', () => {
		for (const type of ['publish', 'publish-batched', 'shutdown', 'tls-reload']) {
			expect(routeWorkerMessage(type, false)).toBe('buffer');
			expect(routeWorkerMessage(type, true)).toBe('dispatch');
		}
	});
});
