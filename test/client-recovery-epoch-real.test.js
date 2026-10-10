import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import * as client from '../src/client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('recovery client deadline');
		await pause(5);
	}
}

describe('recovery epoch markers on the actual client socket', () => {
	let server, connection, peers, requests, events, unsubscribe;
	beforeEach(async () => {
		peers = []; requests = []; events = [];
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', bytes => {
				const frame = JSON.parse(bytes.toString());
				if (frame.type === 'subscribe' || frame.type === 'subscribe-batch') requests.push({ socket, frame });
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, reconnectInterval: 5, maxReconnectInterval: 5 });
		connection.events.subscribe(value => { if (value) events.push(value); });
		unsubscribe = connection.on('room').subscribe(() => {});
		await waitFor(() => requests.length === 1);
		peers[0].send(JSON.stringify({ type: 'subscribed', topic: 'room', ref: requests[0].frame.ref, epoch: 4 }));
		peers[0].send(JSON.stringify({ topic: 'room', event: 'put', data: 'before', seq: 11 }));
		await waitFor(() => events.some(event => event.data === 'before'));
	});
	afterEach(async () => {
		unsubscribe?.();
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
	});
	for (const [name, event, data, epoch] of [
		['standalone truncation', 'truncated', null, 4],
		['inline resume truncation', 'end', { truncated: true }, 4],
		['inline requested replay truncation', 'end', { reqId: 77, truncated: true }, 4],
		['relay gap', 'gap', { lost: 1 }, 4],
		['new generation', 'rehydrate', { epoch: 9 }, 9],
		['legacy generation marker', 'rehydrate', {}, 4],
		['denied recovery', 'denied', { code: 'FORBIDDEN' }, 4]
	]) {
		for (const reseed of [false, true]) {
			it(name + (reseed ? ' retains a generation for the next observed offset' : ' clears the old offset'), async () => {
				peers[0].send(JSON.stringify({ topic: '__replay:room', event, data }));
				if (reseed) peers[0].send(JSON.stringify({ topic: 'room', event: 'put', data: 'after', seq: 12 }));
				await waitFor(() => events.some(value => reseed ? value.data === 'after' : value.topic === '__replay:room'));
				peers[0].terminate();
				await waitFor(() => peers.length === 2 && requests.some(value => value.socket === peers[1]));
				const retry = requests.find(value => value.socket === peers[1]).frame;
				expect(retry.type).toBe('subscribe-batch');
				expect(retry.recover?.room).toEqual(reseed ? { offset: 12, epoch } : undefined);
			});
		}
	}
	it('preserves the offset and epoch after an ordinary replay end', async () => {
		peers[0].send(JSON.stringify({ topic: '__replay:room', event: 'end', data: { reqId: 77 } }));
		await waitFor(() => events.some(value => value.event === 'end'));
		peers[0].terminate();
		await waitFor(() => peers.length === 2 && requests.some(value => value.socket === peers[1]));
		expect(requests.find(value => value.socket === peers[1]).frame.recover?.room).toEqual({ offset: 11, epoch: 4 });
	});
});
