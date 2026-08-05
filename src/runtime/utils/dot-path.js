/**
 * Whether static serving must refuse a path because of a dot segment.
 *
 * static/ is a plain directory app authors drop files into, and what lands
 * there by accident is exactly the sensitive family - a stray .env, an editor
 * backup, an unpacked .git. Refusing dot paths by default is also what
 * adapter-node's static serving does, so an app migrating from it must not
 * silently gain exposure here.
 *
 * The rule is segment-wise: a path is refused when ANY slash-separated segment
 * starts with a dot, so `a/.hidden/b` is caught as well as `.env`. One
 * exemption, checked at the FIRST segment only: `.well-known` - RFC 8615
 * discovery (security.txt, ACME HTTP-01 challenges) is documented served
 * behavior. First-segment-only keeps `x/.well-known/y` from becoming an
 * escape hatch, and a dotfile INSIDE `.well-known/` is still refused.
 *
 * Shared by the runtime's index-time walk and the build-time warning scan, so
 * what the build warns about and what the runtime refuses cannot drift.
 *
 * @param {string} relPath - `/`-separated path relative to the served root
 * @returns {boolean} true when the path must not be served
 */
export function excludedDotPath(relPath) {
	const segments = relPath.split('/');
	for (let i = 0; i < segments.length; i++) {
		if (segments[i].charCodeAt(0) === 46 /* '.' */ && !(i === 0 && segments[i] === '.well-known')) {
			return true;
		}
	}
	return false;
}
