// In-flight subscribe authorization is bounded per connection.
//
// The landed-subscription cap counts memberships, and a denied, parked, or
// slow attempt never lands - so before this bound, one connection against an
// async authorization hook could hold arbitrarily many hook invocations
// (typically DB or session-store queries) in flight at once just by sending
// subscribe frames faster than the hook resolves. The budget refuses the
// attempt past the cap BEFORE it reaches the hook, and every settled attempt
// frees its slot.
//
// Three layers: the predicate (pure, from source), the begin/settle counter
// (from source - every mutation lives in one module), and the real built
// runtime over a real socket, where the parked-probe frames prove exactly
// which attempts reached the hook and which were refused before it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exceedsPendingSubscribeCap } from '../src/runtime/utils/subscribe-policy.js';
import {
	WS_PENDING_SUBSCRIBES,
	WS_SUBSCRIPTIONS,
	authorizeDerivedSubscribe,
	beginPendingSubscribe,
	pendingSubscribeTotal,
	settlePendingSubscribe,
	settleHeldSubscribe,
	settleDeniedSubscribe,
	tombstonePendingSubscribe
} from '../src/runtime/utils/ws-symbols.js';
import { MAX_PENDING_SUBSCRIBES_PER_CONNECTION } from '../src/runtime/utils/caps.js';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeMaybe = hasUWS ? describe : describe.skip;

describe('exceedsPendingSubscribeCap', () => {
	it('admits under the cap and refuses at it', () => {
		expect(exceedsPendingSubscribeCap({ pending: 0, max: 4 })).toBe(false);
		expect(exceedsPendingSubscribeCap({ pending: 3, max: 4 })).toBe(false);
		expect(exceedsPendingSubscribeCap({ pending: 4, max: 4 })).toBe(true);
		expect(exceedsPendingSubscribeCap({ pending: 5, max: 4 })).toBe(true);
	});

	it('fails closed on a missing cap', () => {
		expect(exceedsPendingSubscribeCap({ pending: 0, max: undefined })).toBe(true);
		expect(exceedsPendingSubscribeCap({ pending: 0, max: NaN })).toBe(true);
	});
});

describe('the in-flight total mirrors the pending map', () => {
	it('counts every begin and returns on every settle exit', () => {
		const ud = {};
		const t1 = beginPendingSubscribe(ud, 'a');
		const t2 = beginPendingSubscribe(ud, 'a');
		const t3 = beginPendingSubscribe(ud, 'b', true);
		expect(pendingSubscribeTotal(ud)).toBe(3);

		settlePendingSubscribe(ud, 'a', t1, true);
		expect(pendingSubscribeTotal(ud)).toBe(2);

		expect(settleHeldSubscribe(ud, 'a', t2)).toBe('ack');
		expect(pendingSubscribeTotal(ud)).toBe(1);

		// Held seeding marked 'b' granted, so the denial leaves membership alone.
		expect(settleDeniedSubscribe(ud, 'b', t3, true)).toBe('deny');
		expect(pendingSubscribeTotal(ud)).toBe(0);
		expect(ud[WS_PENDING_SUBSCRIBES].size).toBe(0);
	});

	it('a tombstoned attempt still returns its budget on every settle shape', () => {
		const ud = {};
		const t1 = beginPendingSubscribe(ud, 'x');
		tombstonePendingSubscribe(ud, 'x');
		expect(settlePendingSubscribe(ud, 'x', t1)).toBe(false);
		expect(pendingSubscribeTotal(ud)).toBe(0);

		const t2 = beginPendingSubscribe(ud, 'y');
		tombstonePendingSubscribe(ud, 'y');
		expect(settleHeldSubscribe(ud, 'y', t2)).toBe('deny-unwind');
		expect(pendingSubscribeTotal(ud)).toBe(0);

		const t3 = beginPendingSubscribe(ud, 'z');
		tombstonePendingSubscribe(ud, 'z');
		expect(settleDeniedSubscribe(ud, 'z', t3, false)).toBe('deny');
		expect(pendingSubscribeTotal(ud)).toBe(0);
	});
});

