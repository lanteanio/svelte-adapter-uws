// The resume gap-fill flush giving up on a buried connection, driven end to end
// against the REAL built runtime with a real socket earning a real refusal.
//
// WHY THIS EXISTS. The flush reads uWS's DROPPED sentinel and, when even the
// truncation marker is refused, closes the connection so the client reconnects
// and resumes from what it actually received. Nothing covered that path against
// a real socket: the unit suite beside this one scripts the refusal, which is
// the only way to refuse on cue, but a scripted socket proves only that the
// branch runs - not that a real uWS connection ever reaches it. Here the
// backpressure is real (a client that stops reading, against a 4 KiB
// maxBackpressure), so the whole chain is exercised: capture window, held
// frames, refusal partway, refused marker, close.
//
// WHAT IT ASSERTS, and why from two connections. The flushed client cannot
// report its own close: its close FRAME is queued behind the megabytes that
// caused the refusal, so it only ever observes an abnormal 1006. The server's
// close hook is where the real code is visible, and 1013 is reachable from
// nowhere else in this runtime - so a bystander reads it back, and that is the
// positive proof the give-up path ran. The bystander also answers before the
// spill as its own control, so a silent bystander cannot be mistaken for a probe
// that never worked, and it answers after as a standing guard that one buried
// consumer does not cost the worker.
//
// A NOTE ON WHAT THIS DOES NOT SHOW, because it was originally written to show
// it. uWS keeps `getUserData` working after `end()` and only throws on `send`
// (measured against the bundled 20.69.0), and both sites the subscribe lane
// touches afterwards - joinSharedCohort and sendSubscribed - already guard every
// socket call. So the post-close continuation is wasted bookkeeping and a
// misleading closed-socket abort, not a crash. The caller stops anyway because
// that is the honest answer; do not read this file as pinning a worker kill.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const TOPIC = 'resume-spill-room';

// Enough held bytes to bury a paused reader. The flush pushes all of them in one
// synchronous loop, so the kernel socket buffer is the only thing absorbing them
// and it does not drain until the loop is over.
const SPILL_FRAMES = 160;
const SPILL_BYTES = 32 * 1024;

describeUWS('a resume flush that closes its connection (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {Awaited<ReturnType<typeof connectRealClient>>[]} */
	const clients = [];

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'resumespill',
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

	/**
	 * Round-trip a nonce. The client helper scans the whole frame history, so a
	 * probe asked twice on one connection needs a correlator or the second read
	 * resolves with the first answer.
	 */
	async function answers(c, nonce) {
		c.send({ type: 'alive', nonce });
		const frame = await c.waitFor((f) => f?.event === 'alive' && f.data?.nonce === nonce, 3000);
		return frame !== null;
	}

	/** Close codes this worker has seen, read from the server's own close hook. */
	async function closeCodes(c, nonce) {
		c.send({ type: 'closes', nonce });
		const frame = await c.waitFor((f) => f?.event === 'closes' && f.data?.nonce === nonce, 3000);
		expect(frame, 'the close-code probe must answer').not.toBeNull();
		return frame.parsed.data.codes;
	}

	it('gives up with a 1013 the server can account for, and keeps serving everyone else', async () => {
		const bystander = await client();
		// Control: the probe works and this connection is being served, so a
		// silent bystander later means the worker died rather than that the
		// assertion never had a chance.
		expect(await answers(bystander, 'before'), 'the liveness probe never worked').toBe(true);

		const victim = await client();
		/** @type {number[]} */
		const victimClose = [];
		victim.ws.on('close', (code) => { victimClose.push(code); });
		// Open the capture window. The resume hook suspends until released, so
		// everything published below is held in the buffer rather than sent.
		victim.send({ type: 'subscribe', topic: TOPIC, ref: 1, recover: { offset: 0 } });
		victim.send({ type: 'spill', topic: TOPIC, count: SPILL_FRAMES, bytes: SPILL_BYTES });
		const spilled = await victim.waitFor((f) => f?.event === 'spilled', 20000);
		expect(spilled, 'the fixture never filled the capture window').not.toBeNull();

		// Stop reading, so the held frames have nowhere to go. Releasing the hook
		// now runs the flush against a socket that goes past maxBackpressure
		// partway through: the rest of the frames are refused, the truncation
		// marker is refused too, and the flush closes the connection - which is
		// the moment the caller must not touch it again.
		victim.ws._socket.pause();
		victim.send({ type: 'release' });

		// Give the release, the flush and the close time to run.
		await new Promise((r) => setTimeout(r, 1000));

		// Start reading again so the queued bytes drain and the socket settles.
		victim.ws._socket.resume();
		for (let i = 0; i < 100 && victimClose.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		// The victim only ever observes 1006: its close FRAME was queued behind
		// the megabytes that caused the refusal, so it never arrives. The server's
		// own close hook is where the real code is visible, and 1013 is reachable
		// from nowhere in this runtime except the gap-fill flush giving up - so
		// this is what proves the refusal path was taken rather than the socket
		// having died some other way.
		expect(await closeCodes(bystander, 'codes'), 'the flush never reached its close-and-report path').toContain(1013);

		expect(
			await answers(bystander, 'after'),
			'burying one consumer cost the worker every other connection on it'
		).toBe(true);
	}, 90000);
});
