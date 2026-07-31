// @ts-check
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as nodeDnsLookup } from 'node:dns';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { checkUrl, classifyAddress } from '../../safe-url.js';
import { randomFloat, setTimer, clearTimer, now, wallEpoch } from '../../runtime/runtime.js';

import { WebhookAdmissionDeniedError } from './controls.js';

export {
	createWebhookAdmission,
	createRetryBudget,
	createWebhookBreaker,
	WebhookCircuitOpenError,
	WebhookAdmissionDeniedError
} from './controls.js';

/**
 * Generic outbound-webhook delivery: SSRF-gated, DNS-pinned, HMAC-signed HTTP
 * POST with jittered-exponential retry. Transport-only and framework-free - it
 * takes a per-webhook config plus the `(topic, event, data)` of one event and
 * returns a terminal outcome; it never throws, never reports, and holds no
 * state. The realtime layer wraps it with event fan-out, failure reporting, and
 * dead-letter capture; a future budget/breaker rides the same config object.
 *
 * Every timer and random draw goes through the runtime seam (`runtime/runtime.js`)
 * so a seeded/deterministic harness controls the jittered backoff, and every URL
 * (initial and each redirect hop) is gated by `safe-url`'s `checkUrl` with the
 * connection pinned to the validated address set so a resolved host cannot rebind
 * to a private address after the check.
 *
 * @module svelte-adapter-uws/plugins/webhooks/server
 */

/**
 * Strip a URL down to its origin before it appears in an error message or log
 * line: userinfo (`user:pass@`), the query string, AND the path can all carry
 * secrets (mainstream webhook endpoints embed their credential in the path,
 * e.g. `https://hooks.example.com/services/T00/B00/SECRET`), and URL-bearing
 * failure messages are persisted in dead-letter queues and logs, so only the
 * origin is safe to keep. Falls back to a fixed placeholder when the value
 * does not parse.
 * @param {string} url
 * @returns {string}
 */
/** Default freshness window, in seconds, either side of the receiver's clock. */
const DEFAULT_SIGNATURE_TOLERANCE_S = 300;

/**
 * Ceiling on the `x-webhook-signature` header this will parse at all.
 *
 * One entry is `sha256=` plus 64 hex characters, so 1 KB already admits about
 * fourteen. The header is attacker-controlled and was previously unbounded.
 */
const MAX_SIGNATURE_HEADER_LENGTH = 1024;

/**
 * Ceiling on the decimal Unix-seconds timestamp header. The sender currently
 * emits ten digits; sixteen exceeds even JavaScript's maximum Date range while
 * bounding validation and signed-prefix allocation for a wire-controlled value.
 */
const MAX_TIMESTAMP_HEADER_LENGTH = 16;

/**
 * Ceiling on signature entries compared, so the compare count cannot be driven
 * from the wire. Rotation needs two (old and new); this is generous.
 */
const MAX_SIGNATURE_ENTRIES = 8;

/**
 * Constant-time compare of two ASCII strings. Returns false on a length
 * mismatch (which `timingSafeEqual` throws on) without comparing further -
 * the length of a hex digest is not a secret.
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * The received body as the exact bytes to sign, or null if it is not a body
 * this function can hash byte-exactly.
 *
 * A receiver reads its body in whichever shape its framework hands over, and
 * the three that matter are all byte containers: `Buffer` (Node), `ArrayBuffer`
 * (`await request.arrayBuffer()`) and any typed-array view over one. A string
 * is accepted too and encoded as UTF-8, which is what a sender that signed a
 * JSON string produced. Anything else - an already-parsed object, a stream, a
 * null body - cannot be reconstructed byte-for-byte here and returns null so
 * the caller fails closed instead of verifying against a coerced stand-in.
 *
 * @param {unknown} rawBody
 * @returns {Buffer | null}
 */
function toBodyBytes(rawBody) {
	if (Buffer.isBuffer(rawBody)) return rawBody;
	if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
	// A view must be sliced to ITS window, not the whole backing buffer: a
	// `Uint8Array` over a pooled allocation would otherwise hash its neighbours.
	if (ArrayBuffer.isView(rawBody)) {
		return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
	}
	if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody);
	return null;
}

/**
 * Verify a delivery on the RECEIVING side.
 *
 * Shipped as executable code rather than a documentation snippet on purpose:
 * this contract has four separate ways to get it subtly wrong (a non-numeric
 * timestamp making the `.` delimiter ambiguous, a missing freshness window
 * that lets a capture replay forever, verifying a re-serialized body instead
 * of the raw bytes, and a `===` comparison that leaks the digest a byte at a
 * time), and every receiver re-implementing it from prose gets to make those
 * mistakes independently.
 *
 * Accepts when ANY comma-separated entry in `x-webhook-signature` matches -
 * several appear only while a `previousSecret` rotation is converging, and
 * both sign the same timestamped material.
 *
 * @param {Record<string, string | string[] | undefined>} headers - received headers, lowercase keys
 * @param {string | Buffer | ArrayBuffer | ArrayBufferView} rawBody - the body EXACTLY as received,
 *   before any JSON round-trip. Pass whatever your framework gives you: a Node `Buffer`, the
 *   `ArrayBuffer` from `await request.arrayBuffer()`, a typed-array view over one, or the raw string.
 *   An already-parsed object cannot be verified - re-serializing it does not reproduce the bytes the
 *   sender signed - and is refused rather than coerced.
 * @param {{ secret?: string, secrets?: string[], toleranceSeconds?: number, nowMs?: number }} [options]
 * @returns {boolean}
 */
