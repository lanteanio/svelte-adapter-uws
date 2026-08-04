// The resume gap-fill flush kept pushing into a socket that was refusing every
// frame, and told the client nothing.
//
// uWS answers a send past maxBackpressure with the DROPPED sentinel (2). It does
// NOT throw, so a loop that only caught throws saw nothing wrong: a slow
// consumer resuming a large window crossed its limit partway through, every
// remaining frame was handed to a socket discarding it, each was charged to
// bytesOut on the next line as though delivered, and the client then received
// the `resumed` ack and went live believing it was caught up - with a hole in
// the middle it has no way to detect.
//
// The rest of this runtime already pattern-matches that sentinel (the wire lanes
// branch on `result === 2` and degrade), and the overflow branch directly above
// the flush already shows the answer for an uncoverable hole: emit the
// `__replay:<topic>` truncated marker so the client drops its stale offset and
// cold-resyncs. This pins the mid-flush refusal onto the same behaviour.
//
// Driven against the SHIPPED flushResumeTopic with a scripted socket, because a
// real socket cannot be asked to refuse on cue - the same reason the wire
// suites script connections rather than negotiate real backpressure.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const TOPIC = 'resume-refusal-probe';

// Reached through the built runtime rather than src/: the source modules read a
// build-time define, so the fixture build IS the shipped code here.
let beginResumeCapture;
let flushResumeTopic;
let captureResumeFrame;
let resumeBuffers;

/**
 * A socket that accepts `acceptCount` sends and then refuses everything, the
 * way uWS does once a connection is past maxBackpressure - and that INVALIDATES
 * ITSELF on end(), which is the half that matters here.
 *
 * uWS fires the close handler inside end() and every later access throws
 * ('Invalid access of closed uWS.WebSocket'). A scripted socket that stays
 * usable afterwards validates the close path in a world where closing is free,
 * so a caller reading the socket after the flush closed it looks fine here and
 * takes the worker down in production.
 */
function refusingWs(acceptCount) {
	const sent = [];
	const closed = [];
	let dead = false;
	const alive = () => {
		if (dead) throw new Error('Invalid access of closed uWS.WebSocket.');
	};
	return {
		sent,
		closed,
		get dead() { return dead; },
		getUserData() { alive(); return {}; },
		send(payload) {
			alive();
			sent.push(String(payload));
			return sent.length <= acceptCount ? 1 : 2;
		},
		end(code, reason) { alive(); closed.push({ code, reason }); dead = true; }
	};
}

function fill(count) {
	for (let i = 1; i <= count; i++) {
		captureResumeFrame(TOPIC, i, '{"topic":"' + TOPIC + '","event":"tick","seq":' + i + '}', false);
	}
}

const markers = (ws) => ws.sent.filter((s) => s.includes('"__replay:' + TOPIC + '"'));
const frames = (ws) => ws.sent.filter((s) => !s.includes('__replay:'));

