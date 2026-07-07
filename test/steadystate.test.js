import { describe, it, expect } from 'vitest';
import { runSim, replaySim } from '../src/sim.js';
import {
	checkTimeMonotonic,
	checkQuiescence,
	checkDeliveryMonotonic,
	checkStarvation,
	faultClasses,
	runSteadyState
} from '../src/runtime/steadystate.js';
import { checkTopicsHaveSubscribers } from '../src/runtime/invariants.js';

// Every predicate is proven with a FIRE fixture and a NOT-FIRE fixture (the
// discrimination proof that it is not vacuously green), then the whole layer is
// exercised end-to-end through runSim.

describe('steadystate - checkTimeMonotonic', () => {
	it('does not fire on a non-decreasing clock (equal samples are fine)', () => {
		expect(checkTimeMonotonic([100, 100, 200, 300])).toBeNull();
	});
	it('fires on a backward clock step', () => {
		const v = checkTimeMonotonic([100, 200, 90, 300]);
		expect(v).toEqual({ category: 'steady.time-nonmonotonic', context: { at: 2, from: 200, to: 90 } });
	});
	it('is a no-op on a non-array', () => {
		expect(checkTimeMonotonic(undefined)).toBeNull();
	});
});

describe('steadystate - checkQuiescence', () => {
	it('does not fire when the run drained with zero pending', () => {
		expect(checkQuiescence({ drained: true, pending: 0 })).toBeNull();
	});
	it('fires when refed work is left pending', () => {
		const v = checkQuiescence({ drained: true, pending: 3 });
		expect(v).toEqual({ category: 'steady.no-quiescence', context: { drained: true, pending: 3 } });
	});
	it('also fires when the budget was hit AND work remained', () => {
		const v = checkQuiescence({ drained: false, pending: 2 });
		expect(v && v.category).toBe('steady.no-quiescence');
	});
	it('does NOT fire when a run settled exactly at the step budget (drained false, zero pending)', () => {
		// The step-count proxy can read false on a clean fixpoint reached at the cap;
		// pending is the sound signal, so this must stay green (no false positive).
		expect(checkQuiescence({ drained: false, pending: 0 })).toBeNull();
	});
});

describe('steadystate - terminal topic.zero-subscribers (reused predicate)', () => {
	it('does not fire when every terminal topic has a subscriber', () => {
		expect(checkTopicsHaveSubscribers({ topicCounts: { room: 2, lobby: 1 } })).toBeNull();
	});
	it('fires on a zero-count terminal topic', () => {
		const v = checkTopicsHaveSubscribers({ topicCounts: { room: 0 } });
		expect(v).toEqual({ category: 'topic.zero-subscribers', context: { topic: 'room', count: 0 } });
	});
});

describe('steadystate - checkDeliveryMonotonic', () => {
	const client = (id, topic, seqs) => ({
		id,
		raw: seqs.map(() => ({ routingTopic: topic })),
		decoded: seqs.map((seq) => ({ seq }))
	});

	it('does not fire on strictly-increasing per-topic seqs', () => {
		expect(checkDeliveryMonotonic([client(0, 'room', [1, 2, 3])], {})).toBeNull();
	});
	it('fires when a per-topic seq regresses', () => {
		const v = checkDeliveryMonotonic([client(0, 'room', [1, 3, 2])], {});
		expect(v).toEqual({ category: 'steady.delivery-nonmonotonic', context: { client: 0, topic: 'room', seq: 2, prev: 3 } });
	});
	it('fires on a repeated seq (a duplicate is not strictly increasing)', () => {
		const v = checkDeliveryMonotonic([client(0, 'room', [1, 2, 2])], {});
		expect(v && v.category).toBe('steady.delivery-nonmonotonic');
	});
	it('is guarded off under a reorder fault', () => {
		expect(checkDeliveryMonotonic([client(0, 'room', [1, 3, 2])], { reorder: true })).toBeNull();
	});
	it('is guarded off under a duplicate fault', () => {
		expect(checkDeliveryMonotonic([client(0, 'room', [1, 2, 2])], { duplicate: true })).toBeNull();
	});
	it('is guarded off under a corrupt fault (the seq lives in the corruptible body)', () => {
		expect(checkDeliveryMonotonic([client(0, 'room', [1, 3, 2])], { corrupt: true })).toBeNull();
	});
	it('is guarded off when a topic had more than one originating worker', () => {
		expect(checkDeliveryMonotonic([client(0, 'room', [1, 3, 2])], { multiOriginator: true })).toBeNull();
	});
	it('ignores control frames (no routingTopic) and undecodable bodies (no numeric seq)', () => {
		const c = {
			id: 0,
			raw: [{ routingTopic: null }, { routingTopic: 'room' }, { routingTopic: 'room' }],
			decoded: [{ type: 'welcome' }, null, { seq: 5 }]
		};
		expect(checkDeliveryMonotonic([c], {})).toBeNull();
	});
});

