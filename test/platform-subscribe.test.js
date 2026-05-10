// Tests for platform.subscribe / platform.unsubscribe.
//
// These methods exist so server-side code (RPC handlers, framework
// integration layers, plugins) can subscribe a connection on the user's
// behalf and inherit the centralized hooks.ws.subscribe authorization
// gate. Calling ws.subscribe(topic) directly bypasses the gate - the
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
		expect(await server.platform.subscribe(capturedWs, 'public:feed')).toBeNull();
		expect(hookCalls).toContain('public:feed');
		expect(server.platform.subscribers('public:feed')).toBe(1);

		// Hook returns false / string -> denial reason flows through unchanged
		expect(await server.platform.subscribe(capturedWs, 'admin:secret')).toBe('FORBIDDEN');
		expect(server.platform.subscribers('admin:secret')).toBe(0);

		expect(await server.platform.subscribe(capturedWs, 'audit:trail')).toBe('UNAUTHENTICATED');
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

		expect(await server.platform.subscribe(capturedWs, 'feed')).toBeNull();
		expect(hookCallCount).toBe(1);
		expect(server.platform.subscribers('feed')).toBe(1);

		// Second call: hook must NOT fire again, count must NOT double-charge.
		expect(await server.platform.subscribe(capturedWs, 'feed')).toBeNull();
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

		expect(await server.platform.subscribe(capturedWs, '')).toBe('INVALID_TOPIC');
		expect(await server.platform.subscribe(capturedWs, '\n')).toBe('INVALID_TOPIC');
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

		expect(await server.platform.subscribe(capturedWs, 'broadcast')).toBeNull();
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

		await server.platform.subscribe(capturedWs, 'feed');
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
		// silently bypassed for single subscribes - the wire-level
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

		expect(await server.platform.subscribe(capturedWs, 'public:feed')).toBeNull();
		expect(batchCalls).toEqual([['public:feed']]);

		expect(await server.platform.subscribe(capturedWs, 'admin:secret')).toBe('FORBIDDEN');
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

		expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('BATCH_DENIED');
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

		expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');
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

		expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');
		expect(server.platform.subscribers('feed')).toBe(0);

		client.close();
	});

	it('contract: ws.subscribe direct does NOT fire the wire-level subscribe hook (the bypass we are guarding against)', async () => {
		// This test documents the gap that platform.subscribe exists to
		// close. If ws.subscribe direct ever starts firing the hook, the
		// hook fires twice when we then call platform.subscribe - the
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
		// WS_SUBSCRIPTIONS Set was NOT updated - platform.subscribers uses
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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();

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

		expect(await server.platform.checkSubscribe(capturedWs, 'allow:implicit')).toBeNull();
		expect(await server.platform.checkSubscribe(capturedWs, 'allow:explicit')).toBeNull();

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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBe('FORBIDDEN');

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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBe('CUSTOM_REASON');

		client.close();
	});

	it('does not subscribe the connection (purely a gate, no state mutation)', async () => {
		const { createTestServer } = await import('../testing.js');
		let capturedWs = null;
		server = await createTestServer({ handler: { open(ws) { capturedWs = ws; } } });
		const { ws: client } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();
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

		expect(await server.platform.checkSubscribe(capturedWs, '')).toBe('INVALID_TOPIC');
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

		expect(await server.platform.checkSubscribe(capturedWs, 'public')).toBeNull();
		expect(await server.platform.checkSubscribe(capturedWs, 'admin')).toBe('FORBIDDEN');

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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBeNull();

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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBe('BATCH_DENIED');
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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');

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

		expect(await server.platform.checkSubscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');

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
		const checkDecisions = await Promise.all(cases.map((t) => server.platform.checkSubscribe(capturedWs, t)));

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

	// Async-hook deny matrix. Pre-fix bug: a hook returning a Promise was
	// inspected synchronously; the Promise was truthy and not a string so
	// the framework treated the return as "allow". Every async hook
	// (typical for hooks that touch a session store / DB) silently let
	// every subscribe through. Each case here would have passed the
	// pre-fix code with the wrong shape; they pin the await behaviour.
	describe('async hook denial pinning', () => {
		it('platform.subscribe: async () => false denies with FORBIDDEN', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribe: async () => false
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('FORBIDDEN');
			expect(server.platform.subscribers('feed')).toBe(0);

			client.close();
		});

		it('platform.subscribe: async () => "CUSTOM" denies with CUSTOM', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribe: async () => 'CUSTOM_REASON'
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('CUSTOM_REASON');
			expect(server.platform.subscribers('feed')).toBe(0);

			client.close();
		});

		it('platform.subscribe: async () => { throw } denies with INTERNAL_ERROR', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribe: async () => { throw new Error('boom'); }
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');
			expect(server.platform.subscribers('feed')).toBe(0);

			client.close();
		});

		it('platform.subscribe: async () => true allows', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribe: async () => true
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'feed')).toBeNull();
			expect(server.platform.subscribers('feed')).toBe(1);

			client.close();
		});

		it('platform.subscribe: subscribeBatch async returning {topic:false} denies', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribeBatch: async (_ws, topics) => {
						const denials = {};
						for (const t of topics) if (t === 'private') denials[t] = false;
						return denials;
					}
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'private')).toBe('FORBIDDEN');
			expect(await server.platform.subscribe(capturedWs, 'public')).toBeNull();
			expect(server.platform.subscribers('private')).toBe(0);
			expect(server.platform.subscribers('public')).toBe(1);

			client.close();
		});

		it('platform.subscribe: subscribeBatch async throwing denies all with INTERNAL_ERROR', async () => {
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribeBatch: async () => { throw new Error('boom'); }
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, 'feed')).toBe('INTERNAL_ERROR');

			client.close();
		});

		it('wire subscribe frame: async () => false denies on the wire too', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({
				handler: {
					subscribe: async () => false
				}
			});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({ type: 'subscribe', topic: 'feed', ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const denied = newFrames.find((f) => f.type === 'subscribe-denied');
			expect(denied).toBeDefined();
			expect(denied.topic).toBe('feed');
			expect(denied.reason).toBe('FORBIDDEN');
			// The "subscribed" ack must NOT also have arrived.
			expect(newFrames.find((f) => f.type === 'subscribed')).toBeUndefined();
			expect(server.platform.subscribers('feed')).toBe(0);

			client.close();
		});

		it('wire subscribe-batch frame: async hook denies per-topic correctly', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({
				handler: {
					subscribeBatch: async (_ws, topics) => {
						const denials = {};
						for (const t of topics) if (t === 'private') denials[t] = false;
						return denials;
					}
				}
			});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({ type: 'subscribe-batch', topics: ['public', 'private'], ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const byTopic = new Map();
			for (const f of newFrames) byTopic.set(f.topic, f);

			expect(byTopic.get('public').type).toBe('subscribed');
			expect(byTopic.get('private').type).toBe('subscribe-denied');
			expect(byTopic.get('private').reason).toBe('FORBIDDEN');
			expect(server.platform.subscribers('public')).toBe(1);
			expect(server.platform.subscribers('private')).toBe(0);

			client.close();
		});

		it('wire subscribe frame: async per-topic fallback when no batch hook is exported', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({
				handler: {
					subscribe: async (_ws, topic) => topic === 'admin' ? false : true
				}
			});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({ type: 'subscribe-batch', topics: ['user', 'admin', 'feed'], ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const byTopic = new Map();
			for (const f of newFrames) byTopic.set(f.topic, f);

			expect(byTopic.get('user').type).toBe('subscribed');
			expect(byTopic.get('admin').type).toBe('subscribe-denied');
			expect(byTopic.get('admin').reason).toBe('FORBIDDEN');
			expect(byTopic.get('feed').type).toBe('subscribed');

			client.close();
		});

		it('platform.checkSubscribe: async () => false returns FORBIDDEN (not a Promise)', async () => {
			// Pre-fix bug: caller did `if (denial) ...` against a Promise,
			// always taking the truthy branch. The fix awaits before the
			// truthiness check.
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: {
					open(ws) { capturedWs = ws; },
					subscribe: async () => false
				}
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const denial = await server.platform.checkSubscribe(capturedWs, 'feed');
			expect(denial).toBe('FORBIDDEN');

			client.close();
		});

		it('platform.sendTo: async filter is fail-closed and the message goes to no one', async () => {
			// pre-fix bug: !Promise === false, so async-deny filters became
			// async-allow filters. The fix detects Promise return, logs once,
			// and treats the connection as not matching.
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			const count = server.platform.sendTo(async () => true, 'feed', 'tick', { n: 1 });
			await new Promise(r => setTimeout(r, 30));

			expect(count).toBe(0);
			expect(frames.slice(before)).toHaveLength(0);

			client.close();
		});

		// Wire-level subscribes to `__`-prefixed system topics are reserved
		// for framework / plugin internals. Pre-fix bug: any authenticated
		// client could subscribe to `__signal:victim-userId` and intercept
		// every `live.signal()` to that user. Default-block is the fix;
		// apps can opt back in via websocket.allowSystemTopicSubscribe.
		it('wire subscribe to __signal: topic is denied with INVALID_TOPIC by default', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({ type: 'subscribe', topic: '__signal:victim', ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const denied = newFrames.find((f) => f.type === 'subscribe-denied');
			expect(denied).toBeDefined();
			expect(denied.topic).toBe('__signal:victim');
			expect(denied.reason).toBe('INVALID_TOPIC');
			expect(server.platform.subscribers('__signal:victim')).toBe(0);

			client.close();
		});

		it('wire subscribe to __rpc / __presence / __group / __replay / __realtime are all denied by default', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const reserved = ['__rpc', '__presence:room', '__group:secret', '__replay:chat', '__realtime'];
			const before = frames.length;
			for (const t of reserved) {
				client.send(JSON.stringify({ type: 'subscribe', topic: t, ref: 'r-' + t }));
			}
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			for (const t of reserved) {
				const denied = newFrames.find((f) => f.type === 'subscribe-denied' && f.topic === t);
				expect(denied, `topic ${t} must be denied`).toBeDefined();
				expect(denied.reason).toBe('INVALID_TOPIC');
				expect(server.platform.subscribers(t)).toBe(0);
			}

			client.close();
		});

		it('wire subscribe-batch denies __ topics per-entry; non-reserved topics still allowed', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({
				type: 'subscribe-batch',
				topics: ['public', '__signal:victim', '__group:secret', 'feed'],
				ref: 'rb'
			}));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const byTopic = new Map();
			for (const f of newFrames) byTopic.set(f.topic, f);

			expect(byTopic.get('public').type).toBe('subscribed');
			expect(byTopic.get('feed').type).toBe('subscribed');
			expect(byTopic.get('__signal:victim').type).toBe('subscribe-denied');
			expect(byTopic.get('__signal:victim').reason).toBe('INVALID_TOPIC');
			expect(byTopic.get('__group:secret').type).toBe('subscribe-denied');
			expect(byTopic.get('__group:secret').reason).toBe('INVALID_TOPIC');

			client.close();
		});

		it('wire __ block fires BEFORE the user subscribe hook (no leak via hook side effects)', async () => {
			// The block is a top-level wire-protocol guard; it must not pass
			// through to the user's subscribe hook (where a logging side
			// effect or DB lookup might cost something attacker-controlled).
			const { createTestServer } = await import('../testing.js');
			let hookCalls = 0;
			server = await createTestServer({
				handler: { subscribe(_ws, _topic) { hookCalls++; return undefined; } }
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			client.send(JSON.stringify({ type: 'subscribe', topic: '__signal:victim', ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			expect(hookCalls).toBe(0);

			client.close();
		});

		it('opt-in: allowSystemTopicSubscribe:true permits wire __ subscribes', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({ allowSystemTopicSubscribe: true });
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			client.send(JSON.stringify({ type: 'subscribe', topic: '__signal:opted-in', ref: 'r1' }));
			await new Promise(r => setTimeout(r, 50));

			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			const subscribed = newFrames.find((f) => f.type === 'subscribed' && f.topic === '__signal:opted-in');
			expect(subscribed).toBeDefined();

			client.close();
		});

		it('server-side platform.subscribe to __ topic is NOT blocked (legitimate framework pattern)', async () => {
			// enableSignals -> platform.subscribe(ws, '__signal:userId') is
			// the expected pattern. The wire-side subscribe gate must not
			// regress that for server-initiated subscribes.
			const { createTestServer } = await import('../testing.js');
			let capturedWs = null;
			server = await createTestServer({
				handler: { open(ws) { capturedWs = ws; } }
			});
			const { ws: client } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			expect(await server.platform.subscribe(capturedWs, '__signal:user-42')).toBeNull();
			expect(server.platform.subscribers('__signal:user-42')).toBe(1);

			client.close();
		});

		it('platform.sendTo: sync filter still works and sends to matching connections', async () => {
			const { createTestServer } = await import('../testing.js');
			server = await createTestServer({});
			const { ws: client, frames } = await connectClient(server.wsUrl);
			await new Promise(r => setTimeout(r, 30));

			const before = frames.length;
			const count = server.platform.sendTo(() => true, 'feed', 'tick', { n: 1 });
			await new Promise(r => setTimeout(r, 30));

			expect(count).toBe(1);
			const newFrames = frames.slice(before).map((f) => JSON.parse(f));
			expect(newFrames.find((f) => f.event === 'tick')).toBeDefined();

			client.close();
		});
	});
});
