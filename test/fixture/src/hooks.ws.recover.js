// Fixture handler for the recover-lane variant.
//
// The lane under test decides whether a `recover` request may be served the
// topic's replay history when a revocation landed while the authorization hook
// was parked. Two things have to be real for that decision to be observable:
//
//  1. The hook must genuinely SUSPEND, so the revocation lands in a real gap
//     rather than between two synchronous statements. See hooks.ws.park.js.
//  2. A `resume` hook must EXIST, because its presence is what opens the
//     recover lane at all. Announcing what it received gives the test a
//     positive reading - a suite that only asserted the absence of replay would
//     pass against a server that never ran the lane for any reason.
//
// The re-grant is the point of this variant. A revoke followed by a
// platform.subscribe inside one await window is a topic the connection
// legitimately holds again, so the history must still be served; the revocation
// epoch alone cannot express that, because it only ever rises.

const RELEASE = '__recoverRelease';
const RESUMED = '__recoverResumed';

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export function subscribeBatch(ws, topics, { platform }) {
	const ud = ws.getUserData();
	// PARK SELECTIVELY. platform.subscribe is routed through this same hook, so
	// parking unconditionally would deadlock the re-grant against the very park
	// it is supposed to land inside - the test would hang rather than fail, and
	// a hang is the hardest kind of red to read. Only topics the test marks are
	// parked; everything else, the re-grant included, resolves immediately.
	if (!topics.some((t) => t.startsWith('park-'))) return {};
	// A park is already outstanding on this connection, so this call IS the
	// re-grant landing inside the window. It must pass straight through:
	// parking it would suspend the re-grant behind the park it is meant to
	// interrupt, and the suite would hang instead of failing.
	if (ud[RELEASE]) return {};
	return new Promise((resolve) => {
		ud[RELEASE] = () => resolve({});
		platform.send(ws, 'probe', 'parked', { topics });
	});
}

// Its EXISTENCE opens the recover lane; what it records is the proof the lane
// ran. The runtime hands it the topics it decided were still recoverable.
//
// RECORDED ON THE CONNECTION as well as sent, so the suite can assert a
// server-side fact that does not depend on frame delivery or ordering. The
// record and the frame are two reads of the SAME fact - that this hook ran -
// not independent confirmations, and neither exercises the runtime's real
// replay flush: this hook is synchronous, so the capture never holds anything.
// A backend-backed gap-fill is a different test than this file.
export function resume(ws, { lastSeenSeqs, platform }) {
	const ud = ws.getUserData();
	const seen = ud[RESUMED] || (ud[RESUMED] = []);
	const topics = Object.keys(lastSeenSeqs || {});
	for (const t of topics) seen.push(t);
	// A real backend delivers the missed tail from here. Sending one frame
	// stands in for that, so a suite can assert the CLIENT received something
	// rather than only that the server ran the hook - the difference between
	// proving the gap-fill happened and proving a flag was set.
	platform.send(ws, 'probe', 'replayed', { topics });
	return undefined;
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());

	// Server-side revocation, landed while the hook above is parked.
	if (msg.type === 'revoke') {
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
	}

	// The re-grant: the same topic handed back inside the same window.
	if (msg.type === 'regrant') {
		let ok = false;
		try { ok = (await platform.subscribe(ws, msg.topic)) !== false; } catch { ok = false; }
		platform.send(ws, 'probe', 'regranted', { topic: msg.topic, ok });
	}

	if (msg.type === 'release') {
		const ud = ws.getUserData();
		const fn = ud[RELEASE];
		ud[RELEASE] = null;
		fn?.();
	}

	// Membership as the SERVER sees it. A frame alone would still be satisfied
	// by a runtime that answered the client one thing and did another.
	// Which topics the recover lane actually handed the resume hook, read back
	// after the window has closed so no capture can swallow the answer.
	if (msg.type === 'resumed-topics') {
		const ud = ws.getUserData();
		platform.send(ws, 'probe', 'resumed-topics', { topics: (ud[RESUMED] || []).slice() });
	}

	if (msg.type === 'count') {
		platform.send(ws, 'probe', 'count', { topic: msg.topic, count: platform.subscribers(msg.topic) });
	}
}
