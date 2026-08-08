import { describe, it, expect } from 'vitest';
import { recordSeen } from '../src/runtime/handler/state.js';
import { nextTopicSeq } from '../src/runtime/utils/epoch.js';
import { computeStateHash, partitionActiveTopics } from '../src/runtime/invariants.js';
import { createStateHashDetector } from '../src/runtime/state-hash-detector.js';

// The convergent observable is a per-worker map of the highest seq each topic
// was OBSERVED at (whether stamped locally or received over the relay). These
// tests prove the two operations that maintain it (a bare set on the local
// publish path; recordSeen's monotone-max guard on the relay-receive path) keep
// every worker's map byte-identical under a reliable relay, so a structural hash
// over the map agrees across workers - and that a dropped delivery is exactly
// what makes a worker's hash differ. They use no uWS and no real threads: the
// map maintenance and the hash are pure functions of their inputs.

describe('recordSeen (relay-receive seq tracker)', () => {
	it('records the first seq for a topic', () => {
		const m = new Map();
		recordSeen(m, 'room', 1);
		expect(m.get('room')).toBe(1);
	});

	it('advances to a higher seq', () => {
		const m = new Map([['room', 3]]);
		recordSeen(m, 'room', 7);
		expect(m.get('room')).toBe(7);
	});

	it('keeps the max under an out-of-order (reordered) seq on receive', () => {
		// Frames can reorder across the postMessage boundary; a lower seq
		// arriving after a higher one must NOT move the value backward.
		const m = new Map();
		recordSeen(m, 'room', 5);
		recordSeen(m, 'room', 2);
		recordSeen(m, 'room', 4);
		expect(m.get('room')).toBe(5);
	});

	it('is a no-op for an equal seq (idempotent re-delivery)', () => {
		const m = new Map([['room', 4]]);
		recordSeen(m, 'room', 4);
		expect(m.get('room')).toBe(4);
	});

	it('ignores a non-number seq so a {seq:false} topic never enters the map', () => {
		const m = new Map();
		recordSeen(m, 'room', null);
		recordSeen(m, 'room', undefined);
		expect(m.has('room')).toBe(false);
	});

	it('tracks distinct topics independently', () => {
		const m = new Map();
		recordSeen(m, 'a', 2);
		recordSeen(m, 'b', 9);
		recordSeen(m, 'a', 1);
		expect(m.get('a')).toBe(2);
		expect(m.get('b')).toBe(9);
	});
});

// Helper: turn a maxSeenSeq Map into the plain { topicSeqs } projection the
// reporter hands to computeStateHash.
function project(seenMap) {
	const topicSeqs = {};
	for (const [t, s] of seenMap) topicSeqs[t] = s;
	return { topicSeqs };
}

describe('computeStateHash over a maxSeenSeq projection', () => {
	it('hashes identical maps to the same value (order-independent)', () => {
		const a = new Map([['x', 3], ['y', 7], ['z', 1]]);
		const b = new Map([['z', 1], ['x', 3], ['y', 7]]); // same entries, different insertion order
		expect(computeStateHash(project(a))).toBe(computeStateHash(project(b)));
	});

	it('hashes a differing seq to a different value', () => {
		const a = new Map([['x', 3], ['y', 7]]);
		const b = new Map([['x', 3], ['y', 8]]);
		expect(computeStateHash(project(a))).not.toBe(computeStateHash(project(b)));
	});

	it('distinguishes a missing topic from a present one (count-seeded)', () => {
		const a = new Map([['x', 3]]);
		const b = new Map([['x', 3], ['y', 1]]);
		expect(computeStateHash(project(a))).not.toBe(computeStateHash(project(b)));
	});

	it('is a 32-bit unsigned integer', () => {
		const h = computeStateHash(project(new Map([['x', 123456]])));
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
	});
});

