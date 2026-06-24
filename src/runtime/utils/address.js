/**
 * Coarse network-address scope classification for runtime heuristics.
 *
 * This is deliberately NOT an SSRF validator. The SSRF-grade classifier - the
 * one that normalises decimal/hex/octal/short-form obfuscation and unwraps
 * IPv4-in-IPv6 to defeat smuggling - is the canonical
 * `svelte-adapter-uws/safe-url`, and there is intentionally one copy of that
 * logic. This helper classifies the canonical literal a socket layer hands
 * back (`getRemoteAddressAsText`), which is OS-produced and never
 * attacker-encoded, into a coarse scope so boot/runtime diagnostics can reason
 * about proxy topology (e.g. "is the client address a private gateway?").
 *
 * @param {string} ip - A canonical IPv4, IPv6, or IPv4-mapped-IPv6 literal.
 * @returns {'loopback' | 'private' | 'link-local' | 'public' | 'unknown'}
 */
export function addressScope(ip) {
	if (!ip) return 'unknown';
	let host = ip.trim().toLowerCase();

	// Unwrap an IPv4-mapped IPv6 prefix so ::ffff:10.0.0.1 classifies as IPv4.
	if (host.startsWith('::ffff:') && host.indexOf('.') !== -1) host = host.slice(7);
	// Drop an IPv6 zone id (fe80::1%eth0) and surrounding brackets.
	const pct = host.indexOf('%');
	if (pct !== -1) host = host.slice(0, pct);
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

	// IPv4 dotted quad.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
		const o = host.split('.').map(Number);
		if (o[0] > 255 || o[1] > 255 || o[2] > 255 || o[3] > 255) return 'unknown';
		const a = o[0];
		const b = o[1];
		if (a === 127) return 'loopback'; // 127.0.0.0/8
		if (a === 10) return 'private'; // 10.0.0.0/8
		if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
		if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
		if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16
		return 'public';
	}

	// IPv6.
	if (host.indexOf(':') !== -1) {
		if (host === '::1') return 'loopback';
		if (host === '::') return 'unknown'; // unspecified
		if (/^f[cd]/.test(host)) return 'private'; // fc00::/7 unique-local (fc00::/8 + fd00::/8)
		if (/^fe[89ab]/.test(host)) return 'link-local'; // fe80::/10
		return 'public';
	}

	return 'unknown';
}
