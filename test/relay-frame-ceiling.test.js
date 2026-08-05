// The cluster relay refuses a frame that is too large for it, at the SENDER,
// and refuses to reassemble one at the READER.
//
// WHY BOTH ENDS. The per-peer spill ceilings describe a receiving worker's
// failure to drain. Size is a different question with a different answer: it is
// a property of the frame, it is identical for every peer, and it is nobody's
// fault - so it cannot be answered by quarantining whoever happened to receive
// it, which is what used to happen and what took the whole cluster down.
//
// Deciding it once at the sender is also the only way every peer gets the SAME
// answer. A per-peer refusal would leave some siblings holding a frame the
// others never saw, and with stream tracking off by default nothing would
// notice.
//
// The sender's ceiling alone is only a policy, though: the reader's accumulator
// grows to hold a WHOLE frame before the consumer sees any of it - that is how a
// frame larger than the ring streams through in pieces - so a peer that does not
// apply the ceiling, or a corrupt length prefix, would still make this process
// allocate for it. The reader therefore decides from the length PREFIX, before
// it commits to holding the frame.

import { describe, it, expect, afterEach } from 'vitest';
import {
	createRelayRingBuffer,
	encodePublishFrame,
	RingReader,
	RingWriter
} from '../src/runtime/relay-ring.js';
import { relayBatched, batchRelay, setRelayFrameCeiling } from '../src/runtime/handler/relay.js';

afterEach(() => {
	setRelayFrameCeiling(0, null);
});

describe('the cluster relay refuses a frame too large to carry', () => {
	it('refuses an oversized batched publish at the sender, and says so', () => {
		const refusals = [];
		setRelayFrameCeiling(1024, (...args) => refusals.push(args));

		// No ring writer is wired here, so an ADMITTED relay would fall through to
		// `parentPort.postMessage` - and `parentPort` is null outside a worker.
		// That is the vacuity guard for this whole file: a refusal is the only
		// reason this call can return without throwing.
		//
		// The entry shape is the PRODUCTION shape: platform.publishBatched relays
		// `{ topic, env, seq }`, with the envelope under `env`. The first version
		// of this file invented `envelope` here, and the ceiling read the same
		// invented field - so the suite was green while every clustered
		// publishBatched crashed on the real shape.
		relayBatched([{ topic: 'room', env: 'x'.repeat(4096), seq: null }], false);

		expect(refusals).toEqual([['batched', 'room', 4096, 1024]]);
	});

	it('lets an admitted batched publish reach the transport', () => {
		const refusals = [];
		setRelayFrameCeiling(1024, (...args) => refusals.push(args));

		// Under the ceiling, so it is handed on - and reaching the null
		// `parentPort` is what proves it got that far rather than being dropped.
		expect(() => relayBatched([{ topic: 'room', env: 'x'.repeat(16), seq: null }], false)).toThrow();
		expect(refusals, 'refused a publish that was under the ceiling').toEqual([]);
	});

	it('refuses an oversized single publish on the other lane too', async () => {
		const refusals = [];
		setRelayFrameCeiling(1024, (...args) => refusals.push(args));

		// A cap on one send site leaves the bug reachable through the other: this
		// lane batches per tick and encodes per message, so it is a separate
		// decision point from the batched lane above.
		batchRelay('room', 'y'.repeat(4096), false, null, undefined, undefined, undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(refusals).toEqual([['publish', 'room', 4096, 1024]]);
	});

	it('applies the ceiling with no ring configured, which is a documented setup', () => {
		// `CLUSTER_RELAY_RING_KB=0` routes every relay through postMessage. The
		// ceiling is checked ABOVE that split precisely so disabling the ring does
		// not silently disable the protection with it - the way the per-peer spill
		// ceilings are disabled by it.
		const refusals = [];
		setRelayFrameCeiling(512, (...args) => refusals.push(args));

		relayBatched([{ topic: 'room', env: 'z'.repeat(2048), seq: null }], false);

		expect(refusals).toEqual([['batched', 'room', 2048, 512]]);
	});

	it('does not reassemble a frame larger than the reader will hold', async () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab);
		const oversized = [];
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(frame), {
			maxFrameBytes: 2048,
			onOversized: (event) => oversized.push(event)
		});
		reader.start();

		// Far larger than the reader's ceiling AND than the ring, so without the
		// prefix check the accumulator would grow to hold all of it before the
		// consumer was ever offered a frame.
		const envelope = JSON.stringify({ doc: 'q'.repeat(32 * 1024) });
		writer.write(encodePublishFrame('room', envelope, false, 1, undefined, undefined, undefined));
		writer.notify();

		for (let i = 0; i < 100 && oversized.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(oversized.length, 'the reader reassembled a frame past its ceiling').toBe(1);
		expect(oversized[0].maxFrameBytes).toBe(2048);
		expect(oversized[0].declaredBytes).toBeGreaterThan(2048);
		expect(seen, 'delivered a frame it had refused to hold').toEqual([]);
		expect(reader.closed).toBe(true);
	});

	it('reassembles a frame the reader will hold, so the refusal is not blanket', async () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab);
		const oversized = [];
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(frame), {
			maxFrameBytes: 128 * 1024,
			onOversized: (event) => oversized.push(event)
		});
		reader.start();

		// Still far larger than the RING, so it streams through in pieces - which
		// is the behaviour the byte stream exists for and must survive the ceiling.
		const envelope = JSON.stringify({ doc: 'q'.repeat(32 * 1024) });
		writer.write(encodePublishFrame('room', envelope, false, 1, undefined, undefined, undefined));
		writer.notify();

		for (let i = 0; i < 200 && seen.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(oversized, 'refused a frame that was under the ceiling').toEqual([]);
		expect(seen.length, 'a frame larger than the ring must still stream through').toBe(1);
		reader.close();
	});
});