export function verifyWebhookSignature(headers, rawBody, options) {
	// Authentication helpers must fail closed even when a framework hands over a
	// malformed header container or a detached byte view. Keeping the catch at
	// the public boundary also covers hostile accessors without weakening the
	// straight-line verifier below.
	try {
		return verifyWebhookSignatureUnchecked(headers, rawBody, options);
	} catch {
		return false;
	}
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string | Buffer | ArrayBuffer | ArrayBufferView} rawBody
 * @param {{ secret?: string, secrets?: string[], toleranceSeconds?: number, nowMs?: number } | undefined} options
 * @returns {boolean}
 */
function verifyWebhookSignatureUnchecked(headers, rawBody, options) {
	if (headers === null || typeof headers !== 'object') return false;
	const opts = options ?? {};
	const configuredSecrets = opts.secrets ?? (opts.secret === undefined ? [] : [opts.secret]);
	if (!Array.isArray(configuredSecrets)) return false;
	const secrets = configuredSecrets
		.filter((s) => typeof s === 'string' && s.length > 0);
	if (secrets.length === 0) return false;

	const readHeader = (/** @type {string} */ name) => {
		const v = headers[name];
		return Array.isArray(v) ? v[0] : v;
	};

	// A numeric timestamp is required, and checking it is what makes the '.'
	// delimiter unambiguous: without it a body containing a dot could be
	// re-split into a different (timestamp, body) pair that signs identically.
	const ts = readHeader('x-webhook-timestamp');
	if (
		typeof ts !== 'string' ||
		ts.length > MAX_TIMESTAMP_HEADER_LENGTH ||
		!/^\d+$/.test(ts)
	) return false;

	const tolerance = opts.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_S;
	// Freshness is an authentication boundary, so use the exact wall clock rather
	// than the runtime's 1 Hz cached `now()`. After a long event-loop stall the
	// cached value can be minutes old until its interval callback runs; the first
	// receiver verification after that stall would otherwise accept a captured
	// signature against the stale cache. Callers can still inject `nowMs` for a
	// deterministic receiver test.
	const nowMs = opts.nowMs ?? wallEpoch();
	if (
		typeof tolerance !== 'number' ||
		!Number.isFinite(tolerance) ||
		tolerance < 0 ||
		typeof nowMs !== 'number' ||
		!Number.isFinite(nowMs)
	) return false;
	const timestampSeconds = Number(ts);
	if (!Number.isFinite(timestampSeconds)) return false;
	if (Math.abs(nowMs / 1000 - timestampSeconds) > tolerance) return false;

	// SIGN THE BYTES, not a decoded string. `rawBody.toString('utf8')` replaces
	// every invalid sequence with U+FFFD, so a body that is not valid UTF-8 never
	// verifies against the signature its sender computed - and worse, two
	// different bodies that differ only inside invalid sequences decode to the
	// SAME string and therefore accept the same signature. Hashing the buffer is
	// byte-exact and is identical to the old behaviour for any body that was valid
	// UTF-8, so no legitimate sender changes.
	// EVERY byte container takes the byte path, not just `Buffer`. Testing only
	// `Buffer.isBuffer` and coercing the rest with `String()` reintroduced the
	// same defect one level down, and worse: `String(arrayBuffer)` is the
	// CONSTANT '[object ArrayBuffer]', so the digest stopped covering the body
	// at all and any two bodies signed each other. A `Uint8Array` fared no
	// better, stringifying to a decimal CSV of its bytes. Both are exactly what
	// `await request.arrayBuffer()` hands a receiver in this project's own
	// framework, which is the call the doc above invites.
	const bodyBytes = toBodyBytes(rawBody);
	// Fail closed on a body this function cannot hash byte-exactly, rather than
	// coercing it into something that hashes but means nothing.
	if (bodyBytes === null) return false;
	// The prefix is ASCII digits and a dot, so latin1 and utf8 agree on it.
	const signed = Buffer.concat([Buffer.from(ts + '.', 'latin1'), bodyBytes]);

	// BOUND THE HEADER before splitting it. The value is attacker-controlled and
	// nothing limited it: a multi-megabyte header of commas allocated one string
	// per comma and then ran a constant-time compare against every one of them,
	// for every configured secret. Failing closed on an over-long header is the
	// safe direction here - unlike the client-IP resolver, where refusing to parse
	// merges distinct identities, a rejected signature merely fails a delivery
	// that no legitimate sender produces.
	const rawSignature = readHeader('x-webhook-signature');
	if (typeof rawSignature !== 'string') return false;
	// Counted in BYTES, which is what the bound is arguing about. `.length` is
	// UTF-16 code units, so a caller that hands in an already-decoded header can
	// carry roughly twice the intended bytes under the same number.
	if (Buffer.byteLength(rawSignature, 'utf8') > MAX_SIGNATURE_HEADER_LENGTH) return false;
	const entries = rawSignature.split(',', MAX_SIGNATURE_ENTRIES);

	// No early exit on the first match: keep the work independent of WHICH
	// secret or entry matched.
	let ok = false;
	for (const secret of secrets) {
		const expected = 'sha256=' + createHmac('sha256', secret).update(signed).digest('hex');
		for (const entry of entries) {
			if (safeEqual(entry.trim(), expected)) ok = true;
		}
	}
	return ok;
}

