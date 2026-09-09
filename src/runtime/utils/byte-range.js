/**
 * Parse a Range header value for one byte range against a representation of
 * `fileSize` octets. Three outcomes, and the caller treats them differently:
 *
 *   { start, end }  a satisfiable range, both offsets inclusive - serve 206
 *   null            syntactically valid but unsatisfiable - answer 416
 *   false           not a single byte range this lane serves (another unit,
 *                   multi-range, malformed) - ignore the header, serve 200
 *
 * RFC 9110 14.2 decides which of the last two a well-formed range is: a set is
 * satisfiable when a first-pos is below the current length, or a suffix has a
 * NON-ZERO length. So `bytes=-0` is unsatisfiable rather than ignorable - a
 * client asking for the last zero bytes is asking for nothing, and answering
 * with the whole body is the one outcome the RFC rules out. A suffix longer
 * than the representation is the whole representation (14.1.2).
 *
 * The range values are 1*DIGIT (14.1.1), so a token carrying anything else is
 * malformed, not merely a number that failed to parse.
 *
 * @param {string} header - the Range value, e.g. `bytes=0-499`
 * @param {number} fileSize - octets in the selected representation
 * @returns {{ start: number, end: number } | null | false}
 */
export function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	// Multi-range (comma-separated) is not supported; the caller serves the full
	// representation instead, which RFC 9110 14.2 allows.
	if (spec.includes(',')) return false;

	const dash = spec.indexOf('-');
	if (dash < 0) return false;

	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);

	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;

	let start, end;
	if (rawStart === '') {
		// Suffix range: bytes=-N (the last N bytes)
		if (rawEnd === '') return false;
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix)) return false;
		if (suffix === 0) return null;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			// Open-ended: bytes=N- (from N to the end)
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}

	if (start >= fileSize) return null;
	end = Math.min(end, fileSize - 1);
	return { start, end };
}
