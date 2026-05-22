// Microbenchmark: A/B test the leading-edge sync-fire vs microtask-defer
// patterns for cursor broadcast under simulated event-loop pause.
//
// Pre-fix shape (sync): the first broadcast on an idle topic (and the
// first broadcast after any pause >= topicThrottleMs) fires immediately
// with whatever single cursor is in `dirty`. Co-arriving broadcasts in
// the SAME synchronous JS pass take the trailing-edge path and queue
// for the next setTimeout-driven tick. Result under event-loop pauses
// > topicThrottleMs: fragmented single-cursor UPDATE storm.
//
// Post-fix shape (microtask-defer): the cadence slot is claimed
// synchronously (lastFlush = now) but the actual flush is deferred by
// one microtask. Co-arriving broadcasts in the same JS pass add to
// `dirty` before the microtask fires, so the flush emits a single
// coalesced frame for the entire pass.
//
// Bench setup: simulate the demo's load profile - bursts of N cursors
// arriving back-to-back within a single sync JS pass, separated by
// "pauses" longer than topicThrottle. Count single-cursor UPDATE
// frames vs multi-cursor BULK frames. The fix should collapse UPDATE
// count toward zero.
//
// Usage:
//   node bench/micro-cursor-microtask-defer.mjs [movers] [bursts]
//
// Defaults: 250 movers/burst, 1000 bursts (mirrors the demo's per-
// replica mover count and reaches steady-state quickly).

const MOVERS_PER_BURST = parseInt(process.argv[2] || '250', 10);
const BURST_COUNT = parseInt(process.argv[3] || '1000', 10);
const TOPIC_THROTTLE_MS = 8;

function makeRecordingPlatform() {
	const events = { update: 0, bulk: 0, bulkSizes: [] };
	return {
		events,
		publish(_topic, event, data) {
			if (event === 'update') events.update++;
			else if (event === 'bulk') {
				events.bulk++;
				events.bulkSizes.push(data.length);
			}
		}
	};
}

// ----- Variant A: sync leading-edge (pre-fix) ---------------------------

function makeBroadcastSync() {
	const topicFlush = new Map();
	return function broadcast(topic, key, data, platform) {
		let state = topicFlush.get(topic);
		if (!state) {
			state = { dirty: new Map(), lastFlush: 0 };
			topicFlush.set(topic, state);
		}
		state.dirty.set(key, { data, platform });

		const now = Date.now();
		if (now - state.lastFlush >= TOPIC_THROTTLE_MS) {
			state.lastFlush = now;
			// Sync flush
			if (state.dirty.size === 1) {
				const [, v] = state.dirty.entries().next().value;
				platform.publish(topic, 'update', { key, data: v.data });
			} else {
				const entries = [];
				for (const [k, v] of state.dirty) entries.push({ key: k, data: v.data });
				platform.publish(topic, 'bulk', entries);
			}
			state.dirty.clear();
		}
		// else: trailing edge omitted - this bench measures the leading-edge
		// fragmentation under pause, not the trailing-edge coalescing path.
	};
}

// ----- Variant B: microtask-deferred leading-edge (post-fix) -------------

function makeBroadcastDeferred() {
	const topicFlush = new Map();
	return function broadcast(topic, key, data, platform) {
		let state = topicFlush.get(topic);
		if (!state) {
			state = { dirty: new Map(), lastFlush: 0, pendingMicroflush: false };
			topicFlush.set(topic, state);
		}
		state.dirty.set(key, { data, platform });

		const now = Date.now();
		if (now - state.lastFlush >= TOPIC_THROTTLE_MS) {
			state.lastFlush = now;
			if (!state.pendingMicroflush) {
				state.pendingMicroflush = true;
				queueMicrotask(() => {
					state.pendingMicroflush = false;
					if (state.dirty.size === 0) return;
					if (state.dirty.size === 1) {
						const [k, v] = state.dirty.entries().next().value;
						platform.publish(topic, 'update', { key: k, data: v.data });
					} else {
						const entries = [];
						for (const [k, v] of state.dirty) entries.push({ key: k, data: v.data });
						platform.publish(topic, 'bulk', entries);
					}
					state.dirty.clear();
				});
			}
		}
	};
}

