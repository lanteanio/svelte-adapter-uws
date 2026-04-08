export function upgrade({ headers, cookies, url }) {
	const token = cookies?.token;
	if (token === 'reject') return false;
	if (token === 'error') throw new Error('auth error');
	return token ? { token } : {};
}

export function subscribe(ws, topic, { platform }) {
	// Exercise platform.subscribers() and ws wrapper methods
	platform.subscribers(topic);
	ws.isSubscribed(topic);
	ws.getTopics();
	ws.getBufferedAmount();
	ws.getRemoteAddressAsText();
}

export function open(ws, { platform }) {
	platform.publish('test-topic', 'connected', { ts: Date.now() });
	// Exercise platform.connections and topic() helpers
	const _ = platform.connections;
	const t = platform.topic('test-topic');
	t.increment(1);
	t.decrement(1);
}

export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'echo') {
		platform.send(ws, 'test-topic', 'echo', msg.payload);
	}
	if (msg.type === 'broadcast') {
		platform.publish(msg.topic || 'test-topic', msg.event || 'broadcast', msg.payload);
	}
	if (msg.type === 'sendto') {
		platform.sendTo(
			(ud) => ud.token === msg.token,
			msg.topic || 'test-topic',
			msg.event || 'dm',
			msg.payload
		);
	}
	if (msg.type === 'cork-test') {
		ws.cork(() => {
			platform.send(ws, 'test-topic', 'corked', msg.payload);
		});
	}
}

export function close(ws, { code, platform }) {
	platform.publish('test-topic', 'disconnected', { code });
}
