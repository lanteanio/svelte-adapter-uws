import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

/**
 * Connect a ws client and capture every text frame the server sends. The
 * caller can wait for specific frames via `waitFor(predicate, timeout)`.
 */
async function connectAndCapture(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw) => {
		const text = raw.toString();
		const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
		const frame = { text, parsed };
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) {
				waiters[i].resolve(frame);
				waiters.splice(i, 1);
			}
		}
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		waitFor(pred, timeout = 1000) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex(w => w.pred === pred);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error('waitFor timed out'));
				}, timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

describeUWS('session resume protocol', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('sends a welcome envelope with a session id on open', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		const welcome = await client.waitFor(f => f.parsed?.type === 'welcome');
		expect(welcome.parsed.sessionId).toMatch(/^[0-9a-f-]{36}$/);

		client.ws.close();
	});

	it('issues a fresh session id per connection', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const a = await connectAndCapture(server.wsUrl);
		const b = await connectAndCapture(server.wsUrl);
		const wa = await a.waitFor(f => f.parsed?.type === 'welcome');
		const wb = await b.waitFor(f => f.parsed?.type === 'welcome');
		expect(wa.parsed.sessionId).not.toBe(wb.parsed.sessionId);

		a.ws.close();
		b.ws.close();
	});

	it('dispatches the resume hook with sessionId and lastSeenSeqs', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const captured = [];
		server = await createTestServer({
			handler: {
				resume(_ws, ctx) { captured.push(ctx); }
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'topic:a': 7, 'topic:b': 3 }
		}));
		await client.waitFor(f => f.parsed?.type === 'resumed');

		expect(captured).toHaveLength(1);
		expect(captured[0].sessionId).toBe('prev-abc');
		expect(captured[0].lastSeenSeqs).toEqual({ 'topic:a': 7, 'topic:b': 3 });
		expect(typeof captured[0].platform.publish).toBe('function');

		client.ws.close();
	});

	it('still acks resume when no resume hook is wired', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'whatever',
			lastSeenSeqs: {}
		}));
		const ack = await client.waitFor(f => f.parsed?.type === 'resumed');
		expect(ack).toBeTruthy();

		client.ws.close();
	});

	it('ignores malformed resume frames', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let called = false;
		server = await createTestServer({
			handler: {
				resume() { called = true; }
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		// Missing sessionId
		client.ws.send(JSON.stringify({ type: 'resume', lastSeenSeqs: {} }));
		// Missing lastSeenSeqs
		client.ws.send(JSON.stringify({ type: 'resume', sessionId: 'x' }));
		// Wrong types
		client.ws.send(JSON.stringify({ type: 'resume', sessionId: 7, lastSeenSeqs: 'no' }));

		await new Promise(r => setTimeout(r, 100));
		expect(called).toBe(false);

		client.ws.close();
	});

	it('survives a resume hook that throws', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				resume() { throw new Error('boom'); }
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 's',
			lastSeenSeqs: { a: 1 }
		}));
		// Server still sends resumed despite the throw.
		await client.waitFor(f => f.parsed?.type === 'resumed');

		client.ws.close();
	});

	it('awaits the resume hook before emitting resumed (so replay frames land first)', async () => {
		// Pre-fix bug: the resume hook was fired-and-forgotten and the
		// resumed ack went out immediately. Replay backends call
		// platform.send(ws, '__replay:topic', 'msg', ...) asynchronously,
		// so the client started processing live publishes before the
		// gap-fill arrived. Assert ordering: every __replay:* frame
		// dispatched from inside the user resume hook must appear on the
		// wire BEFORE the resumed ack.
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				async resume(ws, ctx) {
					await new Promise(r => setTimeout(r, 30));
					ctx.platform.send(ws, '__replay:topic-a', 'msg', { seq: 1, data: 'gap-fill' });
					ctx.platform.send(ws, '__replay:topic-a', 'end', null);
				}
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 's',
			lastSeenSeqs: { 'topic-a': 0 }
		}));

		const resumed = await client.waitFor(f => f.parsed?.type === 'resumed', 500);
		const resumedIdx = client.frames.indexOf(resumed);
		// The replay 'msg' and 'end' must appear before the resumed ack.
		const replayMsgIdx = client.frames.findIndex(f => f.parsed?.event === 'msg' && f.parsed?.topic === '__replay:topic-a');
		const replayEndIdx = client.frames.findIndex(f => f.parsed?.event === 'end' && f.parsed?.topic === '__replay:topic-a');
		expect(replayMsgIdx).toBeGreaterThanOrEqual(0);
		expect(replayEndIdx).toBeGreaterThan(replayMsgIdx);
		expect(resumedIdx).toBeGreaterThan(replayEndIdx);

		client.ws.close();
	});
});

