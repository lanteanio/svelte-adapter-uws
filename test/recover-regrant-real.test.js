// The recover lane's revocation test, driven against the REAL built runtime.
//
// WHY THIS EXISTS. The lane decides whether a `recover` request may be served a
// topic's replay history after a revocation landed while the authorization hook
// was parked. It used to answer that from the revocation EPOCH, which only ever
// rises - so a revoke followed by a legitimate re-grant inside the same await
// window could never clear it. The runtime then acked the subscription and
// silently dropped the replay: the client switched to live mode believing it
// was caught up, with everything between its last-seen seq and now gone, and no
// denial, no `truncated`, no error to notice.
//
// A later fix consulted the current grant set instead, but only when the
// server-grant gate was armed AND the app exported no subscribe hook. That is
// the narrow configuration; `authorizeWireSubscribe` defaults to false and
// exporting a subscribe hook is the documented way to keep control, so the
// defect stayed live in both mainstream setups. This suite therefore runs with
// the gate OFF and an app hook exported - the default shape - and covers BOTH
// the single and the batch spelling, because fixing one and leaving the other
// is the repeat-offender pattern in this area.
//
// WHAT MAKES IT A PROOF. The `resume` hook announces the topics the runtime
// handed it, so a served replay is a POSITIVE reading rather than an inference
// from silence - a server that never opened the lane at all produces no replay
// either. Membership is asserted from the server's own count for the same
// reason.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('recover after revoke-then-re-grant (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'recover',
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

	/**
	 * Topics the recover lane actually handed the app's resume hook.
	 *
	 * Read back from the connection after the window closes, so the assertion
	 * is a server-side fact that does not depend on frame ordering or delivery.
	 * This and the `replayed` frame are two reads of the SAME fact - that the
	 * hook ran - so neither substitutes for the other; the withhold assertions
	 * in the controls are what make this file cover its own subject.
	 */
	async function resumedTopics(c) {
		c.send({ type: 'resumed-topics' });
		const frame = await c.waitFor((f) => f?.event === 'resumed-topics');
		expect(frame, 'the resumed-topics probe must answer').not.toBeNull();
		return frame.parsed.data.topics;
	}

	/** Wait for the subscribe answer, whichever way it went. */
	async function answerFor(c, topic) {
		const answer = await c.waitFor(
			(f) => (f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.topic === topic
		);
		expect(answer, 'the client must be answered, not left waiting').not.toBeNull();
		return answer;
	}

	it('serves the replay when a revoke is followed by a re-grant (batch)', async () => {
		const alice = await client();
		const topic = 'park-batch-regrant';
		alice.send({ type: 'subscribe-batch', topics: [topic], recover: { [topic]: { offset: 0 } }, ref: 10 });

		expect(await alice.waitFor((f) => f?.event === 'parked'), 'the hook must park').not.toBeNull();

		alice.send({ type: 'revoke', topic });
		expect(await alice.waitFor((f) => f?.event === 'revoked' && f.data?.topic === topic)).not.toBeNull();

		// The re-grant: the connection legitimately holds the topic again.
		alice.send({ type: 'regrant', topic });
		const regranted = await alice.waitFor((f) => f?.event === 'regranted' && f.data?.topic === topic);
		expect(regranted, 'the re-grant must be processed inside the window').not.toBeNull();
		expect(regranted.parsed.data.ok, 'the re-grant must succeed').toBe(true);

		alice.send({ type: 'release' });

		const answer = await answerFor(alice, topic);
		expect(answer.parsed.type, 'a re-granted topic must be acked').toBe('subscribed');

		// The point of the test: the ack must not come with a silently dropped
		// replay. This is the assertion that was red before the fix.
		expect(
			await resumedTopics(alice),
			'the replay history must be served for a re-granted topic'
		).toContain(topic);

		// And the CLIENT must actually have received the gap-fill, not merely
		// have caused a server-side flag to be set.
		const replayed = await alice.waitFor((f) => f?.event === 'replayed' && f.data?.topics?.includes(topic));
		expect(replayed, 'the gap-fill must reach the client').not.toBeNull();

		expect(await countOf(alice, topic), 'the ack must be true of the world').toBe(1);
	});

	it('serves the replay when a revoke is followed by a re-grant (single)', async () => {
		// The sibling spelling. Fixing the batch path and leaving this one is
		// exactly how this defect survived a previous round.
		const bob = await client();
		const topic = 'park-single-regrant';
		bob.send({ type: 'subscribe', topic, recover: { offset: 0 }, ref: 11 });

		expect(await bob.waitFor((f) => f?.event === 'parked'), 'the hook must park').not.toBeNull();

		bob.send({ type: 'revoke', topic });
		expect(await bob.waitFor((f) => f?.event === 'revoked' && f.data?.topic === topic)).not.toBeNull();

		bob.send({ type: 'regrant', topic });
		const regranted = await bob.waitFor((f) => f?.event === 'regranted' && f.data?.topic === topic);
		expect(regranted, 'the re-grant must be processed inside the window').not.toBeNull();
		expect(regranted.parsed.data.ok, 'the re-grant must succeed').toBe(true);

		bob.send({ type: 'release' });

		const answer = await answerFor(bob, topic);
		expect(answer.parsed.type, 'a re-granted topic must be acked').toBe('subscribed');

		expect(
			await resumedTopics(bob),
			'the replay history must be served for a re-granted topic'
		).toContain(topic);

		// And the CLIENT must actually have received the gap-fill, not merely
		// have caused a server-side flag to be set.
		const replayed = await bob.waitFor((f) => f?.event === 'replayed' && f.data?.topics?.includes(topic));
		expect(replayed, 'the gap-fill must reach the client').not.toBeNull();

		expect(await countOf(bob, topic), 'the ack must be true of the world').toBe(1);
	});

	it('still refuses a revocation that was NOT followed by a re-grant', async () => {
		// The control that keeps the two cases above honest. Without it they are
		// satisfied by a runtime that serves every replay unconditionally, which
		// is the failure the lane exists to prevent.
		const carol = await client();
		const topic = 'park-revoked-only';
		carol.send({ type: 'subscribe-batch', topics: [topic], recover: { [topic]: { offset: 0 } }, ref: 12 });

		expect(await carol.waitFor((f) => f?.event === 'parked'), 'the hook must park').not.toBeNull();

		carol.send({ type: 'revoke', topic });
		expect(await carol.waitFor((f) => f?.event === 'revoked' && f.data?.topic === topic)).not.toBeNull();

		carol.send({ type: 'release' });

		const answer = await answerFor(carol, topic);
		expect(answer.parsed).toMatchObject({ type: 'subscribe-denied', topic, reason: 'FORBIDDEN' });

		// Positive reading of the same fact: a refused subscribe leaves no
		// membership behind. The denial frame alone would still be satisfied by a
		// runtime that answered "denied" and subscribed the client anyway.
		expect(await countOf(carol, topic), 'a refused subscribe may leave no membership').toBe(0);

		// AND the recover lane must not have served the history. This is the
		// assertion that makes this file cover its own subject: the denial and
		// the zero count above both come from the LANDING's tombstone, not from
		// the recover lane, so without this the whole revocation check could be
		// deleted and every test here would still pass - which is exactly what a
		// mutation of the shipped tree confirmed.
		expect(
			await resumedTopics(carol),
			'a revoked topic may not be served its replay history'
		).not.toContain(topic);
	});

	it('still refuses a revocation that was NOT followed by a re-grant (single)', () => runSingleRevokedOnly());

	async function runSingleRevokedOnly() {
		// The sibling spelling of the control. There was no single-path
		// revoked-only test at all, so the single lane's withhold direction was
		// unasserted in both files that claim to cover it.
		const erin = await client();
		const topic = 'park-single-revoked-only';
		erin.send({ type: 'subscribe', topic, recover: { offset: 0 }, ref: 14 });

		expect(await erin.waitFor((f) => f?.event === 'parked'), 'the hook must park').not.toBeNull();

		erin.send({ type: 'revoke', topic });
		expect(await erin.waitFor((f) => f?.event === 'revoked' && f.data?.topic === topic)).not.toBeNull();

		erin.send({ type: 'release' });

		const answer = await answerFor(erin, topic);
		expect(answer.parsed).toMatchObject({ type: 'subscribe-denied', topic, reason: 'FORBIDDEN' });
		expect(await countOf(erin, topic), 'a refused subscribe may leave no membership').toBe(0);
		expect(
			await resumedTopics(erin),
			'a revoked topic may not be served its replay history'
		).not.toContain(topic);
	}

	it('serves the replay when nothing was revoked at all', async () => {
		// The other control: proves the lane is open in this fixture, so a
		// "replay served" assertion above means the fix and not a fixture quirk.
		const dave = await client();
		const topic = 'park-untouched';
		dave.send({ type: 'subscribe-batch', topics: [topic], recover: { [topic]: { offset: 0 } }, ref: 13 });

		expect(await dave.waitFor((f) => f?.event === 'parked'), 'the hook must park').not.toBeNull();
		dave.send({ type: 'release' });

		const answer = await answerFor(dave, topic);
		expect(answer.parsed.type).toBe('subscribed');

		expect(
			await resumedTopics(dave),
			'an untouched topic must be served its replay'
		).toContain(topic);
	});
});
