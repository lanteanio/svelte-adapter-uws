const SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');
const closed = new Map();

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'arm') {
		const ud = ws.getUserData();
		ud.closeProbe = msg.id;
		if (msg.mode === 'valid') await platform.subscribe(ws, 'close:kept');
		else if (msg.mode === 'revoked') {
			const { proxy, revoke } = Proxy.revocable(new Set(), {});
			revoke();
			ud[SUBSCRIPTIONS] = proxy;
		} else if (msg.mode === 'prototype-trap') ud[SUBSCRIPTIONS] = new Proxy({}, { getPrototypeOf() { throw new Error('prototype trap'); } });
		else if (msg.mode === 'impostor') ud[SUBSCRIPTIONS] = Object.create(Set.prototype);
		else ud[SUBSCRIPTIONS] = msg.value;
		platform.send(ws, 'probe', 'armed', { id: msg.id });
		ws.end(1000, 'finished');
	} else if (msg.type === 'report') {
		platform.send(ws, 'probe', 'reported', { id: msg.id, closed: closed.get(msg.id), connections: platform.connections });
	}
}

export function close(ws, ctx) {
	const ud = ws.getUserData();
	if (!ud.closeProbe) return;
	const result = { isSet: ctx.subscriptions instanceof Set, same: ctx.subscriptions === ud[SUBSCRIPTIONS], topics: [], completed: false };
	closed.set(ud.closeProbe, result);
	for (const topic of ctx.subscriptions) result.topics.push(topic);
	result.completed = true;
}
