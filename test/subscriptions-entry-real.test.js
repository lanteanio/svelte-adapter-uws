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

	it('enters the worker\'s shared cohort on a topic that is already shared', async () => {
		// The helpers reach the cohort through the connection's platform, not
		// through anything the runtime installs in the plugin's module copy, so
		// this is the case that fails if the slot and the lookup ever disagree.
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);
		const frames = { wireIds: [], binary: [], probes: [], envelopes: [] };
		ws.on('message', (data, isBinary) => {
			if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
			try {
				const obj = JSON.parse(data.toString());
				if (obj?.type === 'wire-id') frames.wireIds.push(obj);
				else if (obj?.topic === 'probe') frames.probes.push(obj);
				else if (obj?.topic !== undefined && obj?.event !== undefined) frames.envelopes.push(obj);
			} catch { /* not JSON */ }
		});
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
		const send = (msg) => ws.send(JSON.stringify(msg));
		const until = async (pred, what) => {
			const deadline = Date.now() + 3000;
			while (!pred()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		try {
			const topic = '__probe:shared-tracked';
			send({ type: 'hello', caps: ['fixture.shared:1'] });
			// Shared before anyone holds it: this connection is capable, so the
			// publish takes the cohort split and registers the topic.
			send({ type: 'shared-publish', topic, n: 1 });
			send({ type: 'membership-probe', mode: 'tracked', topic, nonce: 10 });
			await until(() => frames.probes.some((p) => p.event === 'membership-done' && p.data?.nonce === 10), 'the tracked join');
			await until(() => frames.wireIds.length >= 1, 'the shared id announce');
			send({ type: 'shared-publish', topic, n: 2 });
			await until(() => frames.binary.length >= 1, 'the shared frame');
			expect(frames.wireIds).toHaveLength(1);
			expect(frames.wireIds[0].topic).toBe(topic);

			// And the tracked leave takes it out again. The probe answered after
			// the publish is the fence: the publish's frames leave first.
			send({ type: 'membership-probe', mode: 'tracked-leave', topic, nonce: 11 });
			send({ type: 'shared-publish', topic, n: 3 });
			send({ type: 'membership-probe', mode: 'noop', topic, nonce: 12 });
			await until(() => frames.probes.some((p) => p.event === 'membership-done' && p.data?.nonce === 12), 'the fence');
			expect(frames.binary, 'no frame after the tracked leave').toHaveLength(1);
			expect(frames.envelopes.filter((e) => e.topic === topic), 'and no envelope either').toHaveLength(0);
		} finally {
			ws.terminate();
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
