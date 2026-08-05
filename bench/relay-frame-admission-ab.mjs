// A/B: the cluster relay's per-message frame admission (one envelope-length
// comparison per relayed message in batchRelay's flush loop) against the same
// flush with no ceiling configured. Everything else - ordinal stamping,
// encodePublishFrame, the ring write - is identical work on identical
// messages, so the delta isolates the admission branch.
//
// Run with: node bench/relay-frame-admission-ab.mjs
//
// The flush is timer-driven; going through real timers buries a sub-percent
// branch under milliseconds of scheduler latency per tick. The runtime's
// injectable timer seam captures the armed flush instead, and the bench
// invokes it synchronously - the measured loop is exactly the code whose cost
// is in question, identical on both sides of the comparison.

import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';
import { setRelayFrameCeiling, setRelayRingWriter, batchRelay } from '../src/runtime/handler/relay.js';

const BATCH = 64;
const TICKS = 2000;
const ROUNDS = 7;

let pendingFlush = null;
setRuntimeEnv({
	timers: {
		set: (cb) => {
			pendingFlush = cb;
			return {};
		}
	}
});

function makeEnvelope(i) {
	return JSON.stringify({
		topic: 'room:' + (i % 16),
		event: 'update',
		data: { x: i % 640, y: (i * 7) % 480, hp: 100 - (i % 100), tag: 'entity-' + (i % 32) }
	});
}

const topics = Array.from({ length: BATCH }, (_, i) => 'room:' + (i % 16));
const envelopes = Array.from({ length: BATCH }, (_, i) => makeEnvelope(i));

let sinkBytes = 0;
setRelayRingWriter({
	write(frame) {
		sinkBytes += frame.length;
		return true;
	},
	notify() {}
});

function run() {
	const start = performance.now();
	for (let t = 0; t < TICKS; t++) {
		for (let i = 0; i < BATCH; i++) {
			batchRelay(topics[i], envelopes[i], false, null);
		}
		const flush = pendingFlush;
		pendingFlush = null;
		flush();
	}
	const elapsed = performance.now() - start;
	return (BATCH * TICKS) / (elapsed / 1000);
}

function best(label) {
	let top = 0;
	for (let r = 0; r < ROUNDS; r++) top = Math.max(top, run());
	console.log(label.padEnd(16) + Math.round(top / 1000) + 'k msg/s through the flush');
	return top;
}

// Warm both branches before either measurement.
setRelayFrameCeiling(4 * 1024 * 1024);
run();
setRelayFrameCeiling(0);
run();

setRelayFrameCeiling(0);
const off = best('ceiling off');
setRelayFrameCeiling(4 * 1024 * 1024);
const on = best('ceiling 4 MiB');
setRelayFrameCeiling(0);
resetRuntimeEnv();

if (sinkBytes === 0) throw new Error('ring sink saw no bytes - the bench measured nothing');
console.log('delta ' + (((on - off) / off) * 100).toFixed(2) + '%');
