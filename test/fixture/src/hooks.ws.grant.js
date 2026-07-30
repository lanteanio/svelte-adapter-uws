// Fixture handler for the armed wire-subscribe variant.
//
// This module deliberately exports NO `subscribe` and NO `subscribeBatch`
// hook. When an app exports either, it owns the topic decision and the
// server-grant model steps aside - so a handler that exports one leaves an
// armed gate inert, and a test driving it would pass against a server that
// never denies anything. Keep the subscribe path hook-free here.

export function upgrade({ cookies }) {
	const token = cookies?.token;
	if (token === 'reject') return false;
	return token ? { token } : {};
}

// Echoes the topics the runtime actually handed the resume hook. Asserting on
// the ABSENCE of replay traffic would pass against a server with no resume hook
// at all, which is exactly what this fixture had; echoing the filtered list is
// what makes the grant filter observable.
export async function resume(ws, { lastSeenSeqs, platform }) {
	platform.send(ws, 'probe', 'resume-topics', { topics: Object.keys(lastSeenSeqs || {}) });
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	// Server-initiated subscribe: the trusted path that mints a grant. A test
	// grants one connection a topic and then proves a DIFFERENT connection
	// cannot reach that topic by naming it in a wire frame.
	if (msg.type === 'grant') {
		const denial = await platform.subscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'granted', { topic: msg.topic, denial: denial ?? null });
	}
	// The OBSERVER lane, exposed so a differential can compare it across the
	// three surfaces. It has no second line of defence - the gate IS the answer -
	// and its decision survived every source-level check the project had,
	// because nothing drove it from a client.
	if (msg.type === 'observe-check') {
		const denial = await platform.checkSubscribe(ws, msg.topic, { requireGrant: true });
		platform.send(ws, 'probe', 'observe-result', { topic: msg.topic, ref: msg.ref, denial: denial ?? null });
	}
}