describeUWS('resume gap-fill flush against a refusing socket', () => {
	let server;

	beforeAll(async () => {
		server = await startRealRuntime();
		({ beginResumeCapture, flushResumeTopic } = await import('./fixture/build/handler/resume-buffer.js'));
		({ captureResumeFrame, resumeBuffers } = await import('./fixture/build/handler/state.js'));
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	beforeEach(() => {
		resumeBuffers.delete(TOPIC);
	});

	it('stops at the first refusal instead of pushing the rest into the void', () => {
		const ws = refusingWs(3);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(10);

		flushResumeTopic(handle, TOPIC, 0);

		// Three accepted, the fourth refused, and then it stops - it does not
		// hand the remaining six to a socket that is discarding them.
		expect(frames(ws).length, 'kept sending past the refusal').toBe(4);
	});

	it('tells the client the window is incomplete, so it cold-resyncs', () => {
		const ws = refusingWs(3);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(10);

		flushResumeTopic(handle, TOPIC, 0);

		// The client drops its stale per-topic offset on this marker; without it
		// the client goes live believing it is caught up.
		expect(markers(ws).length, 'no truncation signal after a partial flush').toBe(1);
		expect(markers(ws)[0]).toContain('"event":"truncated"');
	});

	it('closes the connection when even the truncation signal is refused', () => {
		// Refuse everything: there is no way to tell this client it has a hole.
		const ws = refusingWs(0);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(4);

		flushResumeTopic(handle, TOPIC, 0);

		// Staying connected is the one outcome that leaves the client silently
		// wrong. A reconnect resumes from the last seq it actually received, so
		// the missed tail is re-delivered rather than lost.
		expect(ws.closed.length, 'left the client connected and silently behind').toBe(1);
		// A RETRY-class code: 1008/4401/4403 are terminal to the client and would
		// stop it reconnecting, which would turn a recoverable hole into a dead
		// connection.
		expect([1008, 4401, 4403]).not.toContain(ws.closed[0].code);
		expect(ws.closed[0].code).toBe(1013);
	});

	it('does not signal or close when every frame is accepted', () => {
		const ws = refusingWs(Infinity);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(5);

		flushResumeTopic(handle, TOPIC, 0);

		expect(frames(ws).length).toBe(5);
		expect(markers(ws).length, 'signalled truncation on a complete flush').toBe(0);
		expect(ws.closed.length, 'closed a healthy connection').toBe(0);
	});

	it('does not send a second marker when the window already overflowed', () => {
		const ws = refusingWs(1);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(4);
		// The overflow branch signals BEFORE the flush; a refusal during that
		// flush must not repeat the signal the client already has.
		handle.entries[0].buffer.overflow = true;

		flushResumeTopic(handle, TOPIC, 0);

		expect(markers(ws).length).toBe(1);
	});

	// The close is only half the answer. uWS invalidates the socket inside end(),
	// so the flush has to TELL its caller - the subscribe lane goes on to read
	// getUserData() for the shared-cohort join and to send the ack, and on a dead
	// socket both throw into an un-awaited async callback, which kills the worker
	// and every other connection on it.
	it('reports the close to its caller, so no caller touches a dead socket', () => {
		const ws = refusingWs(0);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(4);

		const unusable = flushResumeTopic(handle, TOPIC, 0);

		expect(unusable, 'closed the connection but told the caller nothing').toBe(true);
		expect(ws.dead).toBe(true);
		// Exactly what the caller does next, and what it would get for it.
		expect(() => ws.getUserData()).toThrow(/closed uWS/);
	});

	it('reports nothing to the caller when the connection survives', () => {
		const ws = refusingWs(Infinity);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(5);

		expect(flushResumeTopic(handle, TOPIC, 0), 'a healthy flush must not stop the caller').toBe(false);
	});

	it('escalates when the overflow marker itself is dropped', () => {
		// Refusing from the very first byte is the case that most needs the
		// escalation, and it was the one case that skipped it: the overflow branch
		// recorded the marker as signalled without reading its send result, so the
		// client went live with a hole it was never told about.
		const ws = refusingWs(0);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(4);
		handle.entries[0].buffer.overflow = true;

		const unusable = flushResumeTopic(handle, TOPIC, 0);

		expect(ws.closed.length, 'left the client live with an unsignalled hole').toBe(1);
		expect(ws.closed[0].code).toBe(1013);
		expect(unusable).toBe(true);
	});

	it('escalates on a dropped overflow marker even when the flush sends nothing', () => {
		// Every captured frame is already covered by the resume, so the flush loop
		// sends nothing and never discovers the refusal on its own. The overflow
		// still has to reach the client, and it did not.
		const ws = refusingWs(0);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(3);
		handle.entries[0].buffer.overflow = true;

		const unusable = flushResumeTopic(handle, TOPIC, 99);

		expect(ws.closed.length, 'a dropped overflow marker went unnoticed on an empty flush').toBe(1);
		expect(unusable).toBe(true);
	});

	it('does not call end() on a socket that is already gone', () => {
		// A send that THROWS means the socket has already closed under us - there
		// is nothing left to signal to and nothing left to close. Reporting it as
		// unusable is still correct, because the caller must not touch it either.
		const ws = refusingWs(Infinity);
		const handle = beginResumeCapture([TOPIC], ws);
		fill(3);
		ws.end(1000, 'gone');
		ws.closed.length = 0;

		const unusable = flushResumeTopic(handle, TOPIC, 0);

		expect(ws.closed.length, 'called end() on an already-closed socket').toBe(0);
		expect(unusable, 'let the caller keep using a socket that had gone').toBe(true);
	});
});
