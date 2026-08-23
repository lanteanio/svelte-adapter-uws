// The egress account's charge math, driven through the shared unit every
// surface runs (utils/egress-account.js) with an injected clock, so window
// rotation is exact rather than timed. The end-to-end suites drive the same
// account through createTestServer, the dev plugin, and the built runtime;
// this file pins the arithmetic those suites then observe from outside.

import { describe, it, expect } from 'vitest';
import {
	normalizeEgressOptions,
	createEgressAccount,
	binaryFrameChargeBytes,
	envelopeWireBytes,
	excludedRecipient,
	EGRESS_DEFAULT_WINDOW_MS
} from '../src/runtime/utils/egress-account.js';
import { WS_SUBSCRIPTIONS } from '../src/runtime/utils.js';

function accountWith(options, io = {}) {
	let nowMs = 0;
	const refusals = [];
	const invalid = [];
	const account = createEgressAccount({
		options: normalizeEgressOptions(options),
		clock: () => nowMs,
		onRefused: (scope, topic, dimension, limit) => refusals.push({ scope, topic, dimension, limit }),
		onResolverInvalid: (raw) => invalid.push(raw),
		...io
	});
	return { account, refusals, invalid, advance: (ms) => { nowMs += ms; } };
}

describe('normalizeEgressOptions', () => {
	it('defaults to a disabled account with the documented window', () => {
		const config = normalizeEgressOptions(undefined);
		expect(config.windowMs).toBe(EGRESS_DEFAULT_WINDOW_MS);
		expect(config.topicEnabled).toBe(false);
		expect(config.tenantEnabled).toBe(false);
	});

	it('reads 0 as a deliberately disabled ceiling', () => {
		const config = normalizeEgressOptions({ topic: { messages: 0, bytes: 5, deliveries: 0 } });
		expect(config.topic).toEqual({ messages: 0, bytes: 5, deliveries: 0 });
		expect(config.topicEnabled).toBe(true);
	});

	it('arms the encoded-length measure for a BYTES ceiling only', () => {
		// Measuring encoded length walks the envelope - O(envelope) on the
		// hottest primitive here, 517 ns at 2 KB - so only the ceiling that
		// decides on the number may arm it. Widening this back to "any armed
		// ceiling" charges a messages-only budget for a value nothing reads.
		expect(normalizeEgressOptions({ topic: { messages: 5 } }).bytesEnabled).toBe(false);
		expect(normalizeEgressOptions({ topic: { deliveries: 5 } }).bytesEnabled).toBe(false);
		expect(normalizeEgressOptions({ tenant: { messages: 5, deliveries: 5 } }).bytesEnabled).toBe(false);
		expect(normalizeEgressOptions({ topic: { bytes: 5 } }).bytesEnabled).toBe(true);
		expect(normalizeEgressOptions({ tenant: { bytes: 5 } }).bytesEnabled).toBe(true);

		// And the unit that reaches the ledger follows the flag, on an
		// envelope where the two units differ.
		const envelope = '{"topic":"t","event":"e","data":"grün"}';
		expect(Buffer.byteLength(envelope)).toBeGreaterThan(envelope.length);
		const messagesOnly = normalizeEgressOptions({ topic: { messages: 5 } });
		const withBytes = normalizeEgressOptions({ topic: { bytes: 5 } });
		expect(envelopeWireBytes(envelope, 2, messagesOnly.bytesEnabled)).toBe(envelope.length * 2);
		expect(envelopeWireBytes(envelope, 2, withBytes.bytesEnabled)).toBe(Buffer.byteLength(envelope) * 2);
	});

	it('sizes the ledger from maxKeys, rounded UP to the next power of two', () => {
		// The EFFECTIVE bound is exposed on the config so every consumer - the
		// ledgers, the memo, and an operator reading the account - agrees on
		// one number. Rounding up is the memory law, not a convenience: the V8
		// backing table is the power-of-two size either way, so the rounded
		// bound holds no fewer keys - strictly more whenever rounding moves
		// the value - in the memory the requested value would have taken.
		expect(normalizeEgressOptions(undefined).maxKeys).toBe(4096);
		expect(normalizeEgressOptions({}).maxKeys).toBe(4096);
		expect(normalizeEgressOptions({ maxKeys: 4096 }).maxKeys).toBe(4096);
		expect(normalizeEgressOptions({ maxKeys: 1024 }).maxKeys).toBe(1024);
		expect(normalizeEgressOptions({ maxKeys: 5000 }).maxKeys).toBe(8192);
		expect(normalizeEgressOptions({ maxKeys: 8193 }).maxKeys).toBe(16384);
		expect(normalizeEgressOptions({ maxKeys: 2 ** 24 }).maxKeys).toBe(2 ** 24);
	});

	it('reads an unusable maxKeys or evictionSample as absent, never as inverted', () => {
		// The shared guard refuses these on every intake surface; a value that
		// still arrives here must land on the default rather than on some
		// clamped reading the operator never asked for. The bounds are the
		// guard's own: below 1024 there is no sizing story and the derived
		// slack degenerates, above 2^24 a V8 Map throws on the insert instead
		// of seating the entry - a crash on the publish path, verified
		// empirically at exactly 2^24 - and there is deliberately no
		// 0-disables, because an unbounded ledger reaches that same crash
		// behind unbounded memory first.
		for (const bad of [0, -1, 1023, 1.5, '8192', 2 ** 24 + 1, Number.MAX_SAFE_INTEGER + 2, null]) {
			expect(normalizeEgressOptions({ maxKeys: bad }).maxKeys, `maxKeys ${String(bad)}`).toBe(4096);
		}
		expect(normalizeEgressOptions(undefined).evictionSample).toBe(8);
		expect(normalizeEgressOptions({ evictionSample: 64 }).evictionSample).toBe(64);
		for (const bad of [0, -3, 2.5, '16', null]) {
			expect(normalizeEgressOptions({ evictionSample: bad }).evictionSample, `evictionSample ${String(bad)}`).toBe(8);
		}
	});
});

