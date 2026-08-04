// Fixture handler for the resume gap-fill flush against a buried connection.
//
// The flush that gap-fills a recovered topic can find the connection past
// maxBackpressure and be unable to deliver even the truncation marker. Its only
// honest answer then is to close the connection - and uWS invalidates the
// socket inside that close, while the subscribe lane that called the flush is
// still mid-flight. Everything that lane does next (the shared-cohort join
// reads getUserData, the ack sends) would touch a dead socket and throw into an
// un-awaited async callback, which is an unhandled rejection and takes the
// whole worker down.
//
// Three things have to be real for that to be observable, and no existing
// variant provides them together:
//
//  1. The `resume` hook must genuinely SUSPEND, so the capture window stays
//     open and live publishes land in the buffer instead of on the wire. The
//     recover variant's hook is synchronous and says so - its capture never
//     holds anything.
//  2. Publishes large enough, while that window is open, to bury a client that
//     has stopped reading. The flush pushes every held frame in ONE synchronous
//     loop, so nothing drains until it is over - volume is the only lever.
//  3. A liveness probe a SECOND connection can use, because the failure under
//     test kills the worker rather than the connection being flushed.

const RELEASE = '__spillRelease';

// Close codes this worker has seen, newest last. The flushed connection cannot
// report its own close: it is buried under the very backpressure that caused it,
// so its close FRAME never reaches the client and the client only ever observes
// an abnormal 1006. The server's own close hook is the one place the real code
// is visible, and a bystander reads it back from here.
const closeCodes = [];

// Its EXISTENCE opens the recover lane; its SUSPENSION is what makes the
// capture window real. It reports nothing covered, so the flush applies the
// pre-window floor and every held frame is eligible.
export function resume(ws) {
	const ud = ws.getUserData();
	return new Promise((resolve) => { ud[RELEASE] = () => resolve(undefined); });
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());

	// Fill the open capture window. `seq: false` leaves every held frame
	// unsequenced, so none can be skipped as already-covered and the flush has
	// to attempt all of them - the test is about what happens when it cannot.
	if (msg.type === 'spill') {
		// Mark the topic SHARED first. A shared stateless codec fans out through
		// cohort topics, so the subscribe lane cohorts each new joiner as it
		// lands - and that is the line which reads ws.getUserData() straight
		// after the gap-fill flush. Without a shared topic the lane skips it and
		// a flush that closed the connection is survivable by luck, which is
		// exactly why the defect could ship: the crash needs a shared fan-out
		// topic, and shared fan-out is what high-rate traffic uses, which is also
		// what produces the backpressure in the first place.
		platform.publishWire(msg.topic, 'shared-init', { n: 0 }, {
			capability: 'fixture.spill:1', schemaVersion: 1, shared: true, encode: () => null
		});
		const payload = 'x'.repeat(msg.bytes);
		for (let i = 0; i < msg.count; i++) {
			platform.publish(msg.topic, 'tick', { i, payload }, { seq: false });
		}
		platform.send(ws, 'probe', 'spilled', { count: msg.count });
	}

	if (msg.type === 'release') {
		const ud = ws.getUserData();
		const fn = ud[RELEASE];
		ud[RELEASE] = null;
		fn?.();
	}

	// The liveness read, carrying a caller-supplied nonce because the client
	// helper scans the whole frame history - an un-correlated probe asked twice
	// reads its own first answer back and the assertion goes vacuous.
	if (msg.type === 'alive') {
		platform.send(ws, 'probe', 'alive', { nonce: msg.nonce });
	}

	// What the worker saw close, and with which code. 1013 is reachable from
	// nowhere in this runtime except the gap-fill flush giving up, so reading it
	// here is what proves the flush took that path rather than the connection
	// having died some other way.
	if (msg.type === 'closes') {
		platform.send(ws, 'probe', 'closes', { nonce: msg.nonce, codes: closeCodes.slice() });
	}
}

export function close(ws, ctx) {
	closeCodes.push(ctx.code);
}
