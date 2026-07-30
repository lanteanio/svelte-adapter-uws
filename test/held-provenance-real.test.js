// Revocation when the REVOKED ATTEMPT'S OWN HOOK installs the membership,
// driven against the REAL built runtime.
//
// WHY THIS EXISTS. batch-tombstone-real.test.js proves the tombstone landing
// when nothing installs membership inside the authorization window. The
// harder shape - the one the group plugin produces on every join - is the
// parking hook releasing INTO the join, so the landing finds the topic
// already held by the attempt the tombstone cancelled. A held-at-landing
// branch that acks on membership alone defeats the revocation: the banned
// client keeps the room it was kicked from, and platform.unsubscribe's
// `true` ("revocation honored") becomes a lie one tick later.
//
// WHAT IS BEING PROVEN. The client subscribes the group channel; the hook
// parks; platform.unsubscribe lands (tombstone + returns true); the hook
// releases and the group join installs tracked membership. The runtime must
// answer FORBIDDEN and unwind the membership - both as the runtime sees it
// (subscriber count) and as the plugin sees it (group roster count), the
// latter proving the unwind ran the app's unsubscribe hook.
//
// The deferral case is the one a single-attempt test cannot reach. When a
// SECOND attempt for the same topic is still parked, the revoked landing
// leaves the membership for it to judge - and if that second attempt leaves
// through its own hook's DENIAL, it is the last settler and owes the unwind.
// Missing that reading left the socket subscribed with BOTH frames denied.
//
// The control case pins the fresh-grant path the provenance read must NOT
// break: an unrevoked join lands, acks, and stays a member.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('revocation of a subscribe whose own hook installs the membership (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'parkjoin',
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

	// Every probe carries a nonce the fixture echoes, and the wait matches on
	// it. waitFor scans the connection's WHOLE frame history, so two probes of
	// the same shape on one client alias: the second read returns the FIRST
	// answer again, and a baseline-relative assertion compares the baseline
	// with itself - green under any server behavior. That is not hypothetical:
	// the deferral case below asserted exactly that way and stayed green under
	// a mutation that disabled the unwind it exists to prove.
	let probeNonce = 0;

	/** Server-side runtime membership count for `topic`. */
	async function countOf(c, topic) {
		const nonce = ++probeNonce;
		c.send({ type: 'count', topic, nonce });
		const frame = await c.waitFor((f) => f?.event === 'count' && f.data?.nonce === nonce);
		expect(frame, 'the count probe must answer').not.toBeNull();
		expect(frame.parsed.data.topic, 'the count answer must be about the probed topic').toBe(topic);
		return frame.parsed.data.count;
	}

	/** Plugin-side roster count: the unwind must have run the leave hook. */
	async function groupCountOf(c) {
		const nonce = ++probeNonce;
		c.send({ type: 'group-count', nonce });
		const frame = await c.waitFor((f) => f?.event === 'group-count' && f.data?.nonce === nonce);
		expect(frame, 'the group-count probe must answer').not.toBeNull();
		return frame.parsed.data.count;
	}

	it('denies and unwinds the membership the revoked attempt installed', async () => {
		const alice = await client();
		alice.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });

		const parked = await alice.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the authorization hook must actually park').not.toBeNull();

		// The revocation lands INSIDE the begin/settle window, before any
		// membership exists - so `true` can only mean the in-flight subscribe
		// was found and tombstoned.
		alice.send({ type: 'revoke', topic: '__group:lobby' });
		const revoked = await alice.waitFor((f) => f?.event === 'revoked' && f.data?.topic === '__group:lobby');
		expect(revoked, 'the revocation must be processed while the hook is parked').not.toBeNull();
		expect(revoked.parsed.data.removed, 'the revocation must have found the in-flight subscribe to cancel').toBe(true);

		// The hook releases INTO the group join: tracked membership for the very
		// topic in flight is installed by the revoked attempt itself.
		alice.send({ type: 'release' });

		// Assert the frame EXISTS before asserting its type: `.not.toBe('subscribed')`
		// on an absent frame passes while a client's awaited subscribe hangs forever.
		const answer = await alice.waitFor(
			(f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.topic === '__group:lobby'
		);
		expect(answer, 'the client must be answered, not left waiting').not.toBeNull();
		expect(answer.parsed).toMatchObject({
			type: 'subscribe-denied',
			topic: '__group:lobby',
			ref: 1,
			reason: 'FORBIDDEN'
		});

		// And the answer must be true of the world, on BOTH registries: the
		// runtime's subscriber set and the plugin's roster. The second proves
		// the unwind ran the app's unsubscribe hook rather than only dropping
		// the native subscription.
		expect(await countOf(alice, '__group:lobby'), 'no runtime membership may survive the revocation').toBe(0);
		expect(await groupCountOf(alice), 'no roster membership may survive the revocation').toBe(0);
	});

	it('still acks and keeps an unrevoked join', async () => {
		// The control. Without it the case above is satisfied by a runtime that
		// denies every group subscribe - and by a provenance read that treats
		// every hook-installed membership as revoked.
		const bob = await client();
		bob.send({ type: 'subscribe', topic: '__group:lobby', ref: 2 });

		const parked = await bob.waitFor((f) => f?.event === 'parked');
		expect(parked, 'the authorization hook must actually park').not.toBeNull();

		bob.send({ type: 'release' });

		const ack = await bob.waitFor((f) => f?.type === 'subscribed' && f.topic === '__group:lobby');
		expect(ack, 'an unrevoked join must be acked').not.toBeNull();
		expect(ack.parsed).toMatchObject({ type: 'subscribed', topic: '__group:lobby', ref: 2 });
		expect(await countOf(bob, '__group:lobby'), 'an acked topic must really be subscribed').toBe(1);
		expect(await groupCountOf(bob), 'an acked join must really be on the roster').toBe(1);
	});

	it('unwinds when the second parked attempt denies, so the deferral is not a leak', async () => {
		// Two attempts for one topic are parked at once. The FIRST is revoked
		// mid-park and installs membership from its own hook on release, so its
		// landing defers (the second is still in flight). The SECOND then denies,
		// as an app hook does once the ban is visible to it - making its denial
		// exit the last settler and the only place left that can unwind.
		const carol = await client();

		// Baseline: what the server already holds from the cases above.
		const baseCount = await countOf(carol, '__group:lobby');
		const baseRoster = await groupCountOf(carol);

		carol.send({ type: 'subscribe', topic: '__group:lobby', ref: 3 });
		expect(await carol.waitFor((f) => f?.event === 'parked' && f.data?.depth === 1), 'the first attempt must park').not.toBeNull();

		carol.send({ type: 'revoke', topic: '__group:lobby' });
		const revoked = await carol.waitFor((f) => f?.event === 'revoked' && f.data?.topic === '__group:lobby');
		expect(revoked, 'the revocation must land while the first attempt is parked').not.toBeNull();
		expect(revoked.parsed.data.removed, 'the revocation must have found the in-flight subscribe').toBe(true);

		// A second attempt enrols while the first is still parked. It must not be
		// mistaken for authority over the membership the first one installs.
		carol.send({ type: 'subscribe', topic: '__group:lobby', ref: 4 });
		expect(await carol.waitFor((f) => f?.event === 'parked' && f.data?.depth === 2), 'the second attempt must park too').not.toBeNull();

		// First (revoked) attempt releases INTO the join: membership installed.
		carol.send({ type: 'release' });
		const first = await carol.waitFor((f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.ref === 3);
		expect(first, 'the revoked frame must be answered').not.toBeNull();
		expect(first.parsed).toMatchObject({ type: 'subscribe-denied', topic: '__group:lobby', ref: 3, reason: 'FORBIDDEN' });

		// Second attempt's hook refuses. Nothing is left in flight afterwards.
		carol.send({ type: 'release', verdict: 'deny' });
		const second = await carol.waitFor((f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.ref === 4);
		expect(second, 'the denying frame must be answered').not.toBeNull();
		expect(second.parsed).toMatchObject({ type: 'subscribe-denied', topic: '__group:lobby', ref: 4, reason: 'FORBIDDEN' });

		// Both frames were denied, so this connection must hold nothing. The
		// probes report SERVER-WIDE counts and the control case above leaves its
		// own member subscribed, so the assertion is that carol added nothing:
		// a leak shows up as baseline + 1 on both registries.
		expect(await countOf(carol, '__group:lobby'), 'no runtime membership may survive two denials').toBe(baseCount);
		expect(await groupCountOf(carol), 'no roster membership may survive two denials').toBe(baseRoster);
	});
});
