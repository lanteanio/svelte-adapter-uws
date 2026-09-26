/**
 * Duplicate-aware request-header collection, shared by every entry point that
 * needs the full header set.
 *
 * uWS hands header LINES to `req.forEach` one at a time, repeats included, so
 * the obvious `headers[key] = value` keeps the LAST line of a repeated name and
 * silently discards every earlier one. That is not an exotic input: HAProxy's
 * `option forwardfor` APPENDS its own `X-Forwarded-For` line rather than
 * extending the existing one, so a two-hop path arrives as two lines. Last-wins
 * reduces that chain to a single address, `XFF_DEPTH` then finds fewer addresses
 * than hops, and the resolver falls back to the socket peer - which collapses
 * every client behind that proxy onto one rate-limit identity.
 *
 * A blanket comma join would be its own bug, so the policy is decided per
 * header CLASS:
 *
 *   - LIST-VALUED, the default. Every header whose grammar is a comma-separated
 *     list - `x-forwarded-for`, `forwarded`, `via`, `accept-encoding`, and the
 *     open-ended set of vendor chains like `x-original-forwarded-for` - is
 *     joined with ", " in ARRIVAL ORDER, the form RFC 9110 defines as equivalent
 *     to the separate lines. This is the DEFAULT precisely because the list
 *     header universe cannot be enumerated: a vendor chain nobody here has heard
 *     of must not silently lose hops. The one exception is a chain this
 *     deployment CONFIGURED as a proxy header, which the class below claims
 *     instead unless it is `x-forwarded-for`.
 *
 *   - `cookie` joins with "; ", not ", ". Several `Cookie` lines are what an
 *     HTTP/2 to HTTP/1.1 downgrade at an edge proxy produces, and a comma join
 *     would fold every cookie after the first into the last cookie's VALUE.
 *
 *   - `set-cookie` is never joined. It is not a list header (a comma is legal
 *     inside an `Expires` date), so joining corrupts the cookies rather than
 *     concatenating them. It carries no meaning on a request in the first place,
 *     so the first line is kept, the rest are dropped, and the request is still
 *     served - refusing over an inert header would be gratuitous.
 *
 *   - SINGLE-VALUED PROXY headers keep the LAST line: the well-known spellings
 *     below plus every name this deployment configured, `x-forwarded-for`
 *     excepted. These carry one scheme, one host, one port or one address, and
 *     joining them produces a value that is not any of those things.
 *
 *   - SINGLE-VALUED framing / identity headers REFUSE the request. See the set
 *     below for why merging or picking is the wrong answer for those.
 *
 * Written once and used at every collection site: the hand-written copies this
 * replaces had already drifted apart, which is how the same defect in each of
 * them stayed invisible.
 */

/**
 * Headers where a second line refuses the request rather than being merged or
 * picked between.
 *
 * Deliberately short. Every name here is one where a wrong pick changes how the
 * request is FRAMED, how its body is PARSED, WHO it is from, or WHICH origin it
 * claims - and whichever value this layer picks, the proxy in front may have
 * picked the other, which is the request-smuggling shape. Merging them is
 * meaningless (two `Host` values are not one host) and choosing between them is
 * a security decision this layer must not make silently, so the answer is to
 * refuse and let the ambiguity die at the door.
 *
 * Everything else takes the list-join default or the last-line rule below,
 * including headers no real client repeats: refusing traffic over a header
 * nothing reads is a worse failure than merging it.
 */
const SINGLE_VALUED = new Set([
	'host',
	'content-length',
	'transfer-encoding',
	'content-type',
	'authorization',
	'proxy-authorization',
	'origin'
]);

/**
 * The only Transfer-Encoding a request may carry. RFC 9112 6.1: chunked must
 * be applied at most once and must be the final encoding, so `chunked` alone
 * is the only spelling with one meaning; `chunked, chunked`, `gzip, chunked`
 * and `chunked, gzip` are all refusals, and so is a coding this server cannot
 * decode on its own (`gzip`, `xchunked`).
 *
 * This matters more than conformance. The vendored parser reads the PRESENCE
 * of the header, not its value: every spelling above is decoded as chunked
 * here, while a conformant intermediary in front reads `xchunked` as a coding
 * it does not know and the request as bodyless. The two then disagree about
 * where the request ends, which is what a smuggled request is made of.
 */
const CHUNKED = 'chunked';

/** A Content-Length is a bare decimal count, and never empty. */
const DIGITS = /^[0-9]+$/;

/**
 * Does this request frame its body two ways at once? Returns the header to
 * name in the refusal, or null when the framing has one reading.
 *
 * `undefined` is an ABSENT header and the empty string is one sent with
 * nothing after the colon. The two are not the same answer: an empty
 * Transfer-Encoding names no coding at all, which this server still reads as
 * chunked and a conformant reader in front cannot read as anything, and an
 * empty Content-Length is a body length that does not say how long. Values
 * arrive trimmed of surrounding whitespace by the parser.
 *
 * Asked two ways. Every lane that builds a header set asks it of the whole
 * set, where an empty value and a repeat are both visible for free. The
 * request edge asks it of ONE lookup, `transfer-encoding`, ahead of the lanes
 * that answer without building a set - see `handleRequest` for what that
 * covers and what it cannot.
 *
 * @param {string | undefined} transferEncoding
 * @param {string | undefined} contentLength
 * @returns {'transfer-encoding' | 'content-length' | null}
 */
