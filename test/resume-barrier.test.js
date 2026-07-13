// Recovery-barrier interleave tests: a publish that lands DURING an async resume
// hook (after the backend read, before the connection is subscribed to live) must
// still reach the client instead of vanishing into the replay-to-live gap. These
// drive the real createTestServer message loop end to end - a real WS client, a
// real uWS fan-out, a resume hook that genuinely awaits - and the interleave is
// made deterministic with a pair of deferreds: the hook signals when it is mid
// await, the test publishes, then releases the hook.
import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer } from '../src/testing.js';

/** @type {Array<{ close: () => Promise<void> | void }>} */
const servers = [];
/** @type {Array<{ close: () => void }>} */
const clients = [];

afterEach(async () => {
	for (const c of clients.splice(0)) { try { c.close(); } catch {} }
	for (const s of servers.splice(0)) { try { await s.close(); } catch {} }
});

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const messages = [];
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		messages.push(m);
		for (const w of waiters.slice()) {
			if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
		}
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	const client = {
		ws,
		messages,
		send: (frame) => ws.send(JSON.stringify(frame)),
		waitFor(pred, timeoutMs = 2000) {
			const existing = messages.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const w = { pred, resolve };
				waiters.push(w);
				setTimeout(() => {
					const i = waiters.indexOf(w);
					if (i >= 0) { waiters.splice(i, 1); reject(new Error('waitFor timeout')); }
				}, timeoutMs);
			});
		},
		close: () => { try { ws.close(); } catch {} }
	};
	clients.push(client);
	return client;
}

// Let queued microtasks/macrotasks settle so a "should not arrive" assertion is real.
const settle = () => new Promise((r) => setTimeout(r, 40));