// The core convergence proof. We model the bare cluster at the observable level:
// the publishing worker advances its own topicSeqs via nextTopicSeq (and sets
// maxSeenSeq to that fresh max); every other worker receives each stamped frame
// and applies recordSeen, ungated by whether it has a local subscriber. Under a
// reliable relay every worker ends with the same maxSeenSeq, so the hash agrees.
describe('cross-worker convergence (asymmetric publish)', () => {
	it('converges every worker to the same hash when only worker 0 publishes', () => {
		const WORKERS = 4;
		const N = 25;
		const maps = Array.from({ length: WORKERS }, () => new Map());
		const publisherTopicSeqs = new Map();

		for (let i = 0; i < N; i++) {
			// Worker 0 publishes: stamp locally, set its own max to the new seq.
			const seq = nextTopicSeq(publisherTopicSeqs, 'room');
			maps[0].set('room', seq);
			// The relay delivers the stamped frame to every OTHER worker.
			for (let w = 1; w < WORKERS; w++) recordSeen(maps[w], 'room', seq);
		}

		const hashes = maps.map((m) => computeStateHash(project(m)));
		// All workers ended at seq N and hash identically.
		for (const m of maps) expect(m.get('room')).toBe(N);
		expect(new Set(hashes).size).toBe(1);
	});

	it('converges with reordered relay delivery to a lagging worker', () => {
		// Worker 0 stamps 1..5 in order; worker 1 receives them shuffled. The
		// monotone-max guard still lands worker 1 on the same final max.
		const m0 = new Map();
		const m1 = new Map();
		const seqs = [];
		const ts = new Map();
		for (let i = 0; i < 5; i++) { const s = nextTopicSeq(ts, 'room'); m0.set('room', s); seqs.push(s); }
		for (const s of [3, 1, 5, 2, 4]) recordSeen(m1, 'room', s);
		void seqs;
		expect(computeStateHash(project(m0))).toBe(computeStateHash(project(m1)));
	});

	it('converges with multiple publishers on different workers (each sees every stamped frame)', () => {
		// Worker 0 and worker 1 each publish to their own topicSeqs; every worker
		// SEES both stamped streams via the relay and takes the per-topic max, so
		// the delivered (origin-stamped) seq set is identical across workers.
		const WORKERS = 3;
		const maps = Array.from({ length: WORKERS }, () => new Map());
		const ts0 = new Map();
		const ts1 = new Map();

		// Interleave two publishers on topic 'a' (worker 0) and 'b' (worker 1).
		for (let i = 0; i < 10; i++) {
			const sa = nextTopicSeq(ts0, 'a');
			maps[0].set('a', sa); // publisher-local set
			for (let w = 0; w < WORKERS; w++) if (w !== 0) recordSeen(maps[w], 'a', sa);

			const sb = nextTopicSeq(ts1, 'b');
			maps[1].set('b', sb);
			for (let w = 0; w < WORKERS; w++) if (w !== 1) recordSeen(maps[w], 'b', sb);
		}

		const hashes = maps.map((m) => computeStateHash(project(m)));
		expect(new Set(hashes).size).toBe(1);
		for (const m of maps) { expect(m.get('a')).toBe(10); expect(m.get('b')).toBe(10); }
	});

	it('DIVERGES when one worker ends behind a dropped relay frame (the detector trip condition)', () => {
		// A single dropped frame in the MIDDLE of a monotonic stream is masked by
		// a later higher delivery (the max recovers) - which is correct: max-seq
		// convergence is about where a worker ENDS, not every frame in between.
		// The catchable case is a worker left behind, e.g. the last frame lost.
		const WORKERS = 3;
		const N = 12;
		const maps = Array.from({ length: WORKERS }, () => new Map());
		const ts = new Map();
		for (let i = 0; i < N; i++) {
			const seq = nextTopicSeq(ts, 'room');
			maps[0].set('room', seq);
			for (let w = 1; w < WORKERS; w++) {
				if (w === 2 && seq === N) continue; // final frame never reaches worker 2
				recordSeen(maps[w], 'room', seq);
			}
		}
		const hashes = maps.map((m) => computeStateHash(project(m)));
		expect(maps[2].get('room')).toBe(N - 1);
		expect(maps[0].get('room')).toBe(N);
		// Worker 2's hash differs from the converged majority - exactly the
		// cross-worker delivery divergence the detector exists to catch.
		expect(hashes[2]).not.toBe(hashes[0]);
		expect(hashes[0]).toBe(hashes[1]);
	});
});

