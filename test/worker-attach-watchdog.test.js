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
import { classifyWorkerHealth, recordWorkerMessage, sweepWorkerHealth } from '../src/runtime/worker-watchdog.js';
import { createRestartSupervisor } from '../src/runtime/restart-supervisor.js';

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

// The state itself, driven end to end through the code the primary runs: the
// slot record as index.js creates it, every stamp made by recordWorkerMessage,
// the sweep the primary's heartbeat interval runs, and the restart budget the
// exit handler charges. Only the message transport and the worker thread are
// stood in for - by posting the messages a worker posts, in the order it posts
// them, and by withholding the one that never arrives.
describe('a worker that reports ready and never attaches, driven through the primary\'s own stamping', () => {
	const OPTS = { steadyTimeoutMs: 30000, bootTimeoutMs: 60000 };
	/** The slot record exactly as spawn_worker builds it, minus the ring handles. */
	const slotRecord = (slot, now) => ({
		threadId: slot.index + 1, descriptor: null, lastHeartbeat: 0, spawnedAt: now, ready: false, readyAt: 0,
		role: slot.role, slot, ringWriter: null, ringReader: null, relayAttached: false, relayQuarantined: false
	});

	/** The primary's composition: metas keyed by worker, a supervisor with a virtual clock, the sweep hooks. */
	function primary({ clusterMode = 'reuseport', maxAttempts = 3 } = {}) {
		let now = 1000;
		const exhausted = [];
		const respawns = [];
		const timers = [];
		const supervisor = createRestartSupervisor({
			setTimer: (fn) => { timers.push(fn); return timers.length; },
			clearTimer: () => {},
			now: () => now,
			spawn: (slot) => { respawns.push(slot); supervisor.noteSpawn(slot); },
			onExhausted: (slot) => exhausted.push(`${slot.role}#${slot.index}`),
			shuttingDown: () => false,
			delayBase: 100, delayMax: 5000, maxAttempts, stableMs: 30000
		});
		const workers = new Map();
		const escalated = [];
		const kept = [];
		const registered = new Set();
		function spawn(slot) {
			const worker = { id: `${slot.role}#${slot.index}`, posted: [] };
			// A slot is registered once at boot; every later spawn is a respawn
			// into the same slot and keeps its budget, as spawn_worker does.
			if (!registered.has(worker.id)) { registered.add(worker.id); supervisor.register(slot); }
			supervisor.noteSpawn(slot);
			workers.set(worker, slotRecord(slot, now));
			return worker;
		}
		/** What index.js does on 'message': stamp, then act on the transition. */
		function receive(worker, msg) {
			const meta = workers.get(worker);
			const transition = recordWorkerMessage(meta, msg, now, clusterMode);
			if (msg.type === 'relay-attached' && transition === 'attached') supervisor.noteReady(meta.slot);
			return transition;
		}
		/** What the heartbeat interval does. */
		function sweep() {
			sweepWorkerHealth(workers, now, OPTS, {
				escalate: (worker, meta, verdict) => escalated.push({ worker: worker.id, regime: verdict.regime, reason: verdict.reason }),
				keep: (worker) => kept.push(worker.id)
			});
		}
		/** What the exit handler does after requestWorkerExit lands. */
		function exit(worker) {
			const meta = workers.get(worker);
			workers.delete(worker);
			return supervisor.noteExit(meta.slot);
		}
		return { spawn, receive, sweep, exit, workers, escalated, kept, exhausted, respawns, advance: (ms) => { now += ms; }, fireRespawn: () => { const fn = timers.shift(); if (fn) fn(); } };
	}

	it('is escalated by the attach regime while its attached sibling is kept, and its exit is charged unstamped', () => {
		const p = primary();
		const healthy = p.spawn({ role: 'io', index: 0 });
		const stuck = p.spawn({ role: 'io', index: 1 });
		// Both report ready; only one posts relay-attached, in the same tick.
		expect(p.receive(healthy, { type: 'ready', role: 'io' })).toBe('ready');
		expect(p.receive(healthy, { type: 'relay-attached' })).toBe('attached');
		expect(p.receive(stuck, { type: 'ready', role: 'io' })).toBe('ready');
		expect(p.workers.get(stuck).ready).toBe(true);
		expect(p.workers.get(stuck).readyAt).toBe(1000);
		expect(p.workers.get(stuck).relayAttached).toBe(false);

		// Inside the window: both keep acking, both are kept.
		p.advance(20000);
		p.receive(healthy, { type: 'heartbeat-ack' });
		p.receive(stuck, { type: 'heartbeat-ack' });
		p.sweep();
		expect(p.escalated).toEqual([]);
		expect(p.kept).toEqual(['io#0', 'io#1']);

		// Past the steady window: still acking, still unattached.
		p.advance(10001);
		p.receive(healthy, { type: 'heartbeat-ack' });
		p.receive(stuck, { type: 'heartbeat-ack' });
		p.sweep();
		expect(p.escalated).toEqual([{ worker: 'io#1', regime: 'attach', reason: expect.stringContaining('relay-attached') }]);
		expect(p.kept.slice(2)).toEqual(['io#0']);

		// The kill lands as an exit, and the difference the stamp makes shows on
		// the SECOND life: the stuck slot was never stamped, so its attempts
		// climb; the healthy slot, stamped on its attach and up past the stable
		// window, earns a fresh budget on every exit.
		expect(p.exit(stuck)).toMatchObject({ attempts: 1 });
		expect(p.exit(healthy)).toMatchObject({ attempts: 1 });
		p.fireRespawn(); p.fireRespawn();
		const stuck2 = p.spawn({ role: 'io', index: 1 });
		const healthy2 = p.spawn({ role: 'io', index: 0 });
		p.receive(stuck2, { type: 'ready', role: 'io' });
		p.receive(healthy2, { type: 'ready', role: 'io' });
		p.receive(healthy2, { type: 'relay-attached' });
		p.advance(30001);
		p.receive(stuck2, { type: 'heartbeat-ack' });
		p.receive(healthy2, { type: 'heartbeat-ack' });
		p.sweep();
		expect(p.escalated.at(-1)).toMatchObject({ worker: 'io#1', regime: 'attach' });
		expect(p.exit(stuck2), 'unstamped: the budget keeps climbing').toMatchObject({ attempts: 2 });
		expect(p.exit(healthy2), 'stamped and stably up: the budget reset').toMatchObject({ attempts: 1 });
	});

	it('walks a deterministic attach failure to restart-limit exhaustion instead of flapping forever', () => {
		const p = primary({ maxAttempts: 3 });
		let worker = p.spawn({ role: 'io', index: 0 });
		for (let life = 1; life <= 3; life++) {
			p.receive(worker, { type: 'ready', role: 'io' });
			p.advance(30001);
			p.receive(worker, { type: 'heartbeat-ack' });
			p.sweep();
			expect(p.escalated.at(-1).regime).toBe('attach');
			expect(p.exit(worker)).toMatchObject({ attempts: life });
			p.fireRespawn();
			expect(p.respawns).toHaveLength(life);
			worker = p.spawn({ role: 'io', index: 0 });
		}
		p.receive(worker, { type: 'ready', role: 'io' });
		p.advance(30001);
		p.sweep();
		expect(p.exit(worker)).toEqual({ exhausted: true, attempts: 4 });
		expect(p.exhausted).toEqual(['io#0']);
	});

	it('stamps the ready edge the way each surface reports it, and attaches once', () => {
		const acceptor = primary({ clusterMode: 'acceptor' });
		const io = acceptor.spawn({ role: 'io', index: 0 });
		// Under an acceptor primary an io worker's ready edge is its descriptor;
		// a bare 'ready' from it is only a liveness proof.
		expect(acceptor.receive(io, { type: 'ready', role: 'io' })).toBe('alive');
		expect(acceptor.workers.get(io).ready).toBe(false);
		expect(acceptor.receive(io, { type: 'descriptor', descriptor: {} })).toBe('ready');
		const compute = acceptor.spawn({ role: 'compute', index: 0 });
		expect(acceptor.receive(compute, { type: 'ready', role: 'compute' })).toBe('ready');

		const reuseport = primary({ clusterMode: 'reuseport' });
		const w = reuseport.spawn({ role: 'io', index: 0 });
		expect(reuseport.receive(w, { type: 'descriptor', descriptor: {} })).toBe('alive');
		expect(reuseport.receive(w, { type: 'ready', role: 'io' })).toBe('ready');
		// A repeated relay-attached is not a second transition, so the budget is
		// stamped once and a later repeat cannot move its uptime clock forward.
		expect(reuseport.receive(w, { type: 'relay-attached' })).toBe('attached');
		expect(reuseport.receive(w, { type: 'relay-attached' })).toBe('alive');
		// Every message advances the liveness clock.
		reuseport.advance(5000);
		reuseport.receive(w, { type: 'posture' });
		expect(reuseport.workers.get(w).lastHeartbeat).toBe(6000);
	});
});