describe('the derived observer lane is bounded too', () => {
	it('refuses its tap at the cap without running the authorization', async () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = { getUserData: () => ud };
		// Fill the budget the way the surface lanes do.
		const tokens = [];
		for (let i = 0; i < MAX_PENDING_SUBSCRIBES_PER_CONNECTION; i++) {
			tokens.push(beginPendingSubscribe(ud, `fill-${i}`));
		}
		expect(pendingSubscribeTotal(ud)).toBe(MAX_PENDING_SUBSCRIBES_PER_CONNECTION);

		let authorizeRan = false;
		const admitted = await authorizeDerivedSubscribe(ws, 'derived', async () => {
			authorizeRan = true;
			return false;
		});
		// This lane is client-triggered (a presence sync or cursor snapshot
		// frame reaches it), so an unbounded one would leave the whole budget
		// bypassable - and because it shares the counter, it would also starve
		// the connection's own wire subscribes.
		expect(admitted).toBe(false);
		expect(authorizeRan).toBe(false);
		expect(pendingSubscribeTotal(ud)).toBe(MAX_PENDING_SUBSCRIBES_PER_CONNECTION);

		// Freeing one slot admits it again, and the authorization runs.
		settlePendingSubscribe(ud, 'fill-0', tokens[0]);
		const after = await authorizeDerivedSubscribe(ws, 'derived', async () => {
			authorizeRan = true;
			return false;
		});
		expect(authorizeRan).toBe(true);
		expect(after).toBe(true);
		expect(pendingSubscribeTotal(ud)).toBe(MAX_PENDING_SUBSCRIBES_PER_CONNECTION - 1);
	});
});

/**
 * Wait until at least `count` frames match, or time out and return what there
 * is - callers assert on the returned count, so a shortfall fails loudly.
 * @param {{ frames: string[] }} client
 * @param {(parsed: any) => boolean} predicate
 * @param {number} count
 * @param {number} [ms]
 */
async function waitForCount(client, predicate, count, ms = 30_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		let n = 0;
		for (const raw of client.frames) {
			let parsed = null;
			try { parsed = JSON.parse(raw); } catch { continue; }
			if (predicate(parsed)) n++;
		}
		if (n >= count || Date.now() >= deadline) return n;
		await new Promise((r) => setTimeout(r, 25));
	}
}

