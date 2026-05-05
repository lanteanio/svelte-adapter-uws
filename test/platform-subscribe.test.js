// Tests for platform.subscribe / platform.unsubscribe.
//
// These methods exist so server-side code (RPC handlers, framework
// integration layers, plugins) can subscribe a connection on the user's
// behalf and inherit the centralized hooks.ws.subscribe authorization
// gate. Calling ws.subscribe(topic) directly bypasses the gate -- the
// wire-level subscribe hook fires only for {type:'subscribe'} wire frames.
// These tests verify both halves of that contract: platform.subscribe
// runs the hook, ws.subscribe direct does not.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => { frames.push(data.toString()); });
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, frames };
}

describeUWS('platform.subscribe / platform.unsubscribe', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('platform.subscribe runs the user subscribe hook and gates the actual subscription', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		const hookCalls = [];

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe(_ws, topic) {
					hookCalls.push(topic);
					if (topic === 'admin:secret') return 'FORBIDDEN';
					if (topic === 'audit:trail') return 'UNAUTHENTICATED';
					return undefined;
				}
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));
		expect(capturedWs).not.toBeNull();

		// Allowed topic
		expect(server.platform.subscribe(capturedWs, 'public:feed')).toBeNull();
		expect(hookCalls).toContain('public:feed');
		expect(server.platform.subscribers('public:feed')).toBe(1);

		// Hook returns false / string -> denial reason flows through unchanged
		expect(server.platform.subscribe(capturedWs, 'admin:secret')).toBe('FORBIDDEN');
		expect(server.platform.subscribers('admin:secret')).toBe(0);

		expect(server.platform.subscribe(capturedWs, 'audit:trail')).toBe('UNAUTHENTICATED');
		expect(server.platform.subscribers('audit:trail')).toBe(0);

		client.close();
	});

	it('platform.subscribe is idempotent and does not re-run the hook on second call for same topic', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let hookCallCount = 0;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { hookCallCount++; return undefined; }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'feed')).toBeNull();
		expect(hookCallCount).toBe(1);
		expect(server.platform.subscribers('feed')).toBe(1);

		// Second call: hook must NOT fire again, count must NOT double-charge.
		expect(server.platform.subscribe(capturedWs, 'feed')).toBeNull();
		expect(hookCallCount).toBe(1);
		expect(server.platform.subscribers('feed')).toBe(1);

		client.close();
	});

	it('platform.subscribe rejects malformed topics with INVALID_TOPIC and does not call the hook', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let hookCallCount = 0;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { hookCallCount++; return undefined; }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, '')).toBe('INVALID_TOPIC');
		expect(server.platform.subscribe(capturedWs, '\n')).toBe('INVALID_TOPIC');
		expect(hookCallCount).toBe(0);

		client.close();
	});

	it('platform.subscribe wires the connection into the publish broadcast path', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;

		server = await createTestServer({
			handler: { open(ws) { capturedWs = ws; } }
		});

		const { ws: client, frames } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'broadcast')).toBeNull();
		const before = frames.length;
		server.platform.publish('broadcast', 'tick', { n: 1 });
		await new Promise(r => setTimeout(r, 30));

		const newFrames = frames.slice(before).map((f) => JSON.parse(f));
		const ticks = newFrames.filter((f) => f.event === 'tick');
		expect(ticks).toHaveLength(1);
		expect(ticks[0].data.n).toBe(1);

		client.close();
	});

	it('platform.unsubscribe removes the subscription and fires the unsubscribe hook', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		const unsubscribeCalls = [];

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				unsubscribe(_ws, topic) { unsubscribeCalls.push(topic); }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		server.platform.subscribe(capturedWs, 'feed');
		expect(server.platform.subscribers('feed')).toBe(1);

		expect(server.platform.unsubscribe(capturedWs, 'feed')).toBe(true);
		expect(server.platform.subscribers('feed')).toBe(0);
		expect(unsubscribeCalls).toEqual(['feed']);

		// Idempotent: a second unsubscribe is a no-op and does not refire the hook.
		expect(server.platform.unsubscribe(capturedWs, 'feed')).toBe(false);
		expect(unsubscribeCalls).toEqual(['feed']);

		client.close();
	});

	it('routes through subscribeBatch when subscribe is not exported (closes single-frame ungated path)', async () => {
		// Pre-fix bug: a user who exports only `subscribeBatch` for
		// centralized auth had their hook fire for batch frames but
		// silently bypassed for single subscribes -- the wire-level
		// single-subscribe path consulted only the per-topic hook. This
		// test pins the fix: batch hook is consulted with [topic] when
		// subscribe is not exported.
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		const batchCalls = [];

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch(_ws, topics) {
					batchCalls.push(topics.slice());
					const denials = {};
					for (const t of topics) {
						if (t.startsWith('admin')) denials[t] = 'FORBIDDEN';
					}
					return denials;
				}
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'public:feed')).toBeNull();
		expect(batchCalls).toEqual([['public:feed']]);

		expect(server.platform.subscribe(capturedWs, 'admin:secret')).toBe('FORBIDDEN');
		expect(batchCalls).toEqual([['public:feed'], ['admin:secret']]);
		expect(server.platform.subscribers('admin:secret')).toBe(0);

		client.close();
	});

	it('subscribeBatch decision wins when both hooks are exported', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let perTopicCalls = 0;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { perTopicCalls++; return undefined; },
				subscribeBatch(_ws, topics) {
					const denials = {};
					for (const t of topics) denials[t] = 'BATCH_DENIED';
					return denials;
				}
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'feed')).toBe('BATCH_DENIED');
		expect(perTopicCalls).toBe(0); // batch hook decided; per-topic was NOT consulted

		client.close();
	});

	it('fail-closed: throwing subscribe hook returns INTERNAL_ERROR, no subscription created', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { throw new Error('boom'); }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');
		expect(server.platform.subscribers('feed')).toBe(0);

		client.close();
	});

	it('fail-closed: throwing subscribeBatch hook denies every topic with INTERNAL_ERROR', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch() { throw new Error('boom'); }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');
		expect(server.platform.subscribers('feed')).toBe(0);

		client.close();
	});

	it('contract: ws.subscribe direct does NOT fire the wire-level subscribe hook (the bypass we are guarding against)', async () => {
		// This test documents the gap that platform.subscribe exists to
		// close. If ws.subscribe direct ever starts firing the hook, the
		// hook fires twice when we then call platform.subscribe -- the
		// idempotency test above catches that. Together the two pin the
		// contract: hook fires exactly once per (ws, topic) regardless of
		// how the subscribe arrived, ONLY when routed through the wire
		// frame OR platform.subscribe.
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let hookCallCount = 0;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { hookCallCount++; return undefined; }
			}
		});

		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		// Direct ws.subscribe call: the bypass path that motivated this fix.
		// uWS C++ TopicTree gets the subscription; our hook never sees it.
		capturedWs.subscribe('bypass:topic');
		expect(hookCallCount).toBe(0);

		// Subscriber count climbed (uWS knows about it) but our internal
		// WS_SUBSCRIPTIONS Set was NOT updated -- platform.subscribers uses
		// the uWS C++ count, so it includes the bypassed subscription.
		expect(server.platform.subscribers('bypass:topic')).toBe(1);

		client.close();
	});
});