describeUWS('per-topic epoch on subscribe and resume', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('includes a per-topic epoch on the subscribe ack', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 1 }));

		const ack = await client.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');
		// Back-compat fields are untouched.
		expect(ack.parsed.topic).toBe('room:1');
		expect(ack.parsed.ref).toBe(1);
		// The new additive field. The server stamps a stable per-process value;
		// the exact value is opaque to the client, only its presence and
		// stability matter.
		expect(ack.parsed.epoch).toBeDefined();
		expect(typeof ack.parsed.epoch === 'string' || typeof ack.parsed.epoch === 'number').toBe(true);

		client.ws.close();
	});

	it('keeps the same epoch across two subscribes to one topic in one process', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const a = await connectAndCapture(server.wsUrl);
		const b = await connectAndCapture(server.wsUrl);
		await a.waitFor(f => f.parsed?.type === 'welcome');
		await b.waitFor(f => f.parsed?.type === 'welcome');

		a.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 1 }));
		b.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 1 }));
		const ackA = await a.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');
		const ackB = await b.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');

		// One process, one in-memory seq space, so every subscriber to the topic
		// sees the same epoch. A later restart is the only thing that changes it.
		expect(ackA.parsed.epoch).toBe(ackB.parsed.epoch);

		a.ws.close();
		b.ws.close();
	});

	it('forwards the client-presented per-topic epochs to the resume hook', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const captured = [];
		server = await createTestServer({
			handler: {
				resume(_ws, ctx) { captured.push(ctx); }
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'room:1': 7, 'room:2': 3 },
			lastSeenEpochs: { 'room:1': 'epoch-a', 'room:2': 'epoch-a' }
		}));
		await client.waitFor(f => f.parsed?.type === 'resumed');

		expect(captured).toHaveLength(1);
		expect(captured[0].lastSeenSeqs).toEqual({ 'room:1': 7, 'room:2': 3 });
		expect(captured[0].lastSeenEpochs).toEqual({ 'room:1': 'epoch-a', 'room:2': 'epoch-a' });

		client.ws.close();
	});

	it('gap-fills a topic whose presented epoch matches the current epoch', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// Capture the live epoch from the subscribe ack, then resume with it.
		// The resume hook gap-fills only when the presented epoch matches; the
		// test asserts the resume hook saw a match and emitted gap-fill frames.
		server = await createTestServer({
			handler: {
				async resume(ws, ctx) {
					for (const [topic, sinceSeq] of Object.entries(ctx.lastSeenSeqs)) {
						const presentedEpoch = ctx.lastSeenEpochs ? ctx.lastSeenEpochs[topic] : undefined;
						const currentEpoch = ctx.platform.topicEpoch(topic);
						if (presentedEpoch !== undefined && presentedEpoch !== currentEpoch) {
							// Mismatch: cold-rehydrate marker instead of gap-fill.
							ctx.platform.send(ws, '__replay:' + topic, 'truncated', null);
							ctx.platform.send(ws, '__replay:' + topic, 'end', null);
							continue;
						}
						// Match: ordinary gap-fill from sinceSeq.
						ctx.platform.send(ws, '__replay:' + topic, 'msg', { seq: sinceSeq + 1, data: 'gap' });
						ctx.platform.send(ws, '__replay:' + topic, 'end', null);
					}
				}
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 1 }));
		const ack = await client.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');
		const liveEpoch = ack.parsed.epoch;

		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'room:1': 4 },
			lastSeenEpochs: { 'room:1': liveEpoch }
		}));
		await client.waitFor(f => f.parsed?.type === 'resumed');

		const gap = client.frames.find(f => f.parsed?.event === 'msg' && f.parsed?.topic === '__replay:room:1');
		const truncated = client.frames.find(f => f.parsed?.event === 'truncated' && f.parsed?.topic === '__replay:room:1');
		expect(gap).toBeTruthy();
		expect(gap.parsed.data.seq).toBe(5);
		// A matching epoch never cold-rehydrates.
		expect(truncated).toBeFalsy();

		client.ws.close();
	});

	it('cold-rehydrates a topic whose presented epoch is stale (simulated restart)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// The presented epoch is a value the live server never issued, modeling
		// a client that reconnected to a process which restarted (its in-memory
		// seq space reset). The hook must not gap-fill against the new seq space.
		const gapFillCalls = [];
		server = await createTestServer({
			handler: {
				async resume(ws, ctx) {
					for (const [topic, sinceSeq] of Object.entries(ctx.lastSeenSeqs)) {
						const presentedEpoch = ctx.lastSeenEpochs ? ctx.lastSeenEpochs[topic] : undefined;
						const currentEpoch = ctx.platform.topicEpoch(topic);
						if (presentedEpoch !== undefined && presentedEpoch !== currentEpoch) {
							ctx.platform.send(ws, '__replay:' + topic, 'truncated', null);
							ctx.platform.send(ws, '__replay:' + topic, 'end', null);
							continue;
						}
						gapFillCalls.push({ topic, sinceSeq });
						ctx.platform.send(ws, '__replay:' + topic, 'msg', { seq: sinceSeq + 1, data: 'gap' });
						ctx.platform.send(ws, '__replay:' + topic, 'end', null);
					}
				}
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'room:1': 9 },
			lastSeenEpochs: { 'room:1': 'epoch-from-before-restart' }
		}));
		await client.waitFor(f => f.parsed?.type === 'resumed');

		const truncated = client.frames.find(f => f.parsed?.event === 'truncated' && f.parsed?.topic === '__replay:room:1');
		const gap = client.frames.find(f => f.parsed?.event === 'msg' && f.parsed?.topic === '__replay:room:1');
		// Stale epoch: cold-rehydrate, never serve the reset seq space as contiguous.
		expect(truncated).toBeTruthy();
		expect(gap).toBeFalsy();
		expect(gapFillCalls).toHaveLength(0);

		client.ws.close();
	});

	it('acks an old client that presents no epochs exactly as before', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const captured = [];
		server = await createTestServer({
			handler: {
				async resume(_ws, ctx) {
					captured.push(ctx);
				}
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		// Old client: lastSeenSeqs only, no lastSeenEpochs. Must ack with a
		// plain { type:'resumed' } and the hook must treat the absent epochs as
		// a match (gap-fill as today).
		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'room:1': 2 }
		}));
		const ack = await client.waitFor(f => f.parsed?.type === 'resumed');

		expect(ack.parsed).toEqual({ type: 'resumed' });
		expect(captured).toHaveLength(1);
		expect(captured[0].lastSeenSeqs).toEqual({ 'room:1': 2 });
		// Missing epochs is the absent-is-a-match contract: undefined, never a throw.
		expect(captured[0].lastSeenEpochs === undefined || Object.keys(captured[0].lastSeenEpochs).length === 0).toBe(true);

		client.ws.close();
	});

	it('decides each topic independently when one epoch is stale and one is fresh', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const decisions = [];
		server = await createTestServer({
			handler: {
				async resume(ws, ctx) {
					for (const [topic, sinceSeq] of Object.entries(ctx.lastSeenSeqs)) {
						const presentedEpoch = ctx.lastSeenEpochs ? ctx.lastSeenEpochs[topic] : undefined;
						// The live epoch is read server-side from the platform;
						// 'fresh' presents that value and 'stale' presents a value
						// the process never issued.
						const currentEpoch = ctx.platform.topicEpoch(topic);
						const stale = presentedEpoch !== undefined && presentedEpoch !== currentEpoch;
						if (stale) {
							decisions.push({ topic, verdict: 'cold' });
							ctx.platform.send(ws, '__replay:' + topic, 'truncated', null);
							ctx.platform.send(ws, '__replay:' + topic, 'end', null);
						} else {
							decisions.push({ topic, verdict: 'gap' });
							ctx.platform.send(ws, '__replay:' + topic, 'msg', { seq: sinceSeq + 1, data: 'gap' });
							ctx.platform.send(ws, '__replay:' + topic, 'end', null);
						}
					}
				}
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');

		// Capture each topic's live epoch from its own subscribe ack.
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'fresh:1', ref: 1 }));
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'stale:1', ref: 2 }));
		const ackFresh = await client.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'fresh:1');
		await client.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'stale:1');

		client.ws.send(JSON.stringify({
			type: 'resume',
			sessionId: 'prev-abc',
			lastSeenSeqs: { 'fresh:1': 4, 'stale:1': 9 },
			lastSeenEpochs: { 'fresh:1': ackFresh.parsed.epoch, 'stale:1': 'never-issued-epoch' }
		}));
		await client.waitFor(f => f.parsed?.type === 'resumed');

		// fresh:1 gap-filled, stale:1 cold-rehydrated. One topic's verdict does
		// not disturb the other's.
		const freshGap = client.frames.find(f => f.parsed?.event === 'msg' && f.parsed?.topic === '__replay:fresh:1');
		const freshTrunc = client.frames.find(f => f.parsed?.event === 'truncated' && f.parsed?.topic === '__replay:fresh:1');
		const staleTrunc = client.frames.find(f => f.parsed?.event === 'truncated' && f.parsed?.topic === '__replay:stale:1');
		const staleGap = client.frames.find(f => f.parsed?.event === 'msg' && f.parsed?.topic === '__replay:stale:1');

		expect(freshGap).toBeTruthy();
		expect(freshGap.parsed.data.seq).toBe(5);
		expect(freshTrunc).toBeFalsy();
		expect(staleTrunc).toBeTruthy();
		expect(staleGap).toBeFalsy();
		expect(decisions).toContainEqual({ topic: 'fresh:1', verdict: 'gap' });
		expect(decisions).toContainEqual({ topic: 'stale:1', verdict: 'cold' });

		client.ws.close();
	});

	it('still acks (and does not count an abort) when topicEpoch throws', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		// epoch is an additive best-effort field. A throwing topicEpoch must
		// fall back to the process generation and still deliver the ack; it is
		// not a closed-socket abort.
		server.platform.topicEpoch = () => { throw new Error('boom'); };
		const abortsBefore = server.platform.closedWsAborts;

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor(f => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 1 }));

		const ack = await client.waitFor(f => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');
		// Ack delivered with the fallback epoch present.
		expect(ack.parsed.ref).toBe(1);
		expect(ack.parsed.epoch).toBeDefined();
		// The throw was not charged to the closed-socket abort counter.
		expect(server.platform.closedWsAborts).toBe(abortsBefore);

		client.ws.close();
	});
});
