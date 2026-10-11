import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class Socket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	static all = [];
	constructor() { this.readyState = 0; this.sent = []; Socket.all.push(this); }
	send(frame) { this.sent.push(JSON.parse(frame)); }
	open() { this.readyState = 1; this.onopen?.(); }
	close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
	receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
let client, runtime, connection;
beforeEach(async () => {
	vi.resetModules(); vi.useFakeTimers(); Socket.all = [];
	vi.stubGlobal('WebSocket', Socket);
	vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:5173' } });
	runtime = await import('../src/client-runtime.js');
	runtime.setRuntimeEnv({ rng: { float: () => 0.5 } });
	client = await import('../src/client.js');
});
afterEach(() => { connection?.close(); runtime.resetRuntimeEnv(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('retains server authority for every holder through denial, partial release and reconnect', async () => {
	const topic = 'managed:shared';
	const subscriptions = socket => socket.sent.filter(frame =>
		(frame.type === 'subscribe' && frame.topic === topic) ||
		(frame.type === 'subscribe-batch' && frame.topics.includes(topic)));
	connection = client.connect({ reconnectInterval: 5, maxReconnectInterval: 5 });
	const first = Socket.all[0]; first.open();
	client.setTopicManaged(topic);
	const releaseOwner = client.on(topic).subscribe(() => {});
	const received = [];
	const releasePlain = client.on(topic).subscribe(value => { if (value) received.push(value); });
	await vi.advanceTimersByTimeAsync(0);
	expect(subscriptions(first)).toEqual([]);

	// Denial does not grant an attached plain listener a second authorization path.
	const denied = [];
	const stopDenials = connection.denials.subscribe(value => { if (value) denied.push(value); });
	first.receive({ type: 'subscribe-denied', topic, reason: 'FORBIDDEN', ref: 7 });
	await vi.advanceTimersByTimeAsync(0);
	expect(denied).toEqual([{ topic, reason: 'FORBIDDEN', ref: 7 }]);
	expect(subscriptions(first)).toEqual([]);
	stopDenials();

	// The framework leaving does not grant wire-subscribe authority to another holder.
	releaseOwner();
	await vi.advanceTimersByTimeAsync(0);
	expect(first.sent.filter(frame => frame.type === 'unsubscribe')).toEqual([]);
	expect(subscriptions(first)).toEqual([]);
	first.close(1006);
	await vi.advanceTimersByTimeAsync(5);
	const second = Socket.all[1]; expect(second).toBeDefined(); second.open();
	await vi.advanceTimersByTimeAsync(0);
	expect(subscriptions(second)).toEqual([]);

	// A server-authorized delivery still reaches the surviving local store.
	second.receive({ topic, event: 'update', data: { count: 1 } });
	expect(received).toEqual([{ topic, event: 'update', data: { count: 1 } }]);
	releasePlain();
	expect(second.sent.filter(frame => frame.type === 'unsubscribe')).toEqual([{ type: 'unsubscribe', topic }]);

	// Only after every old holder leaves can a new plain consumer own the wire subscription.
	const releaseNew = client.on(topic).subscribe(() => {});
	await vi.advanceTimersByTimeAsync(0);
	expect(subscriptions(second)).toHaveLength(1);
	releaseNew();
});

for (const phase of ['before flush', 'after flush', 'queued']) {
	it('transfers a plain-first topic to server authority ' + phase, async () => {
		const topic = 'managed:plain-first';
		const subscriptions = socket => socket.sent.filter(frame => frame.type === 'subscribe' || frame.type === 'subscribe-batch');
		connection = client.connect({ reconnectInterval: 5, maxReconnectInterval: 5 });
		const first = Socket.all[0]; first.open();
		if (phase === 'queued') {
			first.receive({ type: 'lease-ok' });
			first.receive({ type: 'lease', count: 0, ttlMs: 60000 });
		}
		const values = [];
		const releasePlain = client.on(topic).subscribe(value => values.push(value));
		if (phase !== 'before flush') await vi.advanceTimersByTimeAsync(0);
		client.setTopicManaged(topic);
		const releaseOwner = client.on(topic).subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		if (phase === 'queued') first.receive({ type: 'lease', count: 1, ttlMs: 60000 });
		expect(subscriptions(first)).toHaveLength(phase === 'after flush' ? 1 : 0);
		first.close(1006);
		await vi.advanceTimersByTimeAsync(5);
		const second = Socket.all[1]; second.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(subscriptions(second)).toEqual([]);
		releaseOwner();
		second.receive({ topic, event: 'put', data: 'authorized' });
		expect(values.at(-1)?.data).toBe('authorized');
		releasePlain();
		if (phase === 'queued') second.receive({ type: 'lease', count: 1, ttlMs: 60000 });
		const releaseNew = client.on(topic).subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(subscriptions(second)).toHaveLength(1);
		releaseNew();
	});
}

it('does not retry a plain subscription denied before server authority is assigned', async () => {
	const topic = 'managed:retry';
	connection = client.connect();
	const socket = Socket.all[0]; socket.open();
	const release = client.on(topic).subscribe(() => {});
	await vi.advanceTimersByTimeAsync(0);
	const first = socket.sent.find(frame => frame.type === 'subscribe');
	socket.receive({ type: 'subscribe-denied', topic, ref: first.ref, reason: 'RATE_LIMITED' });
	client.setTopicManaged(topic);
	await vi.advanceTimersByTimeAsync(1000);
	expect(socket.sent.filter(frame => frame.type === 'subscribe' || frame.type === 'subscribe-batch')).toHaveLength(1);
	release();
});

it('keeps ordinary members of a queued batch when one topic becomes server managed', async () => {
	connection = client.connect();
	const socket = Socket.all[0]; socket.open();
	socket.receive({ type: 'lease-ok' });
	socket.receive({ type: 'lease', count: 0, ttlMs: 60000 });
	const releaseManaged = client.on('managed:batch').subscribe(() => {});
	const releasePlain = client.on('plain:batch').subscribe(() => {});
	await vi.advanceTimersByTimeAsync(0);
	client.setTopicManaged('managed:batch');
	socket.receive({ type: 'lease', count: 1, ttlMs: 60000 });
	expect(socket.sent.filter(frame => frame.type === 'subscribe-batch').map(frame => frame.topics)).toEqual([['plain:batch']]);
	releaseManaged(); releasePlain();
});

it('drops an already queued retry when its topic becomes server managed', async () => {
	const topic = 'managed:queued-retry';
	connection = client.connect();
	const socket = Socket.all[0]; socket.open();
	const release = client.on(topic).subscribe(() => {});
	await vi.advanceTimersByTimeAsync(0);
	const first = socket.sent.find(frame => frame.type === 'subscribe');
	socket.receive({ type: 'lease-ok' });
	socket.receive({ type: 'lease', count: 0, ttlMs: 60000 });
	socket.receive({ type: 'subscribe-denied', topic, ref: first.ref, reason: 'RATE_LIMITED' });
	await vi.advanceTimersByTimeAsync(1000);
	expect(socket.sent.some(frame => frame.type === 'request-n' && frame.queued === 1)).toBe(true);
	client.setTopicManaged(topic);
	socket.receive({ type: 'lease', count: 1, ttlMs: 60000 });
	expect(socket.sent.filter(frame => frame.type === 'subscribe' || frame.type === 'subscribe-batch')).toHaveLength(1);
	release();
});
