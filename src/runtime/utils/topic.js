/**
 * Safely quote a string for JSON embedding in topic / event positions.
 *
 * Topics and events are developer-defined identifiers, so a quote,
 * backslash, or control character is always a bug. We throw rather than
 * silently escape, so the bug surfaces at the publish site instead of
 * producing malformed JSON on the wire.
 *
 * @param {string} s
 * @returns {string} JSON-quoted string, e.g. '"chat"'
 */
export function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

/**
 * Validate a wire-protocol topic name from a subscribe / unsubscribe /
 * subscribe-batch control message. Topics are non-empty strings, at most
 * 256 chars, with no control characters, double-quotes, or backslashes.
 *
 * The `"` and `\\` rejections match `esc()`'s rejection set so the
 * wire-accept invariant stays in lockstep with envelope-build: any topic
 * that survives this check is also safe to embed in a JSON envelope.
 *
 * Single linear scan, no regex. Used by the production handler, the dev
 * vite plugin, and the test harness so all three apply identical rules.
 *
 * @param {unknown} topic
 * @returns {boolean}
 */
export function isValidWireTopic(topic, allowNonAscii) {
	if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) return false;
	for (let i = 0; i < topic.length; i++) {
		const c = topic.charCodeAt(i);
		// Always reject control bytes and the two characters that break the
		// envelope writer (`"` and `\\`). When the caller has not opted in
		// to non-ASCII topics, also reject anything outside printable ASCII
		// - this closes Unicode line separators (U+2028 / U+2029), the
		// right-to-left override (U+202E), and the byte-order mark
		// (U+FEFF), all of which survive the wire and surprise log
		// dashboards or admin tools that render topics back to a human.
		if (c < 32 || c === 34 || c === 92) return false;
		if (!allowNonAscii && c > 126) return false;
	}
	return true;
}

/**
 * Build the `platform.topic(name)` scoped publisher: a small object that
 * forwards each named action (created / updated / deleted / set /
 * increment / decrement) and a generic `publish(event, data)` to the
 * supplied `publish(topic, event, data)` with `topic` bound.
 *
 * @param {(topic: string, event: string, data: unknown) => unknown} publish
 * @param {string} name
 */
export function createScopedTopic(publish, name) {
	return {
		publish: (event, data) => publish(name, event, data),
		created: (data) => publish(name, 'created', data),
		updated: (data) => publish(name, 'updated', data),
		deleted: (data) => publish(name, 'deleted', data),
		set: (value) => publish(name, 'set', value),
		increment: (amount = 1) => publish(name, 'increment', amount),
		decrement: (amount = 1) => publish(name, 'decrement', amount)
	};
}

/**
 * Build a per-publish-binding LRU cache of scoped topic helpers so repeated
 * `platform.topic(name)` calls reuse one helper object instead of allocating a
 * fresh 7-closure object every call. Keyed by topic name (one helper bundles all
 * seven event methods). True LRU: a hit moves the key to most-recent; once the
 * map exceeds `cap`, the oldest key is evicted. Pure - no clock/RNG/timer, so it
 * stays determinism-clean.
 *
 * MUST be created ONCE per publish binding (the platform singleton, a dev-server
 * closure, a test server) - never module-global keyed on name alone, or two
 * servers would hand out helpers bound to the wrong `publish`.
 *
 * @param {(topic: string, event: string, data: unknown) => unknown} publish
 * @param {number} [cap=256]
 * @returns {(name: string) => ReturnType<typeof createScopedTopic>}
 */
export function createTopicHelperCache(publish, cap = 256) {
	/** @type {Map<string, ReturnType<typeof createScopedTopic>>} */
	const cache = new Map();
	return function get(name) {
		const hit = cache.get(name);
		if (hit !== undefined) {
			// Move to most-recent (delete + re-set) so recency drives eviction.
			cache.delete(name);
			cache.set(name, hit);
			return hit;
		}
		const helper = createScopedTopic(publish, name);
		cache.set(name, helper);
		if (cache.size > cap) {
			// Evict the oldest (least-recently-used) key.
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return helper;
	};
}