describe('steadystate - checkStarvation', () => {
	const recv = (id, topics) => ({ id, raw: topics.map((t) => ({ routingTopic: t })), decoded: topics.map(() => ({})) });

	it('does not fire when every publish-time subscriber received the topic', () => {
		const clients = [recv(1, ['room']), recv(2, ['room'])];
		const publishLog = [{ topic: 'room', subscribers: [1, 2] }];
		expect(checkStarvation(clients, publishLog, {})).toBeNull();
	});
	it('fires when a publish-time subscriber never received the topic', () => {
		const clients = [recv(1, ['room']), recv(2, [])];
		const publishLog = [{ topic: 'room', subscribers: [1, 2] }];
		const v = checkStarvation(clients, publishLog, {});
		expect(v).toEqual({ category: 'steady.starvation', context: { client: 2, topic: 'room' } });
	});
	it('is guarded off under a drop fault', () => {
		const clients = [recv(1, ['room']), recv(2, [])];
		const publishLog = [{ topic: 'room', subscribers: [1, 2] }];
		expect(checkStarvation(clients, publishLog, { drop: true })).toBeNull();
	});
	it('is guarded off under a corrupt fault', () => {
		const clients = [recv(1, ['room']), recv(2, [])];
		const publishLog = [{ topic: 'room', subscribers: [1, 2] }];
		expect(checkStarvation(clients, publishLog, { corrupt: true })).toBeNull();
	});
	it('is guarded off under cluster disruption (a lost worker)', () => {
		const clients = [recv(1, ['room']), recv(2, [])];
		const publishLog = [{ topic: 'room', subscribers: [1, 2] }];
		expect(checkStarvation(clients, publishLog, { disrupted: true })).toBeNull();
	});
	it('uses the PUBLISH-TIME subscriber set (a non-subscriber that got nothing is not starved)', () => {
		// Client 2 was never a publish-time subscriber, so its empty delivery is fine -
		// this is the mid-run subscribe/unsubscribe soundness guarantee.
		const clients = [recv(1, ['room']), recv(2, [])];
		const publishLog = [{ topic: 'room', subscribers: [1] }];
		expect(checkStarvation(clients, publishLog, {})).toBeNull();
	});
	it('is a no-op with no publishes', () => {
		expect(checkStarvation([recv(1, [])], [], {})).toBeNull();
	});
});

describe('steadystate - faultClasses', () => {
	it('flags a class active in the wire faults', () => {
		expect(faultClasses({ drop: 0.3 })).toEqual({ drop: true, duplicate: false, corrupt: false, reorder: false });
	});
	it('OR-combines the wire faults with the relay faults', () => {
		const f = faultClasses({ reorder: 0.5 }, { drop: 0.2 });
		expect(f).toEqual({ drop: true, duplicate: false, corrupt: false, reorder: true });
	});
	it('is all-false for a clean run', () => {
		expect(faultClasses()).toEqual({ drop: false, duplicate: false, corrupt: false, reorder: false });
	});
});

