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
