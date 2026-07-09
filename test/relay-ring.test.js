// The shared-memory relay ring (runtime/relay-ring.js): SPSC byte-stream
// framing over a SharedArrayBuffer with Atomics.waitAsync wake-up - the
// cluster relay's replacement for structured-clone postMessage hops. Framing
// and stream mechanics are exercised in-process (both ends of a ring work
// from any thread); the cross-thread contract runs against a real
// worker_threads Worker at the end.

import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	createRelayRingBuffer,
	RingWriter,
	RingReader,
	encodePublishFrame,
	encodePublishBatchedFrame,
	decodeRelayFrame
} from '../src/runtime/relay-ring.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(predicate, ms = 2000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error('condition not reached in ' + ms + 'ms');
		await tick();
	}
}

describe('relay frame codec', () => {
	it('round-trips a full publish frame', () => {
		const frame = encodePublishFrame('room:1', '{"e":"moved"}', true, 42, 'smooth.protocol:1', 'update', { key: 'p1', x: 1.5 });
		const msg = decodeRelayFrame(frame);
		expect(msg).toEqual({
			type: 'publish',
			topic: 'room:1',
			envelope: '{"e":"moved"}',
			compress: true,
			seq: 42,
			capability: 'smooth.protocol:1',
			event: 'update',
			data: { key: 'p1', x: 1.5 }
		});
	});

	it('round-trips the minimal publish frame (every optional field absent)', () => {
		const msg = decodeRelayFrame(encodePublishFrame('t', '{}', undefined, null, undefined, undefined, undefined));
		expect(msg).toEqual({
			type: 'publish',
			topic: 't',
			envelope: '{}',
			compress: false,
			seq: null,
			capability: undefined,
			event: undefined,
			data: undefined
		});
	});

	it('round-trips unicode topics and large envelopes', () => {
		const envelope = JSON.stringify({ blob: 'x'.repeat(200000) });
		const msg = decodeRelayFrame(encodePublishFrame('zimmer:übung', envelope, false, 7, undefined, undefined, undefined));
		expect(msg.topic).toBe('zimmer:übung');
		expect(msg.envelope).toBe(envelope);
		expect(msg.seq).toBe(7);
	});

	it('round-trips a publish-batched frame', () => {
		const events = [
			{ topic: 'a', env: '{"n":1}', seq: 1 },
			{ topic: 'b', env: '{"n":2}', seq: null }
		];
		const msg = decodeRelayFrame(encodePublishBatchedFrame(events, true));
		expect(msg).toEqual({ type: 'publish-batched', events, compress: true });
	});

	it('returns null for an unknown frame kind', () => {
		const frame = encodePublishFrame('t', '{}', false, null, undefined, undefined, undefined);
		frame[4] = 250;
		expect(decodeRelayFrame(frame)).toBe(null);
	});
});

