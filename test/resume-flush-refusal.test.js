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
 * way uWS does once a connection is past maxBackpressure.
 */
function refusingWs(acceptCount) {
	const sent = [];
	const closed = [];
	return {
		sent,
		closed,
		getUserData() { return {}; },
		send(payload) {
			sent.push(String(payload));
			return sent.length <= acceptCount ? 1 : 2;
		},
		end(code, reason) { closed.push({ code, reason }); }
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
});
