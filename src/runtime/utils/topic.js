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
 * Maximum topic name length, counted in UTF-16 code units.
 *
 * The unit is load-bearing, not incidental. The plugin-side `maxTopicLength`
 * caps (cursor, throttle) read `topic.length`, which is the same unit and also
 * defaults to 256. Counting Unicode code points here instead would raise this
 * boundary to 512 units and let a client name a topic those caps then refuse:
 * throttle throws out of the app's own publish call, cursor drops every frame
 * silently, and the client picks which. The wire ceiling must therefore stay at
 * or below the narrowest downstream cap, in the same unit.
 */
const MAX_TOPIC_UNITS = 256;

/**
 * Validate a wire-protocol topic name from a subscribe / unsubscribe /
 * subscribe-batch control message. Topics are non-empty strings, at most
 * 256 UTF-16 code units, with no control characters, double-quotes, or
 * backslashes.
 *
 * The `"` and `\\` rejections match `esc()`'s rejection set so the
 * wire-accept invariant stays in lockstep with envelope-build: any topic
 * that survives this check is also safe to embed in a JSON envelope.
 *
 * Single linear scan, no regex. Used by the production handler, the dev
 * vite plugin, and the test harness so all three apply identical rules.
 *
 * `allowNonAscii` arrives from two callers this function cannot tell apart:
 * the operator opt-in on the client-named wire paths, and a hard `true` from
 * the server-named platform APIs, which trust their caller and deliberately
 * run a looser alphabet than the client-named observer lane does. Narrowing
 * the widened set here therefore narrows the server-named APIs by the same
 * step; a rule that must apply to client-named topics only has to be given a
 * mode the call sites can pass, not folded into this flag. That is why the
 * bidirectional controls (U+061C, U+200E-U+200F, U+202A-U+202E,
 * U+2066-U+2069) are still accepted once the flag is on, even though they can
 * visually reorder a name in an operator console: refusing them here would
 * also refuse them to `platform.checkSubscribe`, whose ordinary mode is
 * contractually looser than its observer mode.
 *
 * @param {unknown} topic
 * @param {boolean} [allowNonAscii] widen the accepted letters beyond ASCII
 * @returns {boolean}
 */
export function isValidWireTopic(topic, allowNonAscii) {
	if (typeof topic !== 'string' || topic.length === 0 || topic.length > MAX_TOPIC_UNITS) return false;
	if (allowNonAscii) return isValidNonAsciiWireTopic(topic);
	for (let i = 0; i < topic.length; i++) {
		const c = topic.charCodeAt(i);
		// Reject control bytes, the two characters that break the envelope
		// writer (`"` and `\\`), and everything outside printable ASCII -
		// the last of which closes Unicode line separators (U+2028 /
		// U+2029), the right-to-left override (U+202E), and the byte-order
		// mark (U+FEFF), all of which survive the wire and surprise log
		// dashboards or admin tools that render topics back to a human.
		if (c < 32 || c === 34 || c === 92 || c > 126) return false;
	}
	return true;
}

/**
 * Validate a topic once names outside ASCII are permitted. Same length cap and
 * same always-illegal set as the default scan, plus one rule the default scan
 * gets for free by refusing everything above 0x7E: an unpaired surrogate is
 * rejected.
 *
 * An unpaired surrogate is not encodable as UTF-8, so it is replaced by U+FFFD
 * the moment the name is written to a socket - and the two lanes that reach
 * here break differently on that. On the client-named wire lane the server
 * keeps the decoded name, and a well-formed `JSON.stringify` re-emits the same
 * escape, so an unsubscribe still matches; what breaks is egress, because
 * `esc()` puts the raw name into the envelope, so the `subscribed` ack and
 * every published frame carry a name the client's own dispatch does not
 * recognise and the subscription silently delivers nothing. On the
 * server-named `platform.subscribe` lane the name is built by app code (a
 * slice landing mid-pair), and there the client never sees anything but the
 * replaced form, so it holds no name it could send back to clear the
 * subscription again.
 *
 * Printable ASCII leaves the loop before any surrogate work. That matters
 * because the server-named APIs pass `true` unconditionally, so this scan - not
 * the default one - is what every zero-config deployment runs on names like
 * `__signal:user-42`.
 *
 * @param {string} topic
 * @returns {boolean}
 */
function isValidNonAsciiWireTopic(topic) {
	for (let i = 0; i < topic.length; i++) {
		const c = topic.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) return false;
		if (c <= 126) continue;
		// Both surrogate halves share the top five bits 0xD800, so one mask
		// keeps the whole 0xD800-0xDFFF block off the common path.
		if ((c & 0xf800) !== 0xd800) continue;
		// A low surrogate reached here is unpaired by definition: a
		// well-formed pair steps the index past its own low half. A high
		// one is unpaired unless a low half follows it immediately.
		if (c > 0xdbff || i + 1 >= topic.length) return false;
		const low = topic.charCodeAt(i + 1);
		if (low < 0xdc00 || low > 0xdfff) return false;
		i++;
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
