import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

const cursors = createCursor({
	throttle: 0,
	topicThrottle: 16,
	select: (userData) => ({ name: userData.token || 'anon' })
});

// Test-only init probe: when ACCEPTOR_INIT_PROBE=1 the per-worker init hook logs a
// marker so the acceptor-init integration test can prove that a clustered acceptor
// worker runs its init BEFORE the primary starts serving (a no-op otherwise).
export function init({ platform }) {
	if (process.env.ACCEPTOR_INIT_PROBE === '1') {
		console.log(`__ACCEPTOR_INIT_RAN__ connections=${platform.connections}`);
	}
}

// Exporting this is what makes the adapter register the auth preflight route
// (`connect({ auth: true })` POSTs it before upgrading), so it is required for
// any test of that endpoint. Accepts everything: the tests here are about the
// door in front of the hook, not about the hook's own decision.
export function authenticate() {
	return { userId: 'fixture-user' };
}

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
	if (msg.type === 'revoke-topic') {
		// Server-side revocation, the shape a kick / ban / lease expiry uses. Lets
		// a test prove that revoking a topic also releases the observer taps
		// derived from it (the cursor and presence channels), against the real
		// runtime rather than against the in-process mirror.
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
	}
	if (msg.type === 'tap-count') {
		// Server-visible membership for any topic, including the `__`-prefixed
		// derived ones a client can never name in a subscribe frame.
		// The nonce is echoed because the test client's frame matcher rescans every
		// frame it has received: without it, a poll would keep matching the FIRST
		// answer for a topic and never observe the value changing.
		platform.send(ws, 'probe', 'tap-count', {
			topic: msg.topic,
			nonce: msg.nonce,
			count: platform.subscribers(msg.topic)
		});
	}
	if (msg.type === 'cork-test') {
		ws.cork(() => {
			platform.send(ws, 'test-topic', 'corked', msg.payload);
		});
	}
	if (msg.type === 'publish-except-me') {
		// Sender-excluded publish through the wire path. The codec declines
		// every frame, so each subscriber receives the plain JSON envelope -
		// except the sender, which the exclusion withholds it from on every
		// platform implementation. `exclude: false` is the unexcluded control.
		platform.publishWire(
			msg.topic || 'test-topic',
			msg.event || 'poke',
			msg.payload,
			{ capability: 'fixture.unused:1', schemaVersion: 1, encode: () => null },
			msg.exclude === false ? undefined : { excludeWs: ws }
		);
	}
}

export function close(ws, ctx) {
	cursors.hooks.close(ws, ctx);
	ctx.platform.publish('test-topic', 'disconnected', { code: ctx.code });
}
