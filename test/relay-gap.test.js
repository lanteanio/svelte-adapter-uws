import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { recordOriginStream, takeConfirmedGaps, MAX_PENDING_ABOVE, GAP_CONFIRM_MS } from '../src/runtime/handler/state.js';

// The cross-worker maxima (see state-convergence.test.js) are structurally blind
// to a lost INTERIOR frame: a worker that received [2,3] and one that received
// [1,2,3] hold the same maximum and hash identically no matter how the entries
// are folded, so the relay can drop a frame to exactly one worker and nothing
// reports it. What distinguishes them is contiguity, tracked per (topic, origin)
// over the relay ORDINAL each sending worker stamps on its outbound frames.
//
// Unlike a maximum, a hole is decidable locally - the ordinal is dense at the
// origin by construction, so a worker holding 1 that receives 3 knows 2 was sent
// and never arrived. So these are REPORTS, not votes, and the tests below are
// about what a single worker concludes from its own delivery. The silence cases
// matter as much as the detections: a report can restart the worker, so a worker
// that lost nothing must say nothing, however it joined or whatever it missed
// legitimately.

describe('recordOriginStream (per-origin relay contiguity)', () => {
	// A stream born BEFORE we attached: nothing before our attach was ever ours.
	const OLD_BIRTH = 100;
	const ATTACHED_AT = 200;
	// A stream born AFTER we attached: every ordinal from 1 was owed to us.
	const NEW_BIRTH = 300;
	const clock = (t) => () => t;
	const gapsOf = (streams, at = 10_000) => takeConfirmedGaps(streams, at, GAP_CONFIRM_MS);

	it('baselines mid-stream when the stream predates our attach (a legitimate late join)', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 50, OLD_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 51, OLD_BIRTH, ATTACHED_AT, clock(1000));
		// Ordinals 1..49 were never ours to receive, so they are not a hole.
		expect(gapsOf(s)).toEqual([]);
	});

	it('reports a lost prefix when the stream was born after we attached', () => {
		const s = new Map();
		// We were on the relay when this stream opened, so ordinal 1 was owed to us.
		recordOriginStream(s, 'room', 7, 3, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([{ topic: 'room', origin: 7, from: 1, to: 2, count: 2 }]);
	});

	it('baselines when the first sighting IS the stream head', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 2, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([]);
	});

	it('baselines when birth EQUALS the attach instant (a tie resolves to silence)', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 4, ATTACHED_AT, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([]);
	});

	it('stays silent across a long contiguous stream', () => {
		const s = new Map();
		for (let ord = 1; ord <= 500; ord++) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		expect(gapsOf(s)).toEqual([]);
	});

	it('reports a skipped ordinal, naming exactly what was missing', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 2, NEW_BIRTH, ATTACHED_AT, clock(1000));
		// 3 and 4 are lost; 5 and 6 arrive.
		recordOriginStream(s, 'room', 7, 5, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 6, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([{ topic: 'room', origin: 7, from: 3, to: 4, count: 2 }]);
	});

	it('withholds a hole until the confirmation grace elapses (an in-flight reorder is not a loss)', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 3, NEW_BIRTH, ATTACHED_AT, clock(1000)); // hole opens at t=1000
		// Still inside the grace: the missing frame may yet be in flight.
		expect(takeConfirmedGaps(s, 1000 + GAP_CONFIRM_MS - 1, GAP_CONFIRM_MS)).toEqual([]);
		// Beyond it: gone, not late.
		expect(takeConfirmedGaps(s, 1000 + GAP_CONFIRM_MS, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 2, to: 2, count: 1 }]);
	});

	it('closes the hole when the reordered frame lands, and reports nothing', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 3, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 4, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 2, NEW_BIRTH, ATTACHED_AT, clock(1000)); // the straggler
		// 2 plugged the hole and 3,4 drained behind it: the stream is whole again.
		expect(gapsOf(s)).toEqual([]);
		expect(s.get('room').get(7).w).toBe(4);
	});

	it('re-ages the hole left behind when a drain exposes a new one', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(0));
		recordOriginStream(s, 'room', 7, 3, NEW_BIRTH, ATTACHED_AT, clock(0));  // hole at 2, aged from t=0
		recordOriginStream(s, 'room', 7, 5, NEW_BIRTH, ATTACHED_AT, clock(0));  // 4 also missing
		// 2 lands late, exposing the hole at 4 as the blocking one - and 4's age
		// must start HERE, not back at t=0, or a frame still in flight is called lost.
		recordOriginStream(s, 'room', 7, 2, NEW_BIRTH, ATTACHED_AT, clock(900));
		expect(takeConfirmedGaps(s, 1000, GAP_CONFIRM_MS)).toEqual([]);
		expect(takeConfirmedGaps(s, 900 + GAP_CONFIRM_MS, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 4, to: 4, count: 1 }]);
	});

	it('ignores a duplicate re-delivery below the watermark', () => {
		const s = new Map();
		for (const ord of [1, 2, 3, 2, 1, 3]) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		expect(gapsOf(s)).toEqual([]);
		expect(s.get('room').get(7).w).toBe(3);
	});

	it('tracks each origin separately, so two workers publishing one topic never look gapped', () => {
		const s = new Map();
		// Each origin stamps its OWN 1-based ordinal space for the same topic, so
		// interleaved arrival is normal and is not a hole in either stream.
		for (const ord of [1, 2, 3]) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
			recordOriginStream(s, 'room', 9, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		expect(gapsOf(s)).toEqual([]);
	});

	it('reports each affected (topic, origin) stream separately', () => {
		const s = new Map();
		for (const [topic, origin] of [['a', 7], ['b', 9]]) {
			recordOriginStream(s, topic, origin, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
			recordOriginStream(s, topic, origin, 3, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		expect(gapsOf(s)).toEqual([
			{ topic: 'a', origin: 7, from: 2, to: 2, count: 1 },
			{ topic: 'b', origin: 9, from: 2, to: 2, count: 1 }
		]);
	});

	it('reports one loss exactly ONCE, then resumes clean tracking from the new baseline', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 3, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([{ topic: 'room', origin: 7, from: 2, to: 2, count: 1 }]);
		// The report consumed it: a worker restates a lost frame once, not on every
		// tick for the life of the process.
		expect(gapsOf(s)).toEqual([]);
		// Tracking continues from the highest ordinal seen, so the stream stays quiet
		// while it is healthy...
		for (const ord of [4, 5, 6]) recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([]);
		// ...and a LATER loss on the same stream is its own report.
		recordOriginStream(s, 'room', 7, 9, NEW_BIRTH, ATTACHED_AT, clock(2000));
		expect(takeConfirmedGaps(s, 2000 + GAP_CONFIRM_MS, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 7, to: 8, count: 2 }]);
	});

	it('bounds the pending buffer without losing the hole, however far the publisher runs on', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		// 2 is lost; the publisher keeps going well past the pending cap.
		const last = 3 + MAX_PENDING_ABOVE + 50;
		for (let ord = 3; ord < last; ord++) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		expect(s.get('room').get(7).above.size).toBeLessThanOrEqual(MAX_PENDING_ABOVE);
		// The hole is still exactly identified, and still subject to the grace.
		expect(takeConfirmedGaps(s, 1000, GAP_CONFIRM_MS)).toEqual([]);
		expect(takeConfirmedGaps(s, 10_000, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 2, to: 2, count: 1 }]);
		// And the buffer is released once reported.
		expect(s.get('room').get(7).above).toBe(null);
	});

	it('does not swallow a late frame that arrives after the buffer filled', () => {
		const s = new Map();
		const last = 3 + MAX_PENDING_ABOVE + 20;
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		for (let ord = 3; ord < last; ord++) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		// The watermark never jumped past the hole, so the missing frame still plugs
		// it if it lands - a filled buffer must not turn a reorder into a loss.
		recordOriginStream(s, 'room', 7, 2, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(takeConfirmedGaps(s, 10_000, GAP_CONFIRM_MS)).toEqual([]);
		// And the publisher is still live: the frames that arrived above the cap
		// stopped being buffered but did NOT stop arriving, so the stream must carry
		// on from the last of them rather than re-reporting them as lost.
		recordOriginStream(s, 'room', 7, last, NEW_BIRTH, ATTACHED_AT, clock(2000));
		expect(takeConfirmedGaps(s, 20_000, GAP_CONFIRM_MS)).toEqual([]);
	});

	it('never invents a loss out of frames that arrived above the buffer cap', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		// 2 is genuinely lost, and a busy publisher then runs a thousand frames past
		// the cap. Every one of those ARRIVED - the buffer just stopped recording
		// which, so resuming from the buffer would call them all lost.
		for (let ord = 3; ord <= 1000; ord++) {
			recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		}
		// Exactly the one frame that never came.
		expect(takeConfirmedGaps(s, 10_000, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 2, to: 2, count: 1 }]);
		// The stream resumed from what arrived, so it stays quiet as the publisher
		// continues - no second, fabricated report of 900-odd delivered frames.
		recordOriginStream(s, 'room', 7, 1001, NEW_BIRTH, ATTACHED_AT, clock(11_000));
		recordOriginStream(s, 'room', 7, 1002, NEW_BIRTH, ATTACHED_AT, clock(11_000));
		expect(takeConfirmedGaps(s, 20_000, GAP_CONFIRM_MS)).toEqual([]);
	});

	it('reports a real loss that happens after a cap-limited stream resumes', () => {
		const s = new Map();
		recordOriginStream(s, 'room', 7, 1, NEW_BIRTH, ATTACHED_AT, clock(1000));
		for (let ord = 3; ord <= 500; ord++) recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(takeConfirmedGaps(s, 10_000, GAP_CONFIRM_MS)).toHaveLength(1);
		// Resuming must not blind the stream: a later drop is still its own report.
		recordOriginStream(s, 'room', 7, 502, NEW_BIRTH, ATTACHED_AT, clock(11_000));
		expect(takeConfirmedGaps(s, 11_000 + GAP_CONFIRM_MS, GAP_CONFIRM_MS))
			.toEqual([{ topic: 'room', origin: 7, from: 501, to: 501, count: 1 }]);
	});

	it('ignores a frame carrying no origin metadata (a worker predating the carry)', () => {
		const s = new Map();
		recordOriginStream(s, 'room', undefined, undefined, undefined, ATTACHED_AT, clock(1000));
		recordOriginStream(s, 'room', 7, 5, undefined, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([]);
	});

	it('reports nothing before this worker has attached (attachedAt is Infinity)', () => {
		const s = new Map();
		// Nothing is owed to a worker that is not yet on the relay, whatever it sees.
		recordOriginStream(s, 'room', 7, 42, NEW_BIRTH, Infinity, clock(1000));
		expect(gapsOf(s)).toEqual([]);
	});

	it('reads the clock only when a hole opens, never on the contiguous path', () => {
		const s = new Map();
		let reads = 0;
		const counted = () => { reads++; return 1000; };
		for (let ord = 1; ord <= 100; ord++) recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, counted);
		expect(reads).toBe(0);
		recordOriginStream(s, 'room', 7, 102, NEW_BIRTH, ATTACHED_AT, counted); // hole
		expect(reads).toBe(1);
		// An already-open hole does not re-read: the hole's age is from its start.
		recordOriginStream(s, 'room', 7, 103, NEW_BIRTH, ATTACHED_AT, counted);
		expect(reads).toBe(1);
	});

	it('a worker that received the whole stream reports nothing (the case the report must not fire on)', () => {
		const s = new Map();
		// The counterpart to the card's scenario: the sibling that got [1,2,3] while
		// another got [2,3]. Same maximum, but only the one that lost a frame speaks.
		for (const ord of [1, 2, 3]) recordOriginStream(s, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(s)).toEqual([]);

		const lost = new Map();
		for (const ord of [2, 3]) recordOriginStream(lost, 'room', 7, ord, NEW_BIRTH, ATTACHED_AT, clock(1000));
		expect(gapsOf(lost)).toEqual([{ topic: 'room', origin: 7, from: 1, to: 1, count: 1 }]);
	});
});