export function redactUrl(url) {
	try {
		return new URL(url).origin;
	} catch {
		return '[unparseable-url]';
	}
}

/**
 * The origin of a URL, or null when it does not parse.
 * @param {string} url
 * @returns {string | null}
 */
function originOf(url) {
	try { return new URL(url).origin; } catch { return null; }
}

/**
 * The identities a first-attempt allowance is charged to: `<address>:<port>` for
 * EVERY address the SSRF gate pinned this request's socket to.
 *
 * Not the URL, and not its origin. Every part of the URL is caller-chosen, the
 * hostname included, so an allowance keyed on any of it is an allowance the
 * caller can multiply by inventing names: `http://127.0.0.1:P`,
 * `http://localhost:P`, `http://localhost.:P` and `http://[::1]:P` are four
 * origins reaching one listener, and one wildcard-DNS record makes the supply of
 * them unbounded.
 *
 * The whole pinned set is charged rather than one chosen member of it, because
 * WHICH member the socket lands on is not knowable before the request: the
 * connect logic tries the set (dual-stack, address by address), and a caller who
 * controls the DNS answer picks both its contents and its order. Charging every
 * address makes the question moot - wherever the socket ends up, that address
 * paid for the request - and it makes the charge order-independent, so a
 * resolver rotating its answer keys the same buckets. The set is deduplicated,
 * so an answer that repeats an address does not charge it twice, and the gate's
 * set is capped (see `MAX_PINNED_ADDRESSES`), so one delivery cannot charge an
 * unbounded number of buckets.
 *
 * `pinned` is the gate's validated address set; it is absent for an IP literal,
 * for which the URL parser has already canonicalised every encoding of the
 * address into the hostname.
 *
 * @param {string} url a URL the gate accepted, so it parses
 * @param {Array<{ address: string, family: number }> | undefined} pinned
 * @returns {string[]} sorted, deduplicated destination keys, never empty
 */
function destinationsOf(url, pinned) {
	const parsed = new URL(url);
	const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
	const keys = new Set();
	if (pinned !== undefined && pinned.length > 0) {
		for (const p of pinned) {
			keys.add((p.address.includes(':') ? '[' + p.address + ']' : p.address) + ':' + port);
		}
	} else {
		let address = parsed.hostname;
		if (address.startsWith('[')) address = address.slice(1, -1);
		keys.add((address.includes(':') ? '[' + address + ']' : address) + ':' + port);
	}
	return [...keys].sort();
}

/** Backoff sleep through the runtime timer seam; unref'd so it never holds the loop. */
function sleep(ms) {
	return new Promise((resolve) => {
		const h = setTimer(resolve, ms);
		if (h && h.unref) h.unref();
	});
}

/**
 * Await a user-supplied callback but never let it hang a delivery: races the
 * call against a bounded, unref'd timer (through the runtime seam so a seeded
 * harness stays deterministic). On timeout the promise rejects with a
 * `callback timed out (<label>)` error and the still-running callback is
 * abandoned. Applied to transform / url / validateUrl / resolve / idempotencyKey
 * so an attacker-triggered publish cannot pile up unbounded pending promises.
 */
function callWithTimeout(fn, ms, label) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimer(() => {
			if (settled) return;
			settled = true;
			reject(new Error('outbound webhook: callback timed out (' + label + ')'));
		}, ms);
		if (timer && timer.unref) timer.unref();
		Promise.resolve().then(fn).then(
			(v) => { if (!settled) { settled = true; clearTimer(timer); resolve(v); } },
			(e) => { if (!settled) { settled = true; clearTimer(timer); reject(e); } }
		);
	});
}

/** Default DNS resolver for the SSRF pin: every address, native order. */
function defaultResolve(hostname) {
	return new Promise((resolve, reject) => {
		nodeDnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
			if (err) reject(err);
			else resolve(addresses);
		});
	});
}

/** Build a node:net `lookup` that returns ONLY the pre-validated address set. */
function pinnedLookup(pinned) {
	return (hostname, options, cb) => {
		const opts = options || {};
		if (opts.all) return cb(null, pinned);
		const fam = opts.family;
		const pick = fam ? (pinned.find((p) => p.family === fam) || null) : pinned[0];
		if (!pick) {
			const err = new Error('outbound webhook: no validated address for family ' + fam);
			/** @type {any} */ (err).code = 'ENOTFOUND';
			return cb(err);
		}
		cb(null, pick.address, pick.family);
	};
}

const PIN_CACHE_DEFAULT_MS = 30000;
const PIN_CACHE_MAX_ENTRIES = 256;

/**
 * How many addresses of one DNS answer a connection is pinned to. A real
 * endpoint publishes a handful; the cap only bites on an answer padded far past
 * that, and it bounds the work and the bucket count ONE delivery can cost, since
 * the admission gate charges every address the socket could reach. Addresses
 * past the cap are dropped AFTER the whole answer has been range-checked, so a
 * private address anywhere in it still rejects the delivery - the cap can only
 * narrow where a socket may go, never widen it.
 */
const MAX_PINNED_ADDRESSES = 32;

