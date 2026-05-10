// - MIME types ------------------------------------------------------------------

export const mimes = {
	"3g2": "video/3gpp2", "3gp": "video/3gpp", "3gpp": "video/3gpp", "3mf": "model/3mf",
	"aac": "audio/aac", "apng": "image/apng", "avif": "image/avif",
	"bin": "application/octet-stream", "bmp": "image/bmp",
	"cjs": "application/node", "css": "text/css", "csv": "text/csv",
	"eot": "application/vnd.ms-fontobject", "epub": "application/epub+zip",
	"gif": "image/gif", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
	"gz": "application/gzip",
	"heic": "image/heic", "heif": "image/heif", "htm": "text/html", "html": "text/html",
	"ico": "image/x-icon", "ics": "text/calendar",
	"jar": "application/java-archive", "jpeg": "image/jpeg", "jpg": "image/jpeg",
	"js": "text/javascript", "json": "application/json", "jsonld": "application/ld+json",
	"map": "application/json", "md": "text/markdown", "mid": "audio/midi", "midi": "audio/midi",
	"mjs": "text/javascript", "mp3": "audio/mpeg", "mp4": "video/mp4", "mpeg": "video/mpeg",
	"oga": "audio/ogg", "ogg": "audio/ogg", "ogv": "video/ogg", "opus": "audio/ogg",
	"otf": "font/otf",
	"pdf": "application/pdf", "png": "image/png",
	"rtf": "text/rtf",
	"svg": "image/svg+xml", "svgz": "image/svg+xml",
	"tif": "image/tiff", "tiff": "image/tiff", "toml": "application/toml",
	"ts": "video/mp2t", "ttc": "font/collection", "ttf": "font/ttf", "txt": "text/plain",
	"vtt": "text/vtt",
	"wasm": "application/wasm", "wav": "audio/wav", "weba": "audio/webm",
	"webm": "video/webm", "webmanifest": "application/manifest+json", "webp": "image/webp",
	"woff": "font/woff", "woff2": "font/woff2",
	"xhtml": "application/xhtml+xml", "xml": "text/xml",
	"yaml": "text/yaml", "yml": "text/yaml", "zip": "application/zip"
};

/**
 * @param {string} name
 * @returns {string}
 */
export function mimeLookup(name) {
	const idx = name.lastIndexOf('.');
	return mimes[idx !== -1 ? name.substring(idx + 1).toLowerCase() : ''] || 'application/octet-stream';
}

// - splitCookiesString -------------------------------------------------------
// Adapted from set-cookie-parser (https://github.com/nfriedly/set-cookie-parser)
// Copyright (c) Nathan Friedly - MIT License
// -----------------------------------------------------------------------------

export function splitCookiesString(cookiesString) {
	if (Array.isArray(cookiesString)) return cookiesString;
	if (typeof cookiesString !== 'string') return [];

	const cookiesStrings = [];
	let pos = 0;
	let start, ch, lastComma, nextStart, cookiesSeparatorFound;

	function skipWhitespace() {
		while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) pos++;
		return pos < cookiesString.length;
	}

	function notSpecialChar() {
		ch = cookiesString.charAt(pos);
		return ch !== '=' && ch !== ';' && ch !== ',';
	}

	while (pos < cookiesString.length) {
		start = pos;
		cookiesSeparatorFound = false;

		while (skipWhitespace()) {
			ch = cookiesString.charAt(pos);
			if (ch === ',') {
				lastComma = pos;
				pos++;
				skipWhitespace();
				nextStart = pos;
				while (pos < cookiesString.length && notSpecialChar()) pos++;
				if (pos < cookiesString.length && cookiesString.charAt(pos) === '=') {
					cookiesSeparatorFound = true;
					pos = nextStart;
					cookiesStrings.push(cookiesString.substring(start, lastComma));
					start = pos;
				} else {
					pos = lastComma + 1;
				}
			} else {
				pos++;
			}
		}

		if (!cookiesSeparatorFound || pos >= cookiesString.length) {
			cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
		}
	}

	return cookiesStrings;
}

// - Helpers -----------------------------------------------------------------

/**
 * @param {string} value
 * @returns {number}
 */