describe('the usage maps bound keys LIVE AT ONCE, not keys seen over a lifetime', () => {
	it('keeps enforcing a long-lived hot topic while short-lived topics churn past the cap', () => {
		const { account, advance } = accountWith({ windowMs: 1000, topic: { messages: 2 } });

		// 8000 distinct short-lived topics - twice the map cap - retired over
		// 80 windows, with never more than ~100 of them live inside any one
		// window. `room:<uuid>` is exactly that shape, so this is a steady
		// state rather than an edge case.
		for (let w = 0; w < 80; w++) {
			// The hot topic reaches its ceiling early in the window.
			expect(account.admit('lobby', null, 1, 1)).toBe(true);
			account.charge('lobby', null, 1, 1, 10);
			expect(account.admit('lobby', null, 1, 1)).toBe(true);
			account.charge('lobby', null, 1, 1, 10);

			for (let i = 0; i < 100; i++) {
				const topic = 'room:w' + w + '-' + i;
				expect(account.admit(topic, null, 1, 1)).toBe(true);
				account.charge(topic, null, 1, 1, 10);
			}

			// ...and is still over it after the churn. Evicting by
			// first-insert order instead of window-start order makes the hot
			// topic the very first victim once the cap is crossed, which
			// restarts its window empty and admits it again mid-window.
			expect(
				account.admit('lobby', null, 1, 1),
				'window ' + w + ': the hot topic must still refuse at its ceiling'
			).toBe(false);
			advance(1000);
		}
	});

	// The property, at four cluster sizes rather than one: when the ledger is
	// full of LIVE keys and something has to go, the key that goes is never the
	// busy one. Nothing expires inside this window, so every insert past the cap
	// forces a live eviction and the choice is exercised on every one of them -
	// a churn workload where expired windows are available instead reclaims
	// those for free and never tests the choice at all.
	// Every dimension a ceiling can be configured on, because the score has to
	// measure the one the operator armed. A busy key here spends its whole
	// allowance in ONE publish on the deliveries and bytes arms, so a score that
	// counts publishes reads it as identical to the one-shot churn around it.
	const DIMENSIONS = [
		{ label: 'a messages ceiling', ceilings: { messages: 2 }, hot: { messages: 2, recipients: 1, bytes: 10 }, churn: { recipients: 1, bytes: 10 } },
		{ label: 'a deliveries ceiling', ceilings: { deliveries: 4 }, hot: { messages: 1, recipients: 4, bytes: 10 }, churn: { recipients: 1, bytes: 10 } },
		{ label: 'a bytes ceiling', ceilings: { bytes: 500 }, hot: { messages: 1, recipients: 1, bytes: 600 }, churn: { recipients: 1, bytes: 10 } }
	];
	for (const dim of DIMENSIONS) {
		for (const HOT of [8, 16, 32, 64]) {
			it('gives up a one-shot topic, never a busy one, under ' + dim.label + ' with ' + HOT + ' busy topics', () => {
				const { account, advance } = accountWith({ windowMs: 60_000, topic: dim.ceilings });
				const hot = Array.from({ length: HOT }, (_, i) => 'hot:' + i);
				let seeded = 0;
				for (let i = 0; i < 6000; i++) {
					advance(1);
					if (seeded < HOT && i % 7 === 0) {
						const topic = hot[seeded++];
						for (let n = 0; n < dim.hot.messages; n++) {
							account.admit(topic, null, 1, dim.hot.recipients);
							account.charge(topic, null, 1, dim.hot.recipients, dim.hot.bytes);
						}
						continue;
					}
					const topic = 'room:' + i;
					account.admit(topic, null, 1, dim.churn.recipients);
					account.charge(topic, null, 1, dim.churn.recipients, dim.churn.bytes);
				}
				const stillEnforcing = hot.filter((topic) => !account.admit(topic, null, 1, dim.hot.recipients));
				expect(stillEnforcing).toHaveLength(HOT);
			});
		}
	}

	it('carries the previous window forward, so a key early in a fresh window is not the victim', () => {
		// The carry is the whole reason the score spans two windows. Early in its
		// window a steady publisher has spent barely anything, so on the current
		// window alone it reads as the idlest key in the ledger - and would be
		// evicted exactly when it has just proved it is live. Nothing else in
		// this file rotates a window under cap pressure.
		const { account, advance } = accountWith({ windowMs: 1000, topic: { messages: 4 } });
		// Window one: 'steady' spends its whole allowance, so the carry is full.
		for (let i = 0; i < 4; i++) {
			account.admit('steady', null, 1, 1);
			account.charge('steady', null, 1, 1, 10);
		}
		advance(1000);
		// Window two: it has spent a quarter of its allowance, LESS than the
		// churn keys spend, so only the carry ranks it above them.
		account.admit('steady', null, 1, 1);
		account.charge('steady', null, 1, 1, 10);
		for (let i = 0; i < 6000; i++) {
			const topic = 'room:' + i;
			for (let n = 0; n < 2; n++) {
				account.admit(topic, null, 1, 1);
				account.charge(topic, null, 1, 1, 10);
			}
		}

		// Its window survived the churn, so the one message it had already spent
		// still counts against the ceiling: three more fill it exactly, and the
		// fourth is refused. Evicted and restarted, it would have had a full
		// allowance and admitted that fourth publish.
		for (let i = 0; i < 3; i++) {
			expect(account.admit('steady', null, 1, 1)).toBe(true);
			account.charge('steady', null, 1, 1, 10);
		}
		expect(account.admit('steady', null, 1, 1), 'the spent message survived the churn').toBe(false);
	});

	for (const HOT of [8, 16, 32, 64]) {
		it('gives up a one-shot topic, never a busy one, with ' + HOT + ' busy topics', () => {
			const { account, advance } = accountWith({ windowMs: 60_000, topic: { messages: 2 } });
			const hot = Array.from({ length: HOT }, (_, i) => 'hot:' + i);
			// Busy topics are spread THROUGH the churn rather than seeded in one
			// block, so a sample holds a mix and the choice between the two kinds
			// is what decides the victim. Seeded in a block they occupy whole
			// samples, and then one of them has to go however it is scored.
			let seeded = 0;
			for (let i = 0; i < 6000; i++) {
				// The clock moves inside the window, so the keys seeded first
				// carry the oldest window START while staying live: that is what
				// separates scoring by activity from scoring by `at`.
				advance(1);
				if (seeded < HOT && i % 7 === 0) {
					// Two messages against a two-message ceiling, so this topic's
					// next publish must be refused for as long as its window
					// survives.
					const topic = hot[seeded++];
					for (let n = 0; n < 2; n++) {
						account.admit(topic, null, 1, 1);
						account.charge(topic, null, 1, 1, 10);
					}
					continue;
				}
				const topic = 'room:' + i;
				account.admit(topic, null, 1, 1);
				account.charge(topic, null, 1, 1, 10);
			}

			// Every busy topic still refuses. Scoring by window START instead
			// inverts the choice - a key that rotates at the boundary or was
			// seeded first carries the OLDEST start - and feeds exactly the
			// runaway publishers a ceiling exists to bound to the churn.
			const stillEnforcing = hot.filter((topic) => !account.admit(topic, null, 1, 1));
			expect(stillEnforcing).toHaveLength(HOT);
		});
	}

	it('reclaims lapsed windows, so a population well under the cap never loses a ceiling', () => {
		// The cap has to bound keys LIVE AT ONCE, not keys ever seen. Without
		// reclamation the map fills with windows that lapsed long ago, and then a
		// new key forces a choice among whichever consecutive entries the cursor
		// is standing on - which costs at-ceiling topics their enforcement at a
		// fraction of the cap, while thousands of reclaimable windows sit resident.
		/** @type {string[]} */
		const evicted = [];
		const { account, advance } = accountWith(
			{ windowMs: 1000, topic: { messages: 4 } },
			{ onEvicted: (scope) => evicted.push(scope) }
		);
		const POP = 3800;
		for (let w = 0; w < 60; w++) {
			advance(1000);
			// Most of the population publishes in most windows, so live keys peak
			// in the low thousands - under the cap, but far past it once every
			// window the run has ever opened is counted.
			for (let i = 0; i < POP; i++) {
				if ((i * 7919 + w * 104729) % 10 === 0) continue;
				const topic = 'pop:' + i;
				for (let n = 0; n < 4; n++) {
					account.admit(topic, null, 1, 1);
					account.charge(topic, null, 1, 1, 10);
				}
			}
			// ...alongside a trickle of keys that are never seen again.
			for (let i = 0; i < 40; i++) {
				const topic = 'gone:w' + w + '-' + i;
				account.admit(topic, null, 1, 1);
				account.charge(topic, null, 1, 1, 10);
			}
		}

		expect(evicted, 'a live population under the cap must not cost any key its ceiling').toEqual([]);
	});

	it('reclaims lapsed windows that sit in a BLOCK, not only ones spread evenly', () => {
		// Reclamation walks consecutive entries, and keys created together sit
		// together in first-publish order and go idle together. So the shape that
		// matters is a long run of live keys with the lapsed ones bunched
		// elsewhere: a sampler that gives up after one budget concludes "nothing
		// to reclaim" from where it happens to be standing, and takes a ceiling
		// off a topic that is refusing right now while thousands of reclaimable
		// windows sit further along. Spreading the idle keys one-in-ten hides
		// this completely.
		/** @type {string[]} */
		const evicted = [];
		const { account, advance } = accountWith(
			{ windowMs: 1000, topic: { messages: 4 } },
			{ onEvicted: (scope) => evicted.push(scope) }
		);
		const LONG = 3000;
		const long = Array.from({ length: LONG }, (_, i) => 'long:' + i);
		let readmitted = 0;
		for (let w = 0; w < 30; w++) {
			advance(1000);
			// One contiguous run of topics that spend their whole allowance every
			// window, seeded together and therefore adjacent in the ledger.
			for (const topic of long) {
				for (let n = 0; n < 4; n++) {
					account.admit(topic, null, 1, 1);
					account.charge(topic, null, 1, 1, 10);
				}
			}
			// A wave of rooms that are never seen again, so the lapsed windows
			// accumulate in blocks of their own.
			for (let i = 0; i < 500; i++) {
				const topic = 'room:w' + w + '-' + i;
				account.admit(topic, null, 1, 1);
				account.charge(topic, null, 1, 1, 10);
			}
			// Live keys peak at 3500 against a 4096 cap, so nothing here should
			// cost a ceiling: every window given up is one that had lapsed.
			for (const topic of long) if (account.admit(topic, null, 1, 1)) readmitted++;
		}

		expect(readmitted, 'a topic at its ceiling must not be re-admitted below the cap').toBe(0);
		expect(evicted).toEqual([]);
	});

	it('reports an eviction that cost enforcement, and stays silent for a free one', () => {
		// The whole meaning of egress_window_evicted_total is the difference
		// between these two: reclaiming a window that had already expired costs
		// nothing an operator could act on, while dropping a live one stops a
		// ceiling from holding. The flag carrying that distinction is one token
		// wide, so it gets its own case.
		/** @type {string[]} */
		const evicted = [];
		const { account, advance } = accountWith(
			{ windowMs: 1000, topic: { messages: 4 } },
			{ onEvicted: (scope) => evicted.push(scope) }
		);
		// Fill the ledger inside one window, so nothing in it can expire and no
		// amount of reclamation can make room.
		for (let i = 0; i < 4096; i++) {
			account.admit('live:' + i, null, 1, 1);
			account.charge('live:' + i, null, 1, 1, 10);
		}
		expect(evicted, 'nothing is evicted before the cap is reached').toEqual([]);

		// Past the cap the ledger takes its slack first, so that a reclamation
		// pass has room to finish before any ceiling is given up. Only once the
		// slack is spent on windows that are all still counting does a key lose
		// its window - and that is what the counter is for.
		for (let i = 0; i < 512; i++) {
			account.admit('crossing:' + i, null, 1, 1);
			account.charge('crossing:' + i, null, 1, 1, 10);
		}
		expect(evicted.length, 'live windows had to go, so they are reported').toBeGreaterThan(0);
		expect(evicted.every((scope) => scope === 'topic')).toBe(true);

		// Now let every resident window expire. The next insert reclaims one of
		// those instead, which is free and must not be reported.
		evicted.length = 0;
		advance(5000);
		for (let i = 0; i < 50; i++) {
			account.admit('later:' + i, null, 1, 1);
			account.charge('later:' + i, null, 1, 1, 10);
		}
		expect(evicted, 'reclaiming expired windows is free and reports nothing').toEqual([]);
	});

	it('still bounds itself when every key in the map is live', () => {
		// The genuine over-cardinality case: far more distinct keys inside ONE
		// window than the cap, so reclamation has nothing to find however long it
		// looks. Enforcement is given up rather than the map growing without
		// bound - the documented trade, and the reason the counter exists.
		/** @type {string[]} */
		const evicted = [];
		const { account } = accountWith(
			{ windowMs: 60000, topic: { messages: 1 } },
			{ onEvicted: (scope) => evicted.push(scope) }
		);
		for (let i = 0; i < 20000; i++) {
			const topic = 'burst:' + i;
			account.admit(topic, null, 1, 1);
			account.charge(topic, null, 1, 1, 10);
		}

		// Roughly one per key past the cap and its slack: the ledger is holding
		// its bound, not growing to 20000.
		expect(evicted.length).toBeGreaterThan(15000);
		expect(evicted.every((scope) => scope === 'topic')).toBe(true);
	});

	it('holds EXACTLY its bound, so the count of windows given up is arithmetic', () => {
		// The bound is a number the ledger's memory and its enforcement both rest
		// on, and every previous case here asserted only "some" or "many". So one
		// case reads it off directly: inside a single window nothing can be
		// reclaimed, so every key past the bound costs exactly one window, and the
		// eviction count is the population minus the bound. This is what makes a
		// change to the bound visible instead of silent, and it pins the exact
		// number the module's memory rule rests on: the BOUND is what must stay a
		// power of two, not the bound plus its sweep slack, which is measured
		// from it and is not part of the rule. An inequality would have shown
		// neither.
		/** @type {string[]} */
		const evicted = [];
		const { account } = accountWith(
			{ windowMs: 600000, topic: { messages: 1 } },
			{ onEvicted: (scope) => evicted.push(scope) }
		);
		const POP = 6000;
		for (let i = 0; i < POP; i++) {
			account.admit('live:' + i, null, 1, 1);
			account.charge('live:' + i, null, 1, 1, 10);
		}
		expect(evicted).toHaveLength(POP - 4096);
	});

	it('holds more keys when maxKeys raises the bound, by the same exact arithmetic', () => {
		// The knob's whole claim: a population that overwhelms the default cap
		// fits under a raised one. Driven at the same single-window shape as
		// the exact-bound case above so the count stays arithmetic - every key
		// past the effective bound costs exactly one window - and driven TWICE:
		// once with a power of two taken verbatim, once with a requested value
		// whose effective bound is the next power of two up, so the rounding is
		// pinned as ledger BEHAVIOR and not merely as a config field.
		const POP = 9000;
		for (const [requested, effective] of [[8192, 8192], [5000, 8192]]) {
			/** @type {string[]} */
			const evicted = [];
			const { account } = accountWith(
				{ windowMs: 600000, maxKeys: requested, topic: { messages: 1 } },
				{ onEvicted: (scope) => evicted.push(scope) }
			);
			for (let i = 0; i < POP; i++) {
				account.admit('live:' + i, null, 1, 1);
				account.charge('live:' + i, null, 1, 1, 10);
			}
			expect(evicted, `maxKeys ${requested}`).toHaveLength(POP - effective);
		}
	});

	it('threads evictionSample to the victim choice: full width finds the global least-spent key', () => {
		// At full width - a sample as wide as the ledger, which the wrap bound
		// caps at one pass regardless - the victim must be the key that spent
		// least of its allowance WHEREVER it sits, so the case seats the idle
		// key at two different positions and demands the same verdict. The
		// eviction cursor's position after the fill is deterministic and
		// identical in both runs, so a sample that ignored the option and
		// stayed at its 8-entry default could pick the idle key at one
		// position only by coincidence, and can never pick it at both.
		for (const idleAt of [512, 900]) {
			const CAP = 1024;
			/** @type {string[]} */
			const evicted = [];
			const { account } = accountWith(
				{ windowMs: 600000, maxKeys: CAP, evictionSample: CAP, topic: { messages: 4 } },
				{ onEvicted: (scope) => evicted.push(scope) }
			);
			// Every key live in one frozen window: the busy ones at their whole
			// allowance, one idle key at a quarter of it.
			for (let i = 0; i < CAP; i++) {
				account.charge('k:' + i, null, i === idleAt ? 1 : 4, 1, 10);
			}
			expect(evicted, 'the fill exactly reaches the bound without evicting').toEqual([]);

			// The insert past the bound must take the idle key's window: with
			// exactly one eviction fired, every busy key still refusing proves
			// the victim by elimination, and the idle key admitting afresh is
			// the positive half.
			account.charge('fresh', null, 1, 1, 10);
			expect(evicted, `idle key at ${idleAt}`).toHaveLength(1);
			for (let i = 0; i < CAP; i++) {
				if (i === idleAt) continue;
				expect(account.admit('k:' + i, null, 1, 1), `busy k:${i} keeps its window`).toBe(false);
			}
			expect(account.admit('k:' + idleAt, null, 1, 1), 'the idle key restarts empty').toBe(true);
		}
	});

	it('holds a population that fits to its ceilings, with the clock running', () => {
		// The clock ADVANCES on every publish here, and that is the case rather
		// than an incidental detail of it. A frozen clock gives every resident
		// window the same start, so one reclamation pass covers the whole ledger
		// and any design looks healthy; production reads a monotonic clock per
		// publish, the window starts fan out, and reclamation has to keep pace
		// continuously. Two eviction designs were accepted against a frozen-clock
		// version of this case and both were wrong on a moving one.
		//
		// The population is sized to sit between the reclamation floor and the
		// bound - 3400 always-live topics plus the rooms of the window before -
		// so every insert genuinely asks the question. A case whose ledger never
		// reaches the floor asserts nothing: reclamation and eviction are both
		// unreachable and the expectation holds for the wrong reason.
		//
		// The room count is also what makes the sweep horizon's VALUE visible.
		// The horizon is the SMALLEST expiry a completed pass left resident;
		// taking the largest instead still yields a horizon, still passes a
		// frozen-clock case, and still looks sound - but it claims the ledger is
		// clean while windows have already lapsed, so reclamation stalls and the
		// ledger fills. At this size that costs 2222 evictions and 1918 windows
		// over their ceiling, against none here. Sized with headroom rather than
		// on the cliff: reclamation keeps this population clean from 450 rooms
		// through 560, and the population genuinely outgrows the ledger at 580.
		//
		// The oracle is deliberately NOT the account's own counters. Every
		// admitted publish is recorded with its timestamp, and the ceiling is
		// checked afterwards by replaying those timestamps through the window
		// rule independently, so the assertion cannot pass by agreeing with the
		// thing it is checking.
		const WINDOW = 1000;
		const CEILING = 4;
		const ATTEMPTS = CEILING + 2;
		const CORE = 3400;
		const ROOMS = 500;
		let nowMs = 0;
		/** @type {string[]} */
		const evicted = [];
		const account = createEgressAccount({
			options: normalizeEgressOptions({ windowMs: WINDOW, topic: { messages: CEILING } }),
			clock: () => nowMs,
			onEvicted: (scope) => evicted.push(scope)
		});
		const core = Array.from({ length: CORE }, (_, i) => 'core:' + i);
		/** @type {Map<string, number[]>} */
		const admitted = new Map(core.map((topic) => [topic, []]));
		// One window of simulated time per window of work, so the population
		// turns over at the same rate a real one would.
		const tick = WINDOW / (CORE * ATTEMPTS + ROOMS);
		for (let w = 0; w < 8; w++) {
			for (const topic of core) {
				for (let n = 0; n < ATTEMPTS; n++) {
					nowMs += tick;
					if (account.admit(topic, null, 1, 1)) {
						account.charge(topic, null, 1, 1, 10);
						admitted.get(topic).push(nowMs);
					}
				}
			}
			for (let i = 0; i < ROOMS; i++) {
				nowMs += tick;
				const topic = 'room:w' + w + '-' + i;
				if (account.admit(topic, null, 1, 1)) account.charge(topic, null, 1, 1, 10);
			}
		}

		// Replay: a window opens at the first admit and again at the first admit
		// past windowMs, which is the lazy rotation the account performs. More
		// than the ceiling inside one of those is a ceiling that stopped holding.
		let over = 0;
		let worst = 0;
		for (const stamps of admitted.values()) {
			let start = null;
			let count = 0;
			for (const at of stamps) {
				if (start === null || at - start >= WINDOW) {
					if (count > CEILING) { over++; if (count > worst) worst = count; }
					start = at;
					count = 0;
				}
				count++;
			}
			if (count > CEILING) { over++; if (count > worst) worst = count; }
		}

		expect(over, `a population that fits must never exceed its ceiling (worst window held ${worst})`).toBe(0);
		expect(evicted, 'and nothing may be given up while the ledger has room').toEqual([]);
	});

	it('reports a TENANT ledger that fills under the tenant scope', () => {
		// Every other cap case here drives topic windows and asserts scope
		// 'topic', so the tenant ledger's own eviction had no case at all and the
		// scope label was documented but never produced. The two ledgers are
		// separate instances of the same factory, and only their ceilings differ.
		/** @type {string[]} */
		const evicted = [];
		const { account } = accountWith(
			{ windowMs: 600000, tenant: { messages: 1 } },
			{
				tenantOf: (topic) => 't' + topic.slice(topic.indexOf(':') + 1),
				onEvicted: (scope) => evicted.push(scope)
			}
		);
		for (let i = 0; i < 5000; i++) {
			const topic = 'topic:' + i;
			const tenant = account.resolveTenant(topic);
			account.admit(topic, tenant, 1, 1);
			account.charge(topic, tenant, 1, 1, 10);
		}

		expect(evicted).toHaveLength(5000 - 4096);
		expect(evicted.every((scope) => scope === 'tenant')).toBe(true);
	});
});