/**
 * Per-config TTL cache of VALIDATED pins. Keyed by the config object (WeakMap,
 * so one webhook's allow-list/mode can never leak into another's cache and a
 * dropped config frees its entries) and by `host + rangeCheck` within it.
 * Serving a cached validated address set is strictly rebinding-safe - the
 * socket still reaches only addresses that passed the range check; the trade
 * is up to `pinCacheMs` of staleness against a legitimate DNS move. Only
 * successful validations are cached (a failure retries resolution on the next
 * delivery, never extending an outage), and the per-config map is bounded so
 * attacker-steered redirect hostnames cannot grow it without limit.
 * @type {WeakMap<object, Map<string, { expires: number, pinned: Array<{ address: string, family: number }> }>>}
 */
const pinCaches = new WeakMap();

/**
 * Resolve a DNS hostname and return the address set the connection is pinned to
 * - so the socket reaches exactly what was resolved here, with no second
 * resolution and no DNS-rebinding window. Every resolved value must be a real IP
 * literal (a name-like string is rejected so the pin can never fall back to a
 * second resolution); when `rangeCheck` is set (strict/allowlist) each address
 * is additionally range-checked and a private one is rejected. With `rangeCheck`
 * false (off mode) the address is pinned WITHOUT the range check, so off can
 * reach a private endpoint while still closing rebinding. Returns
 * `{ ok: false, reason }` when resolution fails, yields zero addresses, returns
 * a non-address, or (with rangeCheck) any address is private. The validated set
 * is capped at `MAX_PINNED_ADDRESSES` addresses.
 *
 * A validated pin is cached for `config.pinCacheMs` (default 30s; 0 disables),
 * so a delivery burst - and every redirect hop back to an already-validated
 * host - costs one DNS resolution per host per window instead of one per hop.
 * A custom `config.resolve` defaults the cache OFF (a caller-supplied resolver
 * owns its own rotation and caching semantics), but an explicit `pinCacheMs`
 * opts it back in.
 */
