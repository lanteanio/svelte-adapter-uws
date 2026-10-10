import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { writable } from 'svelte/store';
import { parseBinaryFrame } from '../src/runtime/wire.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('module store deadline');
		await pause(5);
	}
}

describe('module stores across explicit connection replacement', () => {
	let client, server, connection, peers, frames, stops, warnings;
	beforeEach(async () => {
		vi.resetModules();
		client = await import('../src/client.js');
		peers = []; frames = []; stops = [];
		warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:' + server.address().port } });
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', (bytes, binary) => frames.push({ socket, binary, value: binary ? bytes : JSON.parse(bytes.toString()) }));
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
		await client.ready();
	});
	afterEach(async () => {
		for (const stop of stops) stop();
		connection?.close(); client.connect().close();
		for (const peer of server.clients) peer.terminate();
		await new Promise(resolve => server.close(resolve));
		warnings.mockRestore(); vi.unstubAllGlobals();
	});
	function observe(store) {
		const values = [];
		stops.push(store.subscribe(value => values.push(value)));
		return values;
	}
	function send(frame) { peers.at(-1).send(JSON.stringify(frame)); }
	async function replace() {
		connection.close();
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
		await client.ready();
		await waitFor(() => peers.length === 2);
	}
	it('moves active global diagnostics, topic stores and accumulated helpers to the new socket', async () => {
		const statuses = observe(client.status), failures = observe(client.failure);
		const denials = observe(client.denials), overloads = observe(client.overloads);
		const events = observe(client.on('room')), payloads = observe(client.on('room', 'created'));
		const derived = observe(client.onDerived(value => value, writable('room')));
		const arrays = observe(client.crud('room')), agedArrays = observe(client.crud('room', [], { maxAge: 60000 }));
		const maps = observe(client.lookup('room')), agedMaps = observe(client.lookup('room', [], { maxAge: 60000 }));
		const latest = observe(client.latest('room')), counts = observe(client.count('counter'));
		const bound = observe(connection.on('room'));
		send({ topic: 'room', event: 'created', data: { id: 'first' } });
		await waitFor(() => arrays.at(-1).length === 1);
		await replace();
		send({ topic: 'room', event: 'created', data: { id: 'second' } });
		send({ topic: 'counter', event: 'increment', data: 3 });
		send({ type: 'subscribe-denied', topic: 'private', reason: 'FORBIDDEN', ref: 71 });
		send({ type: 'message-overloaded', reason: 'RATE_LIMITED', scope: 'connection' });
		await waitFor(() => events.some(event => event?.data?.id === 'second') && counts.at(-1) === 3 && overloads.at(-1)?.scope === 'connection');
		expect(statuses.slice(-3)).toEqual(['failed', 'connecting', 'open']);
		expect(payloads.at(-1)).toEqual({ data: { id: 'second' } });
		expect(derived.at(-1)?.data).toEqual({ id: 'second' });
		for (const values of [arrays, agedArrays]) expect(values.at(-1)).toEqual([{ id: 'first' }, { id: 'second' }]);
		for (const values of [maps, agedMaps]) expect(values.at(-1)).toEqual({ first: { id: 'first' }, second: { id: 'second' } });
		expect(latest.at(-1).map(event => event.data)).toEqual([{ id: 'first' }, { id: 'second' }]);
		expect(counts.at(-1)).toBe(3);
		expect(denials.at(-1)).toEqual({ topic: 'private', reason: 'FORBIDDEN', ref: 71 });
		expect(overloads.at(-1)).toEqual({ reason: 'RATE_LIMITED', scope: 'connection' });
		expect(bound.some(event => event?.data?.id === 'second')).toBe(false);
		peers.at(-1).close(4403, 'denied');
		await waitFor(() => failures.at(-1)?.class === 'TERMINAL');
	});
	it('keeps late accessors and plugin construction inert after close until an explicit connect', async () => {
		connection.close();
		const statuses = observe(client.status);
		observe(client.on('late')); observe(client.failure); observe(client.denials); observe(client.overloads);
		const binding = client.bindIngress('test:1', { topic: 'late' });
		stops.push(() => binding.dispose());
		const { createSmoothChannel } = await import('../src/plugins/smooth/client.js');
		const { createCrdtChannel } = await import('../src/plugins/crdt/channel.js');
		const smooth = createSmoothChannel({ apply: state => state, initial: { x: 0 }, transport: { ingress: { topic: 'late' }, sendCommand() {}, async sync() { return null; } } });
		const crdt = createCrdtChannel({ transport: { sendUpdate() {}, async sync() { return null; } }, reconcileIntervalMs: 0 });
		stops.push(() => smooth.destroy(), () => crdt.destroy());
		await pause(40);
		expect(peers).toHaveLength(1);
		expect(statuses).toEqual(['failed']);
		expect(binding.live()).toBe(false);
		await expect(client.ready()).rejects.toThrow();
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port });
		await client.ready();
		await waitFor(() => peers.length === 2);
		expect(statuses.at(-1)).toBe('open');
	});
	it('preserves replacement ownership when an old failed subscriber reconnects synchronously', async () => {
		const old = connection;
		let armed = false, replacement;
		stops.push(client.status.subscribe(value => {
			if (armed && value === 'failed' && !replacement) replacement = client.connect({ url: 'ws://127.0.0.1:' + server.address().port });
		}));
		const values = observe(client.on('room'));
		armed = true; old.close();
		connection = replacement;
		await client.ready();
		await waitFor(() => peers.length === 2);
		old.close();
		expect(client.connect()).toBe(replacement);
		send({ topic: 'room', event: 'created', data: { id: 'fresh' } });
		await waitFor(() => values.at(-1)?.data?.id === 'fresh');
		expect(peers).toHaveLength(2);
	});
	it('rebinds binary ingress, preserves reannounce and disposes the current handle', async () => {
		const binding = client.bindIngress('probe:1', { topic: 'room' });
		stops.push(() => binding.dispose());
		for (let round = 0; round < 2; round++) {
			if (round) await replace();
			const peer = peers.at(-1);
			send({ type: 'ingress-ok' });
			await waitFor(() => frames.some(value => value.socket === peer && value.value.type === 'ingress-bind'));
			const announce = frames.find(value => value.socket === peer && value.value.type === 'ingress-bind').value;
			expect(announce).toMatchObject({ kind: 'probe:1', target: { topic: 'room' } });
			binding.reannounce();
			await waitFor(() => frames.filter(value => value.socket === peer && value.value.type === 'ingress-bind').length === 2);
			send({ type: 'ingress-bound', id: announce.id });
			await waitFor(() => binding.live());
			expect(binding.send(1, new Uint8Array([4, 5, round]))).toBe(true);
			await waitFor(() => frames.some(value => value.socket === peer && value.binary));
			const parsed = parseBinaryFrame(frames.find(value => value.socket === peer && value.binary).value);
			expect(parsed.topicId).toBe(announce.id);
			expect(Array.from(parsed.payload)).toEqual([4, 5, round]);
		}
		binding.dispose();
		expect(binding.live()).toBe(false);
		expect(binding.send(1, new Uint8Array([1]))).toBe(false);
	});
	it('preserves managed-topic ownership and releases inactive followers before reconnect', async () => {
		client.setTopicManaged('managed');
		const managed = observe(client.on('managed'));
		const stopInactive = client.on('inactive').subscribe(() => {});
		stopInactive();
		const late = client.on('late');
		await replace();
		const lateValues = observe(late);
		send({ topic: 'managed', event: 'put', data: 'managed value' });
		send({ topic: 'late', event: 'put', data: 'late value' });
		await waitFor(() => managed.at(-1)?.data === 'managed value' && lateValues.at(-1)?.data === 'late value');
		const subscriptions = frames.filter(value => value.socket === peers.at(-1) && ['subscribe', 'subscribe-batch'].includes(value.value.type));
		const topics = subscriptions.flatMap(value => value.value.topics ?? [value.value.topic]);
		expect(topics).not.toContain('managed');
		expect(topics).not.toContain('inactive');
		expect(topics).toContain('late');
	});

	it('ignores a replaced connection releasing a server-managed topic still followed globally', async () => {
		client.setTopicManaged('managed');
		const releaseOld = connection.on('managed').subscribe(() => {});
		let stopOld = () => { releaseOld(); stopOld = () => {}; };
		stops.push(() => stopOld());
		const values = observe(client.on('managed'));
		await replace();
		stopOld();
		connection.close();
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port });
		await client.ready();
		await waitFor(() => peers.length === 3);
		send({ topic: 'managed', event: 'put', data: 'third connection' });
		await waitFor(() => values.at(-1)?.data === 'third connection');
		const subscriptions = frames.filter(value => value.socket === peers.at(-1) && ['subscribe', 'subscribe-batch'].includes(value.value.type));
		expect(subscriptions.flatMap(value => value.value.topics ?? [value.value.topic])).not.toContain('managed');
	});

});
