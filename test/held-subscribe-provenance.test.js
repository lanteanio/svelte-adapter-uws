// The held-at-landing provenance read (settleHeldSubscribe), driven against
// the published in-process server.
//
// WHY. A revocation (platform.unsubscribe) tombstones an in-flight subscribe
// and removes the membership, so a topic HELD at the landing was installed
// during the await window - either by a fresh post-revoke attempt (current
// authority; must ack) or by the revoked attempt's OWN hook (a plugin join;
// the tombstone exists to defeat exactly this; must deny and unwind). The
// plain settle cannot tell the two apart, so the held branch reads the
// provenance: 'ack' / 'deny' (another in-flight attempt owns the outcome) /
// 'deny-unwind'.
//
// The four branches, each driven through the documented group-join shape:
//   1. deny-unwind: revoked, hook installs membership, no other authority ->
//      FORBIDDEN, membership AND roster gone.
//   2. ack via re-grant: revoke, then a deliberate platform.subscribe re-grant
//      completes before the landing -> the revoked frame acks.
//   3. ack via fresh client attempt: revoke, the client re-subscribes and is
//      acked first -> the revoked frame acks too (current authority).
//   4. deny (no unwind): the revoked frame lands while the fresh attempt is
//      still in flight -> FORBIDDEN for it, membership stands for the fresh
//      one, which acks.
//   5. the deferral in 4 is not a leak: when the fresh attempt's OWN hook
//      then DENIES, its denial exit is the last settler and must unwind the
//      membership the revoked attempt installed. Missing that reading left a
//      revoked socket subscribed with every frame answered FORBIDDEN.
//   6. the entry-creation seed: an observer-lane enrolment (presence sync /
//      cursor snapshot) for an ALREADY-held topic must carry that membership's
//      authority on the entry, so a denied re-subscribe answers its frame
//      without evicting a membership nobody revoked.
//   7. the observer lane's own denial exit reads provenance too: a hook that
//      installs tracked membership and then refuses must have it unwound, app
//      unsubscribe hook included, not left standing behind a "not allowed".
//   8. the observer lane's ALLOW exit is the mirror image: an observer revoked
//      mid-await still refuses its tap, but when a revoked wire sibling's hook
//      installed the membership and its landing deferred, the observer is the
//      last settler and must unwind rather than settle plain and walk away.

import { describe, it, expect, afterEach } from 'vitest';
import { createGroup } from '../src/plugins/groups/server.js';

/** @type {any} */
let server = null;

afterEach(async () => {
	await server?.close();
	server = null;
});

/** Connect a real ws client and collect parsed frames. */
async function connect(wsUrl) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl);
	const frames = [];
	ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, frames, send: (m) => ws.send(JSON.stringify(m)) };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** Answer the client received for one subscribe ref. */
function answerFor(client, topic, ref) {
	return client.frames.find((f) => f.topic === topic && f.ref === ref);
}