async function resolveAndPin(hostname, config, rangeCheck) {
	const resolver = config.resolve || defaultResolve;
	const cacheMs = typeof config.pinCacheMs === 'number' && Number.isFinite(config.pinCacheMs) && config.pinCacheMs >= 0
		? config.pinCacheMs
		: (config.resolve ? 0 : PIN_CACHE_DEFAULT_MS);
	const cacheKey = hostname + '\0' + (rangeCheck ? '1' : '0');
	let cache = null;
	if (cacheMs > 0) {
		cache = pinCaches.get(config) ?? null;
		if (cache === null) {
			cache = new Map();
			pinCaches.set(config, cache);
		}
		const hit = cache.get(cacheKey);
		if (hit !== undefined) {
			if (hit.expires > now()) return { ok: true, pinned: hit.pinned };
			cache.delete(cacheKey);
		}
	}
	let raw;
	try {
		raw = await callWithTimeout(() => resolver(hostname), config.callbackTimeoutMs ?? 10000, 'resolve');
	} catch {
		return { ok: false, reason: 'unresolved-host' };
	}
	const list = Array.isArray(raw) ? raw : [raw];
	if (list.length === 0) return { ok: false, reason: 'unresolved-host' };
	const pinned = [];
	for (const item of list) {
		let address = typeof item === 'string' ? item : (item && item.address);
		if (typeof address !== 'string' || address.length === 0) {
			return { ok: false, reason: 'unresolved-host' };
		}
		// Normalise a bracketed and/or zone-scoped IPv6 the resolver may hand back.
		if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
		const pct = address.indexOf('%');
		if (pct !== -1) address = address.slice(0, pct);
		const probe = address.indexOf(':') !== -1 ? 'http://[' + address + ']/' : 'http://' + address + '/';
		// Confirm the resolver returned a real IP literal, in canonical form, so
		// the pin cannot fall back to a second resolution of a name-like string.
		let canonHost;
		try { canonHost = new URL(probe).hostname; } catch { return { ok: false, reason: 'unresolved-host' }; }
		const isIp = canonHost.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(canonHost);
		if (!isIp) return { ok: false, reason: 'unresolved-host' };
		if (rangeCheck) {
			// canonHost is a confirmed IP literal (bracketed IPv6 or dotted IPv4), so
			// classify it directly against the SSRF ranges instead of re-wrapping it
			// into a probe URL just to reach the same range check.
			const reason = classifyAddress(canonHost);
			if (reason) return { ok: false, reason };
		}
		pinned.push({
			address: canonHost.startsWith('[') ? canonHost.slice(1, -1) : canonHost,
			family: canonHost.startsWith('[') ? 6 : 4
		});
	}
	// Every address was validated above; keep only the first `MAX_PINNED_ADDRESSES`
	// of them as the set the socket may use.
	const capped = pinned.length > MAX_PINNED_ADDRESSES ? pinned.slice(0, MAX_PINNED_ADDRESSES) : pinned;
	if (cache !== null) {
		if (cache.size >= PIN_CACHE_MAX_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(cacheKey, { expires: now() + cacheMs, pinned: capped });
	}
	return { ok: true, pinned: capped };
}

/**
 * SSRF gate for one URL - the initial target and every redirect hop. Always
 * enforces the http(s) scheme. In strict/allowlist mode it enforces the literal
 * range floor, then - for a DNS-name host - resolves and validates every
 * address and returns a pinning `lookup` so the connection cannot rebind to a
 * private address after the check. A custom `validateUrl` is an ADDITIONAL
 * restriction (logical AND): it can only narrow the allowed set, never widen it,
 * so it cannot re-open a blocked host. Only `urlMode: 'off'` relaxes the ranges
 * (the scheme gate still applies); to reach a specific private endpoint, pair
 * `urlMode: 'off'` with a `validateUrl` that allows exactly that host. Returns
 * `{ ok: true, lookup, pinned }` (both undefined for an IP literal, which needs
 * no resolution) or `{ ok: false, reason }`. `pinned` is the same validated
 * address set the `lookup` serves, handed back so a caller that needs to know
 * where the request may land - the admission gate does - reads it from the
 * resolution that already happened rather than resolving the name a second time
 * and possibly getting a different answer.
 */
async function ssrfGate(url, config) {
	const mode = config.urlMode || 'strict';

	// Always-on literal/scheme floor (off still rejects non-http(s)).
	const base = checkUrl(url, { mode, allow: config.allow });
	if (!base.safe) return { ok: false, reason: base.reason };

	// A custom validateUrl can only further restrict, never widen.
	if (config.validateUrl) {
		let ok;
		try {
			ok = !!(await callWithTimeout(() => config.validateUrl(url), config.callbackTimeoutMs ?? 10000, 'validateUrl'));
		} catch {
			return { ok: false, reason: 'validate-url-error' };
		}
		if (!ok) return { ok: false, reason: 'validate-url-rejected' };
	}

	// `URL.hostname` canonicalises every numeric IPv4 encoding to dotted-decimal
	// and brackets IPv6, so an IP literal is exactly one of those two shapes; an
	// IP literal cannot rebind, so it needs no resolution/pin (the literal was
	// already classified by checkUrl above).
	let host;
	try { host = new URL(url).hostname; } catch { return { ok: false, reason: 'parse-error' }; }
	const isIpLiteral = host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
	if (isIpLiteral) return { ok: true, lookup: undefined, pinned: undefined };

	// A DNS name: resolve + pin so the socket reaches exactly the resolved
	// address with no rebinding window. strict/allowlist also range-check every
	// resolved address; off pins WITHOUT the range check (so it can reach a
	// private endpoint) but still closes rebinding - which matters because the
	// blessed "reach a private host" recipe is off mode + a host-restricting
	// validateUrl, and an unpinned off mode would let that host rebind.
	const pin = await resolveAndPin(host, config, mode !== 'off');
	if (!pin.ok) return { ok: false, reason: pin.reason };
	return { ok: true, lookup: pinnedLookup(pin.pinned), pinned: pin.pinned };
}

/**
 * Resolve a redirect `Location` against the current URL and apply the
 * transport-level redirect rules (the SSRF range re-check is done by `ssrfGate`
 * on the result). Rejects a missing / non-http(s) Location and an https->http
 * downgrade. A protocol-relative `//host` Location keeps the current scheme via
 * `new URL(location, base)` and is then re-gated like any other host. Returns
 * `{ ok: true, url }` or `{ ok: false, reason }`.
 */
function resolveRedirect(currentUrl, location) {
	if (typeof location !== 'string' || location.length === 0) return { ok: false, reason: 'redirect-no-location' };
	let next;
	try { next = new URL(location, currentUrl); } catch { return { ok: false, reason: 'redirect-bad-location' }; }
	if (next.protocol !== 'http:' && next.protocol !== 'https:') return { ok: false, reason: 'redirect-bad-scheme' };
	let cur;
	try { cur = new URL(currentUrl); } catch { cur = null; }
	if (cur && cur.protocol === 'https:' && next.protocol === 'http:') return { ok: false, reason: 'redirect-downgrade' };
	return { ok: true, url: next.href };
}

/**
 * Issue one POST over node:http(s), pinned to `lookup` when supplied, under a
 * single absolute deadline (through the runtime timer seam) that covers DNS,
 * connect, TTFB and body. A fresh socket per request (`agent: false`) avoids
 * pool reuse across pinned addresses; the response body is drained and
 * discarded (a webhook receiver's body is unused) so the socket cannot wedge.
 * Resolves `{ status, location }`; rejects on network error / timeout.
 */
function httpDeliver(url, lookup, headers, body, timeoutMs) {
	return new Promise((resolve, reject) => {
		let parsed;
		try { parsed = new URL(url); } catch (err) { reject(err); return; }
		const doRequest = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
		const options = { method: 'POST', headers, agent: false };
		if (lookup) /** @type {any} */ (options).lookup = lookup;

		let decided = false;
		let deadline = setTimer(() => {
			req.destroy(new Error('outbound webhook: timeout'));
		}, timeoutMs);
		if (deadline && deadline.unref) deadline.unref();
		const clearDeadline = () => { if (deadline) { clearTimer(deadline); deadline = null; } };

		const req = doRequest(parsed, options, (res) => {
			const status = res.statusCode || 0;
			const location = res.headers['location'];
			// The decision is known from the status line; drain the body in the
			// background, bounded by the same deadline, and clear it on close.
			res.on('end', clearDeadline);
			res.on('close', clearDeadline);
			res.on('error', clearDeadline);
			res.resume();
			if (!decided) { decided = true; resolve({ status, location }); }
		});
		req.on('error', (err) => {
			clearDeadline();
			if (!decided) { decided = true; reject(err); }
		});
		req.end(body);
	});
}

/**
 * The auth-artifact headers a cross-origin redirect hop must NOT carry. The
 * signature authenticates the body to the INTENDED endpoint and the keyed
 * idempotency-key is unforgeable only as long as it stays there; forwarding
 * either to a different origin (an open redirect on the receiver, a
 * compromised endpoint) hands the target a validly-signed payload it can
 * replay against any receiver trusting the same secret - the same reason
 * browsers strip Authorization on cross-origin redirects. The body itself is
 * still forwarded (following the redirect is the feature); consumers wanting
 * none of that set `maxRedirects: 0`.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = ['x-webhook-signature', 'x-webhook-timestamp', 'idempotency-key'];

/**
 * The headers one redirect hop is allowed to send: the full set while the hop
 * stays on the ORIGINAL request's origin, and a copy stripped of the
 * auth-artifact headers once the hop target is any other origin.
 */
function headersForHop(hopUrl, initialOrigin, headers) {
	const origin = originOf(hopUrl);
	if (origin !== null && initialOrigin !== null && origin === initialOrigin) return headers;
	const stripped = { ...headers };
	for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) delete stripped[name];
	return stripped;
}

