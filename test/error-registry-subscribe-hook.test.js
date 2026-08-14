// ADAPTER-ERR-SUBSCRIBE-HOOK, driven from the condition it claims.
//
// The entry's load-bearing promise is the DISTINCTION: a throwing hook denies
// with INTERNAL_ERROR while a refusing hook denies with FORBIDDEN, so the
// reason on the wire tells the client whether it is looking at a defect or at
// a permissions decision. A prose pass cannot check that; only reaching both
// conditions through the real runtime and comparing the frames can.
//
// Real runtime, real socket: src/testing.js reimplements this path by hand and
// does not emit the operational event at all, so nothing short of the built
// handler proves what the registry documents. The fixture variant exports ONLY
// a per-topic `subscribe` hook - with a `subscribeBatch` export present the
// runtime would route around the path this entry describes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';

const describeUWS = hasUWS ? describe : describe.skip;

const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.SUBSCRIBE_HOOK);

describeUWS('ADAPTER-ERR-SUBSCRIBE-HOOK', () => {
	let server;
	let client;
	/** @type {any[]} */
	const events = [];
	/** @type {() => void} */
	let disposeSink;

	// The sink slot is a process-wide Symbol.for global, which is exactly why a
	// sink installed from the source module observes what the BUILT runtime
	// emits: both graphs read the same slot at emit time.
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'subhook' });
		disposeSink = setOperationalEventSink((record) => { events.push(record); });
		client = await connectRealClient(server.wsUrl);
	}, 400000);

	afterAll(async () => {
		client?.close();
		disposeSink?.();
		await server?.stop();
	});

	/** The operational events emitted after `from`, for one probe. */
	const emittedAfter = (from) => events.slice(from);

	it('reports a throwing hook as a fault: INTERNAL_ERROR on the wire, the documented event in the log', async () => {
		const before = events.length;
		client.send({ type: 'subscribe', topic: 'hook-throw:secret', ref: 101 });
		const denied = await client.waitFor((f) => f?.type === 'subscribe-denied' && f.ref === 101);
		expect(denied, 'no denial frame arrived').not.toBeNull();
		expect(denied.parsed.reason).toBe('INTERNAL_ERROR');
		expect(denied.parsed.topic).toBe('hook-throw:secret');

		// The denial must be real, not just an answer: the server holds no
		// membership for the topic it refused.
		client.send({ type: 'count', topic: 'hook-throw:secret' });
		const count = await client.waitFor((f) => f?.event === 'count' && f.data?.topic === 'hook-throw:secret');
		expect(count, 'the count probe must answer').not.toBeNull();
		expect(count.parsed.data.count).toBe(0);

		const mine = emittedAfter(before).filter((r) => r.event === 'subscribe.hook-failed');
		expect(mine.length).toBe(1);
		const record = mine[0];
		expect(record.component).toBe('runtime.subscribe');
		expect(record.severity).toBe('error');
		// `direct` emission: the record's message IS the registry's search key.
		// An operator pasting the line they saw must land on this entry.
		expect(record.message).toBe(entry.problemPrefix);
		// nextAction says to read the attached error; the record has to carry it.
		expect(record.attributes?.error?.message).toContain('subscribe hook probe fault');
		expect(entry.nextAction).toMatch(/attached error/i);
	});

	it('reports a refusing hook as a refusal: FORBIDDEN on the wire, and no fault event', async () => {
		const before = events.length;
		client.send({ type: 'subscribe', topic: 'hook-false:secret', ref: 102 });
		const denied = await client.waitFor((f) => f?.type === 'subscribe-denied' && f.ref === 102);
		expect(denied, 'no denial frame arrived').not.toBeNull();
		expect(denied.parsed.reason).toBe('FORBIDDEN');

		// The distinction the entry promises: a refusal is not reported as a
		// fault. An event here would tell an operator their hook is broken every
		// time it correctly denies someone.
		expect(emittedAfter(before).filter((r) => r.event === 'subscribe.hook-failed')).toEqual([]);
	});

	it('allows what the hook allows, so the two denials above are decisions rather than a dead path', async () => {
		client.send({ type: 'subscribe', topic: 'open-room', ref: 103 });
		const ack = await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 103);
		expect(ack, 'no subscribed ack arrived').not.toBeNull();
		expect(ack.parsed.topic).toBe('open-room');
	});

	it('runs the hook again on retry, exactly as the entry says recovery works', async () => {
		// automaticRecovery: "None. The client may retry the subscribe, which
		// runs the hook again." A runtime that cached the first INTERNAL_ERROR
		// verdict would make that sentence false in the direction that strands a
		// client after the hook is fixed.
		const before = events.length;
		client.send({ type: 'subscribe', topic: 'hook-throw:retry', ref: 104 });
		const first = await client.waitFor((f) => f?.type === 'subscribe-denied' && f.ref === 104);
		client.send({ type: 'subscribe', topic: 'hook-throw:retry', ref: 105 });
		const second = await client.waitFor((f) => f?.type === 'subscribe-denied' && f.ref === 105);
		expect(first?.parsed.reason).toBe('INTERNAL_ERROR');
		expect(second?.parsed.reason).toBe('INTERNAL_ERROR');
		expect(emittedAfter(before).filter((r) => r.event === 'subscribe.hook-failed').length).toBe(2);
		expect(entry.automaticRecovery).toMatch(/^None\./);
		expect(entry.automaticRecovery).toMatch(/runs the hook again/);
	});

	it('keeps the prose bound to the distinction the frames just showed', () => {
		// Both reasons appear in the consequence because the consequence IS the
		// contrast; guidance that lost either half would read all-clear under
		// the failure it describes.
		expect(entry.consequence).toContain('INTERNAL_ERROR');
		expect(entry.consequence).toContain('FORBIDDEN');
		expect(entry.nextAction).toMatch(/defect, not a permissions decision/);
	});
});