export function parse_as_bytes(value) {
	const str = value.trim();
	const last = str[str.length - 1]?.toUpperCase();
	// Strip trailing 'B' (e.g. "512KB" -> "512K")
	const normalized = last === 'B' ? str.slice(0, -1) : str;
	const suffix = normalized[normalized.length - 1]?.toUpperCase();
	const multiplier =
		{ K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[suffix] ?? 1;
	const result = Number(multiplier !== 1 ? normalized.slice(0, -1) : normalized) * multiplier;
	// NaN already throws via downstream callers; reject negative and
	// non-finite values too so a stray '-100' or 'Infinity' in env can
	// never silently disable a size cap or wrap to a giant positive
	// in arithmetic.
	if (!Number.isFinite(result) || result < 0) return NaN;
	return result;
}

/**
 * Write a chunk to a uWS HttpResponse inside a cork and, if backpressure
 * builds, return a Promise that resolves when the socket drains or the
 * timeout elapses. Returns `true` synchronously when no drain is needed.
 *
 * All uWS response mutations (write + onWritable registration) happen
 * inside the cork callback, which uWS invokes synchronously, so the
 * boolean return value of `res.write()` is captured correctly.
 *
 * @param {{ cork: (fn: () => void) => void, write: (value: any) => boolean, onWritable: (fn: () => boolean) => void }} res
 * @param {any} value
 * @param {number} [timeoutMs]
 * @returns {true | Promise<boolean>} true if the write succeeded without drain; otherwise a promise that resolves true on drain or false on timeout.
 */
export function writeChunkWithBackpressure(res, value, timeoutMs = 30000) {
	let ok = false;
	/** @type {Promise<boolean> | null} */
	let drainPromise = null;
	res.cork(() => {
		ok = res.write(value);
		if (!ok) {
			drainPromise = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(false), timeoutMs);
				res.onWritable(() => {
					clearTimeout(timer);
					resolve(true);
					return true;
				});
			});
		}
	});
	return ok ? true : /** @type {Promise<boolean>} */ (drainPromise);
}

/**
 * Drain a coalesce-by-key buffer.
 *
 * Iterates entries in insertion order and calls `send` for each. Entries
 * whose send result is SUCCESS (0) are removed from the map. The function
 * stops on the first BACKPRESSURE (1) or DROPPED (2) result, leaving the
 * remaining entries (and the one that just hit pressure, in the DROPPED
 * case) for a later flush.
 *
 * Pure: no I/O of its own, no timers, no globals. The caller supplies
 * `send`, which is the only side-effecting boundary, so this is unit-
 * testable with a mock send fn.
 *
 * Map insertion order is preserved across overwrites: setting an existing
 * key replaces the value but keeps the original slot. Latest value wins,
 * order is stable.
 *
 * @template T
 * @param {Map<string, T>} pending
 * @param {(value: T) => number} send  0 SUCCESS, 1 BACKPRESSURE, 2 DROPPED
 */
export function drainCoalesced(pending, send) {
	for (const [key, value] of pending) {
		const result = send(value);
		if (result === 2) return;
		pending.delete(key);
		if (result === 1) return;
	}
}

/**
 * Allocate the next monotonic sequence number for a topic, mutating
 * `seqMap` in place. The first call for a topic returns 1; subsequent
 * calls return the previous value plus one. Each topic has an
 * independent counter.
 *
 * Pure with respect to inputs other than the supplied map. Suitable
 * for unit tests that pass a fresh map per case.
 *
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @returns {number}
 */
export function nextTopicSeq(seqMap, topic) {
	const next = (seqMap.get(topic) ?? 0) + 1;
	seqMap.set(topic, next);
	return next;
}

/**
 * Complete a JSON envelope started by an `envelopePrefix` builder.
 *
 * Appends the JSON-encoded data and an optional `seq` field, plus the
 * closing brace. When `seq` is `null` or `undefined` the field is
 * omitted entirely so the wire shape matches the legacy
 * `{topic,event,data}` envelope verbatim. When `seq` is a number the
 * resulting envelope is `{topic,event,data,seq}`.
 *
 * No JSON.stringify on the seq itself: numbers serialize identically
 * via plain string concatenation, saving a stringify call on the
 * publish hot path.
 *
 * @param {string} prefix  output of envelopePrefix(topic, event)
 * @param {unknown} data
 * @param {number | null | undefined} seq
 * @returns {string}
 */
export function completeEnvelope(prefix, data, seq) {
	const body = prefix + JSON.stringify(data ?? null);
	return seq == null ? body + '}' : body + ',"seq":' + seq + '}';
}

/**
 * Wrap an array of pre-built per-event envelope strings into a single
 * `{"type":"batch","events":[...]}` wire frame. Each input string is
 * a complete `{topic, event, data, seq?}` envelope as produced by
 * `completeEnvelope`. The output is the wire format
 * `platform.publishBatched` emits for clients that have advertised
 * the `'batch'` capability.
 *
 * Pure helper: pure string concatenation, no allocations beyond the
 * result string and the intermediate join. Cheap enough to live on
 * the publishBatched hot path.
 *
 * @param {string[]} eventEnvelopes
 * @returns {string}
 */
export function wrapBatchEnvelope(eventEnvelopes) {
	if (eventEnvelopes.length === 0) return '{"type":"batch","events":[]}';
	return '{"type":"batch","events":[' + eventEnvelopes.join(',') + ']}';
}