/**
 * Deliver to one URL with retry + jittered exponential backoff, using the pinned
 * `lookup`. A 2xx is delivered; a 3xx returns the redirect Location to the
 * caller (not retried); a 4xx other than 429 is permanent; a 5xx / 429 / network
 * error / timeout is retried up to `attempts`. Returns one of
 * `{ kind: 'delivered' }`, `{ kind: 'redirect', location }`, or
 * `{ kind: 'failed', err, attempts }` (terminal; the caller reports it).
 */
async function attemptDelivery(url, lookup, headers, body, config, hooks) {
	const retry = config.retry || {};
	const attempts = Number.isInteger(retry.attempts) && retry.attempts > 0 ? retry.attempts : 3;
	const initialDelayMs = retry.initialDelayMs ?? 100;
	const maxDelayMs = Math.max(1, retry.maxDelayMs ?? 5000);
	const backoff = retry.backoffMultiplier ?? 2;
	const timeoutMs = config.timeoutMs ?? 10000;
	const budget = hooks && hooks.budget;

	let lastErr;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const { status, location } = await httpDeliver(url, lookup, headers, body, timeoutMs);
			if (status >= 200 && status < 300) return { kind: 'delivered' };
			if (status >= 300 && status < 400) return { kind: 'redirect', location };
			if (status >= 400 && status < 500 && status !== 429) {
				return { kind: 'failed', err: new Error('outbound webhook: HTTP ' + status), attempts: attempt + 1 };
			}
			lastErr = new Error('outbound webhook: HTTP ' + status); // 5xx / 429 -> retry
		} catch (err) {
			lastErr = err; // network error / timeout -> retry
		}
		if (attempt < attempts - 1) {
			// Retry-budget gate: consume a token before scheduling a retry - a
			// shared, cross-delivery ceiling on retry AMPLIFICATION, distinct from
			// the per-delivery `attempts` cap, so a storm of failing deliveries to
			// one endpoint cannot launch unbounded retry work (the first attempt of
			// every delivery always proceeds unrationed). Out of budget -> stop now
			// and surface the last error as retry-exhausted. A throwing/unavailable
			// budget fails OPEN (the retry proceeds): it is a best-effort throttle,
			// not a correctness gate.
			if (budget) {
				let allowed = true;
				try { allowed = await budget.take(hooks.key); } catch { allowed = true; }
				if (!allowed) {
					return { kind: 'failed', err: lastErr || new Error('outbound webhook: retry budget exhausted'), attempts: attempt + 1 };
				}
			}
			// Equal-jitter backoff (through the runtime RNG seam) so many
			// deliveries failing at once do not retry in lockstep.
			const ceiling = Math.min(initialDelayMs * Math.pow(backoff, attempt), maxDelayMs);
			await sleep(ceiling / 2 + randomFloat() * (ceiling / 2));
		}
	}
	return { kind: 'failed', err: lastErr, attempts };
}

/**
 * Deliver an outbound webhook, gating SSRF on the initial URL and on EVERY
 * redirect hop and pinning each connection to validated addresses. Follows up
 * to `maxRedirects` hops (default 5), re-running the full gate on each Location;
 * a redirect to a blocked host, a non-http(s) scheme, an https->http downgrade,
 * a missing Location, a loop, or hop-cap overflow ends delivery. The
 * auth-artifact headers (`x-webhook-signature`, `x-webhook-timestamp`,
 * `idempotency-key`) are sent only while a hop stays on the INITIAL URL's
 * origin - a cross-origin hop gets the body and content-type but never the
 * signature artifacts. Returns the terminal outcome (`{ ok: true }` or
 * `{ ok: false, err, attempts }`); the CALLER reports it (so a replay can
 * re-attempt without re-reporting).
 *
 * @returns {Promise<{ ok: true } | { ok: false, err: Error, attempts: number }>}
 */
