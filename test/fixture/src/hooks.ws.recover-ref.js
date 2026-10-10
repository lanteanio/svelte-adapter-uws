const resumed = new WeakMap();

export function resume(ws, { platform, lastSeenSeqs }) {
	const topics = Object.keys(lastSeenSeqs);
	const previous = resumed.get(ws) || [];
	previous.push(...topics);
	resumed.set(ws, previous);
	platform.send(ws, 'probe', 'history', { topics, value: 'private-history' });
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type !== 'probe') return;
	// Batch authorization and resume continuations settle before this turn.
	await new Promise((resolve) => setImmediate(resolve));
	platform.send(ws, 'probe', 'state', {
		nonce: msg.nonce,
		held: msg.topics.map((topic) => ws.isSubscribed(topic)),
		resumed: resumed.get(ws) || []
	});
}
