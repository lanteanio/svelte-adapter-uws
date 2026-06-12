import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

const cursors = createCursor({
	throttle: 0,
	topicThrottle: 16,
	select: (userData) => ({ name: userData.token || 'anon' })
});

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

export function message(ws, ctx) {
	// Cursor frames (cursor / cursor-snapshot / cursor-viewport) are claimed
	// by the plugin; everything else falls through to the echo handlers.
	if (cursors.hooks.message(ws, ctx)) return;
	const { data, platform } = ctx;
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

export function close(ws, ctx) {
	cursors.hooks.close(ws, ctx);
	ctx.platform.publish('test-topic', 'disconnected', { code: ctx.code });
}
