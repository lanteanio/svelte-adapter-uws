// Fixture for the subscribe-batch authorization-ordering defect.
//
// This is the documented presence wiring - `export const { subscribe, ... } =
// presence.hooks` - with the wire-subscribe grant gate ARMED. Presence's
// subscribe hook is a side effect rather than a decision and is marked as such,
// so the gate stays armed. That combination is exactly what makes the ordering
// bug reachable: the batch path used to run the hook for every valid topic and
// only consult the grant decision at the landing, so the hook's side effects -
// joining the roster, establishing the `__presence:` observer tap - had already
// happened for a topic the caller was then told FORBIDDEN about.
//
// The roster is echoed back over the socket on request. A test that asserted
// only the ABSENCE of roster traffic would pass against a server that produces
// no traffic at all, so what is asserted is a positive reading of who the
// server believes is on the topic.

import { createPresence } from 'svelte-adapter-uws/plugins/presence';

const presence = createPresence({
	select: (userData) => ({ name: userData.token || 'anon' })
});

export const { subscribe, unsubscribe, close } = presence.hooks;

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());

	// Server-initiated subscribe: the trusted path, and the only one that mints
	// a grant. A test grants one connection a topic and then proves a DIFFERENT
	// connection cannot reach it by naming it in a batch frame.
	if (msg.type === 'grant') {
		await platform.subscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'granted', { topic: msg.topic });
		return;
	}

	// Positive observation of the roster and of the derived observer tap. Under
	// the defect a caller that was denied still appears in both.
	if (msg.type === 'roster') {
		const members = presence.list(msg.topic).map((entry) => entry.name ?? null);
		members.sort();
		// The nonce is echoed because the test client's `waitFor` rescans every
		// frame received so far, so a second poll would otherwise keep matching
		// the FIRST roster reply and read a stale answer as the current one.
		platform.send(ws, 'probe', 'roster', {
			nonce: msg.nonce ?? null,
			topic: msg.topic,
			members,
			taps: platform.subscribers(`__presence:${msg.topic}`)
		});
	}
}