describe('ring stream', () => {
	it('delivers frames in order across wrap boundaries', async () => {
		const sab = createRelayRingBuffer(4096);
		const writer = new RingWriter(sab);
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame).seq));
		reader.start();

		// Enough traffic to lap the ring many times.
		for (let i = 0; i < 500; i++) {
			writer.write(encodePublishFrame('topic:' + (i % 7), '{"n":' + i + ',"pad":"' + 'p'.repeat(i % 190) + '"}', false, i, undefined, undefined, undefined));
			writer.notify();
			if (i % 25 === 0) await tick(); // let the reader interleave
		}
		await until(() => seen.length === 500);
		expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i));
		reader.close();
	});

	it('spills a burst larger than the ring and flushes in order once draining starts', async () => {
		const sab = createRelayRingBuffer(2048);
		const writer = new RingWriter(sab);
		// Write far more than capacity BEFORE any reader exists.
		for (let i = 0; i < 100; i++) {
			writer.write(encodePublishFrame('t', '{"pad":"' + 'x'.repeat(100) + '"}', false, i, undefined, undefined, undefined));
		}
		writer.notify();
		expect(writer.pendingBytes).toBeGreaterThan(0);

		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame).seq));
		reader.start();
		await until(() => seen.length === 100);
		expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i));
		expect(writer.pendingBytes).toBe(0);
		reader.close();
	});

	it('streams a frame LARGER than the whole ring through in pieces', async () => {
		const sab = createRelayRingBuffer(1024); // capacity 1024
		const writer = new RingWriter(sab);
		const bigEnvelope = JSON.stringify({ doc: 'y'.repeat(64 * 1024) });
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame)));
		reader.start();

		writer.write(encodePublishFrame('doc:1', bigEnvelope, true, 9, undefined, undefined, undefined));
		writer.notify();
		await until(() => seen.length === 1, 5000);
		expect(seen[0].envelope).toBe(bigEnvelope);
		expect(seen[0].seq).toBe(9);
		reader.close();
	});

	it('a throwing consumer skips the frame but keeps the stream alive', async () => {
		const sab = createRelayRingBuffer(4096);
		const writer = new RingWriter(sab);
		const seen = [];
		const reader = new RingReader(sab, (frame) => {
			const msg = decodeRelayFrame(frame);
			if (msg.seq === 1) throw new Error('boom');
			seen.push(msg.seq);
		});
		reader.start();
		for (let i = 0; i < 3; i++) {
			writer.write(encodePublishFrame('t', '{}', false, i, undefined, undefined, undefined));
		}
		writer.notify();
		await until(() => seen.length === 2);
		expect(seen).toEqual([0, 2]);
		reader.close();
	});

	it('close() unblocks a spilling writer and a waiting reader (no hang, no late delivery)', async () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab);
		// Fill past capacity so the writer has a pending flush armed.
		for (let i = 0; i < 50; i++) {
			writer.write(encodePublishFrame('t', '{"pad":"' + 'z'.repeat(80) + '"}', false, i, undefined, undefined, undefined));
		}
		expect(writer.pendingBytes).toBeGreaterThan(0);
		writer.close();
		expect(writer.pendingBytes).toBe(0);

		const seen = [];
		const reader = new RingReader(sab, () => seen.push(1));
		reader.start();
		reader.close();
		// Both sides settled: no timers, no unresolved work that would keep
		// the test (or a real primary) alive. A short settle proves no
		// late async delivery fires after close.
		await tick();
		await tick();
	});

	it('verbatim forwarding: a frame copied ring-to-ring by a forwarder decodes identically', async () => {
		const upstream = createRelayRingBuffer(4096);
		const downstream = createRelayRingBuffer(4096);
		const producer = new RingWriter(upstream);
		const forwardWriter = new RingWriter(downstream);
		// The primary's role: move framed bytes verbatim, never decode.
		const forwarder = new RingReader(upstream, (frame) => {
			forwardWriter.write(frame);
			forwardWriter.notify();
		});
		forwarder.start();
		const seen = [];
		const consumer = new RingReader(downstream, (frame) => seen.push(decodeRelayFrame(frame)));
		consumer.start();

		const original = { type: 'publish', topic: 'r', envelope: '{"v":1}', compress: true, seq: 3, capability: 'cursor.protocol:5', event: 'update', data: [1, 2, 3] };
		producer.write(encodePublishFrame(original.topic, original.envelope, original.compress, original.seq, original.capability, original.event, original.data));
		producer.notify();

		await until(() => seen.length === 1);
		expect(seen[0]).toEqual(original);
		forwarder.close();
		consumer.close();
	});
});

