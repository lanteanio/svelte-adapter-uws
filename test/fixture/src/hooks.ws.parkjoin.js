// Fixture handler for the parked hook-INSTALLS-membership variant.
//
// The revocation-during-a-parked-hook shape, produced honestly: the client
// subscribes a group channel; the app's authorization wrapper PARKS; a
// server-side revocation
// (platform.unsubscribe) lands while it is parked; the wrapper then releases
// INTO the group join, and joining installs tracked membership for the very
// topic in flight (trackedSubscribe inside the plugin's subscribe hook). The
// landing therefore finds the topic HELD - and must still honor the
// tombstone: answer FORBIDDEN and unwind the membership the revoked attempt
// installed, rather than acking the held topic.
//
// The park is real for the same reason as hooks.ws.park.js: without a hook
// that genuinely suspends, every await in the landing resolves within one
// microtask and no client frame can interleave a revocation inside the
// begin/settle window the test exists for.
//
// The resolver lives on the CONNECTION (userData), not a module slot - see
// hooks.ws.park.js for why a module global strands earlier connections.

import { createGroup } from 'svelte-adapter-uws/plugins/groups';

const lobby = createGroup('lobby');
const PARKED = '__parkJoinParked';

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export function subscribe(ws, topic, ctx) {
	// Only the group channel parks; anything else flows straight through.
	if (topic !== '__group:lobby') return lobby.hooks.subscribe(ws, topic, ctx);
	const ud = ws.getUserData();
	return new Promise((resolve) => {
		const queue = ud[PARKED] ?? (ud[PARKED] = []);
		// A bound rather than a single slot: the point of the queue is holding
		// two attempts open, but an unbounded one would hide a driver that
		// never releases.
		if (queue.length >= 4) throw new Error('park queue overflow: a driver is not releasing');
		queue.push((verdict) => resolve(verdict === 'deny' ? 'FORBIDDEN' : lobby.hooks.subscribe(ws, topic, ctx)));
		// Announce the open window so the driver lands its revocation inside it.
		ctx.platform.send(ws, 'probe', 'parked', { topics: [topic], depth: queue.length });
	});
}

export const unsubscribe = lobby.hooks.unsubscribe;
export const close = lobby.hooks.close;

export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());

	// Server-side revocation landed while the subscribe above is parked.
	if (msg.type === 'revoke') {
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
	}

	// Let this connection's OLDEST parked hook resolve, so its landing runs.
	// `verdict: 'deny'` makes that hook refuse instead of joining, which is how
	// a driver reproduces a ban becoming visible to a later attempt.
	if (msg.type === 'release') {
		const queue = ws.getUserData()[PARKED];
		queue?.shift()?.(msg.verdict);
	}

	// Membership as the RUNTIME sees it: a denial frame would also be emitted
	// by a runtime that answered the client and kept the subscription anyway.
	// The nonce is echoed back so a driver asking twice can tell the answers
	// apart: the client records every frame it ever received, and a probe
	// matched by shape alone finds the FIRST count frame in that history - a
	// baseline read taken before the behavior under test, compared against
	// itself.
	if (msg.type === 'count') {
		platform.send(ws, 'probe', 'count', { topic: msg.topic, count: platform.subscribers(msg.topic), nonce: msg.nonce });
	}

	// Membership as the PLUGIN sees it: the unwind must run the app's
	// unsubscribe hook, or the roster keeps a member the runtime dropped.
	// Nonce echoed for the same reason as the count probe.
	if (msg.type === 'group-count') {
		platform.send(ws, 'probe', 'group-count', { count: lobby.count(), nonce: msg.nonce });
	}
}
