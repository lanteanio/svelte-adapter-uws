import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as client from '../src/client.js';
import { onReplay } from '../src/plugins/replay/client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('replay client deadline');
		await pause(5);
	}
}

describe('replay truncation through the actual client socket', () => {
	let server, connection, peer;
	let requests, unsubscribers, frames, peers;
	beforeEach(async () => {
		requests = []; frames = []; peers = [];
		unsubscribers = [];
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peer = socket; peers.push(socket);
			socket.on('message', bytes => {
				const frame = JSON.parse(bytes.toString());
				frames.push(frame);
				if (frame.type === 'replay') requests.push(frame);
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
	});
	afterEach(async () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
		vi.restoreAllMocks(); vi.unstubAllGlobals();
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
	});
	function send(event, data) {
		peer.send(JSON.stringify({ topic: '__replay:chat', event, data }));
	}

	it('reissues an unanswered replay after explicit replacement and rejects the old request id', async () => {
		const events = [];
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) events.push(value); }));
		await waitFor(() => requests.length === 1);
		const replayAt = frames.findIndex(frame => frame.type === 'replay');
		expect(frames.slice(0, replayAt).some(frame => frame.type === 'hello')).toBe(true);
		expect(frames.slice(0, replayAt).some(frame => frame.type === 'subscribe' || frame.type === 'subscribe-batch')).toBe(true);
		const oldId = requests[0].reqId;
		send('msg', { reqId: oldId, seq: 2, event: 'put', data: 'first replay' });
		await waitFor(() => events.length === 1);
		connection.close();
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port });
		await waitFor(() => requests.length === 2);
		const nextId = requests[1].reqId;
		expect(nextId).not.toBe(oldId);
		expect(requests[1].since).toBe(2);
		send('msg', { reqId: oldId, event: 'put', data: 'stale' });
		send('end', { reqId: oldId });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 'too soon' }));
		send('msg', { reqId: nextId, event: 'put', data: 'replayed' });
		send('end', { reqId: nextId });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 'live' }));
		await waitFor(() => events.some(event => event.data === 'live'));
		expect(events.map(event => event.data)).toEqual(['first replay', 'replayed', 'live']);
	});

	it('keeps a restarted subscription active when a truncation handler replaces it synchronously', async () => {
		const replay = onReplay('chat', { since: 1 });
		const events = [];
		let stop = replay.subscribe(value => {
			if (value?.event === 'truncated') {
				stop();
				stop = replay.subscribe(next => { if (next) events.push(next); });
			}
		});
		unsubscribers.push(() => stop());
		await waitFor(() => requests.length === 1);
		send('end', { reqId: requests[0].reqId, truncated: true });
		await waitFor(() => requests.length === 2);
		send('msg', { reqId: requests[0].reqId, event: 'put', data: 'old request' });
		send('msg', { reqId: requests[1].reqId, event: 'put', data: 'new request' });
		send('end', { reqId: requests[1].reqId });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 'live' }));
		await waitFor(() => events.some(event => event.data === 'live'));
		expect(events.map(event => event.data)).toEqual(['new request', 'live']);
	});

	it('does not reopen a closed connection when a replay store is constructed', async () => {
		await client.ready();
		connection.close();
		const events = [];
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) events.push(value); }));
		await pause(50);
		await expect(client.ready()).rejects.toThrow();
		expect(requests).toEqual([]);
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port });
		await waitFor(() => requests.length === 1);
		send('end', { reqId: requests[0].reqId });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 'live' }));
		await waitFor(() => events.some(event => event.data === 'live'));
	});
	it('cancels a scheduled replay when close runs before its send microtask', async () => {
		await client.ready();
		vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:' + server.address().port } });
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(() => {}));
		connection.close();
		await pause(50);
		expect(peers).toHaveLength(1);
		expect(requests).toEqual([]);
		await expect(client.ready()).rejects.toThrow();
	});
	it('ignores a cached truncation from before its request was sent', async () => {
		const prior = [];
		unsubscribers.push(client.on('__replay:chat').subscribe(value => { if (value) prior.push(value); }));
		await client.ready();
		send('truncated', null);
		await waitFor(() => prior.length === 1);
		const events = [];
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) events.push(value); }));
		await waitFor(() => requests.length === 1);
		send('end', { reqId: requests[0].reqId });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 'live' }));
		await waitFor(() => events.some(event => event.data === 'live'));
		expect(events).toEqual([{ topic: 'chat', event: 'put', data: 'live' }]);
	});

	it('ignores truncation and replay frames after the connection refuses the send', async () => {
		await client.ready();
		const refused = vi.spyOn(connection, 'send').mockReturnValue(false);
		const events = [], observed = [];
		unsubscribers.push(client.on('__replay:chat').subscribe(value => { if (value) observed.push(value); }));
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) events.push(value); }));
		await waitFor(() => refused.mock.calls.length === 1);
		expect(refused).toHaveBeenCalledOnce();
		send('truncated', null); send('end', null);
		await waitFor(() => observed.length === 2);
		expect(requests).toEqual([]);
		expect(events).toEqual([]);
	});
	for (const form of ['standalone', 'inline', 'both']) {
		it('reports ' + form + ' truncation once, then delivers replay and live messages', async () => {
			const events = [];
			unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) events.push(value); }));
			await waitFor(() => requests.length === 1);
			const { reqId } = requests[0];
			if (form !== 'inline') {
				send('truncated', null);
				send('truncated', null);
			}
			send('msg', { reqId, event: 'put', data: 5 });
			send('end', form === 'standalone' ? { reqId } : { reqId, truncated: true });
			send('truncated', null);
			peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 6 }));
			await waitFor(() => events.some(event => event.data === 6));
			expect(events.filter(event => event.event === 'truncated')).toEqual([{ topic: 'chat', event: 'truncated', data: null }]);
			expect(events.filter(event => event.event === 'put').map(event => event.data)).toEqual([5, 6]);
		});
	}
	it('keeps independent requests correlated while sharing standalone truncation', async () => {
		const first = [], second = [];
		unsubscribers.push(onReplay('chat', { since: 1 }).subscribe(value => { if (value) first.push(value); }));
		unsubscribers.push(onReplay('chat', { since: 2 }).subscribe(value => { if (value) second.push(value); }));
		await waitFor(() => requests.length === 2);
		send('end', { reqId: requests[0].reqId, truncated: true });
		send('truncated', null);
		send('msg', { reqId: requests[1].reqId, event: 'put', data: 3 });
		send('end', { reqId: requests[1].reqId, truncated: true });
		peer.send(JSON.stringify({ topic: 'chat', event: 'put', data: 4 }));
		await waitFor(() => second.some(event => event.data === 4));
		expect(first).toEqual([{ topic: 'chat', event: 'truncated', data: null }, { topic: 'chat', event: 'put', data: 4 }]);
		expect(second).toEqual([{ topic: 'chat', event: 'truncated', data: null }, { topic: 'chat', event: 'put', data: 3 }, { topic: 'chat', event: 'put', data: 4 }]);
	});
});