describeMaybe('pending-attempt budget (real runtime)', () => {
	const CAP = MAX_PENDING_SUBSCRIBES_PER_CONNECTION;
	const BATCH = 256;
	const FRAMES = CAP / BATCH;

	/** @type {Awaited<ReturnType<typeof startRealRuntime>>} */
	let server;

	beforeAll(async () => {
		// The budget must be whole batch frames, or the fill below cannot reach
		// it exactly and every boundary assertion drifts.
		expect(CAP % BATCH).toBe(0);
		server = await startRealRuntime({ variant: 'parkmany' });
	}, 240000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('refuses the attempt past the budget before it reaches the hook, and frees on settle', async () => {
		const client = await connectRealClient(server.wsUrl);
		try {
			// FILL: sixteen full batch frames, each parking one hook invocation
			// that holds 256 attempts in flight.
			for (let f = 0; f < FRAMES; f++) {
				client.send({
					type: 'subscribe-batch',
					ref: `fill-${f}`,
					topics: Array.from({ length: BATCH }, (_, i) => `cap-${f}-${i}`)
				});
			}
			const parked = await waitForCount(client, (p) => p?.event === 'parked', FRAMES);
			expect(parked).toBe(FRAMES);

			// PAST THE BUDGET, batch lane: every topic is answered RATE_LIMITED
			// and the hook never sees the frame - no seventeenth park.
			client.send({
				type: 'subscribe-batch',
				ref: 'over',
				topics: Array.from({ length: BATCH }, (_, i) => `over-${i}`)
			});
			const overDenied = await waitForCount(
				client,
				(p) => p?.type === 'subscribe-denied' && p.ref === 'over' && p.reason === 'RATE_LIMITED',
				BATCH
			);
			expect(overDenied).toBe(BATCH);
			expect(await waitForCount(client, (p) => p?.event === 'parked', FRAMES + 1, 300)).toBe(FRAMES);

			// PAST THE BUDGET, single lane: same refusal, same reason.
			client.send({ type: 'subscribe', ref: 'single-over', topic: 'single-over' });
			const singleDenied = await client.waitFor(
				(p) => p?.type === 'subscribe-denied' && p.ref === 'single-over' && p.reason === 'RATE_LIMITED',
				5000
			);
			expect(singleDenied).not.toBeNull();

			// RELEASE: every parked batch lands in full - the budget bounded
			// concurrency, it never denied an admitted attempt.
			client.send({ type: 'release', nonce: 'r1' });
			const acked = await waitForCount(
				client,
				(p) => p?.type === 'subscribed' && typeof p.ref === 'string' && p.ref.startsWith('fill-'),
				CAP,
				60_000
			);
			expect(acked).toBe(CAP);

			// FREED: a fresh attempt is admitted to the hook again (it parks -
			// the seventeenth park, arriving only now) and lands once released.
			client.send({ type: 'subscribe', ref: 'after', topic: 'cap-after' });
			expect(await waitForCount(client, (p) => p?.event === 'parked', FRAMES + 1, 5000)).toBe(FRAMES + 1);
			client.send({ type: 'release', nonce: 'r2' });
			const afterAck = await client.waitFor(
				(p) => p?.type === 'subscribed' && p.ref === 'after',
				5000
			);
			expect(afterAck).not.toBeNull();
		} finally {
			client.close();
		}
	}, 120_000);

	// The interesting arithmetic is a PARTIAL frame: headroom strictly inside
	// the frame, where the truncation has to keep `valid` aligned with the
	// authorization decisions, the enrolment tokens and the landing loop. A
	// whole-frame refusal never executes it.
	it('admits exactly the headroom of a straddling frame and refuses the rest', async () => {
		const client = await connectRealClient(server.wsUrl);
		try {
			// Fill all but one slot: fifteen full frames plus one single.
			for (let f = 0; f < FRAMES - 1; f++) {
				client.send({
					type: 'subscribe-batch',
					ref: `pre-${f}`,
					topics: Array.from({ length: BATCH }, (_, i) => `part-${f}-${i}`)
				});
			}
			client.send({ type: 'subscribe', ref: 'odd', topic: 'part-odd' });
			expect(await waitForCount(client, (p) => p?.event === 'parked', FRAMES)).toBe(FRAMES);

			// Headroom is now BATCH - 1, so a full frame straddles the budget.
			client.send({
				type: 'subscribe-batch',
				ref: 'straddle',
				topics: Array.from({ length: BATCH }, (_, i) => `straddle-${i}`)
			});

			// Exactly one topic is over: the LAST one, since truncation drops the
			// tail. The rest reach the hook as one more parked batch.
			const straddleDenied = await waitForCount(
				client,
				(p) => p?.type === 'subscribe-denied' && p.ref === 'straddle' && p.reason === 'RATE_LIMITED',
				1
			);
			expect(straddleDenied).toBe(1);
			expect(await waitForCount(client, (p) => p?.event === 'parked', FRAMES + 1)).toBe(FRAMES + 1);
			const denial = await client.waitFor(
				(p) => p?.type === 'subscribe-denied' && p.ref === 'straddle',
				2000
			);
			expect(denial?.parsed.topic).toBe(`straddle-${BATCH - 1}`);
			// And no further denial arrives for the admitted head.
			expect(await waitForCount(
				client,
				(p) => p?.type === 'subscribe-denied' && p.ref === 'straddle',
				2,
				500
			)).toBe(1);

			// The admitted head lands whole: BATCH - 1 acks, aligned with what
			// the truncation kept.
			client.send({ type: 'release', nonce: 'p1' });
			const straddleAcks = await waitForCount(
				client,
				(p) => p?.type === 'subscribed' && p.ref === 'straddle',
				BATCH - 1,
				60_000
			);
			expect(straddleAcks).toBe(BATCH - 1);
		} finally {
			client.close();
		}
	}, 120_000);
});