// The primary's half of the report lives in the worker-message handler in
// runtime/index.js, which is a build template (its HANDLER import is replaced at
// build time), so it cannot be imported and driven here. It CAN be parsed, and
// the one defect worth guarding is structural: the gap branch reads as a sibling
// of the other message types but is one brace deep, chained onto an inner `if`
// instead of the message-type chain. That compiles, tests green, and the branch
// simply never runs - which is exactly how it shipped broken once.
describe('primary relay-gap handler wiring (runtime/index.js)', () => {
	const source = readFileSync(fileURLToPath(new URL('../src/runtime/index.js', import.meta.url)), 'utf8');
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

	/** Every `if/else if` chain in the file, flattened to the tests of its arms. */
	function chains(node, out = []) {
		if (node === null || typeof node !== 'object') return out;
		if (Array.isArray(node)) {
			for (const n of node) chains(n, out);
			return out;
		}
		if (node.type === 'IfStatement') {
			const arms = [];
			for (let n = node; n && n.type === 'IfStatement'; n = n.alternate) {
				arms.push(source.slice(n.test.start, n.test.end));
				chains(n.consequent, out);
			}
			out.push(arms);
			return out;
		}
		for (const k of Object.keys(node)) {
			if (k === 'start' || k === 'end' || k === 'loc') continue;
			chains(node[k], out);
		}
		return out;
	}

	const all = chains(ast);

	it('dispatches relay-gap from the same message-type chain as the other worker messages', () => {
		// The chain that handles worker messages: the one testing msg.type at all.
		const chain = all.find((arms) => arms.some((t) => t.includes("msg.type === 'state-hash'")));
		expect(chain, "no msg.type chain containing 'state-hash'").toBeDefined();
		// If relay-gap is not an arm of THIS chain, it is nested under some inner
		// condition and can never fire for a relay-gap message.
		expect(chain.some((t) => t.includes("msg.type === 'relay-gap'"))).toBe(true);
	});

	it('never guards relay-gap behind a condition that a relay-gap message cannot satisfy', () => {
		for (const arms of all) {
			const i = arms.findIndex((t) => t.includes("msg.type === 'relay-gap'"));
			if (i === -1) continue;
			// Every earlier arm of a chain containing relay-gap must itself be a
			// msg.type test - anything else (the shipped-once bug was `if (divergence)`)
			// means the branch is chained to the wrong `if`.
			for (const t of arms.slice(0, i)) expect(t).toContain('msg.type');
		}
	});

	it('routes every relay-gap message to ONE live arm', () => {
		// The checks above pass if a chain merely CONTAINS a relay-gap arm, which a
		// duplicated arm (a bad merge) would satisfy while shadowing the real handler
		// - the first arm wins and the second is unreachable. An arm is only live if
		// nothing before it claims the same message.
		const chain = all.find((arms) => arms.some((t) => t.includes("msg.type === 'state-hash'")));
		const literals = chain.map((t) => (t.match(/msg\.type === '([^']+)'/) || [])[1]).filter(Boolean);
		expect(new Set(literals).size, 'a message type is tested twice in one chain: ' + literals.join(', '))
			.toBe(literals.length);
	});
});

describe('the report never names a frame that arrived', () => {
	// The buffer above a hole is capped. Once full, an arrival BELOW the lowest
	// buffered ordinal used to be recorded nowhere, while the report boundary is
	// computed from that lowest buffered value - so a deep reorder with the high
	// block first made the report span frames the worker was holding. One lost
	// frame came back as 98, and relay_gap_frames_total was incremented by 98.
	//
	// The buffer now keeps the SMALLEST ordinals, so the boundary is the true
	// lowest arrival above the hole and everything below it genuinely never came.
	const BIRTH = 300;
	const ATTACHED = 200;
	const clock = (t) => () => t;
	const gapsOf = (streams, at = 10_000) => takeConfirmedGaps(streams, at, GAP_CONFIRM_MS);

	it('reports one lost frame as one, not as the whole reordered span', () => {
		const streams = new Map();
		const now = clock(1000);
		const HIGH = 100;

		// Ordinal 1 lands. Ordinal 2 is the only frame that is ever lost.
		recordOriginStream(streams, 'room', 7, 1, BIRTH, ATTACHED, now);
		// A high block arrives first and fills the buffer to the cap...
		for (let o = HIGH; o < HIGH + MAX_PENDING_ABOVE; o++) {
			recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
		}
		// ... and only then does everything between 3 and 99 arrive. All of it was
		// delivered; none of it may appear in the report.
		for (let o = 3; o < HIGH; o++) {
			recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
		}

		const gaps = gapsOf(streams);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ topic: 'room', origin: 7, from: 2, to: 2, count: 1 });
	});

	it('stays silent when a deep reorder delivered everything', () => {
		// An arrival ABOVE everything retained is discarded once the buffer is full.
		// It still ARRIVED, so the report boundary must not cross it - otherwise a
		// later straggler drains the watermark past it and a DELIVERED ordinal lands
		// inside the reported range. Here every ordinal 1..81 is delivered and
		// nothing at all is lost.
		const streams = new Map();
		const now = clock(1000);
		const rec = (o) => recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
		const order = [1];
		for (let o = 3; o <= 40; o++) order.push(o);
		for (let o = 42; o <= 67; o++) order.push(o);
		for (let o = 68; o <= 80; o++) order.push(o);
		order.push(2, 81, 41);
		for (const o of order) rec(o);

		expect(gapsOf(streams), 'every ordinal arrived, so nothing may be reported').toEqual([]);
	});

	it('retains a later real loss when an earlier deep reorder closes', () => {
		// Fill the exact buffer behind a reordered 2, then lose 67 while later
		// frames continue. The old scalar remembered that 68 arrived, but when 2
		// landed it discarded that fact, jumped w to hi=80 and made the real
		// interior loss invisible - the card's equal-maxima bug again.
		const streams = new Map();
		const now = clock(1000);
		const rec = (o) => recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
		rec(1);
		for (let o = 3; o < 3 + MAX_PENDING_ABOVE; o++) rec(o);
		for (let o = 68; o <= 80; o++) rec(o);
		rec(2);

		expect(gapsOf(streams)).toEqual([
			{ topic: 'room', origin: 7, from: 67, to: 67, count: 1 }
		]);
	});

	it('closes a later compacted range when its missing frame also arrives', () => {
		// Negative control: compact retention must not turn the same complete deep
		// reorder into a restart-worthy report.
		const streams = new Map();
		const now = clock(1000);
		const rec = (o) => recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
		rec(1);
		for (let o = 3; o < 3 + MAX_PENDING_ABOVE; o++) rec(o);
		for (let o = 68; o <= 80; o++) rec(o);
		rec(2);
		rec(67);

		expect(gapsOf(streams), 'every ordinal arrived, so nothing may be reported').toEqual([]);
		expect(streams.get('room').get(7).w).toBe(80);
	});

	it('never emits an inverted or zero-width range', () => {
		// A consumer reads `count` into relay_gap_frames_total and the `[from, to]`
		// span into an operator-facing log line, and RESTART_ON_STATE_DIVERGENCE
		// acts on the report - so a `to < from` entry would restart a worker over
		// nothing. Sweep the shapes that close a hole out of order while the buffer
		// is saturated.
		for (let extra = 0; extra <= 6; extra++) {
			const streams = new Map();
			const now = clock(1000);
			const rec = (o) => recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);
			rec(1);
			for (let o = 3; o < 3 + MAX_PENDING_ABOVE + extra; o++) rec(o);
			rec(2);
			for (const g of gapsOf(streams)) {
				expect(g.to, 'inverted range ' + JSON.stringify(g)).toBeGreaterThanOrEqual(g.from);
				expect(g.count, 'non-positive count ' + JSON.stringify(g)).toBeGreaterThan(0);
			}
		}
	});

	it('keeps the cached buffer maximum consistent with the buffer', () => {
		// aboveMax is the eviction pivot. A stale value evicts the wrong ordinal and
		// silently corrupts the report boundary, and three separate mutations of its
		// bookkeeping previously left this whole file green.
		const maxOf = (set) => (set === null ? -Infinity : Math.max(...set));
		const check = (streams, label) => {
			const st = streams.get('room').get(7);
			expect(st.aboveMax, label + ': cached max disagrees with the buffer').toBe(maxOf(st.above));
			if (st.above !== null) expect(st.above.size, label + ': buffer exceeded the cap').toBeLessThanOrEqual(MAX_PENDING_ABOVE);
		};
		const now = clock(1000);

		// After a first-sighting gap (the constructor that seeds a non-empty buffer).
		const a = new Map();
		recordOriginStream(a, 'room', 7, 42, BIRTH, ATTACHED, now);
		check(a, 'first sighting');

		// After a partial drain that leaves a second hole behind.
		const b = new Map();
		for (const o of [1, 3, 5, 6, 7]) recordOriginStream(b, 'room', 7, o, BIRTH, ATTACHED, now);
		recordOriginStream(b, 'room', 7, 2, BIRTH, ATTACHED, now);
		check(b, 'partial drain');

		// Across the cap, with evictions and duplicates.
		const c = new Map();
		recordOriginStream(c, 'room', 7, 1, BIRTH, ATTACHED, now);
		for (let o = 3 + MAX_PENDING_ABOVE * 2; o > 2; o--) {
			recordOriginStream(c, 'room', 7, o, BIRTH, ATTACHED, now);
			if (o % 7 === 0) recordOriginStream(c, 'room', 7, o, BIRTH, ATTACHED, now);
		}
		check(c, 'descending with duplicates');

		// After a re-baseline, the buffer is released and the cache must follow...
		const d = new Map();
		recordOriginStream(d, 'room', 7, 1, BIRTH, ATTACHED, now);
		recordOriginStream(d, 'room', 7, 3, BIRTH, ATTACHED, now);
		gapsOf(d);
		check(d, 'after re-baseline');

		// ...and a NEW hole opening afterwards must start from a clean cache. This
		// is the case that catches a stale maximum surviving the null-ing of the
		// buffer: checking only at the moment of re-baseline cannot see it, because
		// the buffer is empty and any value trivially agrees.
		recordOriginStream(d, 'room', 7, 5, BIRTH, ATTACHED, now);
		check(d, 'new hole after re-baseline');
		recordOriginStream(d, 'room', 7, 9, BIRTH, ATTACHED, now);
		recordOriginStream(d, 'room', 7, 7, BIRTH, ATTACHED, now);
		check(d, 'new hole, several buffered');
	});

	it('a duplicate arriving at the cap does not evict a frame that arrived', () => {
		// Duplicate re-delivery is expected input on this path, and it interacts with
		// the eviction: re-adding a value the buffer already holds would still evict
		// the maximum, shrinking the set by one and forgetting an ordinal that
		// ARRIVED. A later arrival takes the freed slot, the drain stops on the
		// forgotten value, and it is reported lost - the exact class the retention
		// exists to close, reintroduced by the retention itself.
		const streams = new Map();
		const now = clock(1000);
		const rec = (o) => recordOriginStream(streams, 'room', 7, o, BIRTH, ATTACHED, now);

		rec(1);
		// Fill the buffer to the cap with 3..66 (2 is the only frame not yet seen).
		for (let o = 3; o < 3 + MAX_PENDING_ABOVE; o++) rec(o);
		// A duplicate of a buffered ordinal, then one more new arrival, then the
		// straggler that plugs the hole. Nothing was ever lost.
		rec(3);
		rec(3 + MAX_PENDING_ABOVE);
		rec(2);

		expect(gapsOf(streams), 'nothing was lost, so nothing may be reported').toEqual([]);
	});

	it('still reports a genuinely wide gap at its true width', () => {
		// Control: the narrowing above must come from arrivals being recorded, not
		// from the report having been clamped.
		const streams = new Map();
		const now = clock(1000);
		recordOriginStream(streams, 'room', 7, 1, BIRTH, ATTACHED, now);
		// 2..99 really are lost; only 100 arrives.
		recordOriginStream(streams, 'room', 7, 100, BIRTH, ATTACHED, now);

		const gaps = gapsOf(streams);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ from: 2, to: 99, count: 98 });
	});
});