/**
 * Collapse events that share a `coalesceKey` so only the latest value
 * survives in the batch. Events without a `coalesceKey` pass through
 * unchanged. The latest occurrence's position is preserved (so the
 * order of non-collapsed events is stable, and the surviving entry
 * appears at the position the latest value arrived in).
 *
 * Use case: high-frequency `publishBatched` calls carrying many
 * cursor / presence / price-tick events, where intermediate values are
 * noise. Tagging each with a `coalesceKey` (e.g. `'cursor:' + userId`)
 * lets a single batch deliver only the latest position per user even
 * if the caller submitted hundreds.
 *
 * Pure helper: returns the input array untouched (same reference) when
 * no event carries a `coalesceKey`, so the common no-coalesce path
 * pays only one linear scan.
 *
 * @template {{ coalesceKey?: string }} T
 * @param {T[]} messages
 * @returns {T[]}
 */
export function collapseByCoalesceKey(messages) {
	let hasCoalesce = false;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].coalesceKey !== undefined) { hasCoalesce = true; break; }
	}
	if (!hasCoalesce) return messages;
	/** @type {Map<string, number>} */
	const lastByKey = new Map();
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key !== undefined) lastByKey.set(key, i);
	}
	const out = [];
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key === undefined || lastByKey.get(key) === i) {
			out.push(messages[i]);
		}
	}
	return out;
}

/**
 * Resolve which pressure signal (if any) is firing for a given sample.
 *
 * Precedence is fixed: MEMORY beats PUBLISH_RATE beats SUBSCRIBERS. Memory
 * is the most urgent signal because the worker is approaching OOM; publish
 * rate is next because CPU saturation cascades fastest; subscriber ratio
 * comes last because heavy fan-out degrades gracefully.
 *
 * Any threshold may be `false` to disable that signal entirely. A signal
 * fires when the corresponding sample value is greater than or equal to
 * its threshold.
 *
 * Pure: no I/O, no globals. Suitable for unit tests.
 *
 * @param {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number }} sample
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false }} thresholds
 * @returns {'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY'}
 */
export function computePressureReason(sample, thresholds) {
	if (
		thresholds.memoryHeapUsedRatio !== false &&
		sample.heapUsedRatio >= thresholds.memoryHeapUsedRatio
	) {
		return 'MEMORY';
	}
	if (
		thresholds.publishRatePerSec !== false &&
		sample.publishRate >= thresholds.publishRatePerSec
	) {
		return 'PUBLISH_RATE';
	}
	if (
		thresholds.subscriberRatio !== false &&
		sample.subscriberRatio >= thresholds.subscriberRatio
	) {
		return 'SUBSCRIBERS';
	}
	return 'NONE';
}

/**
 * Reduce a per-topic publish-stats Map (`topic -> { m, b }` where `m` is
 * messages-in-window and `b` is bytes-in-window) into per-second rates.
 * Returns the top 5 topics by message rate plus any topics that crossed
 * either threshold.
 *
 * Pure: no I/O, no globals, does not mutate the input. The caller is
 * responsible for clearing the source map after sampling.
 *
 * @param {Map<string, { m: number, b: number }>} stats
 * @param {number} intervalSec
 * @param {{ topicPublishRatePerSec: number | false, topicPublishBytesPerSec: number | false }} thresholds
 * @returns {{ topPublishers: { topic: string, messagesPerSec: number, bytesPerSec: number }[], overThreshold: { topic: string, messagesPerSec: number, bytesPerSec: number }[] }}
 */
export function computeTopPublishers(stats, intervalSec, thresholds) {
	const topicRates = [];
	const overThreshold = [];
	const msgThreshold = thresholds.topicPublishRatePerSec;
	const byteThreshold = thresholds.topicPublishBytesPerSec;
	for (const [topic, s] of stats) {
		const messagesPerSec = intervalSec > 0 ? s.m / intervalSec : 0;
		const bytesPerSec = intervalSec > 0 ? s.b / intervalSec : 0;
		const entry = { topic, messagesPerSec, bytesPerSec };
		topicRates.push(entry);
		const tooManyMsg = msgThreshold !== false && messagesPerSec >= msgThreshold;
		const tooManyBytes = byteThreshold !== false && bytesPerSec >= byteThreshold;
		if (tooManyMsg || tooManyBytes) overThreshold.push(entry);
	}
	topicRates.sort((a, b) => b.messagesPerSec - a.messagesPerSec);
	return { topPublishers: topicRates.slice(0, 5), overThreshold };
}

// Symbol-keyed slots for adapter-internal scratch state on the
// per-connection userData object.
//
// The adapter needs to track per-connection state (the topic Set used
// to populate CloseContext.subscriptions, the coalesce-by-key buffer
// used by sendCoalesced) somewhere accessible from the WebSocket
// message handler. Stashing it on userData keeps the access pattern
// fast - the WS message handler already has userData in hand via
// ws.getUserData() and a property lookup is cheaper than a WeakMap.
//
// Using Symbol-keyed properties (rather than dunder strings like
// '__subscriptions') prevents collisions with arbitrary user upgrade
// hook returns: a user that does `return { __subscriptions: ... }`
// from upgrade() can no longer clobber the adapter's tracking, and
// Object.keys / JSON.stringify / spread on userData skip these slots
// so they do not leak into client serializations.
//
// The symbols are exported from this module so handler.js, vite.js,
// and testing.js share the same identity. Each Symbol() call creates
// a unique value, so the adapter's slot is unreachable from user code
// that does not import this module.