describe('the charge math: bytes times recipients, per window', () => {
	it('accumulates messages, deliveries, and bytes per scope window and refuses on each dimension', () => {
		const { account, refusals } = accountWith({
			windowMs: 1000,
			topic: { messages: 3, deliveries: 10, bytes: 1000 }
		});

		// Two publishes of 2 recipients x 100 bytes each: 2 messages, 4
		// deliveries, 400 bytes - all under every ceiling.
		expect(account.admit('feed', null, 1, 2)).toBe(true);
		account.charge('feed', null, 1, 2, 200);
		expect(account.admit('feed', null, 1, 2)).toBe(true);
		account.charge('feed', null, 1, 2, 200);

		// deliveries would-cross: 4 + 7 > 10 refuses BEFORE any usage moves.
		expect(account.admit('feed', null, 1, 7)).toBe(false);
		expect(refusals.at(-1)).toEqual({ scope: 'topic', topic: 'feed', dimension: 'deliveries', limit: 10 });

		// messages would-cross: a 2-message batch would make 4 > 3.
		expect(account.admit('feed', null, 2, 2)).toBe(false);
		expect(refusals.at(-1).dimension).toBe('messages');

		// A refusal charged nothing: the same shapes that fit still fit.
		expect(account.admit('feed', null, 1, 2)).toBe(true);
	});

	it('the bytes ceiling refuses once the window charge has REACHED it', () => {
		const { account, refusals } = accountWith({ windowMs: 1000, topic: { bytes: 500 } });
		// The crossing publish is admitted (byte weight exists only after
		// serialization) and the NEXT one is refused.
		expect(account.admit('feed', null, 1, 3)).toBe(true);
		account.charge('feed', null, 1, 3, 600);
		expect(account.admit('feed', null, 1, 3)).toBe(false);
		expect(refusals.at(-1).dimension).toBe('bytes');
	});

	it('refuses at EXACTLY the bytes ceiling, not one publish later', () => {
		// The rule is REACHED, not exceeded, and the difference is only visible
		// when the charge lands exactly on the ceiling. Overshooting - which is
		// what the case above does, and what every other bytes case here did -
		// satisfies both readings, so the boundary itself went unpinned while
		// four shipped artifacts asserted it.
		const { account, refusals } = accountWith({ windowMs: 1000, topic: { bytes: 500 } });
		expect(account.admit('feed', null, 1, 1)).toBe(true);
		account.charge('feed', null, 1, 1, 500);
		expect(
			account.admit('feed', null, 1, 1),
			'a window charged to exactly its bytes ceiling has REACHED it and must refuse'
		).toBe(false);
		expect(refusals.at(-1).dimension).toBe('bytes');

		// One byte short is still open, so the assertion above is about the
		// boundary rather than about bytes ceilings refusing in general.
		const { account: under } = accountWith({ windowMs: 1000, topic: { bytes: 500 } });
		under.charge('feed', null, 1, 1, 499);
		expect(under.admit('feed', null, 1, 1)).toBe(true);
	});

	it('admits a publish that lands EXACTLY on the deliveries ceiling', () => {
		// Deliveries refuses the publish that WOULD CROSS the ceiling, so one
		// landing exactly on it is admitted - the opposite boundary from bytes,
		// because the quantity is known before the decision. Every other
		// deliveries case overshoots (4+7 against 10, 0+2 against 1), which holds
		// under both readings and leaves the boundary free to drift by a whole
		// publish.
		const { account } = accountWith({ windowMs: 1000, topic: { deliveries: 4 } });
		expect(
			account.admit('feed', null, 1, 4),
			'four deliveries against a ceiling of four does not cross it'
		).toBe(true);
		account.charge('feed', null, 1, 4, 10);

		// Having reached it, the next delivery does cross.
		expect(account.admit('feed', null, 1, 1)).toBe(false);

		// And a single publish larger than the whole allowance is refused
		// outright, so the first assertion is a boundary and not a blanket admit.
		const { account: big } = accountWith({ windowMs: 1000, topic: { deliveries: 4 } });
		expect(big.admit('feed', null, 1, 5)).toBe(false);
	});

	it('rotates the window lazily on the injected clock', () => {
		const { account, advance } = accountWith({ windowMs: 1000, topic: { messages: 1 } });
		expect(account.admit('feed', null, 1, 1)).toBe(true);
		account.charge('feed', null, 1, 1, 10);
		expect(account.admit('feed', null, 1, 1)).toBe(false);
		advance(999);
		expect(account.admit('feed', null, 1, 1)).toBe(false);
		advance(1);
		expect(account.admit('feed', null, 1, 1)).toBe(true);
	});

	it('keeps topic scopes apart: one topic at its ceiling never refuses another', () => {
		const { account } = accountWith({ windowMs: 1000, topic: { messages: 1 } });
		account.charge('hot', null, 1, 1, 10);
		expect(account.admit('hot', null, 1, 1)).toBe(false);
		expect(account.admit('cold', null, 1, 1)).toBe(true);
	});

	it('tenant windows pool across topics while topic windows stay per topic', () => {
		const { account, refusals } = accountWith({ windowMs: 1000, tenant: { messages: 2 } });
		account.charge('a', 'acme', 1, 1, 10);
		account.charge('b', 'acme', 1, 1, 10);
		expect(account.admit('c', 'acme', 1, 1)).toBe(false);
		expect(refusals.at(-1)).toMatchObject({ scope: 'tenant', dimension: 'messages' });
		// A different tenant's window is untouched, and an unattributed
		// publish has no tenant window at all.
		expect(account.admit('c', 'globex', 1, 1)).toBe(true);
		expect(account.admit('c', null, 1, 1)).toBe(true);
	});
});