describe('relay attach latch (markRelayAttached)', () => {
	// The latch is what separates "this stream started before we were listening,
	// so its prefix was never ours" from "we were attached and lost the prefix".
	// Without it every late-joining worker would report the whole history of every
	// stream as lost.
	it('records an attach instant that a later stream birth compares against', async () => {
		const state = await import('../src/runtime/handler/state.js');
		expect(typeof state.markRelayAttached).toBe('function');
		state.markRelayAttached();
		expect(state.relayAttach.at, 'attaching must stamp a non-zero instant').toBeGreaterThan(0);

		// A stream BORN BEFORE the attach owes this worker nothing below the first
		// ordinal it saw, so a missing prefix must stay silent...
		const before = new Map();
		const now = () => state.relayAttach.at + 5_000;
		recordOriginStream(before, 'room', 1, 42, state.relayAttach.at - 100, state.relayAttach.at, now);
		expect(takeConfirmedGaps(before, state.relayAttach.at + 20_000, GAP_CONFIRM_MS)).toEqual([]);

		// ... while a stream born AFTER the attach owed us ordinal 1, so the same
		// shape is a real loss. This is the comparison the latch exists for.
		const after = new Map();
		recordOriginStream(after, 'room', 1, 42, state.relayAttach.at + 100, state.relayAttach.at, now);
		const gaps = takeConfirmedGaps(after, state.relayAttach.at + 20_000, GAP_CONFIRM_MS);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ from: 1, to: 41 });
	});
});