export const WS_SUBSCRIPTIONS = Symbol('adapter-uws.ws.subscriptions');
export const WS_COALESCED = Symbol('adapter-uws.ws.coalesced');
export const WS_SESSION_ID = Symbol('adapter-uws.ws.session-id');
export const WS_PENDING_REQUESTS = Symbol('adapter-uws.ws.pending-requests');
export const WS_STATS = Symbol('adapter-uws.ws.stats');
export const WS_PLATFORM = Symbol('adapter-uws.ws.platform');
/**
 * Set of capabilities the connected client has advertised via a
 * `{type:'hello', caps: [...]}` frame. Read by `platform.publishBatched`
 * to decide whether to emit a wire-level batch envelope or fall back
 * to N individual frames for that connection. Empty / undefined is
 * the safe default - assume the client has no opt-in features.
 */
export const WS_CAPS = Symbol('adapter-uws.ws.caps');

// - Bounded-by-default capacity caps ---------------------------------------
// Single source of truth for the per-connection and module-level Map / Set
// caps that handler.js, vite.js, and testing.js all enforce. The numbers
// are deliberately generous - far above any healthy single-connection use,
// even at uWS's million-connection scale - so they catch obvious bugs
// (subscribe-in-a-loop, request-without-await, coalesce-key-leak) without
// ever biting real apps. Aggregate memory is bounded separately by
// `upgradeAdmission.maxConcurrent`; per-conn caps are not the right place
// to defend against a 1M-connection DoS.

/** Max distinct topics one connection may be subscribed to before further subscribes are denied with `RATE_LIMITED`. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 1_000_000;

/** Max in-flight server-initiated `platform.request` calls per connection before further requests reject immediately. */
export const MAX_PENDING_REQUESTS_PER_CONNECTION = 1_000_000;

/** Max distinct keys in the per-connection sendCoalesced buffer before the oldest insertion-order entry is dropped on insert. */
export const MAX_COALESCED_KEYS_PER_CONNECTION = 1_000_000;

/**
 * Distinct topics in the server-side seq registry that triggers a single
 * structured warning. The registry cannot be evicted (the resume protocol
 * depends on each topic's monotonic counter persisting), so the limit is
 * warn-only - a high-cardinality publisher gets surfaced via console.warn
 * before it can OOM the worker, but publish() never throws on cap.
 */
export const TOPIC_SEQS_WARN_THRESHOLD = 1_000_000;

/** Max entries in the runaway-publisher warn-throttle dedup. FIFO-evicted - dropping oldest just resets the warn cooldown for that topic. */
export const PUBLISH_WARN_DEDUP_MAX = 1_000_000;

/**
 * String-keyed slot used to carry the per-connection requestId from
 * `upgrade` to `open`. Cannot be a Symbol: uWebSockets.js strips
 * Symbol-keyed properties from the userData object passed to
 * `res.upgrade()` (only string keys survive the C++ binding boundary).
 * The `open` hook deletes this slot after promoting the value into the
 * Symbol-keyed `WS_PLATFORM` clone, so it never leaks into hook code.
 */
export const WS_REQUEST_ID_KEY = '__adapter_uws_request_id__';

/**
 * Sanitize a possibly-present `X-Request-ID` header value into a value
 * safe to expose as `platform.requestId`. Returns `null` if the input is
 * absent, empty, longer than 128 chars, or contains anything outside the
 * printable ASCII range (0x21-0x7e). Callers fall back to `randomUUID()`
 * on `null`.
 *
 * The whitelist matters: `requestId` flows into structured logs and error
 * messages, where a smuggled control char (CR/LF, ANSI escape, NUL) can
 * fragment a log line or inject formatting. A single printable token is
 * the universal contract across logging libraries and tracing backends.
 *
 * @param {string | undefined | null} value
 * @returns {string | null}
 */
export function resolveRequestId(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 128) return null;
	for (let i = 0; i < trimmed.length; i++) {
		const c = trimmed.charCodeAt(i);
		if (c < 0x21 || c > 0x7e) return null;
	}
	return trimmed;
}

/**
 * Build a self-contained admission controller for WebSocket upgrades.
 *
 * Two independent layers, both opt-in (zero or unset = disabled):
 *
 * - `maxConcurrent` caps how many upgrades may be in flight at once.
 *   Crossed requests get rejected before any per-request work, so a
 *   connection storm can be shed without spending CPU on TLS / header
 *   parsing.
 * - `perTickBudget` caps how many `res.upgrade()` calls run per
 *   event-loop tick. Once the budget is spent, subsequent calls are
 *   deferred via `setImmediate` so the loop is not starved by 10K
 *   synchronous handshakes from one I/O batch.
 *
 * The returned object owns the counters and queue; one instance per
 * uWS app. Pure factory: no module-state capture, no globals - all
 * state lives in the closure so multiple instances do not interfere
 * (relevant for testing.js / vite.js parity in future work).
 *
 * @param {{ maxConcurrent?: number, perTickBudget?: number }} [opts]
 */
