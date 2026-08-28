// Two REAL clients on one live topic, asserting that every roster change one
// makes is observed by the other.
//
// WHY THIS FILE EXISTS. 0.6.0-next.93 intermittently lost presence deliveries
// between two browser contexts on one room, and the adapter's 6500 tests passed
// on the same tree. The suite had presence codec cases, client-store cases over
// a mock socket, heartbeat cases with a faked clock, and structural guards over
// the wiring - and not one case where a frame leaves one real connection and is
// asserted to arrive at another. That is the only shape that can see a delivery
// defect, because presence publishes `{ seq: false }`: a dropped diff leaves no
// sequence gap, triggers no retry, and is invisible to every unit and codec test.
//
// WHAT MAKES THE ASSERTIONS COUNT. The fixture variant runs presence with
// `heartbeat: 0` (test/fixture/src/hooks.ws.presence.js). The heartbeat is the
// periodic full-roster rebroadcast, i.e. the thing that REPAIRS a dropped diff -
// against the shipped 30 s default a delivery case can pass on the repair rather
// than on the frame it names. Off, each roster change arrives as exactly one diff
// or not at all.
//
// Every step carries its own correlator (a distinct `status` value, a distinct
// joining identity). helpers/real-runtime.js documents why: `waitFor` scans the
// whole frame history, so a predicate repeated on one connection reads its own
// earlier answer back and the assertion goes vacuous. Nothing here waits twice
// on the same predicate.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const ROOM = 'room';
const PRESENCE_TOPIC = '__presence:' + ROOM;
const CURSOR_TOPIC = '__cursor:' + ROOM;

/** Presence frames this connection has received, newest last. */
function presenceFrames(client) {
	const out = [];
	for (const raw of client.frames) {
		let parsed;
		try { parsed = JSON.parse(raw); } catch { continue; }
		if (parsed && parsed.topic === PRESENCE_TOPIC) out.push(parsed);
	}
	return out;
}

/** Every `status` value this connection has observed through a diff's updates. */
function observedStatuses(client) {
	const seen = [];
	for (const frame of presenceFrames(client)) {
		if (frame.event !== 'diff' || !frame.data || !frame.data.updates) continue;
		for (const key of Object.keys(frame.data.updates)) {
			const status = frame.data.updates[key].status;
			if (status !== undefined) seen.push(status);
		}
	}
	return seen;
}

/** Keys this connection has observed joining, across `state` and `diff` frames. */
function observedJoins(client) {
	const seen = new Set();
	for (const frame of presenceFrames(client)) {
		if (frame.event === 'state' && frame.data) for (const k of Object.keys(frame.data)) seen.add(k);
		if (frame.event === 'diff' && frame.data && frame.data.joins) {
			for (const k of Object.keys(frame.data.joins)) seen.add(k);
		}
	}
	return seen;
}

/** Keys this connection has observed leaving. */
function observedLeaves(client) {
	const seen = new Set();
	for (const frame of presenceFrames(client)) {
		if (frame.event === 'diff' && frame.data && frame.data.leaves) {
			for (const k of Object.keys(frame.data.leaves)) seen.add(k);
		}
	}
	return seen;
}

/**
 * Every cursor position this connection observed, in arrival order. `update`
 * carries one `{ key, data }`; `bulk` carries an array of them.
 */
function cursorPositions(client) {
	const out = [];
	for (const raw of client.frames) {
		let parsed;
		try { parsed = JSON.parse(raw); } catch { continue; }
		if (!parsed || parsed.topic !== CURSOR_TOPIC) continue;
		if (parsed.event === 'update' && parsed.data && parsed.data.data) out.push(parsed.data.data);
		if (parsed.event === 'bulk' && Array.isArray(parsed.data)) {
			for (const entry of parsed.data) if (entry && entry.data) out.push(entry.data);
		}
	}
	return out;
}

/**
 * Poll until `read()` satisfies `done`, or the deadline passes. Returns the last
 * reading either way, so the caller asserts on the VALUE rather than on a
 * boolean this helper decided - a timeout then reports what was actually
 * received instead of "expected true to be false".
 */
async function settle(read, done, ms = 4000) {
	const deadline = Date.now() + ms;
	let last = read();
	while (!done(last) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
		last = read();
	}
	return last;
}

let nextRef = 1;

async function joinRoom(client) {
	// The ack is sent only for a subscribe carrying a ref (`hasRef`), and each
	// client gets its own so a wait cannot match a different connection's ack.
	const ref = nextRef++;
	client.send({ type: 'subscribe', topic: ROOM, ref });
	// The subscribe ack is the server confirming membership; presence joins on
	// the same hook, so waiting for it removes the race between subscribing and
	// the first diff without sleeping for a guessed interval.
	return client.waitFor((p) => p && p.type === 'subscribed' && p.topic === ROOM && p.ref === ref, 4000);
}

