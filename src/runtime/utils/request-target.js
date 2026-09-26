// Two things RFC 9112 3.2 does not allow in a request target: a byte outside
// visible ASCII, and a fragment. These two, and not the rest of the grammar,
// because uWS routes on them differently from the URL parser behind it.
//
// uWS hands a target's raw non-ASCII bytes to the runtime as the decoded
// characters, where node's parser refuses them before any listener runs, and
// keeps a `#` in the path it routes on, so without this a lane would serve the
// page behind the decoded characters, or the route a truncating URL parser
// reads out of `/healthz#frag` in place of the probe. RFC 9112 3 asks for a
// 400 rather than a guess, because such a line can be built to read one way
// to a filter in front and another way here.

/** A byte outside visible ASCII (0x21-0x7E), or a `#`. */
const INVALID_TARGET = /[^!-~]|#/;

/**
 * Whether a request target must be refused.
 *
 * @param {string} path what uWS's `getUrl()` returns
 * @param {string | undefined} query what `getQuery()` returns
 */
export function invalidRequestTarget(path, query) {
	return INVALID_TARGET.test(path) || (!!query && INVALID_TARGET.test(query));
}

// The authority a request names, as RFC 9110 7.2 has the Host field carry it:
// `uri-host [":" port]` (RFC 3986 3.2.2), with no userinfo. The host is a
// bracketed IPv6 literal, or a non-empty run of unreserved and sub-delims
// characters and percent escapes, which spells a reg-name and an IPv4 address
// alike. Empty is refused too, because an http URI may not name an empty host
// (RFC 9110 4.2.1).
//
// Checked where a lane turns the value into a request URL, because a `/`, `?`,
// `#`, `\` or `@` in it moves the boundary between the authority and what
// follows: `http://` + `a/__realtime/x?` + `/` resolves to the path
// `/__realtime/x` whatever the target said, and every check on the target was
// made against the target. An IPvFuture literal and an IPv6 zone identifier
// are refused with the rest: no HTTP client sends one, and the URL parser
// behind this cannot read either.
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})+)(?::[0-9]*)?$/;

/**
 * Whether a Host value, or the proxy header standing in for it, must be
 * refused.
 *
 * @param {string | undefined} value
 */
export function invalidHost(value) {
	return value === undefined || !HOST.test(value);
}