// End-to-end pipeline using the REAL exported pieces composed the way production
// composes them: a publish stamps the publisher's max and emits a relay frame
// CARRYING the seq as metadata; a modeled primary forwards that frame to the
// other workers; each receiver applies recordSeen with the carried seq (NO
// envelope re-parse); a modeled reporter projects each worker's map and hashes
// it; the modeled primary feeds the hashes to the real detector. This proves the
// seq-carry + receive update + reporter projection + detector agree as a unit -
// the closest headless proxy for the built cluster (whose handler/index modules
// import build-virtual deps and cannot load in-process).
describe('full pipeline: publish -> relay(seq) -> receive -> reporter -> detector', () => {
	// One worker model: its publisher-local seq counter and its observed-max map.
	function makeWorker(id) {
		return { id, topicSeqs: new Map(), maxSeen: new Map() };
	}
	// The publish path: stamp locally, set own max, return the relay frame the
	// receiver will see (topic + the explicit seq metadata; the envelope string
	// is irrelevant to the tracker, which never re-parses it).
	function publish(worker, topic) {
		const seq = nextTopicSeq(worker.topicSeqs, topic);
		worker.maxSeen.set(topic, seq); // bare set (monotonic), as platform.publish does
		return { topic, seq };
	}
	// The receive path (relayPublish): recordSeen with the carried seq, ungated.
	function receive(worker, frame) {
		recordSeen(worker.maxSeen, frame.topic, frame.seq);
	}
	// The reporter: project the map to { topicSeqs } and hash it.
	function reportHash(worker) {
		const topicSeqs = {};
		for (const [t, s] of worker.maxSeen) topicSeqs[t] = s;
		return computeStateHash({ topicSeqs });
	}

	it('a healthy asymmetric run produces ZERO divergence through the detector', () => {
		const workers = [makeWorker(1), makeWorker(2), makeWorker(3)];
		let detectorClock = 0;
		const detector = createStateHashDetector({ epochMs: 1000, monotonicNow: () => detectorClock });
		const live = workers.map((w) => w.id);
		let divergences = 0;

		// Only worker 1 publishes 'room'; the primary forwards each frame to 2 & 3.
		for (let i = 0; i < 30; i++) {
			const frame = publish(workers[0], 'room');
			for (const w of workers) if (w.id !== 1) receive(w, frame);
		}
		// A reporting round: every worker reports in the same primary epoch.
		detectorClock = 5000;
		for (const w of workers) {
			const div = detector.record(w.id, reportHash(w), live);
			if (div) divergences++;
		}
		// The critical no-false-positive proof: a perfectly healthy asymmetric
		// publish deployment (only one worker publishes; others only receive)
		// MUST NOT trip the detector. The naive per-worker topicSeqs design would
		// have here - workers 2 & 3 never advance their OWN topicSeqs - which is
		// exactly the production-dangerous false positive this observable avoids.
		expect(divergences).toBe(0);
		// And every worker did converge to the same hash.
		const hashes = workers.map(reportHash);
		expect(new Set(hashes).size).toBe(1);
	});

	it('a dropped final frame to one worker trips the detector exactly once', () => {
		const workers = [makeWorker(1), makeWorker(2), makeWorker(3)];
		let detectorClock = 0;
		const detector = createStateHashDetector({ epochMs: 1000, monotonicNow: () => detectorClock });
		const live = workers.map((w) => w.id);

		const N = 20;
		for (let i = 0; i < N; i++) {
			const frame = publish(workers[0], 'room');
			for (const w of workers) {
				if (w.id === 1) continue;
				if (w.id === 3 && frame.seq === N) continue; // last frame lost to worker 3
				receive(w, frame);
			}
		}
		// The persistence gate holds the first divergent epoch (a single epoch
		// can be a boundary artifact and a returned divergence can restart a
		// worker); the SAME standing loss fires on the second consecutive one.
		detectorClock = 5000;
		let divergence = null;
		for (const w of workers) {
			const div = detector.record(w.id, reportHash(w), live);
			if (div) divergence = div;
		}
		expect(divergence).toBeNull();
		detectorClock = 6000;
		for (const w of workers) {
			const div = detector.record(w.id, reportHash(w), live);
			if (div) divergence = div;
		}
		expect(divergence).not.toBeNull();
		expect(divergence.minorityThreadIds).toEqual([3]);
		// Majority hash is the converged (workers 1 & 2) value.
		expect(divergence.majorityHash).toBe(reportHash(workers[0]));
	});

	// The scenario the split exists for: a worker restarts on a cluster whose
	// only traffic stopped. Its siblings hold the quiet topic's maximum forever;
	// the respawn can never learn it. Before the split that was a PERMANENT
	// hash disagreement - and under the restart switch, a kill loop driven by a
	// topic nobody was publishing, because the replacement respawns empty and
	// diverges again. Active/quiet partitioning must keep the restart lane
	// silent and report the quiet fact exactly once.
	it('a respawned worker on a quiet cluster never trips the restart lane, and logs once', () => {
		const tracking = () => ({ prev: new Map(), changed: new Map(), tick: 0 });
		const workers = [
			{ id: 1, maxSeen: new Map(), t: tracking() },
			{ id: 2, maxSeen: new Map(), t: tracking() },
			{ id: 3, maxSeen: new Map(), t: tracking() }
		];
		// A room lives and dies while all three run.
		for (const w of workers) recordSeen(w.maxSeen, 'room:final', 40);
		// Everyone ticks a few times: the topic goes quiet on all of them.
		for (let i = 0; i < 3; i++) {
			for (const w of workers) {
				w.t.tick++;
				partitionActiveTopics(w.maxSeen, w.t.prev, w.t.changed, w.t.tick);
			}
		}
		// Worker 3 restarts: empty map, fresh tracking - the respawn shape.
		workers[2].maxSeen = new Map();
		workers[2].t = tracking();

		let detectorClock = 0;
		const detector = createStateHashDetector({ epochMs: 1000, monotonicNow: () => detectorClock });
		const live = workers.map((w) => w.id);
		let restartLane = null;
		let quietReports = 0;
		for (let epoch = 0; epoch < 6; epoch++) {
			detectorClock = epoch * 1000;
			for (const w of workers) {
				w.t.tick++;
				const { active, quiet } = partitionActiveTopics(w.maxSeen, w.t.prev, w.t.changed, w.t.tick);
				const div = detector.record(w.id, computeStateHash({ topicSeqs: active }), live);
				if (div) restartLane = div;
				if (detector.recordQuiet(w.id, computeStateHash({ topicSeqs: quiet }), live)) quietReports++;
			}
		}
		// The restart-authorized lane NEVER fires: the quiet topic is out of the
		// active comparison on every worker, respawned or not.
		expect(restartLane).toBeNull();
		// The quiet fact is reported exactly once, not restated every epoch.
		expect(quietReports).toBe(1);
	});

	it('partitions a topic to active on change and to quiet after the window', () => {
		const current = new Map([['a', 5], ['b', 9]]);
		const prev = new Map();
		const changed = new Map();
		// Tick 1: both first-seen, both active.
		let split = partitionActiveTopics(current, prev, changed, 1);
		expect(split).toEqual({ active: { a: 5, b: 9 }, quiet: {} });
		// Tick 2: nothing moved, still inside the one-tick window.
		split = partitionActiveTopics(current, prev, changed, 2);
		expect(split).toEqual({ active: { a: 5, b: 9 }, quiet: {} });
		// Tick 3: 'a' moves, 'b' ages out of the window.
		current.set('a', 6);
		split = partitionActiveTopics(current, prev, changed, 3);
		expect(split).toEqual({ active: { a: 6 }, quiet: { b: 9 } });
		// Tick 4: both quiet... except 'a' is still inside its window.
		split = partitionActiveTopics(current, prev, changed, 4);
		expect(split).toEqual({ active: { a: 6 }, quiet: { b: 9 } });
		// Tick 5: everything quiet.
		split = partitionActiveTopics(current, prev, changed, 5);
		expect(split).toEqual({ active: {}, quiet: { a: 6, b: 9 } });
	});

	it('a {seq:false} topic never enters any worker map, so it cannot diverge', () => {
		const workers = [makeWorker(1), makeWorker(2)];
		// Worker 1 publishes 'ephemeral' WITHOUT stamping (seq:false): no set on
		// publish, and the relay frame carries seq null, so recordSeen ignores it.
		for (let i = 0; i < 5; i++) {
			// publish-with-seq-false: no maxSeen.set, frame seq is null
			const frame = { topic: 'ephemeral', seq: null };
			for (const w of workers) if (w.id !== 1) receive(w, frame);
		}
		expect(workers[0].maxSeen.has('ephemeral')).toBe(false);
		expect(workers[1].maxSeen.has('ephemeral')).toBe(false);
		// Both empty maps hash identically -> never a divergence.
		expect(reportHash(workers[0])).toBe(reportHash(workers[1]));
	});
});
