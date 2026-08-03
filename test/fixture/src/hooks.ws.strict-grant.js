// Hybrid authorization fixture for strict wire-subscribe policy. The
// application hook allows every topic; strict mode must still require the
// connection-specific server grant minted by platform.subscribe().

export function subscribe() {
	return undefined;
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type !== 'grant') return;
	const denial = await platform.subscribe(ws, msg.topic);
	platform.send(ws, 'probe', 'granted', { topic: msg.topic, denial: denial ?? null });
}
