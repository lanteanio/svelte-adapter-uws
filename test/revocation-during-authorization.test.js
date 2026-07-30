// A revocation that lands while a subscribe is parked in its authorization
// await must cancel that subscribe, not silently miss it.
//
// This drives the in-process test server, which is a public export
// (`svelte-adapter-uws/testing`) and therefore the surface an app uses to verify
// its own ban / kick / lease-expiry logic. It previously had no tombstone at
// all: unsubscribe returned false for a topic that was not yet a member, the
// parked subscribe then installed the grant anyway, and the app's regression
// test passed while the equivalent production path was the one that got fixed -
// a green false negative on exactly the behaviour being tested.
//
// The race is REPRODUCED, not simulated. The subscribe hook genuinely suspends
// on a promise the test controls, so the revocation runs in a real gap between
// the authorization decision and the grant write. A driver that calls the
// primitives in sequence without ever suspending proves nothing about this bug -
// it is the suspension that creates it.

import { describe, it, expect, afterEach } from 'vitest';
import { hasUWS } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('revocation landing during subscribe authorization', () => {
	/** @type {any} */
	let server = null;
	/** @type {any} */
	let client = null;

	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await server?.close();
		server = null;
	});

	/**
	 * Boot a server whose subscribe hook parks until released.
	 * @returns {Promise<{ ws: any, release: () => void }>}
	 */
	async function bootParked() {
		const { createTestServer } = await import('../src/testing.js');
		/** @type {() => void} */
		let release = () => {};
		const parked = new Promise((resolve) => { release = () => resolve(undefined); });
		/** @type {any} */
		let capturedWs = null;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				async subscribe() { await parked; }
			}
		});

		const wsMod = await import('ws');
		const WebSocket = wsMod.WebSocket ?? wsMod.default;
		client = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(capturedWs, 'the connection should have reached the open hook').not.toBeNull();
		return { ws: capturedWs, release };
	}

	it('discards the grant rather than installing it, and reports the removal truthfully', async () => {
		const { ws, release } = await bootParked();

		// Start the subscribe and let it genuinely suspend inside the hook.
		const pending = server.platform.subscribe(ws, 'room');
		await new Promise((r) => setTimeout(r, 20));

		// Revoke while it is parked.
		const removed = server.platform.unsubscribe(ws, 'room');

		release();
		const denial = await pending;

		expect(denial, 'a subscribe revoked while parked must not be granted').toBe('FORBIDDEN');
		expect(removed, 'unsubscribe must report that it cancelled the in-flight grant').toBe(true);
		expect(server.platform.subscribers('room'), 'no membership may survive the revocation').toBe(0);
		expect(ws.isSubscribed('room'), 'the socket must not hold the topic').toBe(false);
	});

	it('still grants normally when no revocation intervenes', async () => {
		// Control: proves the tombstone denies only the revoked case and has not
		// simply broken subscribing through an awaiting hook.
		const { ws, release } = await bootParked();

		const pending = server.platform.subscribe(ws, 'room');
		await new Promise((r) => setTimeout(r, 20));
		release();

		expect(await pending).toBeNull();
		expect(server.platform.subscribers('room')).toBe(1);
		expect(ws.isSubscribed('room')).toBe(true);
	});

	it('cancels a subscribe driven from the WIRE, not only one from platform.subscribe', async () => {
		// The two entry points are separate code paths, and only the
		// platform.subscribe one was covered. The wire path is the one a client
		// controls, so it is the one that matters: a ban landing while the app's
		// async authorization hook is parked has to cancel the CLIENT's subscribe.
		//
		// Driving platform.subscribe cannot detect a missing tombstone on the wire
		// path - it exercises the other branch entirely - which is how this shipped
		// with unsubscribe() returning false and the grant installed anyway.
		const { ws, release } = await bootParked();

		/** @type {any[]} */
		const frames = [];
		client.on('message', (raw) => {
			try { frames.push(JSON.parse(String(raw))); } catch { /* non-JSON */ }
		});

		// The client asks to subscribe; the hook parks inside the server.
		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		await new Promise((r) => setTimeout(r, 30));

		// Revoke while the client's subscribe is parked mid-authorization.
		const removed = server.platform.unsubscribe(ws, 'room');

		release();
		await new Promise((r) => setTimeout(r, 50));

		expect(removed, 'unsubscribe must report that it cancelled the in-flight grant').toBe(true);
		expect(server.platform.subscribers('room'), 'no membership may survive the revocation').toBe(0);
		expect(ws.isSubscribed('room'), 'the socket must not hold the topic').toBe(false);

		// The client's ref'd frame must be answered truthfully - a denial, not an
		// acknowledgement - so an awaited subscribe on the client resolves as
		// refused rather than reporting success for a grant that was discarded.
		const answer = frames.find((f) => f && f.ref === 1);
		expect(answer, 'the ref\'d subscribe frame must be answered').toBeTruthy();
		expect(answer.type, 'the answer must be a denial, not an ack').not.toBe('subscribed');
		expect(JSON.stringify(answer)).toContain('FORBIDDEN');
	});

	it('cancels a BATCH subscribe too, so unsubscribe cannot report over a live membership', async () => {
		// subscribe and subscribe-batch are separate paths and both are ordinary
		// client-store frames, so a client can have the same topic in flight on
		// both at once. Tracking only the single path was worse than tracking
		// neither: platform.unsubscribe answered true - I cancelled the in-flight
		// grant - because it had cancelled the single one, while the untracked
		// batch went on to ack the topic and install the membership. An app whose
		// ban logic reads that boolean then recorded a revocation over a live
		// subscription.
		const { ws, release } = await bootParked();
		/** @type {any[]} */
		const frames = [];
		client.on('message', (raw) => {
			try { frames.push(JSON.parse(String(raw))); } catch { /* non-JSON */ }
		});

		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		client.send(JSON.stringify({ type: 'subscribe-batch', topics: ['room'], ref: 2 }));
		await new Promise((r) => setTimeout(r, 40));

		const removed = server.platform.unsubscribe(ws, 'room');
		release();
		await new Promise((r) => setTimeout(r, 80));

		// The assertion that matters is that the answer is TRUE OF THE WORLD: it
		// reported a cancellation, so nothing may be subscribed afterwards.
		expect(removed).toBe(true);
		expect(server.platform.subscribers('room'), 'no membership may survive the revocation').toBe(0);
		expect(ws.isSubscribed('room')).toBe(false);
		// Answered AND not an ack. `not.toBe('subscribed')` alone passes when the
		// frame is absent entirely, which would leave a client's awaited batch
		// subscribe hanging forever with the suite green.
		const batchAnswer = frames.find((f) => f && f.ref === 2);
		expect(batchAnswer, 'the ref\'d batch frame must be answered at all').toBeTruthy();
		expect(batchAnswer.type, 'the batch frame must not be acknowledged').not.toBe('subscribed');
	});

	it('cancels a parked subscribe when the CLIENT itself unsubscribes', async () => {
		// The wire unsubscribe FRAME is the third entry point into the same TOCTOU,
		// and it was on no still-open list. The client subscribes, its own
		// unsubscribe arrives while the app hook is still parked, and the hook then
		// releases: the membership did not exist when the unsubscribe ran, so
		// removing it was a no-op and the parked subscribe installed it afterwards.
		// The app has already been told the client left - presence and cursor state
		// record it - while the socket is live on the topic.
		const { ws, release } = await bootParked();

		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		await new Promise((r) => setTimeout(r, 30));
		client.send(JSON.stringify({ type: 'unsubscribe', topic: 'room' }));
		await new Promise((r) => setTimeout(r, 20));
		release();
		await new Promise((r) => setTimeout(r, 60));

		expect(server.platform.subscribers('room'), 'the client asked to leave; no membership may remain').toBe(0);
		expect(ws.isSubscribed('room'), 'the socket must not hold the topic').toBe(false);
	});

	it('grants a wire subscribe normally when no revocation intervenes', async () => {
		// Control for the wire path, matching the one above for platform.subscribe.
		const { ws, release } = await bootParked();

		/** @type {any[]} */
		const frames = [];
		client.on('message', (raw) => {
			try { frames.push(JSON.parse(String(raw))); } catch { /* non-JSON */ }
		});

		client.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 2 }));
		await new Promise((r) => setTimeout(r, 30));
		release();
		await new Promise((r) => setTimeout(r, 50));

		expect(server.platform.subscribers('room')).toBe(1);
		expect(ws.isSubscribed('room')).toBe(true);
		const answer = frames.find((f) => f && f.ref === 2);
		expect(answer?.type).toBe('subscribed');
	});
});
