import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as client from '../src/client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('recovery window deadline');
		await pause(5);
	}
}

describe('unanswered recovery offsets on the actual client socket', () => {
	let server, connection, peers, requests, frames, events, unsubscribe, warnings;
	beforeEach(async () => {
		peers = []; requests = []; frames = []; events = [];
		warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', bytes => {
				const frame = JSON.parse(bytes.toString());
				frames.push({ socket, frame });
				if (frame.type === 'subscribe' || frame.type === 'subscribe-batch') requests.push({ socket, frame });
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, reconnectInterval: 5, maxReconnectInterval: 5 });
		connection.events.subscribe(value => { if (value) events.push(value); });
		unsubscribe = connection.on('room').subscribe(() => {});
		await waitFor(() => requests.length === 1);
		send(peers[0], { type: 'subscribed', topic: 'room', ref: requests[0].frame.ref, epoch: 7 });
		send(peers[0], { topic: 'room', event: 'put', data: 'initial', seq: 1 });
		await waitFor(() => events.some(event => event.data === 'initial'));
	});
	afterEach(async () => {
		unsubscribe?.(); connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		warnings.mockRestore();
	});
	function send(socket, frame) { socket.send(JSON.stringify(frame)); }
	async function reconnect() {
		const count = peers.length;
		peers.at(-1).terminate();
		await waitFor(() => peers.length === count + 1 && requests.some(value => value.socket === peers.at(-1)));
		return requests.find(value => value.socket === peers.at(-1));
	}
	async function barrier(socket, label) {
		send(socket, { topic: 'probe', event: 'barrier', data: label });
		await waitFor(() => events.some(event => event.data === label));
	}
	for (const answer of ['none', 'wrong ref', 'other topic', 'denied', 'accepted']) {
		it('keeps the requested offset until the recovery is answered: ' + answer, async () => {
			const recovering = await reconnect();
			expect(recovering.frame.recover.room).toEqual({ offset: 1, epoch: 7 });
			send(recovering.socket, { type: 'batch', events: [{ topic: 'room', event: 'put', data: 'ahead', seq: 10 }] });
			if (answer !== 'none') send(recovering.socket, {
				type: answer === 'denied' ? 'subscribe-denied' : 'subscribed',
				topic: answer === 'other topic' ? 'another' : 'room',
				ref: answer === 'wrong ref' ? recovering.frame.ref - 1 : recovering.frame.ref,
				epoch: 7, reason: 'FORBIDDEN'
			});
			await barrier(recovering.socket, 'before drop');
			expect(events.some(event => event.data === 'ahead'), 'live delivery is not blocked').toBe(true);
			const next = await reconnect();
			expect(next.frame.recover.room).toEqual({ offset: answer === 'accepted' ? 10 : 1, epoch: 7 });
		});
	}
	for (const event of ['truncated', 'gap', 'rehydrate']) {
		it('does not reseed an invalidated offset before the ' + event + ' recovery is answered', async () => {
			const recovering = await reconnect();
			send(recovering.socket, { topic: 'room', event: 'put', data: 'ahead', seq: 10 });
			send(recovering.socket, { topic: '__replay:room', event, data: event === 'rehydrate' ? { epoch: 9 } : null });
			send(recovering.socket, { topic: 'room', event: 'put', data: 'after marker', seq: 11 });
			await barrier(recovering.socket, 'invalidated');
			const next = await reconnect();
			expect(next.frame.recover?.room).toBeUndefined();
		});
	}
	it('resumes committed progress after a matching acknowledgement and subsequent live frames', async () => {
		const recovering = await reconnect();
		send(recovering.socket, { topic: 'room', event: 'put', data: 'ahead', seq: 10 });
		send(recovering.socket, { type: 'subscribed', topic: 'room', ref: recovering.frame.ref, epoch: 7 });
		send(recovering.socket, { topic: 'room', event: 'put', data: 'committed', seq: 12 });
		await barrier(recovering.socket, 'settled');
		expect((await reconnect()).frame.recover.room).toEqual({ offset: 12, epoch: 7 });
	});
	it('retries a denied recovery from the saved offset rather than a speculative live frame', async () => {
		const recovering = await reconnect();
		send(recovering.socket, { topic: 'room', event: 'put', data: 'ahead', seq: 10 });
		send(recovering.socket, { type: 'subscribe-denied', topic: 'room', ref: recovering.frame.ref, reason: 'RATE_LIMITED' });
		await waitFor(() => requests.filter(value => value.socket === recovering.socket).length === 2);
		const retry = requests.filter(value => value.socket === recovering.socket)[1];
		expect(retry.frame.recover.room).toEqual({ offset: 1, epoch: 7 });
		send(recovering.socket, { topic: 'room', event: 'put', data: 'retry ahead', seq: 20 });
		await barrier(recovering.socket, 'retry pending');
		expect((await reconnect()).frame.recover.room).toEqual({ offset: 1, epoch: 7 });
	});
	for (const replace of [false, true]) {
		it('binds a flow-controlled retry to its actual send and owning socket: replace=' + replace, async () => {
			const recovering = await reconnect();
			send(recovering.socket, { type: 'lease-ok' });
			send(recovering.socket, { type: 'lease', count: 0, ttlMs: 60000 });
			send(recovering.socket, { type: 'subscribe-denied', topic: 'room', ref: recovering.frame.ref, reason: 'RATE_LIMITED' });
			await waitFor(() => frames.some(value => value.socket === recovering.socket && value.frame.type === 'request-n' && value.frame.queued === 1));
			expect(requests.filter(value => value.socket === recovering.socket)).toHaveLength(1);
			send(recovering.socket, { topic: 'room', event: 'put', data: 'while queued', seq: 10 });
			await barrier(recovering.socket, 'queued progress');
			const active = replace ? await reconnect() : recovering;
			if (replace) {
				expect(active.frame.recover.room).toEqual({ offset: 10, epoch: 7 });
				send(active.socket, { type: 'subscribed', topic: 'room', ref: active.frame.ref, epoch: 7 });
			}
			send(active.socket, { type: 'lease', count: 1, ttlMs: 60000 });
			if (!replace) await waitFor(() => requests.filter(value => value.socket === active.socket).length === 2);
			send(active.socket, { topic: 'room', event: 'put', data: 'after lease', seq: 20 });
			await barrier(active.socket, 'lease completed');
			expect(requests.filter(value => value.socket === active.socket)).toHaveLength(replace ? 1 : 2);
			if (!replace) expect(requests.filter(value => value.socket === active.socket)[1].frame.recover.room).toEqual({ offset: 1, epoch: 7 });
			expect((await reconnect()).frame.recover.room).toEqual({ offset: replace ? 20 : 1, epoch: 7 });
		});
	}

	for (const resubscribe of [false, true]) {
		it('does not revive a released flow-controlled retry: resubscribe=' + resubscribe, async () => {
			const recovering = await reconnect();
			send(recovering.socket, { type: 'lease-ok' });
			send(recovering.socket, { type: 'lease', count: 0, ttlMs: 60000 });
			send(recovering.socket, { type: 'subscribe-denied', topic: 'room', ref: recovering.frame.ref, reason: 'RATE_LIMITED' });
			await waitFor(() => frames.some(value => value.socket === recovering.socket && value.frame.type === 'request-n' && value.frame.queued === 1));
			unsubscribe(); unsubscribe = null;
			await waitFor(() => frames.some(value => value.socket === recovering.socket && value.frame.type === 'unsubscribe'));
			if (resubscribe) unsubscribe = connection.on('room').subscribe(() => {});
			await pause(0);
			send(recovering.socket, { type: 'lease', count: 8, ttlMs: 60000 });
			await barrier(recovering.socket, 'release settled');
			const sent = requests.filter(value => value.socket === recovering.socket);
			expect(sent).toHaveLength(resubscribe ? 2 : 1);
			if (resubscribe) expect(sent[1].frame.recover).toBeUndefined();
		});
	}

	it('keeps wanted topics when one member of a queued recovery batch is released', async () => {
		const stopOther = connection.on('other').subscribe(() => {});
		try {
			await waitFor(() => requests.length === 2);
			send(peers[0], { type: 'subscribed', topic: 'other', ref: requests[1].frame.ref, epoch: 7 });
			send(peers[0], { topic: 'other', event: 'put', data: 'other initial', seq: 2 });
			await barrier(peers[0], 'other ready');
			const recovering = await reconnect();
			send(recovering.socket, { type: 'lease-ok' });
			send(recovering.socket, { type: 'lease', count: 0, ttlMs: 60000 });
			for (const topic of ['room', 'other']) send(recovering.socket, { type: 'subscribe-denied', topic, ref: recovering.frame.ref, reason: 'RATE_LIMITED' });
			await waitFor(() => frames.some(value => value.socket === recovering.socket && value.frame.type === 'request-n' && value.frame.queued === 1));
			unsubscribe(); unsubscribe = null;
			send(recovering.socket, { type: 'lease', count: 1, ttlMs: 60000 });
			await waitFor(() => requests.filter(value => value.socket === recovering.socket).length === 2);
			const retry = requests.filter(value => value.socket === recovering.socket)[1].frame;
			expect(retry.topics).toEqual(['other']);
			expect(retry.recover).toEqual({ other: { offset: 2, epoch: 7 } });
			send(recovering.socket, { topic: 'other', event: 'put', data: 'other ahead', seq: 20 });
			await barrier(recovering.socket, 'partial retry');
			const next = await reconnect();
			expect(next.frame.topics).toEqual(['other']);
			expect(next.frame.recover).toEqual({ other: { offset: 2, epoch: 7 } });
		} finally { stopOther(); }
	});

});