export function createUpgradeAdmission(opts) {
	const maxConcurrent = (opts && opts.maxConcurrent) || 0;
	const perTickBudget = (opts && opts.perTickBudget) || 0;
	let inFlight = 0;
	let perTickCount = 0;
	/** @type {Array<() => void>} */
	const deferred = [];
	let drainScheduled = false;

	function drain() {
		drainScheduled = false;
		perTickCount = 0;
		while (perTickCount < perTickBudget && deferred.length > 0) {
			const fn = /** @type {() => void} */ (deferred.shift());
			perTickCount++;
			try { fn(); } catch (err) { console.error('[ws] deferred upgrade failed:', err); }
		}
		if (deferred.length > 0) {
			drainScheduled = true;
			setImmediate(drain);
		}
	}

	return {
		/** `true` if there is room; caller is responsible for `release()`. */
		tryAcquire() {
			if (maxConcurrent > 0 && inFlight >= maxConcurrent) return false;
			inFlight++;
			return true;
		},
		release() { inFlight--; },
		/** Live snapshot, primarily for tests / introspection. */
		get inFlight() { return inFlight; },
		/**
		 * Run `fn` (the actual `res.upgrade()` call) under the per-tick
		 * budget. Returns `true` if `fn` ran synchronously, `false` if
		 * deferred to a later tick.
		 *
		 * @param {() => void} fn
		 * @returns {boolean}
		 */
		admit(fn) {
			if (perTickBudget <= 0) { fn(); return true; }
			if (perTickCount < perTickBudget) {
				perTickCount++;
				fn();
				return true;
			}
			deferred.push(fn);
			if (!drainScheduled) {
				drainScheduled = true;
				setImmediate(drain);
			}
			return false;
		}
	};
}

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
 * @typedef {Object} OriginCheckContext
 * @property {'*' | 'same-origin' | string[]} allowedOrigins
 * @property {string} [hostHeader]    - lowercased name of a HOST_HEADER env override (e.g. 'x-forwarded-host')
 * @property {string} [protocolHeader] - lowercased name of a PROTOCOL_HEADER env override
 * @property {string} [portHeader]    - lowercased name of a PORT_HEADER env override
 * @property {boolean} isTls          - true when running under SSLApp
 * @property {boolean} hasUpgradeHook - true when the user supplied an upgrade handler (used to decide whether to accept Origin-less clients)
 */

/**
 * Decide whether a WebSocket upgrade request's Origin should be accepted
 * under the configured policy.
 *
 * Returns `true` when:
 *   - allowedOrigins is '*' (wildcard accepts everything)
 *   - the request has no Origin header AND an upgrade hook is configured
 *     (the hook can authenticate non-browser clients itself)
 *   - allowedOrigins is 'same-origin' AND the Origin host+scheme match the
 *     request's host (PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER overrides
 *     applied; default ports stripped to allow port-omitted Host comparisons)
 *   - allowedOrigins is an array AND the Origin is a member
 *
 * Returns `false` otherwise. Malformed Origin headers (URL parse failure)
 * are rejected.
 *
 * Pure with respect to inputs - no I/O, no globals, no module state. The
 * env-driven header-name overrides and TLS state are passed via `ctx` so
 * the function is unit-testable and benchable.
 *
 * @param {string | undefined} reqOrigin - The request's Origin header value, if any
 * @param {Record<string, string>} headers - All request headers (lowercased keys)
 * @param {OriginCheckContext} ctx
 * @returns {boolean}
 */
export function isOriginAllowed(reqOrigin, headers, ctx) {
	if (ctx.allowedOrigins === '*') return true;
	if (!reqOrigin) return ctx.hasUpgradeHook;
	if (ctx.allowedOrigins === 'same-origin') {
		try {
			const parsed = new URL(reqOrigin);
			const requestHost = (ctx.hostHeader && headers[ctx.hostHeader]) || headers['host'];
			if (!requestHost) return false;
			const requestScheme = ctx.protocolHeader
				? (headers[ctx.protocolHeader] || (ctx.isTls ? 'https' : 'http'))
				: (ctx.isTls ? 'https' : 'http');
			// Merge PORT_HEADER into the host the same way get_origin() does,
			// so proxies that split host/port across headers still match.
			const requestPort = ctx.portHeader ? headers[ctx.portHeader] : undefined;
			let expectedHost = requestHost;
			if (requestPort) {
				expectedHost = requestHost.replace(/:\d+$/, '') + ':' + requestPort;
			}
			// Strip the default port so "example.com" matches "example.com:443"
			// (URL.host omits the port when it is the default for the scheme).
			const defaultPort = requestScheme === 'https' ? '443' : '80';
			expectedHost = expectedHost.replace(':' + defaultPort, '');
			return parsed.host === expectedHost && parsed.protocol === requestScheme + ':';
		} catch {
			return false;
		}
	}
	if (Array.isArray(ctx.allowedOrigins)) return ctx.allowedOrigins.includes(reqOrigin);
	return false;
}

