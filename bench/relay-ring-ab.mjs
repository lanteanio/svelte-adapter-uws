// @ts-check
//
// A/B: the cross-worker relay star over postMessage (structured clone per
// message per receiving worker) vs the shared-memory relay ring (encode once,
// forward the framed bytes verbatim). Run with: node bench/relay-ring-ab.mjs
//
// Topology mirrors production: one producing worker, the main thread as the
// forwarding primary, three consuming workers. The measured quantities:
//
//   - end-to-end throughput (messages/s from producer dispatch to the last
//     consumer having decoded every message), and
//   - primary busy time (time the main thread spends inside its forwarding
//     handlers - the star's scaling bottleneck).
//
// Message shape is a realistic relay entry: a short topic, a ~250 byte JSON
// envelope, a seq, and on half the messages a capability + event + data (the
// codec-aware re-encode carry).

import { Worker } from 'node:worker_threads';

const RING_URL = new URL('../src/runtime/relay-ring.js', import.meta.url).href;
const CONSUMERS = 3;
const MESSAGES = 100000;
const BATCH = 20;
const RING_KB = 256;

function makeMessage(i) {
	const data = { key: 'p' + (i % 64), x: i * 0.25, y: (i * 7) % 480, hp: 100 - (i % 100) };
	const envelope = JSON.stringify({ topic: 'room:' + (i % 16), event: 'update', data });
	return i % 2 === 0
		? { topic: 'room:' + (i % 16), envelope, compress: false, seq: i, capability: 'smooth.protocol:1', event: 'update', data }
		: { topic: 'room:' + (i % 16), envelope, compress: false, seq: i };
}

const consumerPostMessageSrc = `
const { parentPort, workerData } = require('node:worker_threads');
let n = 0;
parentPort.on('message', (msg) => {
	if (msg.type === 'publish') {
		// Touch the fields the real relay dispatch reads.
		if (typeof msg.topic !== 'string' || typeof msg.envelope !== 'string') throw new Error('bad msg');
		n++;
		if (n === workerData.expect) parentPort.postMessage({ type: 'done' });
	}
});
`;

const consumerRingSrc = `
const { parentPort, workerData } = require('node:worker_threads');
import(${JSON.stringify(RING_URL)}).then(({ RingReader, decodeRelayFrame }) => {
	let n = 0;
	const reader = new RingReader(workerData.sab, (frame) => {
		const msg = decodeRelayFrame(frame);
		if (typeof msg.topic !== 'string' || typeof msg.envelope !== 'string') throw new Error('bad frame');
		n++;
		if (n === workerData.expect) parentPort.postMessage({ type: 'done' });
	});
	reader.start();
	const hold = setInterval(() => { if (n >= workerData.expect) clearInterval(hold); }, 50);
});
`;

const producerPostMessageSrc = `
const { parentPort, workerData } = require('node:worker_threads');
${makeMessage.toString()}
parentPort.on('message', (m) => {
	if (m.type !== 'go') return;
	let i = 0;
	const pump = () => {
		const batch = [];
		for (let b = 0; b < ${BATCH} && i < workerData.total; b++, i++) batch.push(makeMessage(i));
		parentPort.postMessage({ type: 'publish-batch', messages: batch });
		if (i < workerData.total) setImmediate(pump);
	};
	pump();
});
`;

const producerRingSrc = `
const { parentPort, workerData } = require('node:worker_threads');
${makeMessage.toString()}
import(${JSON.stringify(RING_URL)}).then(({ RingWriter, encodePublishFrame }) => {
	const writer = new RingWriter(workerData.sab);
	parentPort.on('message', (m) => {
		if (m.type !== 'go') return;
		let i = 0;
		const pump = () => {
			for (let b = 0; b < ${BATCH} && i < workerData.total; b++, i++) {
				const msg = makeMessage(i);
				writer.write(encodePublishFrame(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data));
			}
			writer.notify();
			if (i < workerData.total) setImmediate(pump);
		};
		pump();
	});
	const hold = setInterval(() => {}, 1000);
	parentPort.on('message', (m) => { if (m.type === 'stop') clearInterval(hold); });
});
`;

