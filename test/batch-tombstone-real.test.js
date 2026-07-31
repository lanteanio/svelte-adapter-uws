// Revocation during a BATCH subscribe authorization, driven against the REAL
// built runtime.
//
// WHY THIS EXISTS. revocation-during-authorization.test.js covers the same
// decision, but it boots src/testing.js - a hand-written mirror of the runtime.
// Neutering the tombstone landing in src/testing.js turns that suite red;
// neutering the SAME landing in src/runtime/handler.js left the entire suite
// green, because no suite sent a subscribe-batch frame through the built
// runtime. A mirror is not an oracle for production, so the production landing
// needs its own behavioural proof.
//
// WHAT IS BEING PROVEN. A client sends a subscribe-batch; the app's
// authorization hook parks; a server-side platform.unsubscribe lands for one of
// those topics while it is parked; the hook then resolves. The runtime must
// discard the grant and answer the client truthfully with FORBIDDEN, rather
// than acking a subscription the server had already been told to revoke.
//
// The membership count is asserted as well as the frame. A denial frame alone
// would still be satisfied by a runtime that told the client "denied" and
// subscribed it anyway, which is the more dangerous half of the bug.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('revocation during a batch subscribe (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'park',
			env: { ORIGIN: undefined, TRUSTED_PROXIES: undefined, CLUSTER_WORKERS: undefined }
		});
	}, 400000);

	afterAll(async () => {
		for (const c of clients) c.close();
		await server?.stop();
	});

	async function client() {
		const c = await connectRealClient(server.wsUrl);
		clients.push(c);
		return c;
	}

	/** Server-side membership count for `topic`, as the server sees it. */
	async function countOf(c, topic) {
		c.send({ type: 'count', topic });
		const frame = await c.waitFor((f) => f?.event === 'count' && f.data?.topic === topic);
		expect(frame, 'the count probe must answer').not.toBeNull();
		return frame.parsed.data.count;
	}

	it('discards the grant and denies when a revocation lands mid-authorization', async () => {
		const alice = await client();
		alice.send({ type: 'subscribe-batch', topics: ['room-a'], ref: 1 });

		const parked = await alice.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the authorization hook must actually park').not.toBeNull();

		// The revocation lands INSIDE the begin/settle window.
		alice.send({ type: 'revoke', topic: 'room-a' });
		const revoked = await alice.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'room-a');
		expect(revoked, 'the revocation must be processed while the hook is parked').not.toBeNull();
		// platform.unsubscribe answers `true` for BOTH a tombstoned in-flight
		// subscribe and a removed established membership, so this does not on its
		// own identify which happened. It is pinned because the park makes the
		// established path unreachable - nothing is subscribed yet - so `false`
		// here would mean the revocation found nothing to cancel and the window
		// the rest of this test depends on was never open.
		expect(revoked.parsed.data.removed, 'the revocation must have found the in-flight subscribe to cancel').toBe(true);

		alice.send({ type: 'release' });

		// Assert the frame EXISTS before asserting its type: `.not.toBe('subscribed')`
		// on an absent frame passes while a client's awaited batch subscribe hangs
		// forever.
		const answer = await alice.waitFor(
			(f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.topic === 'room-a'
		);
		expect(answer, 'the client must be answered, not left waiting').not.toBeNull();
		expect(answer.parsed).toMatchObject({
			type: 'subscribe-denied',
			topic: 'room-a',
			ref: 1,
			reason: 'FORBIDDEN'
		});

		// And the answer must be true of the world.
		expect(await countOf(alice, 'room-a'), 'the revocation was reported honored; no membership may survive it').toBe(0);
	});

	it('discards a single-frame grant when revocation lands mid-authorization', async () => {
		// The original production defect was on this path. The in-process
		// mirror has exercised it for a long time, but a mirror cannot detect this
		// separate landing losing its settle/tombstone check.
		const single = await client();
		single.send({ type: 'subscribe', topic: 'room-single', ref: 11 });

		const parked = await single.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the single subscribe must really be parked').not.toBeNull();

		single.send({ type: 'revoke', topic: 'room-single' });
		const revoked = await single.waitFor(
			(f) => f?.event === 'revoked' && f.data?.topic === 'room-single'
		);
		expect(revoked?.parsed.data.removed, 'the pending single subscribe must be found').toBe(true);

		single.send({ type: 'release' });
		const answer = await single.waitFor(
			(f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.topic === 'room-single'
		);
		expect(answer?.parsed).toMatchObject({
			type: 'subscribe-denied',
			topic: 'room-single',
			ref: 11,
			reason: 'FORBIDDEN'
		});
		expect(await countOf(single, 'room-single'), 'the single grant must not survive its revocation').toBe(0);
	});

	it('still admits a batch topic that was never revoked', async () => {
		// The control. Without it the case above is satisfied by a runtime that
		// denies every batch subscribe, or by a release that never arrives - both
		// of which would make the tombstone assertion vacuous.
		const bob = await client();
		bob.send({ type: 'subscribe-batch', topics: ['room-b'], ref: 2 });

		const parked = await bob.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the authorization hook must actually park').not.toBeNull();

		bob.send({ type: 'release' });

		const ack = await bob.waitFor((f) => f?.type === 'subscribed' && f.topic === 'room-b');
		expect(ack, 'an unrevoked batch topic must be acked').not.toBeNull();
		expect(ack.parsed).toMatchObject({ type: 'subscribed', topic: 'room-b', ref: 2 });
		expect(await countOf(bob, 'room-b'), 'an acked topic must really be subscribed').toBe(1);
	});

	it('revokes only the named topic out of a multi-topic batch', async () => {
		// The landing is per topic inside one loop, so a tombstone that leaked
		// across iterations - or one keyed on the connection rather than the
		// topic - would take the whole batch down with it.
		const carol = await client();
		carol.send({ type: 'subscribe-batch', topics: ['room-c', 'room-d'], ref: 3 });

		const parked = await carol.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the authorization hook must actually park').not.toBeNull();

		carol.send({ type: 'revoke', topic: 'room-c' });
		expect(await carol.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'room-c')).not.toBeNull();

		carol.send({ type: 'release' });

		const denied = await carol.waitFor((f) => f?.type === 'subscribe-denied' && f.topic === 'room-c');
		expect(denied, 'the revoked topic must be denied').not.toBeNull();
		expect(denied.parsed.reason).toBe('FORBIDDEN');

		const ack = await carol.waitFor((f) => f?.type === 'subscribed' && f.topic === 'room-d');
		expect(ack, 'the sibling topic in the same batch must still be acked').not.toBeNull();
		// `ref` is pinned here as it is in the cases above: waitFor rescans every
		// frame received so far, so an ack matched on type + topic alone would
		// accept one arriving from any other path.
		expect(ack.parsed).toMatchObject({ type: 'subscribed', topic: 'room-d', ref: 3 });

		expect(await countOf(carol, 'room-c'), 'the revoked topic must not be subscribed').toBe(0);
		expect(await countOf(carol, 'room-d'), 'the sibling topic must be subscribed').toBe(1);
	});
});
