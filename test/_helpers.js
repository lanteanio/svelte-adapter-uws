/**
 * Test helpers shared across plugin test files.
 *
 * Plugin servers expect a uWS / vite wrapper-shaped WebSocket and a
 * Platform-shaped pub/sub object. These factories produce minimal stand-
 * ins that record what was called so tests can assert on side effects
 * without spinning up a real server.
 */

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