describeUWS('platform.checkSubscribe', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('returns null when no hooks are exported', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({ handler: { open(ws) { capturedWs = ws; } } });
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();

		client.close();
	});

	it('returns null when subscribe hook returns undefined / true', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe(_ws, topic) { return topic === 'allow:explicit' ? true : undefined; }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'allow:implicit')).toBeNull();
		expect(server.platform.checkSubscribe(capturedWs, 'allow:explicit')).toBeNull();

		client.close();
	});

	it('returns FORBIDDEN when subscribe hook returns false', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { return false; }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBe('FORBIDDEN');

		client.close();
	});

	it('returns the verbatim string when subscribe hook returns a string', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { return 'CUSTOM_REASON'; }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBe('CUSTOM_REASON');

		client.close();
	});

	it('does not subscribe the connection (purely a gate, no state mutation)', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({ handler: { open(ws) { capturedWs = ws; } } });
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();
		expect(server.platform.subscribers('feed')).toBe(0); // no actual subscription

		client.close();
	});

	it('returns INVALID_TOPIC for malformed topics without invoking the hook', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let hookCalls = 0;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { hookCalls++; return undefined; }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, '')).toBe('INVALID_TOPIC');
		expect(hookCalls).toBe(0);

		client.close();
	});

	it('routes through subscribeBatch when only subscribeBatch is exported', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch(_ws, topics) {
					const denials = {};
					for (const t of topics) {
						if (t === 'admin') denials[t] = 'FORBIDDEN';
					}
					return denials;
				}
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'public')).toBeNull();
		expect(server.platform.checkSubscribe(capturedWs, 'admin')).toBe('FORBIDDEN');

		client.close();
	});

	it('returns null when subscribeBatch returns {} (topic absent from denial map)', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch() { return {}; }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();

		client.close();
	});

	it('subscribeBatch decision wins when both hooks are exported', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		let perTopicCalls = 0;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { perTopicCalls++; return undefined; },
				subscribeBatch(_ws, topics) {
					const denials = {};
					for (const t of topics) denials[t] = 'BATCH_DENIED';
					return denials;
				}
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBe('BATCH_DENIED');
		expect(perTopicCalls).toBe(0);

		client.close();
	});

	it('fail-closed: throwing subscribe hook returns INTERNAL_ERROR', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe() { throw new Error('boom'); }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');

		client.close();
	});

	it('fail-closed: throwing subscribeBatch hook returns INTERNAL_ERROR', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch() { throw new Error('boom'); }
			}
		});
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(server.platform.checkSubscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');

		client.close();
	});

	it('checkSubscribe and the wire-level subscribe-batch path agree on the same (ws, topic) decisions', async () => {
		// Load-bearing test: the gate must produce the same decision
		// regardless of which entry point invoked it. If the wire-level
		// path and platform.checkSubscribe ever diverge, an attacker could
		// pick the more permissive surface to slip past auth.
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribe(_ws, topic) {
					if (topic === 's:forbidden') return false;
					if (topic === 's:reason') return 'CUSTOM_S';
					return undefined;
				},
				subscribeBatch(_ws, topics) {
					const denials = {};
					for (const t of topics) {
						if (t.startsWith('b:forbidden')) denials[t] = 'FORBIDDEN';
						else if (t.startsWith('b:reason')) denials[t] = 'CUSTOM_B';
					}
					return denials;
				}
			}
		});
		const { ws: client, frames } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		// Test topics: a mix that exercises both hook return shapes.
		// subscribeBatch wins for all of them since it is exported.
		const cases = ['public', 'b:forbidden:1', 'b:reason:2', 'b:forbidden:3'];
		const checkDecisions = cases.map((t) => server.platform.checkSubscribe(capturedWs, t));

		// Drive the same topics via the wire-level subscribe-batch frame
		// and capture the denials returned by the server. Allowed topics
		// produce a `subscribed` frame; denied topics produce a
		// `subscribe-denied` frame.
		const beforeFrames = frames.length;
		client.send(JSON.stringify({ type: 'subscribe-batch', topics: cases, ref: 'consistency-1' }));
		await new Promise(r => setTimeout(r, 50));

		const newFrames = frames.slice(beforeFrames).map((f) => JSON.parse(f));
		const wireDecisionsByTopic = new Map();
		for (const f of newFrames) {
			if (f.type === 'subscribed') wireDecisionsByTopic.set(f.topic, null);
			else if (f.type === 'subscribe-denied') wireDecisionsByTopic.set(f.topic, f.reason);
		}
		const wireDecisions = cases.map((t) => wireDecisionsByTopic.get(t));

		expect(wireDecisions).toEqual(checkDecisions);

		client.close();
	});
});
