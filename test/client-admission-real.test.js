import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as client from '../src/client.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('client admission deadline');
		await pause(5);
	}
}

describeUWS('local send admission on the actual client', () => {
	let server, connection;
	beforeAll(async () => { server = await startRealRuntime(); }, 400000);
	afterEach(() => { connection?.close(); connection = undefined; });
	afterAll(async () => { await server?.stop(); });

	it('reports admission only for frames delivered through the open socket', async () => {
		connection = client.connect({ url: server.wsUrl, maxReconnectAttempts: 0 });
		const states = [], received = [];
		connection.status.subscribe(value => states.push(value));
		connection.events.subscribe(value => { if (value?.event === 'echo') received.push(value.data); });
		expect(connection.send({ type: 'echo', payload: 'connecting' })).toBe(false);
		await waitFor(() => states.at(-1) === 'open');
		expect(connection.send({ type: 'echo', payload: 'text' })).toBe(true);
		expect(connection.send(new TextEncoder().encode(JSON.stringify({ type: 'echo', payload: 'binary' })))).toBe(true);
		await waitFor(() => received.includes('binary'));
		expect(received).toEqual(['text', 'binary']);
		const cyclic = {}; cyclic.self = cyclic;
		expect(() => connection.send(cyclic)).toThrow(TypeError);
		connection.close();
		expect(connection.send({ type: 'echo', payload: 'closed' })).toBe(false);
	});

	it('does not admit a frame when serialization closes the socket', async () => {
		connection = client.connect({ url: server.wsUrl });
		let state;
		connection.status.subscribe(value => { state = value; });
		await waitFor(() => state === 'open');
		expect(connection.send({ toJSON() { connection.close(); return { type: 'echo', payload: 'closed' }; } })).toBe(false);
		expect(state).toBe('failed');
	});
});
