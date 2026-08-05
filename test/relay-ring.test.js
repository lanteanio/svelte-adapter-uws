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
		expect(writer.pendingHead).toBe(0);
		expect(writer.pending).toHaveLength(0);
		reader.close();
	});

	// The ceiling bounds the BACKLOG this peer has failed to drain. It used to be
	// measured against the backlog PLUS the frame being handed over, which is why
	// the case below needed only one write to trip: a peer with nothing queued
	// was quarantined for being handed 65 bytes. That is not a peer fault, and
	// the two tests after this one are what the old shape was hiding.
	it('quarantines a stalled consumer once its backlog passes the ceiling', () => {
		const sab = createRelayRingBuffer(1024);
		const overflows = [];
		const writer = new RingWriter(sab, {
			maxPendingBytes: 64,
			maxPendingAgeMs: 5_000,
			onOverflow: (event) => overflows.push(event)
		});
		// Fill the ring exactly, so everything after this can only spill.
		writer.write(new Uint8Array(writer.cap));
		// Nothing has been read, so each of these joins the backlog.
		expect(writer.write(new Uint8Array(40))).toBe(true);
		expect(writer.write(new Uint8Array(40))).toBe(true);
		expect(writer.pendingBytes).toBe(80);

		// The backlog is now past the ceiling, so the next write is refused: this
		// consumer is genuinely not draining.
		const accepted = writer.write(new Uint8Array(1));

		expect(accepted).toBe(false);
		expect(writer.closed).toBe(true);
		expect(writer.pendingBytes).toBe(0);
		expect(overflows).toEqual([expect.objectContaining({
			reason: 'bytes',
			droppedBytes: 81,
			maxPendingBytes: 64
		})]);
	});

	it('does not quarantine a healthy peer handed a frame bigger than the ceiling', () => {
		const sab = createRelayRingBuffer(1024);
		const overflows = [];
		const writer = new RingWriter(sab, {
			maxPendingBytes: 64,
			maxPendingAgeMs: 5_000,
			onOverflow: (event) => overflows.push(event)
		});

		// An EMPTY ring and one frame far larger than the ceiling. This peer is
		// not lagging - it is being handed something big, which the byte stream
		// carries in pieces. Quarantine is a peer-fault action and must not fire.
		const accepted = writer.write(new Uint8Array(4096));

		expect(accepted, 'refused a frame from a peer with nothing queued').toBe(true);
		expect(writer.closed, 'closed a healthy peer for the size of one frame').toBe(false);
		expect(overflows).toEqual([]);
	});

	it('commits nothing to the shared ring when a write is refused', () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab, { maxPendingBytes: 64, maxPendingAgeMs: 5_000 });
		writer.write(new Uint8Array(writer.cap));
		writer.write(new Uint8Array(80));

		// A FORWARD guard, stated plainly rather than dressed up as a
		// reproduction: with every refusal now decided before `_push` runs, the
		// old shape's partial commit is structurally unreachable - there is no
		// post-push refusal left to leave a prefix behind. What this pins is that
		// it stays that way. Moving a ceiling test back below `_push` reintroduces
		// a truncated frame in the shared stream, which misframes every later
		// frame on that peer, and today nothing else would notice because the
		// refusal closes the writer and hides it.
		const before = Atomics.load(writer.i32, 0);
		expect(writer.write(new Uint8Array(200))).toBe(false);

		expect(Atomics.load(writer.i32, 0), 'a refused write advanced the write position').toBe(before);
	});

	it('quarantines an old spill even when no later publish arrives', () => {
		const sab = createRelayRingBuffer(1024);
		let now = 0;
		let ageCallback = null;
		const overflows = [];
		const writer = new RingWriter(sab, {
			maxPendingBytes: 4096,
			maxPendingAgeMs: 50,
			now: () => now,
			setTimer: (callback) => {
				ageCallback = callback;
				return { unref() {} };
			},
			clearTimer: () => {},
			onOverflow: (event) => overflows.push(event)
		});
		writer.write(new Uint8Array(writer.cap));
		writer.write(new Uint8Array(32));
		expect(writer.pendingBytes).toBe(32);
		expect(ageCallback).toBeTypeOf('function');

		now = 50;
		ageCallback();
		expect(writer.closed).toBe(true);
		expect(overflows).toEqual([expect.objectContaining({
			reason: 'age',
			droppedBytes: 32,
			pendingAgeMs: 50,
			maxPendingAgeMs: 50
		})]);
	});

	it('never quarantines a peer that keeps draining, however long it stays behind', () => {
		// The age ceiling is a STALL detector: it is re-stamped on every push
		// that makes progress, so it measures "stopped draining", not "backlog
		// non-empty since". This drives a peer that stays continuously behind
		// for three times the ceiling while draining steadily, and it must
		// survive - the stall case one test up is the only one allowed to trip.
		const sab = createRelayRingBuffer(1024);
		let now = 0;
		const overflows = [];
		const writer = new RingWriter(sab, {
			maxPendingBytes: 64 * 1024,
			maxPendingAgeMs: 50,
			now: () => now,
			setTimer: () => ({ unref() {} }),
			clearTimer: () => {},
			onOverflow: (event) => overflows.push(event)
		});
		const reader = new RingReader(sab, () => {});
		writer.write(new Uint8Array(writer.cap));
		writer.write(new Uint8Array(4096));
		expect(writer.pendingBytes).toBe(4096);

		let elapsed = 0;
		for (let cycle = 0; cycle < 8 && writer.pendingBytes > 0; cycle++) {
			now += 40; // under the 50ms ceiling since the LAST progress
			elapsed += 40;
			reader._drain(); // the consumer frees ring space...
			writer._flushPending(); // ...and the producer pushes, re-stamping
		}
		expect(writer.pendingBytes).toBe(0);
		expect(elapsed).toBeGreaterThan(3 * 50);
		expect(writer.closed).toBe(false);
		expect(overflows).toEqual([]);
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

	// The two lost-wakeup regressions: each side's wait must register against
	// the index value its full/empty verdict was computed from. The peer's
	// advance-plus-notify is forced into the check/register gap by holding the
	// armed flag through the predicate check, so with a reloaded-value wait
	// (the old code) the one notify is gone and the direction parks forever.

	it('writer: a consumer advance in the check/register gap does not strand the pending flush', async () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab);
		const i32 = new Int32Array(sab, 0, 16);
		writer.write(new Uint8Array(writer.cap)); // fills the ring exactly
		writer.flushArmed = true; // hold registration open across the gap
		const extra = encodePublishFrame('t', '{}', false, 1, undefined, undefined, undefined);
		writer.write(extra); // failed push: verdict computed, spill queued
		expect(writer.pendingBytes).toBe(extra.length);
		// The consumer drains everything and sends its ONE notify inside the gap.
		Atomics.store(i32, 8, Atomics.load(i32, 0));
		Atomics.notify(i32, 8);
		writer.flushArmed = false;
		writer._armFlush(); // registers AFTER the advance the old code slept through
		await until(() => writer.pendingBytes === 0);
	});

	it('reader: a producer advance in the check/register gap does not strand delivered bytes', async () => {
		const sab = createRelayRingBuffer(1024);
		const writer = new RingWriter(sab);
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame).seq));
		reader.waiting = true; // hold registration open across the gap
		reader.start(); // empty verdict computed with WRITE_IDX = 0
		// The producer writes and sends its ONE notify inside the gap.
		writer.write(encodePublishFrame('t', '{}', false, 1, undefined, undefined, undefined));
		writer.notify();
		reader.waiting = false;
		reader._armWait(0); // register against the pre-advance verdict value
		await until(() => seen.length === 1);
		expect(seen).toEqual([1]);
		reader.close();
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
		const seen = [];
		const reader = new RingReader(sab, (frame) => seen.push(decodeRelayFrame(frame)));
		try {
			reader.start();
			await until(() => seen.length === N, 10000);
			for (let i = 0; i < N; i++) {
				expect(seen[i].seq).toBe(i);
				expect(seen[i].topic).toBe('cross:' + (i % 3));
				expect(seen[i].compress).toBe(i % 2 === 0);
				expect(seen[i].data).toEqual({ i });
			}
		} finally {
			reader.close();
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
		const stateUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/state.js', import.meta.url))).href;
		const upSab = createRelayRingBuffer(8192);
		const downSab = createRelayRingBuffer(8192);

		const producer = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			Promise.all([import(${JSON.stringify(relayUrl)}), import(${JSON.stringify(ringUrl)}), import(${JSON.stringify(stateUrl)})]).then(([relay, ring, state]) => {
				state.streamTracking.enabled = true; // what handler.js does when the cross-worker reporter is configured
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

	it('end-to-end star: the REAL batchRelay stamps a dense per-topic ordinal, origin and birth that survive the ring', async () => {
		// The interior-gap detector is only as good as this carry: a receiver can
		// only find a hole in a stream if the SENDING worker numbered the frames it
		// sent. The primary forwards ring bytes verbatim without ever parsing them,
		// so it cannot stamp an origin on the way through - the origin worker has to,
		// and that is what this proves against the real relay.js, over a real ring,
		// through the real forward loop, decoded by the real codec.
		const relayUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/relay.js', import.meta.url))).href;
		const ringUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/relay-ring.js', import.meta.url))).href;
		const stateUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/state.js', import.meta.url))).href;
		const upSab = createRelayRingBuffer(16384);
		const downSab = createRelayRingBuffer(16384);

		const producer = new Worker(
			`
			const { workerData, parentPort, threadId } = require('node:worker_threads');
			Promise.all([import(${JSON.stringify(relayUrl)}), import(${JSON.stringify(ringUrl)}), import(${JSON.stringify(stateUrl)})]).then(([relay, ring, state]) => {
				state.streamTracking.enabled = true; // what handler.js does when the cross-worker reporter is configured
				relay.setRelayRingWriter(new ring.RingWriter(workerData.up));
				// Two interleaved topics, so a per-topic (not global) ordinal is proven.
				for (let i = 1; i <= 4; i++) {
					relay.batchRelay('room:a', JSON.stringify({ n: i }), false, i, undefined, undefined, undefined);
					relay.batchRelay('room:b', JSON.stringify({ n: i }), false, i, undefined, undefined, undefined);
				}
				// A wire-level batch carries one publish per event, so each event must
				// take its own ordinal in ITS topic's stream.
				relay.relayBatched([{ topic: 'room:a', env: '{"n":5}', seq: 5 }, { topic: 'room:b', env: '{"n":5}', seq: 5 }], false);
				parentPort.postMessage({ threadId });
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
			let producerThreadId = null;
			consumer.on('message', (m) => received.push(m));
			producer.on('message', (m) => { producerThreadId = m.threadId; });
			const downWriter = new RingWriter(downSab);
			const forwarder = new RingReader(upSab, (frame) => {
				downWriter.write(frame);
				downWriter.notify();
			});
			forwarder.start();

			await until(() => received.filter((m) => m.type === 'publish').length === 8
				&& received.some((m) => m.type === 'publish-batched') && producerThreadId !== null, 10000);

			const publishes = received.filter((m) => m.type === 'publish');
			// Every frame names the worker that actually sent it.
			for (const m of publishes) expect(m.origin).toBe(producerThreadId);

			// Dense per topic, independent of the other topic's traffic. The batch
			// below writes synchronously while these were deferred a tick, so it takes
			// ordinal 1 of each topic and these take 2..5 - ordinals follow the wire.
			for (const topic of ['room:a', 'room:b']) {
				const ords = publishes.filter((m) => m.topic === topic).map((m) => m.ord);
				expect(ords).toEqual([2, 3, 4, 5]);
			}

			// One birth per topic stream, identical on every frame of that stream and
			// read on the process-shared timeline (so it is comparable against the
			// receiving worker's own attach instant).
			for (const topic of ['room:a', 'room:b']) {
				const births = new Set(publishes.filter((m) => m.topic === topic).map((m) => m.birth));
				expect(births.size).toBe(1);
				expect([...births][0]).toBeGreaterThan(0);
			}
			// The two topics opened at different instants, so their births differ -
			// a birth is per stream, not one per worker.
			const birthA = publishes.find((m) => m.topic === 'room:a').birth;
			const birthB = publishes.find((m) => m.topic === 'room:b').birth;
			expect(birthA).not.toBe(birthB);

			// Each event of the batch takes its own ordinal in ITS topic's stream -
			// the batch is one frame but one publish per topic, so losing it must show
			// as a hole in each. It reached the wire first, hence ordinal 1.
			const batched = received.find((m) => m.type === 'publish-batched');
			for (const ev of batched.events) {
				expect(ev.origin).toBe(producerThreadId);
				expect(ev.ord).toBe(1);
			}
			forwarder.close();
			producer.postMessage('stop');
			consumer.postMessage('stop');
		} finally {
			await producer.terminate();
			await consumer.terminate();
		}
	}, 15000);

	it('end-to-end star: numbers nothing when the cross-worker reporter is not configured', async () => {
		// The numbering exists only to be checked for holes, and every worker in a
		// cluster runs one config - so with the reporter off a receiver would discard
		// it, and the frames must not carry the 20 bytes (or the sender the per-topic
		// map) for a feature nothing reads. Same producer as above, minus the enable.
		const relayUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/relay.js', import.meta.url))).href;
		const ringUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/relay-ring.js', import.meta.url))).href;
		const upSab = createRelayRingBuffer(8192);
		const downSab = createRelayRingBuffer(8192);

		const producer = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			Promise.all([import(${JSON.stringify(relayUrl)}), import(${JSON.stringify(ringUrl)})]).then(([relay, ring]) => {
				relay.setRelayRingWriter(new ring.RingWriter(workerData.up));
				relay.batchRelay('room', '{"n":1}', false, 1, undefined, undefined, undefined);
				relay.relayBatched([{ topic: 'room', env: '{"n":2}', seq: 2 }], false);
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
					parentPort.postMessage({ msg: decodeRelayFrame(frame), bytes: frame.byteLength });
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
			const downWriter = new RingWriter(downSab);
			const forwarder = new RingReader(upSab, (frame) => {
				downWriter.write(frame);
				downWriter.notify();
			});
			forwarder.start();

			await until(() => received.length === 2, 10000);
			const publish = received.find((r) => r.msg.type === 'publish');
			const batched = received.find((r) => r.msg.type === 'publish-batched');
			// The publish itself is untouched - only the numbering is absent.
			expect(publish.msg).toMatchObject({ topic: 'room', seq: 1 });
			expect(publish.msg.origin).toBeUndefined();
			expect(publish.msg.ord).toBeUndefined();
			expect(publish.msg.birth).toBeUndefined();
			expect(batched.msg.events[0].origin).toBeUndefined();
			expect(batched.msg.events[0].ord).toBeUndefined();
			forwarder.close();
			producer.postMessage('stop');
			consumer.postMessage('stop');
		} finally {
			await producer.terminate();
			await consumer.terminate();
		}
	}, 15000);

	it('end-to-end star: ordinals follow WIRE order when a batched publish overtakes a single one', async () => {
		// batchRelay defers its flush by a timer tick while relayBatched writes
		// synchronously, so a publishBatched issued AFTER a publish on the same topic
		// reaches the wire FIRST. If the two numbered their frames at publish time,
		// the overtaking batch would carry the higher ordinals and the receiver would
		// see the earlier frame arrive last - reading as a hole that never fills, on
		// nothing worse than a tick that mixes the two APIs. This asserts the ordering
		// across BOTH lanes together, which the per-lane assertions above cannot see.
		const relayUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/relay.js', import.meta.url))).href;
		const ringUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/relay-ring.js', import.meta.url))).href;
		const stateUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/handler/state.js', import.meta.url))).href;
		const upSab = createRelayRingBuffer(65536);
		const downSab = createRelayRingBuffer(65536);

		const producer = new Worker(
			`
			const { workerData, parentPort } = require('node:worker_threads');
			Promise.all([import(${JSON.stringify(relayUrl)}), import(${JSON.stringify(ringUrl)}), import(${JSON.stringify(stateUrl)})]).then(([relay, ring, state]) => {
				state.streamTracking.enabled = true; // what handler.js does when the cross-worker reporter is configured
				relay.setRelayRingWriter(new ring.RingWriter(workerData.up));
				// One tick: a publish (deferred) then a publishBatched (synchronous),
				// same topic. The batch is deliberately larger than the receiver's
				// pending-buffer cap, which is what used to latch the false gap.
				relay.batchRelay('room', '{"n":"single"}', false, 1, undefined, undefined, undefined);
				const events = [];
				for (let i = 0; i < 80; i++) events.push({ topic: 'room', env: '{"n":' + i + '}', seq: i + 2 });
				relay.relayBatched(events, false);
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
			const downWriter = new RingWriter(downSab);
			const forwarder = new RingReader(upSab, (frame) => {
				downWriter.write(frame);
				downWriter.notify();
			});
			forwarder.start();

			await until(() => received.length === 2, 10000);

			// Flatten both lanes into one arrival-ordered list of room ordinals.
			const arrived = [];
			for (const m of received) {
				if (m.type === 'publish') arrived.push(m.ord);
				else for (const ev of m.events) arrived.push(ev.ord);
			}
			// The batch really did overtake the single publish (otherwise this test is
			// asserting nothing).
			expect(received[0].type).toBe('publish-batched');
			expect(received[1].type).toBe('publish');
			// Ordinals are dense 1..81 IN ARRIVAL ORDER: the overtaking batch takes
			// 1..80 and the deferred single publish takes 81.
			expect(arrived).toEqual(Array.from({ length: 81 }, (_, i) => i + 1));
			forwarder.close();
			producer.postMessage('stop');
			consumer.postMessage('stop');
		} finally {
			await producer.terminate();
			await consumer.terminate();
		}
	}, 15000);
});
