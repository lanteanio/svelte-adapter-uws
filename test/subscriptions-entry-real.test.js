// svelte-adapter-uws/subscriptions keeps the worker's subscription accounting
// in step with the connection registries, on the built runtime.
//
// A plugin that joins a topic outside the wire protocol by calling
// ws.subscribe and writing the registry itself grows the registry without
// charging the counter the consistency auditor compares it with - the
// subs.total-mismatch drift, and the negative total after the close releases
// it. The built fixture imports the public entry the way a plugin package
// does, so this drives the helpers through a module instance of their own and
// reads the runtime's state directly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');

describeUWS('accounted membership through svelte-adapter-uws/subscriptions', () => {
	let server;
	let state;
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
		state = await import('./fixture/build/handler/state.js');
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	const summed = () => {
		let total = 0;
		for (const ws of state.wsConnections) total += ws.getUserData()[SUBSCRIPTIONS]?.size ?? 0;
		return total;
	};

	async function probe(client, mode, topic, nonce) {
		client.send({ type: 'membership-probe', mode, topic, nonce });
		const done = await client.waitFor((m) => m?.event === 'membership-done' && m?.data?.nonce === nonce, 3000);
		expect(done, `${mode} ${topic} answered`).toBeTruthy();
	}

	it('charges and releases the counter with the registry', async () => {
		const client = await connectRealClient(server.wsUrl);
		try {
			await client.waitFor((m) => m?.type === 'welcome', 3000);
			const baseTotal = state.counters.totalSubscriptions;
			const baseSum = summed();

			await probe(client, 'tracked', '__probe:tracked', 1);
			expect(summed()).toBe(baseSum + 1);
			expect(state.counters.totalSubscriptions, 'the join is charged').toBe(baseTotal + 1);

			await probe(client, 'tracked-leave', '__probe:tracked', 2);
			expect(summed()).toBe(baseSum);
			expect(state.counters.totalSubscriptions, 'the leave is released').toBe(baseTotal);
		} finally {
			client.close();
		}
	});

	it('shows the drift a hand-written registry entry causes', async () => {
		// The control that gives the case above its meaning: the same join done
		// by hand moves the registry and not the counter.
		const client = await connectRealClient(server.wsUrl);
		try {
			await client.waitFor((m) => m?.type === 'welcome', 3000);
			const baseTotal = state.counters.totalSubscriptions;
			const baseSum = summed();
			await probe(client, 'raw', '__probe:raw', 3);
			expect(summed()).toBe(baseSum + 1);
			expect(state.counters.totalSubscriptions).toBe(baseTotal);
		} finally {
			client.close();
		}
	});
});
