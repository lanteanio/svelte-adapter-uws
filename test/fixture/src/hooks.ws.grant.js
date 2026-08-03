// Fixture handler for the armed wire-subscribe variant.
//
// The exported `subscribe` below wraps a real groups-plugin side-effect hook
// and preserves its marker. It therefore exercises a plugin-owned namespace
// without taking the topic decision back from the server-grant model or
// disarming the armed gate.

import { createGroup } from 'svelte-adapter-uws/plugins/groups';

const group = createGroup('policy-lobby');
const delayed = new WeakMap();
const pluginSubscribe = group.hooks.subscribe;
const subscriptionsSlot = Symbol.for('adapter-uws.ws.subscriptions');

async function subscribe(ws, topic, { platform }) {
	platform.send(ws, 'probe', 'hook-entered', { topic });
	if (topic === 'delayed-room') {
		const gate = delayed.get(ws);
		if (gate) await gate.promise;
		return;
	}
	return pluginSubscribe(ws, topic, { platform });
}

// Preserve the plugin hook's side-effect-only marker. The instrumented hook
// must not turn into an app authorization hook and disarm the policy under test.
for (const symbol of Object.getOwnPropertySymbols(pluginSubscribe)) {
	Object.defineProperty(subscribe, symbol, Object.getOwnPropertyDescriptor(pluginSubscribe, symbol));
}

export { subscribe };
export const unsubscribe = group.hooks.unsubscribe;
export const close = group.hooks.close;

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
	if (msg.type === 'cap-probe') {
		const subscriptions = ws.getUserData()?.[subscriptionsSlot];
		if (!(subscriptions instanceof Set)) throw new Error('cap probe has no subscription Set');
		Object.defineProperty(subscriptions, 'size', { configurable: true, value: msg.size });
		let denial;
		try { denial = await platform.subscribe(ws, msg.topic); }
		finally { delete subscriptions.size; }
		platform.send(ws, 'probe', 'cap-result', {
			topic: msg.topic,
			denial: denial ?? null,
			held: subscriptions.has(msg.topic)
		});
	}
	// The OBSERVER lane, exposed so a differential can compare it across the
	// three surfaces. It has no second line of defence - the gate IS the answer -
	// and its decision survived every source-level check the project had,
	// because nothing drove it from a client.
	if (msg.type === 'observe-check') {
		const denial = await platform.checkSubscribe(ws, msg.topic, { requireGrant: true });
		platform.send(ws, 'probe', 'observe-result', { topic: msg.topic, ref: msg.ref, denial: denial ?? null });
	}
	if (msg.type === 'start-delayed-grant') {
		let release;
		const promise = new Promise((resolve) => { release = resolve; });
		delayed.set(ws, { promise, release });
		void platform.subscribe(ws, msg.topic).then((denial) => {
			platform.send(ws, 'probe', 'delayed-result', { topic: msg.topic, denial: denial ?? null });
		});
	}
	if (msg.type === 'revoke-delayed') {
		const revoked = platform.unsubscribe(ws, msg.topic);
		const gate = delayed.get(ws);
		gate?.release();
		delayed.delete(ws);
		platform.send(ws, 'probe', 'delayed-revoked', { topic: msg.topic, revoked });
	}
}
