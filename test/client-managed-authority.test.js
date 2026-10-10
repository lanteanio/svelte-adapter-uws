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