describe('steadystate - runSteadyState (fold shape)', () => {
	it('returns [] for a clean trajectory', () => {
		const trajectory = {
			clockSamples: [100, 200, 300],
			drained: true,
			pending: 0,
			terminal: { topicCounts: { room: 2 } },
			publishLog: [{ topic: 'room', subscribers: [0, 1] }],
			clients: [
				{ id: 0, raw: [{ routingTopic: 'room' }], decoded: [{ seq: 1 }] },
				{ id: 1, raw: [{ routingTopic: 'room' }], decoded: [{ seq: 1 }] }
			],
			faults: faultClasses()
		};
		expect(runSteadyState(trajectory)).toEqual([]);
	});
	it('collects multiple violations in the shared {category, context} shape', () => {
		const trajectory = {
			clockSamples: [100, 90],
			drained: false,
			pending: 1,
			terminal: { topicCounts: { room: 0 } },
			publishLog: [{ topic: 'room', subscribers: [0] }],
			clients: [{ id: 0, raw: [], decoded: [] }],
			faults: faultClasses()
		};
		const cats = runSteadyState(trajectory).map((v) => v.category).sort();
		expect(cats).toEqual([
			'steady.no-quiescence',
			'steady.starvation',
			'steady.time-nonmonotonic',
			'topic.zero-subscribers'
		]);
		for (const v of runSteadyState(trajectory)) {
			expect(v).toHaveProperty('category');
			expect(v).toHaveProperty('context');
		}
	});
});

describe('steadystate - integration through runSim', () => {
	const steadyCats = (r) => r.invariantViolations.filter((v) => v.category.startsWith('steady.')).map((v) => v.category);

	it('a default fault-free run has zero steady.* violations', async () => {
		const r = await runSim({ seed: 'steady-clean' });
		expect(steadyCats(r)).toEqual([]);
		expect(r.invariantViolations).toEqual([]);
	});

	it('a reorder-only run suppresses steady.delivery-nonmonotonic yet stays clean', async () => {
		const r = await runSim({ seed: 'steady-reorder', clients: 4, topics: ['room'], faults: { reorder: 0.8, maxJitterMs: 40 } });
		expect(steadyCats(r)).not.toContain('steady.delivery-nonmonotonic');
		expect(r.invariantViolations).toEqual([]);
	});

	it('a drop-fault run suppresses steady.starvation and stays clean', async () => {
		const r = await runSim({ seed: 'steady-drop', clients: 4, topics: ['room'], faults: { drop: 0.4 } });
		expect(steadyCats(r)).not.toContain('steady.starvation');
		expect(r.invariantViolations).toEqual([]);
	});

	it('a planted miss (one subscriber short, NO fault) makes steady.starvation fire', async () => {
		const r = await runSim({
			seed: 'steady-planted',
			scenario: async (api) => {
				const a = api.connect();
				const b = api.connect();
				await api.advance();
				a.subscribe('room');
				b.subscribe('room');
				await api.advance();
				// Plant the miss: swallow every frame bound for b at its server socket.
				// b stays a bona-fide subscriber (its native + bookkeeping sets both hold
				// 'room', so the per-step auditor passes), but the broadcast never reaches
				// it - with NO transport fault to excuse it, so starvation must fire.
				b.serverWs.send = () => 1;
				api.publish('room', 'tick', { n: 0 });
				await api.advance();
			}
		});
		const starved = r.invariantViolations.filter((v) => v.category === 'steady.starvation');
		expect(starved.length).toBe(1);
		expect(starved[0].context.topic).toBe('room');
		// The un-starved subscriber still got the tick, so the miss is one-subscriber-short.
		const aFrames = r.clientFrames[0].filter((f) => f && f.event === 'tick' && f.topic === 'room');
		expect(aFrames.length).toBe(1);
	});

	it('replaySim reproduces a folded steady violation bit-for-bit (steady results are pure)', async () => {
		const original = await runSim({
			seed: 'steady-replay',
			scenario: async (api) => {
				const a = api.connect();
				const b = api.connect();
				await api.advance();
				a.subscribe('room');
				b.subscribe('room');
				await api.advance();
				b.serverWs.send = () => 1;
				api.publish('room', 'tick', { n: 0 });
				await api.advance();
			}
		});
		expect(original.invariantViolations.some((v) => v.category === 'steady.starvation')).toBe(true);
		const replay = await replaySim(original);
		expect(replay.reproduced).toBe(true);
		expect(replay.invariantViolations).toEqual(original.invariantViolations);
	});
});