describeUWS('presence delivery between two real clients', () => {
	/** @type {any} */
	let rt;

	beforeAll(async () => {
		rt = await startRealRuntime({ variant: 'presence' });
	}, 60000);

	afterAll(async () => {
		await rt?.stop();
	});

	async function connect(identity) {
		return connectRealClient(rt.wsUrl, { headers: { cookie: 'token=' + identity } });
	}

	it('delivers a joining peer, every field update, and the departure to the other client', async () => {
		const alice = await connect('alice');
		const bob = await connect('bob');
		try {
			expect(await joinRoom(alice), 'alice never got her subscribe ack').not.toBeNull();
			expect(await joinRoom(bob), 'bob never got his subscribe ack').not.toBeNull();

			// 1. ALICE SEES BOB ARRIVE. Alice was already on the topic, so bob's
			// join reaches her as a diff rather than through her own snapshot.
			const joins = await settle(() => observedJoins(alice), (s) => s.has('bob'));
			expect([...joins], 'alice never observed bob joining').toContain('bob');

			// 2. EVERY UPDATE LANDS, not just the last. Each carries its own value,
			// so a lost middle frame cannot be masked by a later one arriving - and
			// the assertion is on the SEQUENCE bob published, compared against what
			// alice received, rather than on a count either side could satisfy alone.
			const sent = ['typing', 'idle', 'reading', 'typing-again', 'away'];
			for (const status of sent) {
				bob.send({ type: 'presence-update', topic: ROOM, fields: { status } });
				// Sequential, one flush window apart: the plugin collapses ops per
				// key within a flush by design, so a burst would legitimately
				// coalesce and the case would be asserting the collapse rule
				// instead of delivery.
				await settle(() => observedStatuses(alice), (s) => s.includes(status), 4000);
			}
			expect(observedStatuses(alice), 'alice lost at least one of bob\'s updates').toEqual(sent);

			// 3. THE DEPARTURE PROPAGATES. Terminate rather than unsubscribe: a
			// dropped connection is the shape the demo reported, and it exercises
			// the close path rather than the tidy client-initiated leave.
			bob.close();
			const leaves = await settle(() => observedLeaves(alice), (s) => s.has('bob'));
			expect([...leaves], 'alice never observed bob leaving').toContain('bob');
		} finally {
			alice.close();
			bob.close();
		}
	}, 60000);

	it('converges the cursor lane on the last position after a coalesced burst', async () => {
		// The OTHER lane on the shared fan-out path, asserted on its own contract.
		// Cursor coalesces per topic at 60 Hz by design, so counting frames here
		// would pin a promise it does not make - a burst is SUPPOSED to collapse.
		// What it does promise is where the peer ends up, so that is what this
		// asserts: the last position alice observes is the last position bob sent.
		const alice = await connect('alice-cursor');
		const bob = await connect('bob-cursor');
		try {
			// The snapshot is the membership-establishing handshake for this lane
			// (it runs the subscribe gate and subscribes the socket), not `subscribe`.
			alice.send({ type: 'cursor-snapshot', topic: ROOM });
			bob.send({ type: 'cursor-snapshot', topic: ROOM });
			expect(
				await alice.waitFor((p) => p && p.topic === CURSOR_TOPIC, 4000),
				'alice never joined the cursor lane'
			).not.toBeNull();

			// Only bob moves, so every position alice observes is his.
			const final = { x: 4242, y: 777 };
			for (let i = 0; i < 30; i++) bob.send({ type: 'cursor', topic: ROOM, data: { x: i, y: i } });
			bob.send({ type: 'cursor', topic: ROOM, data: final });

			const last = await settle(
				() => cursorPositions(alice).at(-1),
				(p) => p && p.x === final.x && p.y === final.y,
				6000
			);
			expect(last, 'the cursor lane never converged on the last position bob sent').toMatchObject(final);
			// Coalescing is the point: a lane that delivered all 31 frames would
			// not be the shipped one, so pin that it collapsed rather than leaving
			// the burst size unexamined.
			expect(cursorPositions(alice).length).toBeLessThan(31);
		} finally {
			alice.close();
			bob.close();
		}
	}, 60000);

	it('delivers every update while the worker is publishing an unrelated flood', async () => {
		// The clean path passes even on a build that drops frames under pressure,
		// which is how .93 shipped. This arm keeps the same delivery assertion but
		// runs it while the worker fans out unrelated traffic, so the presence lane
		// competes for the same send path instead of owning an idle server.
		const alice = await connect('alice-load');
		const bob = await connect('bob-load');
		const noisy = [];
		try {
			expect(await joinRoom(alice)).not.toBeNull();
			expect(await joinRoom(bob)).not.toBeNull();
			await settle(() => observedJoins(alice), (s) => s.has('bob-load'));

			// Background load on a DIFFERENT topic, so it shares the worker and the
			// socket path without touching the presence roster under assertion.
			for (let i = 0; i < 6; i++) noisy.push(await connect('noise-' + i));
			for (const n of noisy) n.send({ type: 'subscribe', topic: 'flood' });
			let flooding = true;
			const flood = (async () => {
				const payload = { type: 'broadcast', topic: 'flood', event: 'tick', payload: { blob: 'x'.repeat(512) } };
				while (flooding) {
					for (const n of noisy) { try { n.send(payload); } catch { /* closing */ } }
					await new Promise((r) => setTimeout(r, 1));
				}
			})();

			const sent = ['load-a', 'load-b', 'load-c', 'load-d', 'load-e', 'load-f', 'load-g', 'load-h'];
			for (const status of sent) {
				bob.send({ type: 'presence-update', topic: ROOM, fields: { status } });
				await settle(() => observedStatuses(alice), (s) => s.includes(status), 6000);
			}
			flooding = false;
			await flood;

			expect(observedStatuses(alice), 'a presence update was lost while the worker was under load').toEqual(sent);
		} finally {
			for (const n of noisy) n.close();
			alice.close();
			bob.close();
		}
	}, 90000);
});
