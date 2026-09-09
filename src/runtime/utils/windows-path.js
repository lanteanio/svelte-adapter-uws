/**
 * Whether a request path names something Windows resolves differently from
 * the path as spelled: a colon opens an NTFS alternate data stream
 * (`file.txt:hidden`), and a tilde can address a file through its 8.3 short
 * name (`LONGFI~1.TXT`), so both let a path reach a file the app's own routing
 * and the static index never saw.
 *
 * Read on the DECODED spelling as well as the raw one, because every lane
 * behind this gate decodes before it touches the filesystem: the prerendered
 * lookup, SvelteKit's router and its `read()` all see `%3A` as `:`. A gate
 * that read only the raw bytes refused `/x:y` and passed `/x%3Ay` to the same
 * `open()`.
 *
 * A path that does not decode is left to those lanes, which refuse it
 * themselves; the only decision made here is the reserved-character one.
 *
 * @param {string} pathname - the raw request path
 * @returns {boolean}
 */
export function windowsReservedPath(pathname) {
	if (pathname.includes(':') || pathname.includes('~')) return true;
	if (!pathname.includes('%')) return false;
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return false;
	}
	return decoded.includes(':') || decoded.includes('~');
}
