// Revocation releases the derived observer tap - against the REAL built runtime.
//
// WHY A SECOND SUITE. derived-subscription-revocation.test.js drives the same
// decision through src/testing.js, a hand-written mirror of the runtime.
// Neutering the release there turns that suite red; the production copy in
// src/runtime/handler/platform.js is a different line in a different file, and
// nothing would have caught its removal. A mirror is not an oracle for
// production, so the production release gets its own proof.
//
// The fixture's default handler already wires the cursor plugin, so the tap this
// exercises is the real one an app gets.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('revocation releases the derived tap (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'default',
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

	let nonceSeq = 0;

	/**
	 * Server-visible membership for a topic, including a derived one.
	 *
	 * Carries a fresh nonce per call because the client's frame matcher rescans
	 * every frame received so far - without it a repeated read would keep
	 * matching the first answer for that topic and never see the value change.
	 */
	async function tapCount(c, topic) {
		const nonce = ++nonceSeq;
		c.send({ type: 'tap-count', topic, nonce });
		const frame = await c.waitFor((f) => f?.event === 'tap-count' && f.data?.nonce === nonce);
		expect(frame, 'the tap-count probe must answer').not.toBeNull();
		return frame.parsed.data.count;
	}

	/**
	 * Poll `tapCount` until it reads `expected`, or give up. The snapshot handler
	 * awaits its authorization check, so a tap-count sent straight after the
	 * snapshot frame can be answered before the tap exists - polling is what
	 * keeps this from racing, rather than a fixed sleep.
	 * @returns {Promise<number>} the last value read
	 */
	async function settleTap(c, topic, expected, tries = 20) {
		let count = -1;
		for (let i = 0; i < tries; i++) {
			count = await tapCount(c, topic);
			if (count === expected) return count;
			await new Promise((r) => setTimeout(r, 25));
		}
		return count;
	}

	it('drops the cursor tap when the underlying topic is revoked', async () => {
		const alice = await client();

		alice.send({ type: 'cursor-snapshot', topic: 'room' });
		expect(
			await settleTap(alice, '__cursor:room', 1),
			'the snapshot must establish the tap, or this test proves nothing'
		).toBe(1);

		alice.send({ type: 'revoke-topic', topic: 'room' });
		const revoked = await alice.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'room');
		expect(revoked, 'the revocation must be processed').not.toBeNull();

		expect(
			await settleTap(alice, '__cursor:room', 0),
			'a revoked client must not keep receiving peer positions on the tap channel'
		).toBe(0);
	});

	it('drops the cursor tap when the client revokes itself over the wire', async () => {
		const selfRevoking = await client();
		const topic = 'self-revoked-room';
		const derived = `__cursor:${topic}`;

		selfRevoking.send({ type: 'cursor-snapshot', topic });
		expect(
			await settleTap(selfRevoking, derived, 1),
			'the snapshot must establish the observer tap before the client leaves'
		).toBe(1);

		// This is the client-wire revocation path in runtime/handler.js, not
		// platform.unsubscribe exercised above. The testing and Vite mirrors
		// already release derived authority here; production must do the same.
		selfRevoking.send({ type: 'unsubscribe', topic });

		expect(
			await settleTap(selfRevoking, derived, 0),
			'a client that left the base topic must not keep its cursor observer tap'
		).toBe(0);
	});

	it('leaves an unrelated topic\'s tap in place', async () => {
		// Per topic, not per connection: tearing down a different room's tap would
		// be a self-inflicted outage rather than a fix.
		const bob = await client();

		bob.send({ type: 'cursor-snapshot', topic: 'room-a' });
		bob.send({ type: 'cursor-snapshot', topic: 'room-b' });
		expect(await settleTap(bob, '__cursor:room-a', 1)).toBe(1);
		expect(await settleTap(bob, '__cursor:room-b', 1)).toBe(1);

		bob.send({ type: 'revoke-topic', topic: 'room-a' });
		expect(await bob.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'room-a')).not.toBeNull();

		expect(await settleTap(bob, '__cursor:room-a', 0), 'the revoked topic loses its tap').toBe(0);
		expect(await settleTap(bob, '__cursor:room-b', 1), 'an unrelated topic keeps its tap').toBe(1);
	});
});