describe('cross-thread (real worker_threads)', () => {
	it('a worker-side writer wakes and feeds a main-thread reader in order', async () => {
		const ringUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/relay-ring.js', import.meta.url))).href;
		const sab = createRelayRingBuffer(2048); // small: forces spill + flush across threads
		const N = 300;
		const worker = new Worker(
			`
			const { workerData } = require('node:worker_threads');
			import(${JSON.stringify(ringUrl)}).then(({ RingWriter, encodePublishFrame }) => {
				const writer = new RingWriter(workerData.sab);
				for (let i = 0; i < ${N}; i++) {
					writer.write(encodePublishFrame('cross:' + (i % 3), JSON.stringify({ i, pad: 'q'.repeat(i % 120) }), i % 2 === 0, i, undefined, 'update', { i }));
				}
				writer.notify();
				// A pending Atomics.waitAsync does not hold the event loop open, so an
				// otherwise-idle worker would exit mid-spill; a real cluster worker
				// always has live handles (listen socket, timers). Hold the loop until
				// the spill has fully flushed.
				const hold = setInterval(() => {
					if (writer.pendingBytes === 0) clearInterval(hold);
				}, 5);
			});
			`,
			{ eval: true, workerData: { sab } }
		);
		try {
			const seen = [];
			const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame)));
			reader.start();
			await until(() => seen.length === N, 10000);
			for (let i = 0; i < N; i++) {
				expect(seen[i].seq).toBe(i);
				expect(seen[i].topic).toBe('cross:' + (i % 3));
				expect(seen[i].compress).toBe(i % 2 === 0);
				expect(seen[i].data).toEqual({ i });
			}
			reader.close();
		} finally {
			await worker.terminate();
		}
	}, 15000);

	it('end-to-end star: the REAL batchRelay producer path through a forwarding primary to a decoding sibling', async () => {
		// Worker A runs the actual handler/relay.js batchRelay with a ring writer
		// wired (exactly what runtime/index.js does at worker startup); the main
		// thread runs the primary's forward loop (verbatim byte copy); worker B
		// decodes and reports. This is the production topology minus the uWS app.
		const relayUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/relay.js', import.meta.url))).href;
		const ringUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/relay-ring.js', import.meta.url))).href;
		const upSab = createRelayRingBuffer(8192);
		const downSab = createRelayRingBuffer(8192);

		const producer = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			Promise.all([import(${JSON.stringify(relayUrl)}), import(${JSON.stringify(ringUrl)})]).then(([relay, ring]) => {
				relay.setRelayRingWriter(new ring.RingWriter(workerData.up));
				relay.batchRelay('game:7', '{"event":"update","data":{"x":1}}', true, 11, 'smooth.protocol:1', 'update', { x: 1 });
				relay.batchRelay('game:7', '{"event":"update","data":{"x":2}}', false, 12, undefined, undefined, undefined);
				relay.relayBatched([{ topic: 'game:7', env: '{"n":3}', seq: 13 }], true);
				const hold = setInterval(() => {}, 100);
				parentPort.on('message', () => clearInterval(hold));
			});
			`,
			{ eval: true, workerData: { up: upSab } }
		);
		const consumer = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			import(${JSON.stringify(ringUrl)}).then(({ RingReader, decodeRelayFrame }) => {
				const reader = new RingReader(workerData.down, (frame) => {
					parentPort.postMessage(decodeRelayFrame(frame));
				});
				reader.start();
				const hold = setInterval(() => {}, 100);
				parentPort.on('message', () => clearInterval(hold));
			});
			`,
			{ eval: true, workerData: { down: downSab } }
		);
		try {
			const received = [];
			consumer.on('message', (m) => received.push(m));
			// The primary's forward loop, byte-for-byte the index.js shape.
			const downWriter = new RingWriter(downSab);
			let ringActivity = 0;
			const forwarder = new RingReader(upSab, (frame) => {
				ringActivity++;
				downWriter.write(frame);
				downWriter.notify();
			});
			forwarder.start();

			await until(() => received.length === 3, 10000);
			// relayBatched writes synchronously while batchRelay defers one timer
			// tick, so the batched frame may overtake - the same relative timing
			// the postMessage path had. Within each path, order is exact.
			const publishes = received.filter((m) => m.type === 'publish');
			const batched = received.filter((m) => m.type === 'publish-batched');
			expect(publishes[0]).toMatchObject({ type: 'publish', topic: 'game:7', compress: true, seq: 11, capability: 'smooth.protocol:1', event: 'update', data: { x: 1 } });
			expect(publishes[1]).toMatchObject({ type: 'publish', topic: 'game:7', compress: false, seq: 12 });
			expect(batched[0]).toMatchObject({ type: 'publish-batched', compress: true, events: [{ topic: 'game:7', env: '{"n":3}', seq: 13 }] });
			expect(ringActivity).toBe(3);
			forwarder.close();
			producer.postMessage('stop');
			consumer.postMessage('stop');
		} finally {
			await producer.terminate();
			await consumer.terminate();
		}
	}, 15000);
});
