import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as client from '../src/client.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('client state or delivered frame deadline');
		await pause(5);
	}
}

describeUWS('public offline controls on the actual client and built runtime', () => {
	let server, platform, wsConnections, connection, states, events;
	beforeAll(async () => {
		// Node supplies its native browser-compatible WebSocket. No replacement
		// constructor, browser event dispatch or synthetic transport is installed.
		expect(typeof globalThis.WebSocket).toBe('function');
		server = await startRealRuntime();
		({ platform } = await import('./fixture/build/handler/platform.js'));
		({ wsConnections } = await import('./fixture/build/handler/state.js'));
	}, 400000);
	afterEach(async () => { connection?.close(); connection = undefined; await waitFor(() => wsConnections.size === 0); });
	afterAll(async () => { await server?.stop(); });
	function connect(options = {}) {
		connection = client.connect({ url: server.wsUrl, auth: true, reconnectInterval: 10, maxReconnectAttempts: 0, ...options });
		states = []; events = [];
		connection.status.subscribe(value => states.push(value));
		connection.events.subscribe(value => { if (value) events.push(value); });
		return connection;
	}
	const echo = value => events.some(event => event.event === 'echo' && event.data === value);

	it('reports local admission and restores subscriptions, listeners and FIFO messages on resume', async () => {
		connect(); const received = [];
		const unsubscribe = connection.on('pause-topic').subscribe(value => { if (value) received.push(value.data); });
		await waitFor(() => states.at(-1) === 'open' && platform.subscribers('pause-topic') === 1);
		expect(connection.send({ type: 'echo', payload: 'before' })).toBe(true);
		await waitFor(() => echo('before'));
		platform.publish('pause-topic', 'update', 'before', { seq: false, relay: false });
		await waitFor(() => received.includes('before'));
		connection.simulateOffline(); connection.simulateOffline();
		expect(states.at(-1)).toBe('disconnected');
		expect(connection.send({ type: 'echo', payload: 'dropped' })).toBe(false);
		connection.sendQueued({ type: 'echo', payload: 'queued-text' });
		connection.sendQueued(new TextEncoder().encode(JSON.stringify({ type: 'echo', payload: 'queued-bytes' })));
		await waitFor(() => wsConnections.size === 0);
		await pause(60);
		expect(states.at(-1)).toBe('disconnected');
		expect(states).not.toContain('failed');
		expect(received).toEqual(['before']);
		connection.resumeOnline(); connection.resumeOnline();
		await waitFor(() => states.at(-1) === 'open' && platform.subscribers('pause-topic') === 1 && echo('queued-bytes'));
		expect(events.filter(event => event.event === 'echo').map(event => event.data)).toEqual(['before', 'queued-text', 'queued-bytes']);
		platform.publish('pause-topic', 'update', 'after', { seq: false, relay: false });
		await waitFor(() => received.includes('after'));
		expect(received).toEqual(['before', 'after']);
		expect(wsConnections.size).toBe(1);
		unsubscribe();
	});

	it('cancels the initial attempt and resumes without a late close muting its replacement', async () => {
		connect({ auth: false });
		connection.simulateOffline();
		expect(states.at(-1)).toBe('disconnected');
		connection.resumeOnline();
		await waitFor(() => states.at(-1) === 'open');
		expect(connection.send({ type: 'echo', payload: 'replacement' })).toBe(true);
		await waitFor(() => echo('replacement'));
		await pause(40);
		expect(states.at(-1)).toBe('open');
		expect(wsConnections.size).toBe(1);
	});

	it('can pause a real remote drop before retry exhaustion and resume the same connection', async () => {
		connect(); await waitFor(() => states.at(-1) === 'open');
		const stop = connection.status.subscribe(status => { if (status === 'disconnected') connection.simulateOffline(); });
		expect(connection.send({ type: 'drop-probe' })).toBe(true);
		await waitFor(() => states.at(-1) === 'disconnected' && wsConnections.size === 0);
		await pause(60);
		expect(states).not.toContain('failed');
		stop(); connection.resumeOnline();
		await waitFor(() => states.at(-1) === 'open');
		expect(connection.send({ type: 'echo', payload: 'after-drop' })).toBe(true);
		await waitFor(() => echo('after-drop'));
	});

	it('preserves queued bytes when a real open-status subscriber pauses immediately', async () => {
		connect(); connection.sendQueued({ type: 'echo', payload: 'survives-open-pause' });
		let once = true;
		connection.status.subscribe(status => { if (status === 'open' && once) { once = false; connection.simulateOffline(); } });
		await waitFor(() => states.at(-1) === 'disconnected' && !once && wsConnections.size === 0);
		expect(echo('survives-open-pause')).toBe(false);
		connection.resumeOnline();
		await waitFor(() => echo('survives-open-pause'));
		expect(events.filter(event => event.event === 'echo')).toHaveLength(1);
	});

	it.each(['close', 'server refusal'])('cannot revive permanent %s', async mode => {
		connect(); await waitFor(() => states.at(-1) === 'open');
		if (mode === 'close') { connection.simulateOffline(); connection.close(); }
		else connection.send({ type: 'end-probe', code: 4401, reason: 'denied' });
		await waitFor(() => states.at(-1) === 'failed' && wsConnections.size === 0);
		connection.simulateOffline(); connection.resumeOnline();
		await pause(60);
		expect(states.at(-1)).toBe('failed');
		expect(wsConnections.size).toBe(0);
		expect(connection.send({ type: 'echo', payload: 'never' })).toBe(false);
	});
});