describe('the detector is actually wired into the runtime', () => {
	// The decisions above are driven behaviourally. The JOINS that turn them into
	// a working detector are split:
	//
	// The two receive-path joins are now proven BEHAVIOURALLY, in
	// relay-receive-real.test.js, which boots the built runtime and drives the
	// real relayPublish / relayPublishBatched. Importing lifecycle.js from SOURCE
	// does fail with "Cannot find package 'WS_HANDLER'" (via
	// ws-handler-bridge.js), but the adapter emits handler/ as separate modules
	// with that placeholder resolved, so the built copy imports fine. Each of the
	// two calls is verified red there by deleting it.
	//
	// The remaining two joins below stay STRUCTURAL, and are deliberately
	// labelled as such - they prove a call exists and is not smothered by a
	// condition, not that it runs. That is a property of THIS suite, not a
	// property of the code: the reporter installs when `parentPort` is present
	// and `stateHashIntervalMs` is set, which needs a worker thread and a build
	// variant carrying that option - both of which this repo already does
	// elsewhere (relay-ring.test.js spawns worker threads; acceptor-init.test.js
	// boots a real CLUSTER_WORKERS=2 runtime). So these two are undriven here,
	// not undrivable, and the drain-and-report join in particular is worth
	// driving: draining without reporting consumes the evidence and tells
	// nobody.
	const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
	const astOf = (src) => parse(src, { ecmaVersion: 'latest', sourceType: 'module' });

	/**
	 * Collect every CallExpression to `name`, each with its ancestor chain.
	 * @param {any} node @param {string} name
	 * @returns {{ node: any, ancestors: any[] }[]}
	 */
	function callsTo(node, name) {
		/** @type {{ node: any, ancestors: any[] }[]} */
		const hits = [];
		const walk = (n, ancestors) => {
			if (!n || typeof n.type !== 'string') return;
			if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === name) {
				hits.push({ node: n, ancestors });
			}
			const next = ancestors.concat(n);
			for (const key of Object.keys(n)) {
				const v = n[key];
				if (Array.isArray(v)) for (const c of v) walk(c, next);
				else if (v && typeof v.type === 'string') walk(v, next);
			}
		};
		walk(node, []);
		return hits;
	}

	/**
	 * The nearest enclosing function of a node, plus whether that function is
	 * REACHABLE - exported, or referenced by name somewhere else in the file.
	 * A call parked inside a function nobody calls satisfies a presence check
	 * while never running, which is how the first version of these guards was
	 * defeated by moving the wiring into a dead `__neverCalled()`.
	 */
	function enclosing(ancestors, src) {
		for (let i = ancestors.length - 1; i >= 0; i--) {
			const a = ancestors[i];
			if (a.type !== 'FunctionDeclaration' && a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression') continue;
			const name = a.id?.name ?? null;
			if (name === null) return { name: null, reachable: true }; // inline callback: runs where it sits
			const exported = new RegExp('export\\s+(async\\s+)?function\\s+' + name + '\\b').test(src) ||
				new RegExp('export\\s*\\{[^}]*\\b' + name + '\\b').test(src);
			const referenced = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length > 1;
			return { name, reachable: exported || referenced };
		}
		return { name: null, reachable: true };
	}

	it('keeps both receive-path recordings behind the streamTracking gate (lifecycle.js)', () => {
		// THAT these two calls run, and that each records, is proven behaviourally
		// in relay-receive-real.test.js. What a behavioural test cannot see is the
		// SHAPE of the gate: moving the flag test inside recordOriginStream would
		// keep every assertion there green while making a default deployment pay a
		// call, an argument evaluation and a Map lookup on every relayed frame.
		// That perf property is what this guard still covers.
		const src = read('../src/runtime/handler/lifecycle.js');
		const hits = callsTo(astOf(src), 'recordOriginStream');
		expect(hits.length, 'both the single and batch relay receive paths must record').toBeGreaterThanOrEqual(2);
		// Checked per CALL via the ancestor chain rather than as a whole-file
		// substring, which a comment mentioning the flag would satisfy.
		for (const { ancestors } of hits) {
			const gated = ancestors.some(
				(a) => a.type === 'IfStatement' && src.slice(a.test.start, a.test.end).includes('streamTracking.enabled')
			);
			// An early return at the top of the enclosing function -
			// `if (!streamTracking.enabled) return;` - is the same gate at the same
			// cost, and must not read as a violation just because it leaves the call
			// with no enclosing IfStatement.
			const earlyReturn = !gated && ancestors.some((a) => {
				if (a.type !== 'FunctionDeclaration' && a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression') return false;
				return /if\s*\(\s*!\s*streamTracking\.enabled\s*\)\s*(\{\s*)?return\b/.test(src.slice(a.start, a.end));
			});
			expect(gated || earlyReturn, 'a recordOriginStream call is not behind streamTracking.enabled').toBe(true);
		}
	});

	it('drains confirmed gaps and emits them from the SAME function (handler.js)', () => {
		const src = read('../src/runtime/handler.js');
		const hits = callsTo(astOf(src), 'takeConfirmedGaps');
		expect(hits.length, 'the reporter must drain the confirmed gaps').toBeGreaterThanOrEqual(1);
		// Draining without reporting consumes the evidence and tells nobody, which
		// is worse than not detecting. Parking the emission in a separate function
		// satisfies a whole-file substring check, so require the emission to live
		// in the same enclosing function as the drain.
		let emitted = false;
		for (const { ancestors } of hits) {
			const fn = enclosing(ancestors, src);
			expect(fn.reachable, 'takeConfirmedGaps sits in unreachable function ' + fn.name).toBe(true);
			for (let i = ancestors.length - 1; i >= 0; i--) {
				const a = ancestors[i];
				if (a.type !== 'FunctionDeclaration' && a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression') continue;
				const body = src.slice(a.start, a.end);
				if (body.includes('relay-gap') && /postMessage\(/.test(body)) emitted = true;
				break;
			}
		}
		expect(emitted, 'a drained gap must be reported from the function that drained it').toBe(true);
	});

	it('latches the attach instant unconditionally (runtime/index.js)', () => {
		// markRelayAttached must run for EVERY worker. Smothered by a relayRing
		// test - in an if, a ternary, or a && short-circuit - a worker with no ring
		// would never latch and would then treat every stream as born after its
		// attach, reporting whole histories as lost.
		const src = read('../src/runtime/index.js');
		const hits = callsTo(astOf(src), 'markRelayAttached');
		expect(hits.length, 'the attach latch must be called').toBeGreaterThanOrEqual(1);
		let unconditional = 0;
		for (const { ancestors } of hits) {
			const fn = enclosing(ancestors, src);
			expect(fn.reachable, 'markRelayAttached sits in unreachable function ' + fn.name).toBe(true);
			const smothered = ancestors.some((a) => {
				if (a.type === 'IfStatement') return src.slice(a.test.start, a.test.end).includes('relayRing');
				// A ternary or a && guard is not an IfStatement but gates just as hard.
				if (a.type === 'LogicalExpression' || a.type === 'ConditionalExpression') return true;
				return false;
			});
			if (!smothered) unconditional++;
		}
		expect(unconditional, 'every markRelayAttached call is gated by a condition').toBeGreaterThanOrEqual(1);
	});
});
