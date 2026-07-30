// The subscribe decisions, pinned as truth tables.
//
// These predicates are the single definition of every authorization decision
// the three socket surfaces make (production, the published test server, the
// dev plugin). They are pure, so they can be enumerated exhaustively rather
// than sampled - and they are the decisions that repeatedly diverged when each
// surface carried its own copy.
//
// A change to any table here is a behaviour change on ALL THREE surfaces at
// once, which is the property the extraction bought.

import { describe, it, expect } from 'vitest';
import {
	deniesWireSystemTopicSubscribe,
	deniesWireSubscribePreHook,
	deniesWireSubscribeLanding,
	wantsRecover,
	recoverIsRevoked,
	exceedsSubscriptionCap
} from '../src/runtime/utils/subscribe-policy.js';
import { registerPluginOwnedPrefix, isPluginOwnedTopic } from '../src/runtime/utils/ws-symbols.js';

registerPluginOwnedPrefix('__policytest:');

const BOOLS = [false, true];

describe('deniesWireSystemTopicSubscribe', () => {
	it('blocks ordinary system topics by default and preserves the broad opt-out', () => {
		for (const topic of ['__signal:user', '__presence:room', '__rpc']) {
			expect(deniesWireSystemTopicSubscribe({ allowSystem: false, topic })).toBe(true);
			expect(deniesWireSystemTopicSubscribe({ allowSystem: true, topic })).toBe(false);
		}
		expect(deniesWireSystemTopicSubscribe({ allowSystem: false, topic: 'room' })).toBe(false);
	});

	it('lets only a registered plugin namespace reach its membership hook', () => {
		expect(isPluginOwnedTopic('__policytest:lobby')).toBe(true);
		expect(deniesWireSystemTopicSubscribe({
			allowSystem: false, topic: '__policytest:lobby'
		})).toBe(false);
		expect(deniesWireSystemTopicSubscribe({
			allowSystem: false, topic: '__policytes:lobby'
		})).toBe(true);
	});
});

describe('deniesWireSubscribePreHook', () => {
	it('refuses only an ungranted topic under an armed gate with no app hook', () => {
		for (const armed of BOOLS) {
			for (const hasUserHook of BOOLS) {
				for (const held of BOOLS) {
					const got = deniesWireSubscribePreHook({ armed, hasUserHook, held, topic: 'room' });
					const want = armed && !hasUserHook && !held;
					expect(got, `armed=${armed} hook=${hasUserHook} held=${held}`).toBe(want);
				}
			}
		}
	});

	it('stands aside for a plugin-owned topic so the plugin hook can decide', () => {
		expect(isPluginOwnedTopic('__policytest:lobby')).toBe(true);
		expect(deniesWireSubscribePreHook({
			armed: true, hasUserHook: false, held: false, topic: '__policytest:lobby'
		})).toBe(false);
		// ... and only for that namespace.
		expect(deniesWireSubscribePreHook({
			armed: true, hasUserHook: false, held: false, topic: 'policytest:lobby'
		})).toBe(true);
	});
});

describe('deniesWireSubscribeLanding', () => {
	it('refuses whenever an armed gate finds no ordinary-topic membership', () => {
		for (const armed of BOOLS) {
			for (const hasUserHook of BOOLS) {
				for (const held of BOOLS) {
					const got = deniesWireSubscribeLanding({ armed, hasUserHook, held });
					expect(got, `armed=${armed} hook=${hasUserHook} held=${held}`).toBe(armed && !hasUserHook && !held);
				}
			}
		}
	});

	it('refuses a plugin-owned topic the plugin hook did not actually subscribe', () => {
		// This is what makes the pre-hook carve-out safe. A carve-out here too
		// would leave the exemption as the entire gate, which is how a private
		// group's buffered history reached a client that merely named it.
		// The `topic` is passed DELIBERATELY. This test is named for the
		// plugin-owned case, and without a topic it exercised nothing of the
		// kind: adding the carve-out to this predicate left it green, so the one
		// property that makes the pre-hook exemption safe was unpinned.
		expect(deniesWireSubscribeLanding({
			armed: true, hasUserHook: false, held: false, topic: '__policytest:room'
		})).toBe(true);
		// The proof is required even without the global grant gate and even when
		// an app wrapper exists. Those two postures used to turn the system-topic
		// exception into a prefix-wide subscribe bypass.
		expect(deniesWireSubscribeLanding({
			armed: false, hasUserHook: false, held: false, topic: '__policytest:room'
		})).toBe(true);
		expect(deniesWireSubscribeLanding({
			armed: false, hasUserHook: true, held: false, topic: '__policytest:room'
		})).toBe(true);
		expect(deniesWireSubscribeLanding({
			armed: false, hasUserHook: true, held: true, topic: '__policytest:room'
		})).toBe(false);
		expect(isPluginOwnedTopic('__policytest:room'), 'the fixture prefix must really be registered').toBe(true);
		// And an ordinary topic reaches the same answer, so the refusal above is
		// not an accident of the topic being unknown.
		expect(deniesWireSubscribeLanding({
			armed: true, hasUserHook: false, held: false, topic: 'room'
		})).toBe(true);
	});
});