/**
 * CSRF defense for the authenticate POST endpoint. The endpoint accepts
 * session cookies and runs the user's `authenticate` hook (which may refresh
 * cookies, write audit log entries, or bump per-user rate-limit counters).
 * Without an origin-side guard, an attacker page from a third-party origin
 * can issue a credentialed `fetch(..., { credentials: 'include' })` and the
 * victim's cookie rides along, executing those side effects on the victim's
 * behalf.
 *
 * Returns `true` when at least one of the following holds:
 *   - `x-requested-with: XMLHttpRequest` is present. Cross-origin browsers
 *     cannot forge custom headers without first passing a CORS preflight,
 *     and this endpoint never approves one. The adapter client always
 *     stamps this header on its preflight POST.
 *   - `Sec-Fetch-Site: same-origin` is present. Modern browsers stamp this
 *     header on every navigation/fetch automatically; it cannot be forged
 *     from script.
 *   - `Origin` is present and matches the configured `allowedOrigins`
 *     policy via the same logic the WebSocket upgrade uses (see
 *     `isOriginAllowed`). `hasUpgradeHook` is forced false so a missing
 *     `Origin` header is always rejected here, even when the upgrade-side
 *     check would have accepted it (the upgrade hook authenticates
 *     non-browser clients itself; this endpoint must not).
 *
 * Apps that need to accept this endpoint from native (non-browser) clients
 * without these headers can opt out at the call site.
 *
 * @param {Record<string, string | undefined>} headers - request headers (lowercased keys)
 * @param {OriginCheckContext} originCtx - same shape consumed by `isOriginAllowed`
 * @returns {boolean}
 */
export function isAuthOriginAccepted(headers, originCtx) {
	const xrw = (headers['x-requested-with'] || '').toLowerCase();
	if (xrw === 'xmlhttprequest') return true;
	const sfs = (headers['sec-fetch-site'] || '').toLowerCase();
	if (sfs === 'same-origin') return true;
	return isOriginAllowed(headers['origin'], /** @type {Record<string, string>} */ (headers), {
		allowedOrigins: originCtx.allowedOrigins,
		hostHeader: originCtx.hostHeader,
		protocolHeader: originCtx.protocolHeader,
		portHeader: originCtx.portHeader,
		isTls: originCtx.isTls,
		hasUpgradeHook: false
	});
}

/**
 * @typedef {Object} SafeOriginConfigInput
 * @property {string | string[]} allowedOrigins - resolved value (default 'same-origin')
 * @property {boolean} hasOriginEnv             - true when ORIGIN env is set
 * @property {boolean} hasHostHeader            - true when HOST_HEADER env is set
 * @property {boolean} isTls                    - true when running under SSLApp
 * @property {boolean} hasUpgradeHook           - true when the user supplied an upgrade handler
 * @property {boolean} optOut                   - explicit opt-out for the misconfig case
 */

/**
 * Detect the misconfig "same-origin policy on a public-internet listener
 * with no fronting trust." When `allowedOrigins` is `'same-origin'`, the
 * server compares the request's `Origin` header to its `Host` header. If
 * the deployment terminates TLS itself (SSL_CERT) OR sits behind a proxy
 * that pins those values via a fixed `ORIGIN` env or a trusted
 * `HOST_HEADER`, the comparison is meaningful. Without any of those, both
 * inputs are attacker-controlled and the comparison passes for any
 * non-browser scripted client. When a user `upgrade` hook is present, that
 * hook is the real authentication boundary and the misconfig is harmless;
 * otherwise it leaves the WebSocket fully open.
 *
 * Returns `null` when the configuration is safe. Returns a human-readable
 * error message describing the missing pieces when the misconfig is
 * detected and `optOut` is false. Callers throw the message at startup so
 * the misconfig cannot reach production unnoticed.
 *
 * @param {SafeOriginConfigInput} input
 * @returns {string | null}
 */