describe('resume recovery barrier', () => {
	it('delivers a publish that lands inside the async resume window (single subscribe)', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				resume: async () => { entered.resolve(); await release.promise; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;                 // hook is mid-await
		server.platform.publish('room', 'tick', { n: 42 });  // lands in the window
		release.resolve();

		const frame = await client.waitFor((m) => m.topic === 'room' && m.event === 'tick');
		expect(frame.data).toEqual({ n: 42 });
		const ticks = client.messages.filter((m) => m.topic === 'room' && m.event === 'tick');
		expect(ticks.length).toBe(1);           // exactly once, no duplicate
	});

	it('delivers a publishBatched that lands inside the async resume window (fast path)', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: { resume: async () => { entered.resolve(); await release.promise; } }
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;
		// Single-topic batch, no other subscribers -> the shared-frame fast path fires
		// (the batch frame reaches nobody). A caps-less resuming connection must still
		// receive the per-event JSON, so the fast path has to capture per event.
		server.platform.publishBatched([{ topic: 'room', event: 'tick', data: { n: 77 } }]);
		release.resolve();

		const frame = await client.waitFor((m) => m.topic === 'room' && m.event === 'tick');
		expect(frame.data).toEqual({ n: 77 });
		expect(client.messages.filter((m) => m.topic === 'room' && m.event === 'tick').length).toBe(1);
	});

	it('skips frames the resume already covered, delivers those beyond the watermark', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				// Reports it delivered up to seq 5 for `room`.
				resume: async () => { entered.resolve(); await release.promise; return { room: 5 }; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;
		server.platform.publish('room', 'old', { n: 1 }, { seq: 5 });  // <= covered -> skip
		server.platform.publish('room', 'new', { n: 2 }, { seq: 6 });  // >  covered -> deliver
		release.resolve();

		const frame = await client.waitFor((m) => m.event === 'new');
		expect(frame.data).toEqual({ n: 2 });
		await settle();
		expect(client.messages.filter((m) => m.event === 'old').length).toBe(0);
	});

	it('bridges the batch cutover for every recovered topic', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				resume: async () => { entered.resolve(); await release.promise; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe-batch', topics: ['a', 'b'], ref: 1, recover: { a: { offset: 0 }, b: { offset: 0 } } });
		await entered.promise;                 // the single batch resume call is mid-await
		server.platform.publish('a', 'tick', { t: 'a' });
		server.platform.publish('b', 'tick', { t: 'b' });
		release.resolve();

		const fa = await client.waitFor((m) => m.topic === 'a' && m.event === 'tick');
		const fb = await client.waitFor((m) => m.topic === 'b' && m.event === 'tick');
		expect(fa.data).toEqual({ t: 'a' });
		expect(fb.data).toEqual({ t: 'b' });
	});

	it('ignores a bare-number watermark in a batch resume (no wrong-skip gap)', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				// Misuse: a multi-topic resume returns a bare number instead of a
				// { [topic]: seq } map. The batch path must ignore it - applying one
				// floor to every topic would wrongly skip a lagging topic's frames.
				resume: async () => { entered.resolve(); await release.promise; return 5; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe-batch', topics: ['a', 'b'], ref: 1, recover: { a: { offset: 0 }, b: { offset: 0 } } });
		await entered.promise;
		server.platform.publish('a', 'tick', { t: 'a' }, { seq: 6 });  // above the bare 5
		server.platform.publish('b', 'tick', { t: 'b' }, { seq: 3 });  // below 5: wrongly skipped if the bare number applied
		release.resolve();

		const fa = await client.waitFor((m) => m.topic === 'a' && m.event === 'tick');
		const fb = await client.waitFor((m) => m.topic === 'b' && m.event === 'tick');
		expect(fa.data).toEqual({ t: 'a' });
		expect(fb.data).toEqual({ t: 'b' });
	});

	it('discards the buffer when a concurrent subscribe wins the race (no duplicate)', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				resume: async () => { entered.resolve(); await release.promise; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		// A recover-subscribe opens the barrier and awaits the hook.
		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;
		// A second plain subscribe for the same topic races in and installs live
		// membership while the hook is still awaiting.
		client.send({ type: 'subscribe', topic: 'room', ref: 2 });
		await client.waitFor((m) => m.type === 'subscribed' && m.topic === 'room' && m.ref === 2);
		// A publish now reaches the (already-live) client exactly once via the normal
		// path; the recover-subscribe must discard its buffer rather than re-deliver.
		server.platform.publish('room', 'tick', { n: 9 });
		release.resolve();

		const frame = await client.waitFor((m) => m.event === 'tick');
		expect(frame.data).toEqual({ n: 9 });
		await settle();
		expect(client.messages.filter((m) => m.event === 'tick').length).toBe(1);
	});

	it('leaves no stale buffer after cutover (later publishes delivered once)', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: {
				resume: async () => { entered.resolve(); await release.promise; }
			}
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;
		release.resolve();                     // nothing published in the window
		await client.waitFor((m) => m.type === 'subscribed' && m.topic === 'room');

		server.platform.publish('room', 'tick', { n: 7 });  // post-cutover, live path
		const frame = await client.waitFor((m) => m.event === 'tick');
		expect(frame.data).toEqual({ n: 7 });
		await settle();
		expect(client.messages.filter((m) => m.event === 'tick').length).toBe(1);
	});

	it('is a no-op for a synchronous (in-memory) resume - the frame flows normally', async () => {
		// A synchronous resume hook never yields a macrotask, so nothing can
		// interleave and the buffer stays empty; delivery still works.
		const server = await createTestServer({
			handler: { resume: () => { /* sync, no await */ } }
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await client.waitFor((m) => m.type === 'subscribed' && m.topic === 'room');
		server.platform.publish('room', 'tick', { n: 3 });
		const frame = await client.waitFor((m) => m.event === 'tick');
		expect(frame.data).toEqual({ n: 3 });
		expect(client.messages.filter((m) => m.event === 'tick').length).toBe(1);
	});

	it('signals truncation when the resume window overflows the frame cap', async () => {
		const entered = deferred();
		const release = deferred();
		const server = await createTestServer({
			handler: { resume: async () => { entered.resolve(); await release.promise; } }
		});
		servers.push(server);
		const client = await connectClient(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
		await entered.promise;
		// Publish past the 4096-frame buffer cap while the resume is in flight.
		for (let i = 0; i < 4097; i++) server.platform.publish('room', 'tick', { i });
		release.resolve();

		// The client must be told its view is truncated (a replay-channel marker),
		// not left with a silent gap past the cap.
		const marker = await client.waitFor(
			(m) => m.topic === '__replay:room' && m.event === 'truncated', 4000
		);
		expect(marker).toBeTruthy();
	});
});
