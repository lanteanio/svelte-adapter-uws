// Wire-subscribe authorization, driven against the REAL built runtime.
//
// Why a second suite for this: the existing wire-subscribe-authz suite boots
// src/testing.js, a separate hand-written mirror of the runtime, so deleting
// the production gate in src/runtime/handler.js leaves that suite fully green.
// This one boots the built handler with the flag baked in by the adapter at
// build time, so it is the only place the whole path - user config, option
// serialization, build-time placeholder, runtime arming, and the actual denial
// branch - is exercised end to end, and the only one that fails if any hop of
// it breaks.
//
// The fixture variant deliberately uses a handler with no `subscribe` export:
// an app-supplied subscribe hook takes the decision back from the grant model,
// so a variant built on the default fixture handler (which does export one)
// would leave the gate inert and let this suite pass against a server that
// never denies anything.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('wire-subscribe authorization (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'grant',
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

	it('denies a wire subscribe to a topic the server never granted', async () => {
		const bob = await client();
		bob.send({ type: 'subscribe', topic: 'room-42', ref: 1 });

		const denied = await bob.waitFor((f) => f?.type === 'subscribe-denied' && f.topic === 'room-42');
		expect(denied, 'an ungranted wire subscribe must be denied').not.toBeNull();
		expect(denied.parsed).toMatchObject({
			type: 'subscribe-denied',
			topic: 'room-42',
			ref: 1,
			reason: 'FORBIDDEN'
		});
		// ... and no ack for the same topic arrived alongside the denial.
		expect(await bob.waitFor((f) => f?.type === 'subscribed' && f.topic === 'room-42', 100)).toBeNull();
	});

	it('admits a wire subscribe to a topic the server granted on that connection', async () => {
		const alice = await client();
		alice.send({ type: 'grant', topic: 'room-42' });
		const granted = await alice.waitFor((f) => f?.event === 'granted');
		expect(granted, 'server-side platform.subscribe should have reported back').not.toBeNull();

		alice.send({ type: 'subscribe', topic: 'room-42', ref: 7 });
		const ack = await alice.waitFor((f) => f?.type === 'subscribed' && f.topic === 'room-42');
		expect(ack, 'a granted topic must still be subscribable on the wire').not.toBeNull();
		expect(ack.parsed).toMatchObject({ type: 'subscribed', topic: 'room-42', ref: 7 });
	});

	it('applies the built option to every topic in subscribe-batch', async () => {
		const dave = await client();
		dave.send({ type: 'grant', topic: 'allowed:batch' });
		expect(await dave.waitFor((f) => f?.event === 'granted' && f?.data?.topic === 'allowed:batch')).not.toBeNull();

		const allowed = dave.waitFor(
			(f) => f?.type === 'subscribed' && f.topic === 'allowed:batch' && f.ref === 11
		);
		const denied = dave.waitFor(
			(f) => f?.type === 'subscribe-denied' && f.topic === 'denied:batch' && f.ref === 11
		);
		dave.send({
			type: 'subscribe-batch',
			topics: ['allowed:batch', 'denied:batch'],
			ref: 11
		});

		const [allowedFrame, deniedFrame] = await Promise.all([allowed, denied]);
		expect(allowedFrame?.parsed).toMatchObject({
			type: 'subscribed',
			topic: 'allowed:batch',
			ref: 11
		});
		expect(deniedFrame?.parsed).toMatchObject({
			type: 'subscribe-denied',
			topic: 'denied:batch',
			ref: 11,
			reason: 'FORBIDDEN'
		});
	});

	it('scopes the grant to one connection - another connection is still denied', async () => {
		// Guards against a gate that arms globally rather than per connection:
		// alice was granted room-42 by the test above, and that must not admit
		// carol.
		const carol = await client();
		carol.send({ type: 'subscribe', topic: 'room-42', ref: 3 });

		const denied = await carol.waitFor((f) => f?.type === 'subscribe-denied' && f.topic === 'room-42');
		expect(denied, "another connection's grant must not admit this one").not.toBeNull();
		expect(denied.parsed.reason).toBe('FORBIDDEN');
	});
});
