/**
 * Test helpers shared across plugin test files.
 *
 * Plugin servers expect a uWS / vite wrapper-shaped WebSocket and a
 * Platform-shaped pub/sub object. These factories produce minimal stand-
 * ins that record what was called so tests can assert on side effects
 * without spinning up a real server.
 */

import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

/**
 * Point the injectable runtime clock at the global `Date.now()` for the
 * duration of a test that scripts time. The plugin servers read wall and
 * duration time through the runtime module rather than the global, so a test
 * that advances time with `vi.useFakeTimers()` / `vi.advanceTimersByTime()` or
 * pins it with `vi.spyOn(Date, 'now')` must route those movements into the
 * runtime clock. Both helpers move the global `Date.now`, so binding both the
 * wall (`now`) and duration (`monotonic`) readers to it makes the runtime clock
 * follow the scripted time at full precision (the production default is the
 * ~1s-cached read, which a synchronous test cannot advance). Call in a
 * `beforeEach` and pair with {@link releaseRuntimeClock} in `afterEach`.
 */
export function installFakeRuntimeClock() {
	setRuntimeEnv({ clock: { now: () => Date.now(), monotonic: () => Date.now() } });
}

/** Restore the native runtime clock. Pair with {@link installFakeRuntimeClock}. */
export function releaseRuntimeClock() {
	resetRuntimeEnv();
}

/**
 * Create a mock WebSocket that mimics the uWS / vite wrapper API.
 *
 * Exposes `getUserData()` plus `subscribe` / `unsubscribe` /
 * `isSubscribed`. The internal topic Set is exposed as `_topics` for
 * assertion convenience. Tests that do not exercise subscriptions can
 * ignore them; allocation cost is one empty Set per call.
 *
 * @param {Record<string, any>} [userData]
 */
export function mockWs(userData = {}) {
	const topics = new Set();
	return {
		getUserData: () => userData,
		subscribe: (topic) => { topics.add(topic); return true; },
		unsubscribe: (topic) => { topics.delete(topic); return true; },
		isSubscribed: (topic) => topics.has(topic),
		_topics: topics
	};
}

/**
 * Create a mock platform that records publish() and send() calls.
 *
 * Every call to `publish(topic, event, data)` appends `{ topic, event,
 * data }` to `published[]`. Every call to `send(ws, topic, event, data)`
 * appends `{ ws, topic, event, data }` to `sent[]`. `reset()` clears
 * both arrays in place.
 *
 * Return values match production: publish returns `true`, send returns
 * `1`.
 */
export function mockPlatform() {
	const p = {
		published: [],
		sent: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data });
			return 1;
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
		}
	};
	return p;
}

/**
 * Create a mock platform that ALSO supports the per-subscriber walk: it
 * tracks a subscriber set per full topic and exposes `forEachSubscriber`
 * and `bufferedAmount`, mirroring the production handler semantics
 * (`bufferedAmount` of an unknown / closed ws is 0). Use it to exercise the
 * backpressure drop and viewport culling paths, which the minimal
 * {@link mockPlatform} (no `forEachSubscriber`) deliberately does not.
 *
 * `addSubscriber(ws, fullTopic)` registers a ws as a subscriber of a full
 * topic (e.g. `__cursor:board`); `setBuffered(ws, bytes)` scripts a ws's
 * queued-byte reading. Shared-frame fan-out (join / catalog / remove and the
 * no-primitive fallback) lands in `published[]`; per-subscriber sends land in
 * `sent[]`. The subscriber set is snapshotted before each walk so a callback
 * may disconnect peers mid-walk without skipping survivors.
 */
export function mockWalkPlatform() {
	const subscribers = new Map(); // fullTopic -> Set<ws>
	const buffered = new Map(); // ws -> queued bytes
	// Production send/publish serialize synchronously before returning, so the
	// per-subscriber walk safely reuses one scratch array across subscribers.
	// Snapshot array payloads here to mirror that - otherwise the recorded
	// reference would alias the reused scratch and read back as the last slice.
	const snap = (data) => (Array.isArray(data) ? data.slice() : data);
	const p = {
		published: [],
		sent: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data: snap(data) });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data: snap(data) });
			return 1;
		},
		forEachSubscriber(fullTopic, fn) {
			const set = subscribers.get(fullTopic);
			if (!set) return;
			for (const ws of [...set]) {
				let ud = {};
				try { ud = ws.getUserData(); } catch { ud = {}; }
				fn(ws, ud);
			}
		},
		bufferedAmount(ws) {
			return buffered.get(ws) || 0;
		},
		addSubscriber(ws, fullTopic) {
			let set = subscribers.get(fullTopic);
			if (!set) { set = new Set(); subscribers.set(fullTopic, set); }
			set.add(ws);
			if (typeof ws.subscribe === 'function') ws.subscribe(fullTopic);
		},
		removeSubscriber(ws, fullTopic) {
			subscribers.get(fullTopic)?.delete(ws);
		},
		setBuffered(ws, bytes) {
			buffered.set(ws, bytes);
		},
		sentTo(ws) {
			return p.sent.filter((e) => e.ws === ws);
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
		}
	};
	return p;
}