// ----- Test driver -------------------------------------------------------

// Simulate one burst: N cursors all move within a single sync JS pass,
// then yield to let microtasks (and the test) catch up. Pause between
// bursts is "simulated" by advancing Date.now via a small busy loop,
// which is correct because both variants read Date.now() the same way
// and we want the lastFlush comparison to take the leading-edge path
// every burst.
async function runBursts(broadcast) {
	const platform = makeRecordingPlatform();
	const startTime = Date.now();
	let simulatedTime = startTime;

	for (let burst = 0; burst < BURST_COUNT; burst++) {
		// Advance simulated time by > TOPIC_THROTTLE_MS so each burst
		// triggers the leading-edge branch.
		simulatedTime += TOPIC_THROTTLE_MS + 2;
		// We cannot mock Date.now here cheaply across variants without
		// hooking each. Instead, use a small busy-loop to consume real
		// wall-clock time between bursts. Reduces N if you want fewer
		// real seconds.
		const target = Date.now() + TOPIC_THROTTLE_MS + 2;
		while (Date.now() < target) { /* spin */ }

		// All N cursors move in a single sync pass:
		for (let i = 0; i < MOVERS_PER_BURST; i++) {
			broadcast('canvas', 'c' + i, { x: burst, y: i }, platform);
		}

		// Yield to let microtasks fire before the next burst.
		await Promise.resolve();
	}

	return platform.events;
}

console.log(`Node ${process.version}`);
console.log(`Bench: ${BURST_COUNT} bursts x ${MOVERS_PER_BURST} cursors, topicThrottle=${TOPIC_THROTTLE_MS}ms`);
console.log('Simulating the demo scenario: event-loop pauses > topicThrottleMs between mover bursts.\n');

console.log('--- Variant A: sync leading-edge (pre-fix shape) ---');
const sync = await runBursts(makeBroadcastSync());
console.log(`  UPDATE frames: ${sync.update.toLocaleString()}`);
console.log(`  BULK frames:   ${sync.bulk.toLocaleString()}`);
console.log(`  ratio U:B:     ${sync.bulk ? (sync.update / sync.bulk).toFixed(1) : 'inf'}`);

console.log('\n--- Variant B: microtask-deferred leading-edge (post-fix shape) ---');
const deferred = await runBursts(makeBroadcastDeferred());
console.log(`  UPDATE frames: ${deferred.update.toLocaleString()}`);
console.log(`  BULK frames:   ${deferred.bulk.toLocaleString()}`);
console.log(`  ratio U:B:     ${deferred.bulk ? (deferred.update / deferred.bulk).toFixed(2) : 'inf'}`);
if (deferred.bulkSizes.length > 0) {
	const meanBulk = deferred.bulkSizes.reduce((a, b) => a + b, 0) / deferred.bulkSizes.length;
	const maxBulk = Math.max(...deferred.bulkSizes);
	console.log(`  bulk size:     mean=${meanBulk.toFixed(1)}, max=${maxBulk}, target=${MOVERS_PER_BURST}`);
}

const totalFramesA = sync.update + sync.bulk;
const totalFramesB = deferred.update + deferred.bulk;
console.log(`\nTotal frames: ${totalFramesA.toLocaleString()} -> ${totalFramesB.toLocaleString()}  (${(totalFramesA / totalFramesB).toFixed(1)}x reduction)`);
console.log(`UPDATE fragmentation: ${sync.update.toLocaleString()} -> ${deferred.update.toLocaleString()}  (${sync.update > 0 ? ((1 - deferred.update / sync.update) * 100).toFixed(1) : 'inf'}% reduction)`);
