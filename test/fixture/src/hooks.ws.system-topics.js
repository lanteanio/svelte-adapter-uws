const calls = new WeakMap();

export function subscribe(ws, topic) {
	const seen = calls.get(ws) ?? [];
	seen.push(topic);
	calls.set(ws, seen);
	return topic.endsWith(':deny') ? 'FORBIDDEN' : undefined;
}

export async function message(ws, { data, platform }) {
	const { operation, topic } = JSON.parse(Buffer.from(data).toString());
	calls.set(ws, []);
	const denial = operation === 'check'
		? await platform.checkSubscribe(ws, topic)
		: await platform.subscribe(ws, topic);
	platform.publish(topic, 'delivery', { topic });
	platform.send(ws, 'probe', 'result', {
		denial, calls: calls.get(ws), subscribers: platform.subscribers(topic)
	});
}
