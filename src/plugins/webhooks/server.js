// @ts-check
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as nodeDnsLookup } from 'node:dns';
import { createHmac, createHash } from 'node:crypto';
import { checkUrl } from '../../safe-url.js';
import { randomFloat, setTimer, clearTimer } from '../../runtime/runtime.js';

export { createRetryBudget, createWebhookBreaker, WebhookCircuitOpenError } from './controls.js';

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
 * Strip credentials and query from a URL before it appears in an error message
 * or log line: userinfo (`user:pass@`) and the query string can carry secrets,
 * so failure reporting keeps only origin + pathname. Falls back to a fixed
 * placeholder when the value does not parse.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
	try {
		const u = new URL(url);
		u.username = '';
		u.password = '';
		u.search = '';
		u.hash = '';
		return u.origin + u.pathname;
	} catch {
		return '[unparseable-url]';
	}
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
 * a non-address, or (with rangeCheck) any address is private.
 */
async function resolveAndPin(hostname, config, rangeCheck) {
	const resolver = config.resolve || defaultResolve;
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
			const verdict = checkUrl(probe, { mode: 'strict' });
			if (!verdict.safe) return { ok: false, reason: verdict.reason };
		}
		pinned.push({
			address: canonHost.startsWith('[') ? canonHost.slice(1, -1) : canonHost,
			family: canonHost.startsWith('[') ? 6 : 4
		});
	}
	return { ok: true, pinned };
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
 * `{ ok: true, lookup }` (lookup may be undefined for an IP literal / off mode)
 * or `{ ok: false, reason }`.
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
	if (isIpLiteral) return { ok: true, lookup: undefined };

	// A DNS name: resolve + pin so the socket reaches exactly the resolved
	// address with no rebinding window. strict/allowlist also range-check every
	// resolved address; off pins WITHOUT the range check (so it can reach a
	// private endpoint) but still closes rebinding - which matters because the
	// blessed "reach a private host" recipe is off mode + a host-restricting
	// validateUrl, and an unpinned off mode would let that host rebind.
	const pin = await resolveAndPin(host, config, mode !== 'off');
	if (!pin.ok) return { ok: false, reason: pin.reason };
	return { ok: true, lookup: pinnedLookup(pin.pinned) };
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
 * a missing Location, a loop, or hop-cap overflow ends delivery. Returns the
 * terminal outcome (`{ ok: true }` or `{ ok: false, err, attempts }`); the
 * CALLER reports it (so a replay can re-attempt without re-reporting).
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
	try { url = new URL(initialUrl).href; } catch { /* leave raw; the gate rejects it */ }
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

		const result = await attemptDelivery(url, gate.lookup, headers, body, config, hooks);
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
 * defaults ({@link createRetryBudget}, {@link createWebhookBreaker}) or a
 * cluster-shared implementation provide: `hooks.breaker` fast-fails an ejected
 * endpoint (an open circuit -> a terminal `attempts:0` outcome, no network
 * touched) and records the terminal result, keyed by `hooks.key`; `hooks.budget`
 * rations retry amplification. Only outcomes that actually reached the network
 * (`attempts > 0`) move the breaker - a pre-network rejection (SSRF block,
 * redirect error, bad config) is a configuration signal, not an endpoint-health
 * one, so it neither ejects nor heals. Omit `hooks` for the unchanged bare
 * delivery.
 *
 * @param {any} config the per-webhook config (url, transform, secret,
 *   previousSecret, retry, urlMode, validateUrl, resolve, allow, maxRedirects,
 *   timeoutMs, callbackTimeoutMs, idempotencyKey)
 * @param {string} topic @param {string} event @param {any} data
 * @param {{ budget?: { take: (key?: string) => boolean | Promise<boolean> }, breaker?: { guard: (key?: string) => void, success: (key?: string) => void, failure: (err: any, key?: string) => void }, key?: string }} [hooks]
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

		// HMAC signature so the receiver can authenticate the payload. During a
		// key rotation (`previousSecret` set) both keys sign, comma-separated,
		// so a receiver still verifying against the old key keeps accepting
		// deliveries while the fleet converges - the receiver contract is:
		// split the header on commas, accept when ANY entry matches. The
		// idempotency key above stays keyed to the CURRENT secret only, so a
		// rotation briefly reopens the leader-transition dedup window (retries
		// of one delivery are unaffected - they reuse the computed headers).
		if (config.secret) {
			let signature = 'sha256=' + createHmac('sha256', config.secret).update(body).digest('hex');
			if (config.previousSecret) {
				signature += ',sha256=' + createHmac('sha256', config.previousSecret).update(body).digest('hex');
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