export function describeUnsafeSameOriginConfig(input) {
	if (input.allowedOrigins !== 'same-origin') return null;
	if (input.hasOriginEnv || input.hasHostHeader || input.isTls || input.hasUpgradeHook) return null;
	if (input.optOut) return null;
	return (
		"WebSocket upgrade is configured with allowedOrigins: 'same-origin' but " +
		'no host pin is in place: ORIGIN env unset, HOST_HEADER env unset, no ' +
		'SSL_CERT/SSL_KEY for native TLS, and no upgrade() hook to authenticate ' +
		'non-browser clients. The same-origin check then compares two ' +
		'attacker-controlled headers (Origin vs Host) and trivially passes for ' +
		'any non-browser scripted client. Resolve with one of:\n' +
		'  - SSL_CERT + SSL_KEY for native TLS (no proxy needed)\n' +
		'  - ORIGIN=https://example.com (behind a TLS proxy)\n' +
		'  - PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)\n' +
		'  - export an upgrade() hook from hooks.ws.{js,ts} that authenticates the connection itself\n' +
		'  - allowedOrigins: [...] with an explicit allowlist\n' +
		"Apps that have audited this and want the previous warn-only behavior can pass " +
		'`websocket.unsafeSameOriginWithoutHostPin: true` in svelte.config.js.'
	);
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function parse_origin(value) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	let url;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. ORIGIN must be a valid URL with http:// or https:// protocol.`,
			{ cause: error }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. Only http:// and https:// protocols are supported.`
		);
	}
	return url.origin;
}

// - Chaos / fault-injection state ------------------------------------------
// State machine consulted by the test harness to simulate broken-network
// conditions while exercising protocol code (subscribe acks, session resume,
// per-topic seq, sendCoalesced, request/reply, etc). Pure helper - no I/O,
// no module-state capture; one instance per server / per harness so parallel
// tests do not stomp on each other.
//
// Three continuous scenarios in this state machine:
//   - 'drop-outbound': probabilistically discard outbound frames before they
//     reach the wire. dropRate is a number in [0, 1].
//   - 'slow-drain': defer outbound frames by delayMs via setTimeout. Order
//     is preserved per call site (every frame waits the same delay).
//   - 'ipc-reorder': defer each outbound frame by an independently-random
//     delay in [0, maxJitterMs]. Adjacent frames can arrive out of order,
//     simulating cross-worker relay reordering or queue jitter.
//
// One scenario lives outside this state machine because it is a one-shot
// trigger rather than continuous state:
//   - 'worker-flap': close all live WebSocket connections with a configurable
//     code/reason, simulating a worker process restart in cluster mode. The
//     test harness handles this directly inside its `__chaos` setter; the
//     chaos state machine does NOT track it.

/** Cap on the jitter window for `ipc-reorder` to keep the delay bounded. */
const CHAOS_MAX_JITTER_MS = 60_000;

/**
 * Build a chaos state machine. Inactive by default; callers gate their
 * interception logic on `state.scenario !== null`.
 *
 * @param {{ random?: () => number }} [opts] Optional injection point for
 *   tests that need a deterministic RNG (default `Math.random`).
 */
export function createChaosState(opts) {
	const random = (opts && opts.random) || Math.random;
	/** @type {{ scenario: string | null, dropRate: number, delayMs: number, maxJitterMs: number }} */
	const state = { scenario: null, dropRate: 0, delayMs: 0, maxJitterMs: 0 };

	return {
		get scenario() { return state.scenario; },
		get dropRate() { return state.dropRate; },
		get delayMs() { return state.delayMs; },
		get maxJitterMs() { return state.maxJitterMs; },

		/**
		 * Activate a scenario. Pass `null` (or call `reset()`) to clear.
		 *
		 * @param {{
		 *   scenario: 'drop-outbound' | 'slow-drain' | 'ipc-reorder',
		 *   dropRate?: number,
		 *   delayMs?: number,
		 *   maxJitterMs?: number
		 * } | null} cfg
		 */
		set(cfg) {
			if (cfg === null || cfg === undefined) {
				state.scenario = null;
				state.dropRate = 0;
				state.delayMs = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'drop-outbound') {
				const r = typeof cfg.dropRate === 'number' ? cfg.dropRate : 0;
				if (r < 0 || r > 1 || Number.isNaN(r)) {
					throw new Error('chaos: dropRate must be a number in [0, 1]');
				}
				state.scenario = 'drop-outbound';
				state.dropRate = r;
				state.delayMs = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'slow-drain') {
				const d = typeof cfg.delayMs === 'number' ? cfg.delayMs : 0;
				if (d < 0 || !Number.isFinite(d)) {
					throw new Error('chaos: delayMs must be a non-negative finite number');
				}
				state.scenario = 'slow-drain';
				state.delayMs = d;
				state.dropRate = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'ipc-reorder') {
				const j = typeof cfg.maxJitterMs === 'number' ? cfg.maxJitterMs : 0;
				if (j < 0 || !Number.isFinite(j)) {
					throw new Error('chaos: maxJitterMs must be a non-negative finite number');
				}
				if (j > CHAOS_MAX_JITTER_MS) {
					throw new Error('chaos: maxJitterMs must be <= ' + CHAOS_MAX_JITTER_MS);
				}
				state.scenario = 'ipc-reorder';
				state.maxJitterMs = j;
				state.dropRate = 0;
				state.delayMs = 0;
				return;
			}
			throw new Error(
				`chaos: unknown scenario '${cfg.scenario}'. Supported: 'drop-outbound', 'slow-drain', 'ipc-reorder'.`
			);
		},

		reset() {
			state.scenario = null;
			state.dropRate = 0;
			state.delayMs = 0;
			state.maxJitterMs = 0;
		},

		/**
		 * Returns true if the caller should drop the outbound frame. Always
		 * false when the active scenario is not 'drop-outbound'. dropRate of
		 * 0 never drops; dropRate of 1 always drops; values in between drop
		 * with the configured probability.
		 */
		shouldDropOutbound() {
			if (state.scenario !== 'drop-outbound') return false;
			if (state.dropRate <= 0) return false;
			if (state.dropRate >= 1) return true;
			return random() < state.dropRate;
		},

		/**
		 * Returns the delay in ms the caller should defer an outbound frame
		 * by. Three cases:
		 * - `slow-drain`: returns the configured `delayMs` (constant, order
		 *   preserved across frames).
		 * - `ipc-reorder`: returns an independently-random delay in
		 *   `[0, maxJitterMs)`, so adjacent frames can arrive out of order.
		 * - any other scenario (or `null`): returns 0.
		 */
		getDelayMs() {
			if (state.scenario === 'slow-drain') return state.delayMs;
			if (state.scenario === 'ipc-reorder') return random() * state.maxJitterMs;
			return 0;
		}
	};
}