async function deliverToUrl(initialUrl, headers, body, config, hooks) {
	const maxRedirects = Number.isInteger(config.maxRedirects) && config.maxRedirects >= 0 ? config.maxRedirects : 5;
	// Canonicalise the initial URL so the loop-detection set matches the `.href`
	// form every redirect hop is normalised to (case differences would otherwise
	// let one extra hop slip past the seen-set check). A url that does not parse
	// is left as-is; ssrfGate reports it as parse-error.
	let url = initialUrl;
	let initialOrigin = null;
	try {
		const parsed = new URL(initialUrl);
		url = parsed.href;
		initialOrigin = parsed.origin;
	} catch { /* leave raw; the gate rejects it */ }
	const admission = hooks && hooks.admission;
	const seen = new Set();
	for (let hop = 0; hop <= maxRedirects; hop++) {
		if (seen.has(url)) {
			return { ok: false, err: new Error('outbound webhook: redirect loop at "' + redactUrl(url) + '"'), attempts: 0 };
		}
		seen.add(url);

		const gate = await ssrfGate(url, config);
		if (!gate.ok) {
			return { ok: false, err: new Error('outbound webhook: url "' + redactUrl(url) + '" blocked by SSRF guard (' + gate.reason + ')'), attempts: 0 };
		}

		// First-attempt admission: consulted for exactly ONE hop per delivery, the
		// hop the caller actually asked for, and only after the gate has resolved
		// and pinned the destination - `destinationsOf` needs those addresses, and
		// a URL the gate rejects can never reach the network so it must not cost a
		// destination anything. A REDIRECT hop is deliberately not charged. It is
		// tempting to charge it (a redirect does put a request on a second host),
		// but the redirect target is chosen by the endpoint being delivered to,
		// which means charging it lets anyone who can register a webhook drain a
		// bystander's allowance by answering 302 to that bystander's address -
		// turning the control that bounds abuse into a way to deny service to a
		// co-tenant. Size the unmetered amplification from BOTH knobs, not from
		// `maxRedirects` alone: `attemptDelivery` runs once per hop and retries
		// inside itself, so one admitted delivery can issue up to
		// `(maxRedirects + 1) * retry.attempts` requests - 18 at the defaults of
		// 5 and 3 - of which only the first hop's destination set is charged. The
		// SSRF gate still runs on every hop, so none of them can reach an address
		// the gate refuses; they are unmetered, not unchecked.
		//
		// A denial is terminal with `attempts:0` and carries
		// WEBHOOK_ADMISSION_DENIED, so a caller requeues instead of dead-lettering,
		// and the breaker stays untouched: nothing reached the network and the
		// endpoint said nothing about its health. Only a definite no from the gate
		// (`false`, or the `0` a Lua-scripted shared backend replies with) refuses
		// a delivery. A throw, or an implementation that answers with nothing at
		// all, admits: a shared backend having a bad minute must not become an
		// outbound outage, and denying on `undefined` would make a single missing
		// return path in a cluster gate exactly that outage.
		//
		// One unit is spent at EVERY address the pin allows the socket to reach,
		// not at one chosen member of the set: which member the connect logic ends
		// up on is not knowable here, and the caller controls both the contents and
		// the order of its own DNS answer, so a single charged member would be an
		// address the caller can point away from the one the request lands on.
		// Charging the whole set costs a multi-address endpoint one unit at each of
		// its addresses, and a set that refuses part-way keeps the units already
		// spent (the gate interface only takes, it cannot give back) - so a
		// delivery can cost more than it sends, never less.
		if (admission && hop === 0) {
			for (const destination of destinationsOf(url, gate.pinned)) {
				let verdict;
				try { verdict = await admission.take(destination); } catch { verdict = undefined; }
				if (verdict === false || verdict === 0) {
					return { ok: false, err: new WebhookAdmissionDeniedError(destination), attempts: 0 };
				}
			}
		}

		const result = await attemptDelivery(url, gate.lookup, headersForHop(url, initialOrigin, headers), body, config, hooks);
		if (result.kind === 'delivered') return { ok: true };
		if (result.kind === 'failed') {
			return { ok: false, err: result.err, attempts: result.attempts };
		}

		const next = resolveRedirect(url, result.location);
		if (!next.ok) {
			return { ok: false, err: new Error('outbound webhook: ' + next.reason + ' following "' + redactUrl(url) + '"'), attempts: 0 };
		}
		url = next.url;
	}
	return { ok: false, err: new Error('outbound webhook: too many redirects (>' + maxRedirects + ')'), attempts: 0 };
}

/**
 * Run one outbound-webhook delivery and RETURN its terminal outcome. Resolves
 * the payload (a `transform` returning null skips) and the URL through bounded
 * callbacks, attaches a stable idempotency-key header (keyed with the HMAC
 * secret when set, so an outsider who can induce the same publish cannot
 * precompute and replay/suppress it; a plain content hash otherwise) and an
 * optional HMAC signature, then delivers with per-hop SSRF gating + DNS pinning
 * + retry. Never throws; reports nothing - the caller owns reporting and
 * dead-letter capture from the returned outcome.
 *
 * The optional `hooks` inject the delivery controls the single-instance
 * defaults ({@link createWebhookAdmission}, {@link createRetryBudget},
 * {@link createWebhookBreaker}) or a cluster-shared implementation provide:
 * `hooks.breaker` fast-fails an ejected endpoint (an open circuit -> a terminal
 * `attempts:0` outcome, no network touched) and records the terminal result,
 * keyed by `hooks.key`; `hooks.budget` rations retry amplification, also keyed
 * by `hooks.key`; `hooks.admission` rations FIRST attempts and ignores
 * `hooks.key`, keyed instead by `<address>:<port>` for EVERY address the SSRF
 * gate pinned the socket to, so every registration, alias and per-event `url`
 * callback that lands on one address draws on that address's allowance and
 * whichever address the socket ends up on has paid for the request. The cost of
 * that: a host answering with several addresses spends one unit at each of them,
 * so it holds several allowances rather than one. Charging happens for one hop
 * per delivery, after the gate and before any request - a URL the gate rejects
 * costs nothing, and a redirect hop is not charged. Only outcomes that
 * actually reached the network (`attempts > 0`) move the breaker - a pre-network
 * rejection (SSRF block, redirect error, admission denial, bad config) is a
 * configuration or capacity signal, not an endpoint-health one, so it neither
 * ejects nor heals. Omit `hooks` for the unchanged bare delivery.
 *
 * @param {any} config the per-webhook config (url, transform, secret,
 *   previousSecret, retry, urlMode, validateUrl, resolve, allow, maxRedirects,
 *   timeoutMs, callbackTimeoutMs, idempotencyKey)
 * @param {string} topic @param {string} event @param {any} data
 * @param {{ admission?: { take: (destination: string) => boolean | Promise<boolean> }, budget?: { take: (key?: string) => boolean | Promise<boolean> }, breaker?: { guard: (key?: string) => void, success: (key?: string) => void, failure: (err: any, key?: string) => void }, key?: string }} [hooks]
 * @returns {Promise<{ ok: true } | { ok: false, err: Error, attempts: number }>}
 */