describe('wantsRecover', () => {
	it('requires a resume hook AND a well-formed non-negative integer offset', () => {
		expect(wantsRecover({ hasResumeHook: undefined, recover: { offset: 0 } })).toBe(false);
		const hasResumeHook = () => {};
		for (const [recover, want] of [
			[{ offset: 0 }, true],
			[{ offset: 5 }, true],
			[{ offset: -1 }, false],
			[{ offset: 1.5 }, false],
			[{ offset: '0' }, false],
			[{ offset: NaN }, false],
			[{}, false],
			[null, false],
			[undefined, false],
			['nope', false],
			[0, false]
		]) {
			expect(wantsRecover({ hasResumeHook, recover }), JSON.stringify(recover)).toBe(want);
		}

		// The hook axis is not just "present or undefined": an app can export a
		// falsy value, and reading the axis as `!== undefined` rather than as
		// truthiness would open the recover lane with no hook behind it.
		for (const absent of [undefined, null, false, 0, '', NaN]) {
			expect(wantsRecover({ hasResumeHook: absent, recover: { offset: 0 } }), String(absent)).toBe(false);
		}

		// A non-object carrying an `offset` must not qualify - dropping the
		// typeof test lets a function through, and a function is what an app
		// exporting the wrong thing hands over.
		const fn = () => {};
		fn.offset = 0;
		expect(wantsRecover({ hasResumeHook, recover: fn }), 'a function with an offset').toBe(false);

		// Integer-ness is `Number.isInteger`, not `Number.isSafeInteger`: the
		// two disagree past 2^53 and the distinction must be deliberate.
		expect(wantsRecover({ hasResumeHook, recover: { offset: Number.MAX_SAFE_INTEGER } })).toBe(true);
		expect(wantsRecover({ hasResumeHook, recover: { offset: 2 ** 53 } })).toBe(true);
		expect(wantsRecover({ hasResumeHook, recover: { offset: Infinity } })).toBe(false);
		expect(wantsRecover({ hasResumeHook, recover: { offset: -0 } }), 'negative zero is zero').toBe(true);
	});

	it('propagates a throwing offset getter rather than swallowing it', () => {
		// Pinned as a DECISION, not an accident. The predicate sits between
		// beginPendingSubscribe and settlePendingSubscribe, so a throw here
		// would leak the enrolment - but every wire `recover` arrives via
		// JSON.parse, which cannot carry a getter, so the only way to reach this
		// is server-side code passing its own object. Swallowing it would hide
		// that bug; if this ever becomes reachable from the wire, guard the read
		// at the CALL SITES rather than making the predicate lie.
		const hasResumeHook = () => {};
		const hostile = { get offset() { throw new Error('boom'); } };
		expect(() => wantsRecover({ hasResumeHook, recover: hostile })).toThrow('boom');
	});
});

describe('recoverIsRevoked', () => {
	it('reads the epoch only when the socket does not hold the topic', () => {
		for (const held of BOOLS) {
			for (const wireAuthz of BOOLS) {
				for (const cancelled of BOOLS) {
					const got = recoverIsRevoked({ held, wireAuthz, cancelled });
					expect(got, `held=${held} authz=${wireAuthz} cancelled=${cancelled}`)
						.toBe(!held && (wireAuthz || cancelled));
				}
			}
		}
	});

	it('serves the history after a revoke followed by a re-grant', () => {
		// The re-grant is what puts the topic back, so `held` is true even though
		// the monotonic epoch still records the revocation. Reading the epoch
		// alone refused this forever while the subscription was acked - a
		// positive ack with a silently dropped replay.
		expect(recoverIsRevoked({ held: true, wireAuthz: false, cancelled: true })).toBe(false);
		expect(recoverIsRevoked({ held: true, wireAuthz: true, cancelled: true })).toBe(false);
	});

	it('withholds the history for a revoke with no re-grant', () => {
		expect(recoverIsRevoked({ held: false, wireAuthz: false, cancelled: true })).toBe(true);
	});

	it('withholds a plugin-owned topic until its hook establishes membership', () => {
		expect(recoverIsRevoked({
			held: false,
			wireAuthz: false,
			cancelled: false,
			topic: '__policytest:room'
		})).toBe(true);
		expect(recoverIsRevoked({
			held: true,
			wireAuthz: false,
			cancelled: false,
			topic: '__policytest:room'
		})).toBe(false);
	});
});

describe('exceedsSubscriptionCap', () => {
	it('never refuses a topic the connection already holds', () => {
		// The recover fall-through reaches this check with the topic already a
		// membership; refusing there answers RATE_LIMITED to a connection that
		// is not growing.
		expect(exceedsSubscriptionCap({ held: true, size: 999, max: 10 })).toBe(false);
		expect(exceedsSubscriptionCap({ held: false, size: 10, max: 10 })).toBe(true);
		expect(exceedsSubscriptionCap({ held: false, size: 9, max: 10 })).toBe(false);
	});

	it('reads the cap from `max`, at more than one value', () => {
		// Every row above used max:10, so a body that ignored `max` and compared
		// against a hardcoded 10 passed the whole table. The cap is a parameter
		// precisely so a deployment can move it.
		for (const [size, max, want] of [
			[5, 5, true], [4, 5, false],
			[11, 100, false], [100, 100, true], [101, 100, true],
			[0, 1, false], [1, 1, true],
			[0, 0, true]
		]) {
			expect(exceedsSubscriptionCap({ held: false, size, max }), `size=${size} max=${max}`).toBe(want);
		}
	});

	it('refuses when `max` is absent rather than silently removing the cap', () => {
		// A caller that forgets `max` must not disable the limit. Every
		// comparison against `undefined` is false, so a bare `size >= max`
		// answered "not at the cap" and admitted without any bound at all. Which
		// way this mistake falls is a security property, so it is pinned: a
		// missing cap refuses, which is loud and survivable.
		for (const max of [undefined, null, NaN, '10', {}]) {
			expect(exceedsSubscriptionCap({ held: false, size: 5, max }), String(max)).toBe(true);
		}
		// Still never applies to a topic the connection already holds, even then.
		expect(exceedsSubscriptionCap({ held: true, size: 5, max: undefined })).toBe(false);
	});
});
