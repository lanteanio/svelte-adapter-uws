// Microbenchmark: A/B/C test for cursor leading-edge scheduling under
// the production cross-task dispatch shape.
//
// Earlier versions of this bench drove every broadcast in one
// synchronous loop, which mis-modeled production: uWS dispatches each
// WS message as its own JS task (with a microtask drain between
// tasks), so a `queueMicrotask`-deferred flush actually runs BEFORE
// the next socket's message handler - meaning microtask defer
// coalesces only WITHIN a single socket's burst, never ACROSS
// sockets. The original bench's tight-loop driver hid this because
// every broadcast was already inside the same task as the microtask.
//
// This rewrite drives broadcasts across `await Promise.resolve()`
// boundaries (microtask drain after each), which is what cross-socket
// dispatch looks like from the cursor plugin's perspective. With this
// driver the three variants should produce these wire profiles:
//
//   A) sync leading-edge (pre-0.5.5):
//      Every first call after the cadence boundary fires alone as a
//      single-cursor UPDATE; subsequent in-window calls queue for the
//      trailing-edge timer. High fragmentation under load.
//
//   B) queueMicrotask defer (0.5.5):
//      Same pattern as A. Microtasks drain at task boundaries, so the
//      defer flushes before the next socket's broadcast lands. No
//      cross-task coalescing.
//
//   C) always-tick (the fix):
//      Every broadcast appends to dirty + arms (or shares) the macro-
//      task timer. setTimeout(0) is a "timers" phase callback that
//      fires only after libuv's poll phase processes every ready
//      message. All cross-task broadcasts within the same loop
//      iteration coalesce into one bulk.
//
// Usage:
//   node bench/micro-cursor-microtask-defer.mjs [cursors] [cycles]
//
// Defaults: 100 cursors per cycle, 50 cycles.

const CURSORS_PER_CYCLE = parseInt(process.argv[2] || '100', 10);
const CYCLES = parseInt(process.argv[3] || '50', 10);
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

// Shared flush implementation - one BULK if >1, one UPDATE if exactly 1.
function flushDirty(topic, dirty, key) {
	if (dirty.size === 0) return;
	if (dirty.size === 1) {
		const [k, v] = dirty.entries().next().value;
		v.platform.publish(topic, 'update', { key: k, data: v.data });
		return;
	}
	const entries = [];
	let p = null;
	for (const [k, v] of dirty) { entries.push({ key: k, data: v.data }); p = v.platform; }
	if (p) p.publish(topic, 'bulk', entries);
}

// ----- Variant A: sync leading-edge (pre-0.5.5) ---------------------------
function makeBroadcastSync() {
	const topicFlush = new Map();
	let tickTimer = null;
	const dirtyTopics = new Set();

	function tick() {
		tickTimer = null;
		const now = Date.now();
		for (const topic of dirtyTopics) {
			const state = topicFlush.get(topic);
			if (!state || state.dirty.size === 0) { dirtyTopics.delete(topic); continue; }
			const deadline = state.lastFlush + TOPIC_THROTTLE_MS;
			if (deadline <= now) {
				flushDirty(topic, state.dirty);
				state.dirty.clear();
				dirtyTopics.delete(topic);
				state.lastFlush = now;
			}
		}
	}

	return function broadcast(topic, key, data, platform) {
		let state = topicFlush.get(topic);
		if (!state) { state = { dirty: new Map(), lastFlush: 0 }; topicFlush.set(topic, state); }
		state.dirty.set(key, { data, platform });

		const now = Date.now();
		if (now - state.lastFlush >= TOPIC_THROTTLE_MS) {
			state.lastFlush = now;
			flushDirty(topic, state.dirty);
			state.dirty.clear();
			dirtyTopics.delete(topic);
			return;
		}
		dirtyTopics.add(topic);
		if (tickTimer === null) tickTimer = setTimeout(tick, TOPIC_THROTTLE_MS - (now - state.lastFlush));
	};
}

// ----- Variant B: queueMicrotask defer (0.5.5) ----------------------------
function makeBroadcastMicrotask() {
	const topicFlush = new Map();
	let tickTimer = null;
	const dirtyTopics = new Set();

	function tick() {
		tickTimer = null;
		const now = Date.now();
		for (const topic of dirtyTopics) {
			const state = topicFlush.get(topic);
			if (!state || state.dirty.size === 0) { dirtyTopics.delete(topic); continue; }
			const deadline = state.lastFlush + TOPIC_THROTTLE_MS;
			if (deadline <= now) {
				flushDirty(topic, state.dirty);
				state.dirty.clear();
				dirtyTopics.delete(topic);
				state.lastFlush = now;
			}
		}
	}

	return function broadcast(topic, key, data, platform) {
		let state = topicFlush.get(topic);
		if (!state) { state = { dirty: new Map(), lastFlush: 0, pendingMicroflush: false }; topicFlush.set(topic, state); }
		state.dirty.set(key, { data, platform });

		const now = Date.now();
		if (now - state.lastFlush >= TOPIC_THROTTLE_MS) {
			state.lastFlush = now;
			dirtyTopics.delete(topic);
			if (!state.pendingMicroflush) {
				state.pendingMicroflush = true;
				queueMicrotask(() => {
					state.pendingMicroflush = false;
					if (state.dirty.size === 0) return;
					flushDirty(topic, state.dirty);
					state.dirty.clear();
				});
			}
			return;
		}
		dirtyTopics.add(topic);
		if (tickTimer === null) tickTimer = setTimeout(tick, TOPIC_THROTTLE_MS - (now - state.lastFlush));
	};
}