describe('steadystate - integration through runClusterSim', () => {
	const steadyCats = (r) => r.invariantViolations.filter((v) => v.category.startsWith('steady.')).map((v) => v.category);

	it('a default multi-worker run holds quiescence + time-monotonic and stays clean', async () => {
		const r = await runSim({ seed: 'steady-cluster', workers: 2, clients: 2, topics: ['room'] });
		expect(steadyCats(r)).toEqual([]);
		expect(r.invariantViolations).toEqual([]);
	});

	it('a multi-worker run with relay reorder stays clean (delivery-monotonic guarded by relay faults)', async () => {
		const r = await runSim({ seed: 'steady-cluster-reorder', workers: 2, clients: 2, topics: ['room'], relayFaults: { reorder: 0.8, maxJitterMs: 30 } });
		expect(steadyCats(r)).not.toContain('steady.delivery-nonmonotonic');
		expect(r.invariantViolations).toEqual([]);
	});

	it('a multi-worker run reproduces its steady pass under replay', async () => {
		const original = await runSim({ seed: 'steady-cluster-replay', workers: 2, clients: 2, topics: ['room'] });
		const replay = await replaySim(original);
		expect(replay.reproduced).toBe(true);
	});

	it('does NOT fire steady.starvation when a cross-worker subscriber unsubscribes inside the relay window (clean run)', async () => {
		// Cross-worker delivery is deferred by the relay: a subscriber captured at
		// publish time that unsubscribes before the relay lands legitimately receives
		// nothing. With NO fault active this must stay clean (the relay-window-
		// unsubscribe false positive the cluster starvation guard exists to suppress).
		const r = await runSim({
			seed: 'steady-relay-window',
			workers: 2,
			topics: ['room'],
			scenario: async (api) => {
				const A = api.worker(1).connect(); // cross-worker (relay) subscriber
				const B = api.worker(0).connect(); // local subscriber on the origin worker
				await api.advance();
				A.subscribe('room');
				B.subscribe('room');
				await api.advance();
				api.worker(0).publish('room', 'tick', { n: 0 }); // captures A + B, schedules the relay
				A.unsubscribe('room'); // A leaves inside the relay window
				await api.advance();
			}
		});
		expect(steadyCats(r)).not.toContain('steady.starvation');
		expect(r.invariantViolations).toEqual([]);
	});

	it('STILL fires steady.starvation for a cross-worker subscriber that stayed subscribed yet never received (guard is non-vacuous)', async () => {
		const r = await runSim({
			seed: 'steady-relay-miss',
			workers: 2,
			topics: ['room'],
			scenario: async (api) => {
				const A = api.worker(1).connect();
				const B = api.worker(0).connect();
				await api.advance();
				A.subscribe('room');
				B.subscribe('room');
				await api.advance();
				// A stays subscribed the whole run, but its relay-delivered frames are
				// swallowed at the socket - a genuine cross-worker miss that must fire.
				A.serverWs.send = () => 1;
				api.worker(0).publish('room', 'tick', { n: 0 });
				await api.advance();
			}
		});
		const starved = r.invariantViolations.filter((v) => v.category === 'steady.starvation');
		expect(starved.length).toBe(1);
		expect(starved[0].context).toEqual({ client: '1:0', topic: 'room' });
	});
});