// - Framework-internal assertions ------------------------------------------
// Library-author defensive coding only. App developers do not call these
// directly - they consume the read-only `platform.assertions` Map via
// handler.js's getter for ops dashboards, and the structured `console.error`
// output for issue reports. Categories follow a `<area>.<thing>` convention
// (e.g. `'relay.topic-type'`, `'ws.platform-missing'`); extension authors
// adopt a package prefix to avoid collisions (`'redis.*'`, `'realtime.*'`).
//
// Behaviour is asymmetric between production and test:
// - In production, assert() logs + increments the counter, but does NOT
//   throw. A throw inside a uWS C++ callback frame can corrupt the worker's
//   binding state; the structured log + the queryable counter are enough
//   for ops to detect a regression and file an issue.
// - In test mode (`process.env.VITEST` set, or `NODE_ENV === 'test'`),
//   assert() throws so the runner fails loudly. The counter still
//   increments so test code can assert on it.
//
// devAssert is dev-time only: it throws in dev and test, and is a complete
// no-op in production. Use it for cosmetic / DX-shape checks where the
// runtime cost of the comparison is unwelcome in production.

const assertionCounts = new Map();

const isTestEnv = process.env.VITEST !== undefined ||
	process.env.NODE_ENV === 'test';
const isProdEnv = process.env.NODE_ENV === 'production';

/**
 * Always-on framework invariant assertion. On violation: increments
 * `assertionCounts.get(category)`, logs a structured `console.error`,
 * and (in test mode only) throws so vitest surfaces the failure.
 *
 * Hot-path safe: the success branch is one comparison, JIT-folded.
 *
 * @param {unknown} cond - any truthy expression
 * @param {string} category - dot-prefixed namespace (e.g. `'relay.topic-type'`)
 * @param {object} [context] - free-form context payload for logs / error
 */
export function assert(cond, category, context) {
	if (cond) return;
	assertionCounts.set(category, (assertionCounts.get(category) || 0) + 1);
	if (isTestEnv) {
		const err = new Error('adapter-uws assert: ' + category);
		// @ts-ignore augment with context for test diagnostics
		err.context = context ?? null;
		throw err;
	}
	try {
		console.error('[adapter-uws/assert]', JSON.stringify({
			category,
			context: context ?? null
		}));
	} catch {
		// JSON.stringify can fail on circular context; fall back to bare log
		console.error('[adapter-uws/assert]', category);
	}
}

/**
 * Dev-time invariant. No-op in production (zero runtime cost when
 * `NODE_ENV === 'production'`); throws in dev / test so the violation
 * surfaces during development. Use for DX hints and cosmetic shape
 * checks that should not cost anything in shipped builds.
 *
 * @param {unknown} cond
 * @param {string} message
 * @param {object} [context]
 */
export function devAssert(cond, message, context) {
	if (cond) return;
	if (isProdEnv) return;
	const err = new Error('adapter-uws devAssert: ' + message);
	// @ts-ignore
	err.context = context ?? null;
	try {
		console.error('[adapter-uws/devAssert]', JSON.stringify({
			message,
			context: context ?? null
		}));
	} catch {
		console.error('[adapter-uws/devAssert]', message);
	}
	throw err;
}

/**
 * Read-only access to the per-category violation counts. The returned
 * Map is the live module-level instance - do not mutate. Surfaced via
 * `platform.assertions` for ops dashboards and integration tests.
 *
 * @returns {Map<string, number>}
 */
export function readAssertionCounts() {
	return assertionCounts;
}

/**
 * Reset the assertion counter map. Test-only utility - production code
 * should never call this. Exists so unit tests can isolate counters
 * between cases without leaking state across `describe` blocks.
 */
export function _resetAssertionCountsForTest() {
	assertionCounts.clear();
}
