// A worker that reports ready and never attaches its relay reader.
//
// The primary hands an unattached worker no relay frames at all. That is what
// keeps a slow boot out of the spill ceiling's reach, and it is also why
// nothing else notices when the attach never arrives: no frames are written,
// so no spill accumulates, and the worker keeps acking heartbeats while
// silently missing every cross-worker publish its own subscribers are owed.
//
// The worker posts `relay-attached` at the very end of its boot, synchronously
// after `ready`, so a healthy worker attaches in the same tick it goes ready.
// The post sits inside a swallowing try/catch, so a failed post leaves a
// perfectly healthy-looking worker permanently invisible to the relay.
//
// classifyWorkerHealth is where that becomes a decision, so it is what these
// cases drive.

import { describe, it, expect } from 'vitest';
import { classifyWorkerHealth } from '../src/runtime/worker-watchdog.js';

const OPTS = { steadyTimeoutMs: 30000, bootTimeoutMs: 60000 };

/** A ready worker whose heartbeat is fresh, so only the attach question is open. */
function readyWorker(now, { readyAt, relayAttached }) {
	return { ready: true, lastHeartbeat: now, spawnedAt: 0, readyAt, relayAttached };
}

describe('a ready worker that never attaches its relay reader', () => {
	it('is escalated once the gap outlives the steady timeout', () => {
		const now = 100000;
		const verdict = classifyWorkerHealth(
			readyWorker(now, { readyAt: now - OPTS.steadyTimeoutMs - 1, relayAttached: false }),
			now,
			OPTS
		);
		expect(verdict.escalate).toBe(true);
		expect(verdict.regime).toBe('attach');
		expect(verdict.reason, 'the reason must name what the worker was missing').toContain('relay-attached');
	});

	it('is left alone while the gap is still inside the timeout', () => {
		// The healthy gap is one tick. This is the slow-but-real case, and killing
		// it would be the false positive that makes the check worse than the hole.
		const now = 100000;
		const verdict = classifyWorkerHealth(
			readyWorker(now, { readyAt: now - (OPTS.steadyTimeoutMs - 1), relayAttached: false }),
			now,
			OPTS
		);
		expect(verdict.escalate).toBe(false);
	});

	it('is left alone once it has attached, however long ago it went ready', () => {
		const now = 100000;
		const verdict = classifyWorkerHealth(
			readyWorker(now, { readyAt: 1, relayAttached: true }),
			now,
			OPTS
		);
		expect(verdict.escalate).toBe(false);
	});

	it('does not judge a meta that makes no claim about attachment', () => {
		// The sim harness passes { ready, lastHeartbeat, spawnedAt } and nothing
		// else. A caller that carries no attach fields is not asserting that its
		// worker failed to attach, and must not be escalated for it.
		const now = 100000;
		const verdict = classifyWorkerHealth({ ready: true, lastHeartbeat: now, spawnedAt: 0 }, now, OPTS);
		expect(verdict.escalate).toBe(false);
	});

	it('does not judge a worker that has not reported ready yet', () => {
		// Before ready there is nothing to measure the gap from, and the boot
		// deadline already owns that window.
		const now = 100000;
		const verdict = classifyWorkerHealth(
			{ ready: false, lastHeartbeat: now, spawnedAt: now - 1000, readyAt: 0, relayAttached: false },
			now,
			OPTS
		);
		expect(verdict.escalate).toBe(false);
	});

	it('survives a disabled boot deadline, which is a different question', () => {
		// WORKER_BOOT_TIMEOUT_MS=0 is a documented configuration that disables the
		// boot deadline. An operator setting it is saying an init may take
		// arbitrarily long - not that a serving worker may miss relay traffic
		// forever - so the attach check is deliberately not tied to it.
		const now = 100000;
		const verdict = classifyWorkerHealth(
			readyWorker(now, { readyAt: now - OPTS.steadyTimeoutMs - 1, relayAttached: false }),
			now,
			{ steadyTimeoutMs: OPTS.steadyTimeoutMs, bootTimeoutMs: 0 }
		);
		expect(verdict.escalate).toBe(true);
		expect(verdict.regime).toBe('attach');
	});

	it('reports the unresponsive worker as unresponsive, not as unattached', () => {
		// Both conditions at once: a worker that stopped acking AND never attached
		// is a dead worker, and the reason an operator reads should say so.
		const now = 100000;
		const verdict = classifyWorkerHealth(
			{ ready: true, lastHeartbeat: now - OPTS.steadyTimeoutMs - 1, spawnedAt: 0, readyAt: 1, relayAttached: false },
			now,
			OPTS
		);
		expect(verdict.escalate).toBe(true);
		expect(verdict.regime).toBe('steady');
	});
});
