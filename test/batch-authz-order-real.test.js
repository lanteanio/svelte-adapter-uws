// The subscribe-batch path must deny before the hook runs, exactly as the
// single-subscribe path does.
//
// Both paths compute the server-grant decision up front, but the batch path
// used to call the app's subscribe hook over EVERY valid topic and consult that
// decision only at the landing. Hooks are not pure: the documented presence
// wiring joins a roster and opens a `__presence:` observer tap. So for a topic
// the gate had already denied, those side effects landed anyway - the caller
// was added to a private topic's roster, broadcast to its real members, handed
// the roster, and left holding a live tap - and only then told FORBIDDEN.
//
// The same frame sent as a single `subscribe` leaked nothing. That asymmetry
// between the two spellings of one request was the defect.
//
// Driven against the real built runtime over real sockets, and asserted with a
// POSITIVE reading of the roster: a test that only checked that no roster frame
// arrived would pass just as well against a server that never sends one.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { startRealRuntime, connectRealClient, hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('subscribe-batch authorization ordering (real runtime)', () => {
	/** @type {{ stop: () => Promise<void> } | null} */
	let server = null;
	/** @type {{ close: () => void }[]} */
	let clients = [];

	// Pay for the variant build once, under a hook timeout that fits it. Each
	// test then starts its own server so the roster assertions read a clean
	// membership rather than whatever a previous test left behind.
	beforeAll(() => {
		expect(buildFixtureOnce('batchleak'), 'batchleak fixture failed to build').toBe(true);
	}, 400000);

	afterEach(async () => {
		for (const c of clients) c.close();
		clients = [];
		if (server) await server.stop();
		server = null;
	});

	/** Connect, tracked for teardown. */
	async function client(wsUrl, token) {
		const c = await connectRealClient(wsUrl, { headers: { cookie: `token=${token}` } });
		clients.push(c);
		return c;
	}

	/** Current roster + observer-tap count, as the SERVER sees them. */
	async function readRoster(c, topic, nonce) {
		c.send({ type: 'roster', topic, nonce });
		const frame = await c.waitFor(
			(p) => p?.event === 'roster' && p?.data?.nonce === nonce,
			2000
		);
		expect(frame, `roster probe ${nonce} did not answer`).not.toBeNull();
		return frame.parsed.data;
	}

	it('does not run the subscribe hook for a topic the grant gate denied', async () => {
		server = await startRealRuntime({ variant: 'batchleak' });

		// Alice is granted the room through the trusted server-side path.
		const alice = await client(server.wsUrl, 'alice');
		alice.send({ type: 'grant', topic: 'private-room' });
		expect(await alice.waitFor((p) => p?.event === 'granted', 2000)).not.toBeNull();

		const before = await readRoster(alice, 'private-room', 'before');
		expect(before.members).toEqual(['alice']);
		expect(before.taps).toBe(1);

		// Mallory holds no grant and names the room in a BATCH frame.
		const mallory = await client(server.wsUrl, 'mallory');
		mallory.send({ type: 'subscribe-batch', topics: ['private-room'], ref: 2 });

		const denied = await mallory.waitFor(
			(p) => p?.type === 'subscribe-denied' && p?.topic === 'private-room',
			2000
		);
		expect(denied, 'batch subscribe was not denied at all').not.toBeNull();
		expect(denied.parsed.reason).toBe('FORBIDDEN');

		// The decision is only half the story - the hook must not have run.
		// Under the defect the roster reads ['alice','mallory'] and taps 2.
		const after = await readRoster(alice, 'private-room', 'after');
		expect(after.members).toEqual(['alice']);
		expect(after.taps).toBe(1);
		// Boots a server and then pays for a grant plus two roster round-trips, so it
		// carries more of the wall clock than its siblings and is the one that crosses
		// vitest's 5000ms default once the full suite is competing for the machine.
		// Long enough that a genuine stall still fails, rather than the scheduler.
	}, 30000);

	it('delivers no roster state to the denied caller', async () => {
		server = await startRealRuntime({ variant: 'batchleak' });

		const alice = await client(server.wsUrl, 'alice');
		alice.send({ type: 'grant', topic: 'private-room' });
		expect(await alice.waitFor((p) => p?.event === 'granted', 2000)).not.toBeNull();

		const mallory = await client(server.wsUrl, 'mallory');
		mallory.send({ type: 'subscribe-batch', topics: ['private-room'], ref: 3 });
		expect(await mallory.waitFor((p) => p?.type === 'subscribe-denied', 2000)).not.toBeNull();

		// Supplementary to the roster assertion above, which is what actually
		// proves the hook did not run.
		const leaked = await mallory.waitFor((p) => p?.topic === '__presence:private-room', 400);
		expect(leaked, 'denied caller received presence traffic for the room').toBeNull();
	});

	it('treats the batch and single spellings of one request identically', async () => {
		server = await startRealRuntime({ variant: 'batchleak' });

		const alice = await client(server.wsUrl, 'alice');
		alice.send({ type: 'grant', topic: 'private-room' });
		expect(await alice.waitFor((p) => p?.event === 'granted', 2000)).not.toBeNull();

		// The single path was already correct; pinning it keeps the two from
		// drifting apart again, which is the shape this bug had.
		const mallory = await client(server.wsUrl, 'mallory');
		mallory.send({ type: 'subscribe', topic: 'private-room', ref: 4 });
		expect(await mallory.waitFor((p) => p?.type === 'subscribe-denied', 2000)).not.toBeNull();

		const after = await readRoster(alice, 'private-room', 'single');
		expect(after.members).toEqual(['alice']);
		expect(after.taps).toBe(1);
	});

	it('still admits a granted topic named in a batch frame', async () => {
		// The gate must not be closed by simply refusing everything.
		server = await startRealRuntime({ variant: 'batchleak' });

		const alice = await client(server.wsUrl, 'alice');
		alice.send({ type: 'grant', topic: 'open-room' });
		expect(await alice.waitFor((p) => p?.event === 'granted', 2000)).not.toBeNull();

		alice.send({ type: 'subscribe-batch', topics: ['open-room'], ref: 5 });
		const ack = await alice.waitFor(
			(p) => p?.type === 'subscribed' && p?.topic === 'open-room',
			2000
		);
		expect(ack, 'a granted topic was refused in a batch frame').not.toBeNull();
	});
});
