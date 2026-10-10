import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
	let requests, unsubscribers;
	beforeEach(async () => {
		requests = [];
		unsubscribers = [];
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peer = socket;
			socket.on('message', bytes => {
				const frame = JSON.parse(bytes.toString());
				if (frame.type === 'replay') requests.push(frame);
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
	});
	afterEach(async () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
	});
	function send(event, data) {
		peer.send(JSON.stringify({ topic: '__replay:chat', event, data }));
	}
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
