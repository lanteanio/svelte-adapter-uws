// The path percent-encode set is everything outside the characters a path
// segment may carry as they are (RFC 3986 3.3: unreserved, sub-delims, `:`,
// `@`) plus the separator. A query may additionally carry `/` and `?`, and
// nothing outside visible ASCII except that `#` ends it.
const PATH_UNSAFE = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]+/g;
const QUERY_UNSAFE = /[^!$-~]+/g;

/**
 * A Location value for a redirect to `path` (decoded, canonical) carrying
 * `search` (raw, `?`-prefixed or empty), spelled the way a client spells a
 * request target: percent-encoded.
 *
 * The prerendered lookup matches on the DECODED path, so the canonical spelling
 * it redirects to is a decoded string too, and a header value is written to the
 * wire as the UTF-8 bytes of the string it was given. A route named with a
 * non-ASCII character would otherwise put raw UTF-8 bytes in Location. Its
 * value must be a URI-reference (RFC 9110 10.2.2), whose RFC 3986 grammar
 * requires these bytes to be percent-encoded; the generic field-value grammar
 * in RFC 9110 5.5 permits obs-text and is not the restriction here.
 * Encoding the segments here gives the same bytes a browser would have sent
 * for that route in the first place, so the redirect lands on the lookup that
 * issued it.
 *
 * The query is the client's own spelling and is left alone except where it
 * cannot go on the wire either. An unpaired surrogate cannot be encoded at
 * all; it is replaced before encoding rather than thrown on.
 *
 * @param {string} path - the decoded canonical path
 * @param {string} search - '' or `?` followed by the raw query
 * @returns {string}
 */
export function locationTarget(path, search) {
	let target = path.toWellFormed().replace(PATH_UNSAFE, encodeURIComponent);
	if (search !== '') target += search.toWellFormed().replace(QUERY_UNSAFE, encodeURIComponent);
	return target;
}
