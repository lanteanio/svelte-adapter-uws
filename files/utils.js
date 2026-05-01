// -- MIME types ------------------------------------------------------------------

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

// -- splitCookiesString -------------------------------------------------------
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

// -- Helpers -----------------------------------------------------------------

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
	return Number(multiplier !== 1 ? normalized.slice(0, -1) : normalized) * multiplier;
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
 * 256 chars, with no control characters.
 *
 * Cheap (single linear scan, no regex). Used by the production handler,
 * the dev vite plugin, and the test harness so all three apply identical
 * rules and stay in lockstep.
 *
 * @param {unknown} topic
 * @returns {boolean}
 */
export function isValidWireTopic(topic) {
	if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) return false;
	for (let i = 0; i < topic.length; i++) {
		if (topic.charCodeAt(i) < 32) return false;
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
