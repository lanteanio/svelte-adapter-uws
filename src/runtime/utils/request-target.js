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
