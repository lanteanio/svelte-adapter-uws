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
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer();

		const client = await connectAndCapture(server.wsUrl);
		const welcome = await client.waitFor(f => f.parsed?.type === 'welcome');
		expect(welcome.parsed.sessionId).toMatch(/^[0-9a-f-]{36}$/);

		client.ws.close();
	});

	it('issues a fresh session id per connection', async () => {
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
		const { createTestServer } = await import('../testing.js');
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