export function framingRefusal(transferEncoding, contentLength) {
	if (transferEncoding !== undefined) {
		if (transferEncoding.toLowerCase() !== CHUNKED) return 'transfer-encoding';
		// Both headers, each naming a different end to the same body. RFC 9112
		// 6.3 says the chunked framing wins and that the message may be a
		// smuggling attempt; the vendored parser answers this one before any of
		// this runs, so the rule is here to own it rather than to rely on that
		// staying true.
		if (contentLength !== undefined) return 'transfer-encoding';
	}
	if (contentLength !== undefined && !DIGITS.test(contentLength)) return 'content-length';
	return null;
}

/**
 * Is this the name of a header that says where the request body ends? A
 * refusal naming one of these cannot be answered on a connection that stays
 * open: the bytes after the response are whatever the sender's own reading of
 * the framing put there.
 *
 * @param {string | null} header
 */
export function isFramingHeader(header) {
	return header === 'content-length' || header === 'transfer-encoding';
}

/**
 * Headers this runtime, or the app in front of it, reads as ONE value, where
 * the last line is the one to keep.
 *
 * These are the headers a reverse proxy writes about the connection it
 * accepted: one scheme, one external host, one external port, one client
 * address. A join does not produce a longer version of any of those, it
 * produces a value of the wrong SHAPE - and the shape is load-bearing here,
 * because the runtime parses each of them:
 *
 *   - `get_origin` (handler/config.js) rejects a protocol that is not exactly
 *     "http" or "https", so two `x-forwarded-proto: https` lines joined into
 *     "https, https" would refuse EVERY request of a deployment configured
 *     exactly as the README recommends. A joined host, "a.test, a.test", is
 *     not an authority and is refused the same way.
 *   - the client-IP resolver's non-chain branch (utils/trusted-proxies.js)
 *     takes the value verbatim and, over its length bound, truncates KEEPING
 *     THE LEADING bytes because for a single-address header those are the
 *     proxy's. Joined, the leading bytes are the CLIENT'S - so padding the
 *     header would hand a client its own choice of rate-limit identity.
 *
 * Last line rather than first, and rather than a refusal: the hop in front
 * APPENDS (the same appending behaviour that makes the list-join default
 * necessary), so the last line is the proxy's and any earlier one is whatever
 * the client sent. That is also what this runtime did before the join existed,
 * so a deployment behind an appending proxy keeps working rather than being
 * answered 400 on every request.
 *
 * The names below are the ubiquitous spellings, honored whether or not this
 * deployment configures them, because an app reads them off
 * `event.request.headers` on its own. The names the RUNTIME was configured
 * with are added by {@link declareSingleValuedProxyHeaders}, which is what
 * covers a deployment that spells one of them differently.
 */
const WELL_KNOWN_PROXY_SINGLE_VALUED = [
	'x-forwarded-proto',
	'x-forwarded-protocol',
	'x-forwarded-scheme',
	'x-forwarded-host',
	'x-forwarded-port',
	'x-real-ip',
	'cf-connecting-ip',
	'true-client-ip',
	'x-client-ip',
	'fly-client-ip'
];

/**
 * The one header name a declaration cannot move into the last-line class.
 *
 * `ADDRESS_HEADER=x-forwarded-for` is the documented configuration and the
 * whole reason the join exists; putting it into the last-line class would
 * delete the fix for the deployment that needs it most. It stays joined ONLY
 * because the resolver has a matching branch: `createClientIpResolver`
 * (utils/trusted-proxies.js) compares the configured name against this exact
 * string and, on a match, counts hops from the RIGHT and truncates from the
 * HEAD, so a joined chain still resolves to the hop the depth names and an
 * over-long one keeps the proxy-authored tail.
 *
 * EVERY OTHER configured name reaches the resolver's single-address branch,
 * which takes the value verbatim and, over its length bound, truncates keeping
 * the LEADING bytes - the proxy's bytes for a single line, the CLIENT'S for a
 * joined one. So a configured address header joins the last-line class whatever
 * it is called, INCLUDING the vendor chains `x-original-forwarded-for`,
 * `forwarded` and `via`: naming one of those as ADDRESS_HEADER and joining its
 * repeats made the resolved address, the rate-limit key and
 * `getClientAddress()` entirely client-authored, which is the identity attack
 * the last-line class exists to prevent. Matching the resolver matters more
 * than matching the header's grammar, because the resolver is what parses the
 * value.
 *
 * This costs those three names nothing when they are NOT the configured address
 * header - undeclared names never enter the last-line class, so an app reading
 * a vendor chain off `event.request.headers` still sees every hop.
 *
 * A second name may only be added here in the same change that widens that
 * comparison in trusted-proxies.js: the two are one policy, and this side alone
 * re-opens the attack.
 */
