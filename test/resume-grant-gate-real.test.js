// The resume lane honours the server-grant model, against the REAL runtime.
//
// WHY THIS EXISTS. The `resume` frame is CLIENT-NAMED: the client supplies the
// topics in `lastSeenSeqs`, and the app's resume hook typically answers each
// one with that topic's replay buffer. Under the pure-grant model every other
// client-named lane is gated - the wire subscribe, the subscribe-batch, and the
// presence/cursor observer lanes - but this one was not, which made it the
// LARGEST hole of the set: it yields a topic's message history rather than a
// roster.
//
// Reported from the extensions side, where the same asymmetry was found from
// the other direction. Ungated topics are filtered out before the hook sees
// them, rather than the whole frame being refused, because a reconnect names
// every topic the client held and a client legitimately holds some of them.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the resume lane honours the grant model (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		// The `grant` variant arms authorizeWireSubscribe and exports NO subscribe
		// hook, which is the pure-grant configuration this gate applies to.
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

	it('does not refuse the frame outright - a resume still acks', async () => {
		// The gate must not turn a reconnect into a failure: the client is still
		// told the resume completed, it simply gets nothing for topics it was
		// never granted.
		const alice = await client();
		alice.send({ type: 'resume', sessionId: 'sess-1', lastSeenSeqs: { 'tenant-b:secret': 0 } });

		const acked = await alice.waitFor((f) => f?.type === 'resumed' || f?.type === 'resume-denied', 800);
		expect(acked, 'a resume must be answered rather than dropped').not.toBeNull();
	});

	it('never hands an ungranted topic to the resume hook', async () => {
		// Asserted on what the HOOK RECEIVED, not on the absence of replay
		// traffic: a server with no resume hook at all produces no traffic
		// either, so an absence assertion would pass against a runtime that
		// filters nothing.
		const bob = await client();
		bob.send({ type: 'resume', sessionId: 'sess-2', lastSeenSeqs: { 'tenant-b:secret': 0 } });

		const echoed = await bob.waitFor((f) => f?.event === 'resume-topics');
		expect(echoed, 'the resume hook must have run').not.toBeNull();
		expect(
			echoed.parsed.data.topics,
			'an ungranted topic must never reach the resume hook'
		).toEqual([]);
	});

	it('still hands over a topic this connection WAS granted', async () => {
		// The control: the filter must drop only the ungranted topics. Without it
		// the case above is satisfied by a gate that empties every resume frame,
		// which would silently break every legitimate reconnect.
		const carol = await client();
		carol.send({ type: 'grant', topic: 'room-9' });
		const granted = await carol.waitFor((f) => f?.event === 'granted');
		expect(granted, 'the fixture must mint the grant').not.toBeNull();

		carol.send({ type: 'resume', sessionId: 'sess-3', lastSeenSeqs: { 'room-9': 0, 'never-granted': 0 } });

		const echoed = await carol.waitFor((f) => f?.event === 'resume-topics');
		expect(echoed, 'the resume hook must have run').not.toBeNull();
		expect(
			echoed.parsed.data.topics,
			'the granted topic survives and only the ungranted one is dropped'
		).toEqual(['room-9']);
	});
});
