// The fields a 304 leaves out of the representation's 200 header set: the ones
// that describe the body it does not carry. RFC 9110 15.4.5 wants a 304 to
// repeat the validator, Vary, Cache-Control and the rest of what the 200 would
// have sent, and to leave out representation metadata that only makes sense
// beside the octets - the coding those octets are in, and the disposition a
// browser would give a download it is not receiving. Everything else in the
// tuples is either a caching directive or an app-configured header that a
// revalidating client has to keep seeing (a strict-transport-security or
// content-security-policy that arrives only on the first fetch is not a
// policy).
const BODY_METADATA = new Set(['content-encoding', 'content-disposition']);

/**
 * The header tuples a 304 for this representation writes, derived once from
 * the representation's 200 tuples so the revalidation path is one loop.
 *
 * @param {[string, string][]} tuples - the representation's 200 headers
 * @returns {[string, string][]}
 */
export function revalidationHeaders(tuples) {
	return tuples.filter((tuple) => !BODY_METADATA.has(tuple[0]));
}