describe('held-at-landing provenance', () => {
	it('denies and unwinds a membership the revoked attempt installed itself', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const lobby = createGroup('lobby');
		let captured = null;
		let releasePark;
		const parked = new Promise((res) => { releasePark = res; });
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				// The documented escape hatch: an app wrapper around the plugin hook.
				async subscribe(ws, topic, ctx) {
					if (topic === '__group:lobby') await parked;
					return lobby.hooks.subscribe(ws, topic, ctx);
				},
				unsubscribe: lobby.hooks.unsubscribe,
				close: lobby.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });
		await settle(); // let the wrapper park

		// The revocation lands inside the begin/settle window: the membership
		// does not exist yet, so `true` means the in-flight subscribe was found.
		expect(server.platform.unsubscribe(captured, '__group:lobby'), 'the in-flight subscribe must be found').toBe(true);

		releasePark();
		await settle(150);

		const answer = answerFor(client, '__group:lobby', 1);
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer, 'the tombstoned subscribe must not be acked').toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(server.platform.subscribers('__group:lobby'), 'no runtime membership may survive the revocation').toBe(0);
		expect(lobby.count(), 'the unwind must have run the leave hook: no roster membership may survive').toBe(0);

		client.ws.terminate();
	});

	it('acks the revoked frame when a platform.subscribe re-grant landed first', async () => {
		// Revoke-then-re-grant inside one window is current authority (the same
		// semantics checkSubscribe documents): the re-grant's own settle marks
		// the topic granted, and the revoked attempt's landing must read it.
		const { createTestServer } = await import('../src/testing.js');
		const lobby = createGroup('lobby');
		let captured = null;
		let park = true;
		let releasePark;
		const parked = new Promise((res) => { releasePark = res; });
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				async subscribe(ws, topic, ctx) {
					if (topic === '__group:lobby' && park) await parked;
					return lobby.hooks.subscribe(ws, topic, ctx);
				},
				unsubscribe: lobby.hooks.unsubscribe,
				close: lobby.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });
		await settle();

		expect(server.platform.unsubscribe(captured, '__group:lobby')).toBe(true);
		// The deliberate re-grant: server-side, trusted, runs its own gate. It
		// must not park on the same wrapper, or it would wait on the frame it is
		// meant to precede.
		park = false;
		expect(await server.platform.subscribe(captured, '__group:lobby'), 'the re-grant must succeed').toBeNull();

		releasePark();
		await settle(150);

		const answer = answerFor(client, '__group:lobby', 1);
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer, 'a topic the server re-granted is current authority').toMatchObject({ type: 'subscribed' });
		expect(server.platform.subscribers('__group:lobby')).toBe(1);
		expect(lobby.count()).toBe(1);

		client.ws.terminate();
	});

	it('acks the revoked frame when the client re-subscribed and landed first', async () => {
		// The client-driven half of the re-grant: a fresh post-revoke attempt
		// uses the new epoch, and its ack marks the grant for the revoked one.
		const { createTestServer } = await import('../src/testing.js');
		const lobby = createGroup('lobby');
		let captured = null;
		let park = true;
		let releasePark;
		const parked = new Promise((res) => { releasePark = res; });
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				async subscribe(ws, topic, ctx) {
					if (topic === '__group:lobby' && park) await parked;
					return lobby.hooks.subscribe(ws, topic, ctx);
				},
				unsubscribe: lobby.hooks.unsubscribe,
				close: lobby.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });
		await settle();
		expect(server.platform.unsubscribe(captured, '__group:lobby')).toBe(true);

		// The fresh attempt runs its hook unparked and lands BEFORE the revoked
		// one: acked on the new epoch.
		park = false;
		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 2 });
		await settle(150);
		expect(answerFor(client, '__group:lobby', 2), 'the fresh attempt must be acked').toMatchObject({ type: 'subscribed' });

		releasePark();
		await settle(150);

		const answer = answerFor(client, '__group:lobby', 1);
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer, 'the fresh ack is current authority for the revoked frame too').toMatchObject({ type: 'subscribed' });
		expect(server.platform.subscribers('__group:lobby')).toBe(1);

		client.ws.terminate();
	});

	it('denies without unwinding when the fresh attempt is still in flight', async () => {
		// The 'deny' branch: the revoked frame settles while another attempt is
		// enrolled, so the membership is left for the fresh landing to judge.
		// Both wrappers park; releasing ref 1 first makes its landing run while
		// ref 2's hook is still parked.
		const { createTestServer } = await import('../src/testing.js');
		const lobby = createGroup('lobby');
		let captured = null;
		const resolvers = [];
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				subscribe(ws, topic, ctx) {
					if (topic !== '__group:lobby') return lobby.hooks.subscribe(ws, topic, ctx);
					return new Promise((resolve) => {
						resolvers.push(() => resolve(lobby.hooks.subscribe(ws, topic, ctx)));
					});
				},
				unsubscribe: lobby.hooks.unsubscribe,
				close: lobby.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });
		await settle();
		expect(server.platform.unsubscribe(captured, '__group:lobby')).toBe(true);
		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 2 });
		await settle();
		expect(resolvers.length, 'both attempts must be parked').toBe(2);

		// Ref 1 lands first: revoked, but ref 2 is still in flight, so the
		// membership ref 1's own hook just installed is left in place for ref
		// 2's landing to re-validate.
		resolvers[0]();
		await settle(150);
		const denied = answerFor(client, '__group:lobby', 1);
		expect(denied, 'the revoked frame must be answered').toBeTruthy();
		expect(denied).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(server.platform.subscribers('__group:lobby'), 'the fresh attempt still owns the membership - it must not be unwound').toBe(1);

		resolvers[1]();
		await settle(150);
		expect(answerFor(client, '__group:lobby', 2), 'the fresh attempt must be acked').toMatchObject({ type: 'subscribed' });
		expect(server.platform.subscribers('__group:lobby')).toBe(1);
		expect(lobby.count()).toBe(1);

		client.ws.terminate();
	});

	it('unwinds when the fresh attempt denies too, so the deferral is not a leak', async () => {
		// The hole the deferral in the previous case opens if the denial exit
		// settles blindly. Both attempts park; the first is revoked mid-park and
		// its own hook installs membership on release; the second attempt's hook
		// DENIES (the ban is visible by then). The revoked landing defers to the
		// second attempt, and the second leaves through its denial exit - so that
		// exit is the last settler and owns the unwind. Without it the socket
		// keeps native membership and the group roster entry while BOTH frames
		// were answered FORBIDDEN.
		const { createTestServer } = await import('../src/testing.js');
		const lobby = createGroup('lobby');
		let captured = null;
		const resolvers = [];
		let attempt = 0;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				subscribe(ws, topic, ctx) {
					if (topic !== '__group:lobby') return lobby.hooks.subscribe(ws, topic, ctx);
					const mine = ++attempt;
					return new Promise((resolve) => {
						// The first attempt joins the group (installing membership from
						// inside the hook); the second refuses, as a ban check would.
						resolvers.push(() => resolve(mine === 1 ? lobby.hooks.subscribe(ws, topic, ctx) : 'FORBIDDEN'));
					});
				},
				unsubscribe: lobby.hooks.unsubscribe,
				close: lobby.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 1 });
		await settle();
		expect(server.platform.unsubscribe(captured, '__group:lobby')).toBe(true);
		client.send({ type: 'subscribe', topic: '__group:lobby', ref: 2 });
		await settle();
		expect(resolvers.length, 'both attempts must be parked').toBe(2);

		// Revoked attempt lands first and defers: ref 2 is still enrolled.
		resolvers[0]();
		await settle(150);
		expect(answerFor(client, '__group:lobby', 1)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });

		// Ref 2's hook denies. Its denial exit is now the last settler.
		resolvers[1]();
		await settle(150);
		const second = answerFor(client, '__group:lobby', 2);
		expect(second, 'the denying attempt must be answered with its own reason').toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });

		// Nothing may survive: both frames were denied, so no authority backs
		// the membership the revoked attempt installed from inside its hook.
		expect(server.platform.subscribers('__group:lobby'), 'the revoked membership must be unwound once no attempt is left to judge it').toBe(0);
		expect(lobby.count(), 'the group roster must be unwound with it').toBe(0);

		client.ws.terminate();
	});

	it('does not evict a held membership when its entry was opened by an observer lane', async () => {
		// The observer lane (a presence sync / cursor snapshot handshake) enrols
		// on the BASE topic under the same revocation guard as the wire lanes,
		// so its enrolment can be the one that CREATES the pending entry for a
		// topic the connection legitimately holds. The entry's authority must be
		// seeded from that membership: without the seed, a wire re-subscribe
		// whose hook denies while the observer is still parked becomes the last
		// settler of an authority-less entry and unwinds a membership nobody
		// revoked - eviction and an unsubscribe hook firing for a topic the app
		// never left.
		const { createTestServer } = await import('../src/testing.js');
		const { authorizeDerivedSubscribe } = await import('../src/runtime/utils.js');
		let captured = null;
		let park = false;
		const resolvers = [];
		let unsubscribeHookRuns = 0;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				subscribe() {
					// The initial server-side grant flows through unparked; every
					// later authorization parks so the driver controls the order.
					if (!park) return undefined;
					return new Promise((resolve) => { resolvers.push(resolve); });
				},
				unsubscribe() { unsubscribeHookRuns++; }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		// A legitimately granted, counted membership.
		expect(await server.platform.subscribe(captured, 'room'), 'the grant must succeed').toBeNull();
		expect(server.platform.subscribers('room')).toBe(1);
		park = true;

		// The observer lane enrols for the held topic and parks in its
		// authorization await: it owns the entry's creation.
		const observer = authorizeDerivedSubscribe(captured, 'room', () =>
			server.platform.checkSubscribe(captured, 'room', { requireGrant: true })
		);
		await settle();
		expect(resolvers.length, 'the observer authorization must be parked').toBe(1);

		// A wire re-subscribe for the same held topic parks behind it.
		client.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await settle();
		expect(resolvers.length, 'the re-subscribe hook must be parked too').toBe(2);

		// The observer resolves first (allowed); the re-subscribe hook then
		// denies, making its denial exit the last settler.
		resolvers[0]();
		await settle();
		resolvers[1]('FORBIDDEN');
		await settle(150);

		expect(await observer, 'the observer request must be allowed').toBe(true);
		const answer = answerFor(client, 'room', 1);
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		// The denial answers the frame and nothing more: the membership predates
		// every in-flight attempt and carries its authority on the entry.
		expect(server.platform.subscribers('room'), 'the standing membership must survive the denied re-subscribe').toBe(1);
		expect(unsubscribeHookRuns, 'no unsubscribe hook may fire for a membership nobody revoked').toBe(0);

		client.ws.terminate();
	});

	it('unwinds a membership the hook installed when the observer authorization denies', async () => {
		// The observer lane's own denial exit. An app hook that installs tracked
		// membership and then refuses (the group-join wrapper shape) used to
		// leave that membership standing when it denied an observer request: the
		// enrolment settled blind, the observer was answered "not allowed", and
		// the socket stayed subscribed to the base topic - receiving its fan-out
		// after being refused.
		const { createTestServer } = await import('../src/testing.js');
		const { authorizeDerivedSubscribe, trackedSubscribe } = await import('../src/runtime/utils.js');
		let captured = null;
		let unsubscribeHookRuns = 0;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				subscribe(ws, topic) {
					trackedSubscribe(ws, topic);
					return 'FORBIDDEN';
				},
				unsubscribe() { unsubscribeHookRuns++; }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		const allowed = await authorizeDerivedSubscribe(captured, 'room', () =>
			server.platform.checkSubscribe(captured, 'room', { requireGrant: true })
		);

		expect(allowed, 'the observer request must be refused').toBe(false);
		expect(server.platform.subscribers('room'), 'the membership the refusing hook installed must not stand').toBe(0);
		expect(unsubscribeHookRuns, 'the unwind must run the app unsubscribe hook').toBe(1);

		client.ws.terminate();
	});

	it('unwinds through the observer ALLOW exit when a revoked sibling deferred to it', async () => {
		// The mirror image of the denial-exit case. A wire subscribe parks in a
		// hook that installs membership and then ALLOWS (the group-join wrapper
		// shape); an observer handshake enrols the same base topic and parks
		// behind it; a revocation tombstones both. The wire landing finds the
		// topic held and defers - the observer is still in flight to judge it.
		// The observer's authorization then resolves ALLOW, but its enrolment
		// was revoked: the tap is refused either way, and the observer is now
		// the LAST attempt left. Settling plain here refused the tap and walked
		// away with the membership standing - revocation honored on paper,
		// socket subscribed until disconnect.
		const { createTestServer } = await import('../src/testing.js');
		const { authorizeDerivedSubscribe, trackedSubscribe } = await import('../src/runtime/utils.js');
		let captured = null;
		const resolvers = [];
		let calls = 0;
		let unsubscribeHookRuns = 0;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				subscribe(ws, topic) {
					const mine = ++calls;
					return new Promise((resolve) => {
						resolvers.push(() => {
							// The wire attempt installs from inside its hook and
							// allows; the observer's chain simply allows.
							if (mine === 1) trackedSubscribe(ws, topic);
							resolve(undefined);
						});
					});
				},
				unsubscribe() { unsubscribeHookRuns++; }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		client.send({ type: 'subscribe', topic: 'room', ref: 1 });
		await settle();
		expect(resolvers.length, 'the wire hook must be parked').toBe(1);

		const observer = authorizeDerivedSubscribe(captured, 'room', () =>
			server.platform.checkSubscribe(captured, 'room', { requireGrant: true })
		);
		await settle();
		expect(resolvers.length, 'the observer authorization must be parked too').toBe(2);

		// The revocation lands while both are parked: nothing is installed yet,
		// so `true` means the in-flight attempts were found and tombstoned.
		expect(server.platform.unsubscribe(captured, 'room'), 'the in-flight subscribes must be found').toBe(true);

		// The wire attempt releases: installs, allows, lands revoked with the
		// observer still in flight - it defers rather than unwinding.
		resolvers[0]();
		await settle(150);
		const answer = answerFor(client, 'room', 1);
		expect(answer, 'the revoked frame must be answered').toBeTruthy();
		expect(answer).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });

		// The observer's authorization ALLOWS, but its enrolment was revoked:
		// tap refused, and as the last settler it owes the unwind.
		resolvers[1]();
		expect(await observer, 'a revoked observer must refuse its tap').toBe(false);
		await settle();

		expect(server.platform.subscribers('room'), 'no membership may survive once no attempt is left to judge it').toBe(0);
		expect(unsubscribeHookRuns, 'the unwind must run the app unsubscribe hook').toBe(1);

		client.ws.terminate();
	});
});