describe('tenant resolution', () => {
	it('memoizes a pure resolver and applies the shared id rule fail-closed', () => {
		let calls = 0;
		const { account, invalid } = accountWith(
			{ windowMs: 1000, tenant: { messages: 1 } },
			{ tenantOf: (topic) => { calls++; return topic === 'bad' ? 'not a valid id' : 'acme'; } }
		);
		expect(account.resolveTenant('feed')).toBe('acme');
		expect(account.resolveTenant('feed')).toBe('acme');
		expect(calls).toBe(1);
		// An invalid result charges unattributed - never a mangled key - and
		// reports the defect exactly once.
		expect(account.resolveTenant('bad')).toBeNull();
		expect(invalid).toEqual(['not a valid id']);
		expect(account.resolveTenant('bad2')).toBe('acme');
	});

	it('a throwing resolver reads as unattributed and reports once', () => {
		const { account, invalid } = accountWith(
			{ windowMs: 1000, tenant: { messages: 1 } },
			{ tenantOf: () => { throw new Error('boom'); }, memoize: false }
		);
		expect(account.resolveTenant('feed')).toBeNull();
		expect(account.resolveTenant('feed')).toBeNull();
		expect(invalid.length).toBe(1);
	});
});

describe('binaryFrameChargeBytes', () => {
	it('prices the frame header plus payload with a varint seq', () => {
		// tag + schemaVersion + 1-byte topic id + 1-byte seq + payload
		expect(binaryFrameChargeBytes(10, 0)).toBe(14);
		expect(binaryFrameChargeBytes(10, 127)).toBe(14);
		// A two-byte seq varint widens the header by one.
		expect(binaryFrameChargeBytes(10, 128)).toBe(15);
	});
});

describe('excludedRecipient', () => {
	it('discounts only a socket that actually holds the topic', () => {
		const holder = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: new Set(['feed']) }) };
		const stranger = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: new Set(['other']) }) };
		const closed = { getUserData: () => { throw new Error('Invalid access'); } };
		expect(excludedRecipient(holder, 'feed')).toBe(true);
		expect(excludedRecipient(stranger, 'feed')).toBe(false);
		expect(excludedRecipient(closed, 'feed')).toBe(false);
		expect(excludedRecipient(null, 'feed')).toBe(false);
	});
});