// ----- Variant C: always-tick (the fix) -----------------------------------
function makeBroadcastAlwaysTick() {
	const topicFlush = new Map();
	let tickTimer = null;
	const dirtyTopics = new Set();

	function tick() {
		tickTimer = null;
		const now = Date.now();
		let nextDeadline = Infinity;
		for (const topic of dirtyTopics) {
			const state = topicFlush.get(topic);
			if (!state || state.dirty.size === 0) { dirtyTopics.delete(topic); continue; }
			const deadline = state.lastFlush + TOPIC_THROTTLE_MS;
			if (deadline <= now) {
				flushDirty(topic, state.dirty);
				state.dirty.clear();
				dirtyTopics.delete(topic);
				state.lastFlush = now;
			} else if (deadline < nextDeadline) {
				nextDeadline = deadline;
			}
		}
		if (nextDeadline !== Infinity) {
			tickTimer = setTimeout(tick, Math.max(0, nextDeadline - Date.now()));
		}
	}

	return function broadcast(topic, key, data, platform) {
		let state = topicFlush.get(topic);
		if (!state) {
			state = { dirty: new Map(), lastFlush: Date.now() - TOPIC_THROTTLE_MS };
			topicFlush.set(topic, state);
		}
		state.dirty.set(key, { data, platform });
		dirtyTopics.add(topic);
		const elapsed = Date.now() - state.lastFlush;
		const delay = elapsed >= TOPIC_THROTTLE_MS ? 0 : TOPIC_THROTTLE_MS - elapsed;
		if (tickTimer === null) tickTimer = setTimeout(tick, delay);
	};
}

// ----- Driver ------------------------------------------------------------

// Each cycle: deliver `cursors` broadcasts each as its own microtask-
// separated JS task (the cross-socket dispatch shape), then wait long
// enough for the tick timer to fire, then move to the next cycle.
async function runCycles(broadcast, label) {
	const platform = makeRecordingPlatform();
	for (let cycle = 0; cycle < CYCLES; cycle++) {
		for (let i = 0; i < CURSORS_PER_CYCLE; i++) {
			broadcast('canvas', 'c' + i, { x: cycle, y: i }, platform);
			// Force a microtask drain between broadcasts. This is what
			// happens between socket message dispatches in production.
			await Promise.resolve();
		}
		// Wait long enough for the tick timer to fire and the next
		// cadence cycle to open.
		await new Promise(r => setTimeout(r, TOPIC_THROTTLE_MS + 4));
	}
	return platform.events;
}

console.log(`Node ${process.version}`);
console.log(`Bench: ${CYCLES} cycles x ${CURSORS_PER_CYCLE} cursors, topicThrottle=${TOPIC_THROTTLE_MS}ms`);
console.log('Cross-task dispatch (await Promise.resolve() between every broadcast - mimics uWS per-socket message dispatch).\n');

async function report(label, factory) {
	const events = await runCycles(factory());
	const total = events.update + events.bulk;
	const meanBulk = events.bulkSizes.length > 0
		? events.bulkSizes.reduce((a, b) => a + b, 0) / events.bulkSizes.length
		: 0;
	const maxBulk = events.bulkSizes.length > 0 ? Math.max(...events.bulkSizes) : 0;
	const fragRatio = total > 0 ? (events.update / total * 100).toFixed(1) : '0.0';
	console.log(`--- ${label}`);
	console.log(`    UPDATE frames: ${events.update.toLocaleString()} (${fragRatio}% fragmentation)`);
	console.log(`    BULK frames:   ${events.bulk.toLocaleString()}  mean size ${meanBulk.toFixed(1)}, max ${maxBulk}`);
	console.log('');
	return events;
}

await report('A) sync leading-edge (pre-0.5.5)', makeBroadcastSync);
await report('B) queueMicrotask defer (0.5.5 - did not fix the bug)', makeBroadcastMicrotask);
const c = await report('C) always-tick (the fix)', makeBroadcastAlwaysTick);

console.log(`Target: 0% fragmentation, bulks of ~${CURSORS_PER_CYCLE} entries each.`);
console.log(`Variant C: ${c.bulk} BULKs of mean ${c.bulkSizes.length > 0 ? (c.bulkSizes.reduce((a, b) => a + b, 0) / c.bulkSizes.length).toFixed(1) : 0} cursors -> ${c.update === 0 ? 'CLEAN' : 'STILL FRAGMENTED'}`);
