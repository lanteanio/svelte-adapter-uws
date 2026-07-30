// Fixture handler for the parked-authorization variant.
//
// `subscribeBatch` PARKS until the client releases it, and that park is the
// whole point. The revocation tombstone only has an effect while a subscribe is
// genuinely in flight, and the batch path's awaits all resolve within a single
// microtask when no app hook is exported - far too soon for a second client
// frame, which arrives as a separate I/O event, to interleave. Without a hook
// that really suspends there is no window to land a revocation in, and a test
// would pass against a runtime that tombstones nothing.
//
// The hook denies nothing (an empty map means allow), so the ONLY thing that
// can stop a topic from landing is the revocation the test lands while it is
// parked.

// The resolver lives on the CONNECTION, not in a module-level slot. A module
// global is clobbered by the next connection to park, which strands the earlier
// promise: that batch's continuation never runs and its pending-subscribe entry
// survives until the socket dies. It also has a wider mouth than it looks -
// runUserSubscribeGate routes SINGLE subscribes and platform.subscribe through
// subscribeBatch too, so any future path that subscribes a second connection
// would park and clobber. userData is per-connection and stable across calls.
const RELEASE = '__parkRelease';

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export function subscribeBatch(ws, topics, { platform }) {
	const ud = ws.getUserData();
	return new Promise((resolve) => {
		// Two parks outstanding on ONE connection would strand the first for the
		// same reason. Fail loudly rather than silently: a rejection here is
		// caught by the runtime and denies the whole batch with INTERNAL_ERROR,
		// which is impossible to mistake for a passing test.
		if (ud[RELEASE]) throw new Error('park clobbered: a subscribe is already parked on this connection');
		ud[RELEASE] = () => resolve({});
		// Announce that the window is open, so the driver lands its revocation
		// inside it instead of guessing at a delay - a race here would silently
		// turn the whole assertion into a no-op.
		platform.send(ws, 'probe', 'parked', { topics });
	});
}

export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());

	// Server-side revocation landed while the batch above is parked.
	if (msg.type === 'revoke') {
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
	}

	// Let this connection's parked hook resolve, so the batch lands.
	if (msg.type === 'release') {
		const ud = ws.getUserData();
		const fn = ud[RELEASE];
		ud[RELEASE] = null;
		fn?.();
	}

	// Membership as the SERVER sees it, which is what a revocation has to have
	// actually prevented - a denial frame alone would still be satisfied by a
	// runtime that answered the client and subscribed it anyway.
	if (msg.type === 'count') {
		platform.send(ws, 'probe', 'count', { topic: msg.topic, count: platform.subscribers(msg.topic) });
	}
}