function waitDone(worker) {
	return new Promise((resolve, reject) => {
		worker.on('message', (m) => { if (m.type === 'done') resolve(undefined); });
		worker.on('error', reject);
	});
}

async function runPostMessage() {
	const consumers = [];
	const dones = [];
	for (let c = 0; c < CONSUMERS; c++) {
		const w = new Worker(consumerPostMessageSrc, { eval: true, workerData: { expect: MESSAGES } });
		consumers.push(w);
		dones.push(waitDone(w));
	}
	const producer = new Worker(producerPostMessageSrc, { eval: true, workerData: { total: MESSAGES } });
	let primaryBusyNs = 0n;
	producer.on('message', (msg) => {
		const t0 = process.hrtime.bigint();
		if (msg.type === 'publish-batch') {
			for (const { topic, envelope, compress, seq, capability, event, data } of msg.messages) {
				const relay = { type: 'publish', topic, envelope, compress, seq, capability, event, data };
				for (const w of consumers) w.postMessage(relay);
			}
		}
		primaryBusyNs += process.hrtime.bigint() - t0;
	});

	const start = performance.now();
	producer.postMessage({ type: 'go' });
	await Promise.all(dones);
	const wallMs = performance.now() - start;
	await producer.terminate();
	for (const w of consumers) await w.terminate();
	return { wallMs, primaryBusyMs: Number(primaryBusyNs / 1000n) / 1000 };
}

async function runRing() {
	const { createRelayRingBuffer, RingWriter, RingReader } = await import(RING_URL);
	const upSab = createRelayRingBuffer(RING_KB * 1024);
	const consumers = [];
	const writers = [];
	const dones = [];
	for (let c = 0; c < CONSUMERS; c++) {
		const downSab = createRelayRingBuffer(RING_KB * 1024);
		const w = new Worker(consumerRingSrc, { eval: true, workerData: { sab: downSab, expect: MESSAGES } });
		consumers.push(w);
		writers.push(new RingWriter(downSab));
		dones.push(waitDone(w));
	}
	let primaryBusyNs = 0n;
	const forwarder = new RingReader(upSab, (frame) => {
		const t0 = process.hrtime.bigint();
		for (const wr of writers) {
			wr.write(frame);
			wr.notify();
		}
		primaryBusyNs += process.hrtime.bigint() - t0;
	});
	forwarder.start();
	const producer = new Worker(producerRingSrc, { eval: true, workerData: { sab: upSab, total: MESSAGES } });

	const start = performance.now();
	producer.postMessage({ type: 'go' });
	await Promise.all(dones);
	const wallMs = performance.now() - start;
	forwarder.close();
	producer.postMessage({ type: 'stop' });
	await producer.terminate();
	for (const w of consumers) await w.terminate();
	return { wallMs, primaryBusyMs: Number(primaryBusyNs / 1000n) / 1000 };
}

function report(label, r) {
	const rate = (MESSAGES / (r.wallMs / 1000) / 1000).toFixed(0);
	console.log(
		label.padEnd(14) +
		' | wall ' + r.wallMs.toFixed(0).padStart(6) + 'ms' +
		' | ' + String(rate).padStart(5) + 'k msg/s end-to-end' +
		' | primary busy ' + r.primaryBusyMs.toFixed(0).padStart(5) + 'ms' +
		' (' + ((r.primaryBusyMs / MESSAGES) * 1e6).toFixed(0) + 'ns/msg)'
	);
}

console.log(`${MESSAGES} messages, batch ${BATCH}, 1 producer -> primary -> ${CONSUMERS} consumers\n`);
// Warm up both paths once, then measure.
await runPostMessage();
report('postMessage', await runPostMessage());
await runRing();
report('ring', await runRing());