export async function deliverWebhook(config, topic, event, data, hooks) {
	const cbMs = config.callbackTimeoutMs ?? 10000;
	try {
		const payload = config.transform
			? await callWithTimeout(() => config.transform(event, data), cbMs, 'transform')
			: { event, data };
		if (payload == null) return { ok: true }; // transform opted out: nothing to deliver

		const url = typeof config.url === 'function'
			? await callWithTimeout(() => config.url(event, data), cbMs, 'url')
			: config.url;
		if (typeof url !== 'string' || url.length === 0) {
			return { ok: false, err: new Error('outbound webhook: url resolved to a non-string'), attempts: 0 };
		}

		// Endpoint-ejection gate BEFORE any body/crypto work: when the breaker is
		// open, fast-fail without spending signing/idempotency cycles on a request
		// that will not be sent. The caller dead-letters the `attempts:0` outcome.
		const breaker = hooks && hooks.breaker;
		const breakerKey = hooks && hooks.key;
		if (breaker) {
			try {
				breaker.guard(breakerKey);
			} catch (err) {
				return { ok: false, err: err instanceof Error ? err : new Error(String(err)), attempts: 0 };
			}
		}

		const body = JSON.stringify(payload);
		const headers = { 'content-type': 'application/json' };

		// Stable idempotency key so receivers dedup retries and any
		// leader-transition double-fire to effectively-once. Keyed (HMAC) when a
		// secret is set so the key is unforgeable; a plain content hash (and so
		// predictable, documented as such) when no secret is configured.
		let idem;
		if (config.idempotencyKey) {
			idem = await callWithTimeout(() => config.idempotencyKey(event, data), cbMs, 'idempotencyKey');
		} else {
			const material = topic + '\0' + event + '\0' + body;
			idem = config.secret
				? createHmac('sha256', config.secret).update('idem\0' + material).digest('hex')
				: createHash('sha256').update(material).digest('hex');
		}
		if (idem != null) {
			const key = String(idem);
			if (/[\r\n\0]/.test(key) || key.length > 256) {
				return { ok: false, err: new Error('outbound webhook: idempotency-key must be <=256 chars with no CR/LF/NUL'), attempts: 0 };
			}
			headers['idempotency-key'] = key;
		}

		// HMAC signature so the receiver can authenticate the payload AND its
		// freshness. The signed material is `<unix-seconds>.<body>` (Stripe /
		// GitHub style) and the timestamp rides alongside as
		// `x-webhook-timestamp`, so a captured (body, signature) pair stops
		// verifying once the receiver's tolerance window (documented: 5
		// minutes of skew) has passed - a body-only signature replays forever.
		// The timestamp is drawn once per delivery (through the runtime clock
		// seam) so every retry and redirect hop of one delivery carries the
		// same signed material. During a key rotation (`previousSecret` set)
		// both keys sign, comma-separated, so a receiver still verifying
		// against the old key keeps accepting deliveries while the fleet
		// converges - the receiver contract is: split the header on commas,
		// accept when ANY entry matches. The idempotency key above stays keyed
		// to the CURRENT secret only, so a rotation briefly reopens the
		// leader-transition dedup window (retries of one delivery are
		// unaffected - they reuse the computed headers).
		if (config.secret) {
			// This is a security timestamp, not hot-path duration bookkeeping.
			// Use the exact wall-clock seam: cached `now()` can remain stale until
			// its 1 Hz refresher runs after an event-loop stall, which would emit a
			// timestamp already outside the receiver's freshness window.
			const timestamp = String(Math.floor(wallEpoch() / 1000));
			headers['x-webhook-timestamp'] = timestamp;
			const signed = timestamp + '.' + body;
			let signature = 'sha256=' + createHmac('sha256', config.secret).update(signed).digest('hex');
			if (config.previousSecret) {
				signature += ',sha256=' + createHmac('sha256', config.previousSecret).update(signed).digest('hex');
			}
			headers['x-webhook-signature'] = signature;
		}

		const outcome = await deliverToUrl(url, headers, body, config, hooks);
		if (breaker) {
			if (outcome.ok) breaker.success(breakerKey);
			else if (outcome.attempts > 0) breaker.failure(outcome.err, breakerKey);
		}
		return outcome;
	} catch (err) {
		return { ok: false, err, attempts: 0 };
	}
}