const RESOLVER_CHAIN_HEADER = 'x-forwarded-for';

/** @type {Set<string>} */
let proxySingleValued = new Set(WELL_KNOWN_PROXY_SINGLE_VALUED);

/**
 * Declare the header names THIS deployment reads as a single value, on top of
 * the well-known spellings.
 *
 * `PROTOCOL_HEADER` / `HOST_HEADER` / `PORT_HEADER` / `ADDRESS_HEADER` are
 * operator-chosen names, so the class a repeated line belongs to cannot be
 * known from the name alone. The runtime declares them once at boot, before it
 * listens, and every collection site in the process then agrees - which is why
 * this is process state rather than a parameter each call site would have to
 * remember to pass.
 *
 * REPLACES the previous declaration rather than adding to it, so a caller can
 * put the policy back by declaring nothing. `x-forwarded-for` is the one name a
 * declaration cannot move: see RESOLVER_CHAIN_HEADER.
 *
 * @param {Array<string | undefined | null>} names - configured header names,
 *   empty entries allowed (an unset knob reads back as '')
 */
export function declareSingleValuedProxyHeaders(names) {
	const declared = new Set(WELL_KNOWN_PROXY_SINGLE_VALUED);
	for (const raw of names) {
		const name = String(raw || '').toLowerCase();
		if (!name || name === RESOLVER_CHAIN_HEADER) continue;
		declared.add(name);
	}
	proxySingleValued = declared;
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Collect every header line of `req` into `headers`, applying the per-class
 * duplicate policy above.
 *
 * Fills a caller-supplied object rather than returning one, so a site that
 * already allocates its header bag keeps allocating exactly one object; the
 * return value is the FINDING, not the result.
 *
 * Callers must treat a non-null return as fatal for that request (400, or a
 * refused upgrade). Collection still completes - uWS offers no way to stop the
 * iteration - and it completes under the SAME policy it started with: a
 * refusal names ONE header - a framing one where the request has one, else the
 * first offender - without changing what any other header collects to. So a
 * caller that ignores the return gets today's behaviour for every class except
 * the refused one, and the refused one keeps its first line.
 *
 * The common path costs one extra property READ per header line compared with a
 * bare assignment: a name seen for the first time reads `undefined` and is
 * stored. The class lookups happen only on a repeat, so ordinary traffic never
 * touches a set.
 *
 * `hasOwn` guards the names that live on `Object.prototype`: a header may
 * legally be called `constructor` or `valueOf`, and those read back as an
 * inherited function rather than `undefined`, so the cheap check alone would
 * report a first sighting as a duplicate.
 *
 * @param {import('uWebSockets.js').HttpRequest} req
 * @param {Record<string, string>} headers - filled in place
 * @returns {string | null} the header to name in a refusal - one that frames
 *   the body two ways, or the first single-valued header that arrived more than
 *   once - or null when the request has a single reading
 */
export function collectRequestHeaders(req, headers) {
	/** @type {string | null} */
	let ambiguous = null;
	/** @type {string | null} */
	let framingRepeat = null;
	req.forEach((key, value) => {
		const previous = headers[key];
		if (previous === undefined || !hasOwn.call(headers, key)) {
			headers[key] = value;
			return;
		}
		if (SINGLE_VALUED.has(key)) {
			// Name the FIRST offender and keep walking. Stopping the merge here
			// would make every later repeated header first-wins, which is neither
			// the documented contract nor a policy anything asked for.
			if (ambiguous === null) ambiguous = key;
			// A repeated FRAMING header is remembered separately, because the two
			// answers do different things for the caller and the first offender is
			// whichever line the sender chose to put first. Two Origin lines say
			// the request is ambiguous; two Content-Length lines say the sender
			// and this server may not agree where it ENDS, and only that answer
			// makes the caller close the connection.
			if (framingRepeat === null && isFramingHeader(key)) framingRepeat = key;
			return;
		}
		if (key === 'set-cookie') return;
		if (proxySingleValued.has(key)) {
			headers[key] = value;
			return;
		}
		headers[key] = key === 'cookie'
			? previous + '; ' + value
			: previous + ', ' + value;
	});
	// A framing answer comes FIRST, ahead of any other repeat the walk found.
	// Both name a header the caller refuses, but only a framing one tells it the
	// connection can no longer be read, and any other repeated single-valued
	// header would otherwise mask it - two Origin lines in front of two
	// Content-Length lines would answer `origin`, and the refusal would keep a
	// connection whose remaining bytes are exactly what the two readings
	// disagree about.
	//
	// Both dimensions, because they hide from each other: the VALUE question
	// below reads the header the walk kept, which is the FIRST of a repeated
	// pair, so a repeat whose first value is a usable one answers null there and
	// is caught only by `framingRepeat`.
	//
	// Free here, where every header has just been read anyway, and reading the
	// object keeps an absent header apart from one sent empty, which a header
	// lookup cannot.
	const framing = framingRefusal(headers['transfer-encoding'], headers['content-length']);
	if (framing !== null) return framing;
	if (framingRepeat !== null) return framingRepeat;
	return ambiguous;
}
