/**
 * SSRF-defence URL validator for svelte-adapter-uws.
 *
 * Server-side handlers that fetch a user-supplied URL (an outbound webhook,
 * a link-preview fetch, an avatar-from-URL import) are a classic
 * server-side request forgery (SSRF) target: an attacker submits a URL that
 * points at an internal address - the cloud instance-metadata endpoint
 * (`169.254.169.254`, which hands out IAM credentials), a loopback admin
 * panel, or an RFC1918 service - and the server fetches it from inside the
 * trust boundary. `isSafeUrl` answers the question "is it safe to fetch
 * this URL" with a single boolean.
 *
 * The validator is pure logic with no `node:dns` import: the synchronous
 * `isSafeUrl` / `checkUrl` classify the URL's *literal* host. A host that is
 * a numeric IP (in any encoding) is normalised and matched against the
 * blocked ranges; a host that is a DNS name is classified on its literal
 * text only. To close the DNS-rebinding gap - a public-looking name that
 * resolves to a private address - the caller passes a resolver to the async
 * `checkUrlResolved`, which resolves the name and re-checks the address.
 * Keeping the resolver an argument (rather than importing `node:dns`) keeps
 * the module isomorphic and trivially testable.
 *
 * This is the single canonical copy for the ecosystem: it lives here in the
 * adapter (the layer every package depends on) and is re-exported by
 * `svelte-adapter-uws-extensions/safe-url`; `svelte-realtime` imports it
 * directly. There is intentionally no second copy to drift.
 *
 * Blocked classes (in `strict` and `allowlist` modes):
 *
 * - loopback: IPv4 `127.0.0.0/8`, IPv6 `::1`, and the `localhost` hostname
 * - link-local IPv4: `169.254.0.0/16`
 * - cloud metadata: `169.254.169.254`, the IPv6 form `fd00:ec2::254`, and
 *   the `metadata.google.internal` hostname (reported as `metadata`)
 * - RFC1918 private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 * - unspecified IPv4 `0.0.0.0/8` and IPv6 `::`
 * - IPv6 unique-local (ULA): `fc00::/7` (both `fc00::/8` and `fd00::/8`)
 * - IPv6 link-local: `fe80::/10`
 * - IPv4-mapped / IPv4-compatible IPv6 (`::ffff:a.b.c.d`, `::a.b.c.d`) are
 *   unwrapped to the embedded IPv4 and re-checked against every IPv4 rule,
 *   so `::ffff:169.254.169.254` cannot smuggle the metadata IP past an
 *   IPv4-only check
 * - bad scheme: anything that is not `http:` or `https:` (blocks `file:`,
 *   `gopher:`, `ftp:`, `data:`, `redis:`, ...)
 *
 * IP-obfuscation evasions are normalised before matching: decimal
 * (`http://2130706433/`), hex (`http://0x7f000001/`, `http://0x7f.0.0.1/`),
 * octal (`http://0177.0.0.1/`), and short forms (`http://127.1/`). Userinfo
 * smuggling (`http://expected.com@127.0.0.1/`) is defeated by reading the
 * parsed `URL.hostname`, never the raw string.
 *
 * @module svelte-adapter-uws/safe-url
 */

/**
 * The IPv6 form of the AWS instance-metadata endpoint and the GCP metadata
 * hostname. The IPv4 metadata IP `169.254.169.254` is matched numerically.
 */
const IPV6_METADATA = 'fd00:ec2::254';
const METADATA_HOSTNAMES = new Set(['metadata.google.internal']);

/**
 * Parse a host string as an IPv4 address, honouring the permissive
 * encodings a real OS resolver / HTTP client accepts: dotted decimal,
 * dotted octal (`0177`), dotted hex (`0x7f`), short forms with fewer than
 * four parts (`127.1` -> `127.0.0.1`), and a single bare integer
 * (`2130706433`). Returns the 32-bit address as a number in `[0, 2^32)`,
 * or `null` when the string is not a valid IPv4 in any of these forms.
 *
 * This duplicates the normalisation the WHATWG `URL` parser already applies
 * to http(s) hosts, on purpose: it makes `classifyIp` correct for a bare
 * host string passed directly (not only one that round-tripped through
 * `new URL`), so the blocked-range logic is self-contained.
 *
 * @param {string} host
 * @returns {number | null}
 */
function parseIpv4(host) {
	if (host.length === 0) return null;
	const parts = host.split('.');
	if (parts.length > 4) return null;

	/** @type {number[]} */
	const nums = [];
	for (const part of parts) {
		if (part.length === 0) return null;
		let value;
		if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
			value = parseInt(part.slice(2), 16);
		} else if (/^0[0-7]+$/.test(part)) {
			value = parseInt(part.slice(1), 8);
		} else if (part === '0') {
			value = 0;
		} else if (/^[1-9][0-9]*$/.test(part)) {
			value = parseInt(part, 10);
		} else {
			return null;
		}
		if (!Number.isInteger(value)) return null;
		nums.push(value);
	}

	// In the short forms, the final part fills all remaining low-order
	// bytes (`127.1` => 127.0.0.1, `127.0.1` => 127.0.0.1, a bare integer
	// fills all four). Leading parts must each fit in one byte.
	const last = nums[nums.length - 1];
	const maxLast = Math.pow(256, 4 - (nums.length - 1));
	if (last < 0 || last >= maxLast) return null;
	let addr = last;
	for (let i = 0; i < nums.length - 1; i++) {
		if (nums[i] < 0 || nums[i] > 255) return null;
		addr += nums[i] * Math.pow(256, 3 - i);
	}
	// Normalise into the unsigned 32-bit range.
	return addr >>> 0 === addr ? addr : addr % Math.pow(2, 32);
}

/**
 * Classify a 32-bit IPv4 address (as produced by `parseIpv4`) against the
 * blocked ranges. Returns the matching reason, or `null` if the address is
 * public.
 *
 * @param {number} addr
 * @returns {('loopback' | 'link-local' | 'metadata' | 'rfc1918' | 'unspecified') | null}
 */
function classifyIpv4(addr) {
	const a = (addr >>> 24) & 0xff;
	const b = (addr >>> 16) & 0xff;
	const c = (addr >>> 8) & 0xff;
	const d = addr & 0xff;

	// 169.254.169.254 - the highest-value SSRF target, reported distinctly.
	if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
	// 0.0.0.0/8 - "this host"; a 0.0.0.0 connect reaches loopback on Linux.
	if (a === 0) return 'unspecified';
	// 127.0.0.0/8 loopback.
	if (a === 127) return 'loopback';
	// 169.254.0.0/16 link-local.
	if (a === 169 && b === 254) return 'link-local';
	// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 RFC1918.
	if (a === 10) return 'rfc1918';
	if (a === 172 && b >= 16 && b <= 31) return 'rfc1918';
	if (a === 192 && b === 168) return 'rfc1918';
	return null;
}

/**
 * Expand a (possibly `::`-compressed) IPv6 hostname - WITHOUT the
 * surrounding brackets - into an array of eight 16-bit group values. A
 * trailing IPv4 dotted-quad tail (`::ffff:1.2.3.4`) is expanded into its
 * two 16-bit groups. Returns `null` when the text is not a valid IPv6
 * literal.
 *
 * @param {string} host - The bracket-stripped IPv6 text.
 * @returns {number[] | null} Eight 16-bit groups, or null.
 */
function parseIpv6(host) {
	// Reject a zone id (`fe80::1%eth0`); the address part is what matters
	// for classification and `URL.hostname` never carries a zone, but be
	// defensive for a bare-host caller.
	const pct = host.indexOf('%');
	if (pct !== -1) host = host.slice(0, pct);

	const halves = host.split('::');
	if (halves.length > 2) return null;

	/**
	 * Expand a colon-separated run of hex groups, with an optional trailing
	 * dotted-quad IPv4 tail, into 16-bit group values.
	 * @param {string} run
	 * @returns {number[] | null}
	 */
	function expand(run) {
		if (run.length === 0) return [];
		const tokens = run.split(':');
		/** @type {number[]} */
		const groups = [];
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			// A dotted-quad tail is only legal as the final token.
			if (tok.indexOf('.') !== -1) {
				if (i !== tokens.length - 1) return null;
				const v4 = parseDottedQuadV6Tail(tok);
				if (v4 === null) return null;
				groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return null;
			groups.push(parseInt(tok, 16));
		}
		return groups;
	}

	if (halves.length === 2) {
		const head = expand(halves[0]);
		const tail = expand(halves[1]);
		if (head === null || tail === null) return null;
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		return head.concat(new Array(fill).fill(0), tail);
	}

	const groups = expand(host);
	if (groups === null || groups.length !== 8) return null;
	return groups;
}

/**
 * Parse the dotted-quad tail of an IPv4-in-IPv6 literal. Stricter than
 * `parseIpv4` (exactly four 0-255 decimal octets, no octal/hex/short
 * forms) because that is the only form the IPv6 grammar permits.
 *
 * @param {string} tail
 * @returns {number | null}
 */
function parseDottedQuadV6Tail(tail) {
	const parts = tail.split('.');
	if (parts.length !== 4) return null;
	let addr = 0;
	for (const part of parts) {
		if (!/^[0-9]{1,3}$/.test(part)) return null;
		const n = parseInt(part, 10);
		if (n > 255) return null;
		addr = addr * 256 + n;
	}
	return addr >>> 0;
}

/**
 * Classify an eight-group IPv6 address. Unwraps IPv4-mapped (`::ffff:0:0/96`)
 * and IPv4-compatible (`::/96`, excluding `::` and `::1`) forms to their
 * embedded IPv4 and re-checks against the IPv4 rules, so a private or
 * metadata IPv4 cannot be smuggled through an IPv6 host.
 *
 * @param {number[]} g - Eight 16-bit groups.
 * @returns {('loopback' | 'link-local' | 'metadata' | 'rfc1918' | 'unspecified' | 'ula') | null}
 */
function classifyIpv6(g) {
	const allZeroHigh = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

	// ::ffff:a.b.c.d (IPv4-mapped) - unwrap and re-check as IPv4.
	if (allZeroHigh && g[5] === 0xffff) {
		return classifyIpv4(((g[6] << 16) | g[7]) >>> 0);
	}
	// ::a.b.c.d (IPv4-compatible, deprecated) - unwrap, but only when the
	// embedded value is a real address (skip :: and ::1, handled below).
	if (allZeroHigh && g[5] === 0 && (g[6] !== 0 || g[7] !== 0)) {
		const v4 = ((g[6] << 16) | g[7]) >>> 0;
		if (v4 !== 1) {
			const r = classifyIpv4(v4);
			if (r) return r;
		}
	}

	// :: (unspecified) and ::1 (loopback).
	const allZero = g.every((x) => x === 0);
	if (allZero) return 'unspecified';
	if (allZeroHigh && g[5] === 0 && g[6] === 0 && g[7] === 1) return 'loopback';

	// fd00:ec2::254 - the IPv6 cloud-metadata endpoint (a subset of ULA,
	// called out distinctly before the ULA range match).
	if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g[2] === 0 && g[3] === 0 &&
		g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 0x0254) {
		return 'metadata';
	}

	// fc00::/7 unique-local (covers fc00::/8 and fd00::/8).
	if ((g[0] & 0xfe00) === 0xfc00) return 'ula';
	// fe80::/10 link-local.
	if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';

	return null;
}

/**
 * Classify a hostname (the value of `URL.hostname`, or a bare host string)
 * by its literal text. Returns a blocked reason, or `null` when the literal
 * is not a known-private host (a public IP or a DNS name).
 *
 * A bracketed value (`[::1]`) is treated as IPv6; a value that parses as a
 * numeric IPv4 in any encoding is classified as IPv4; the `localhost` and
 * `metadata.google.internal` hostnames are matched by name. Anything else
 * is a DNS name and returns `null` (the rebinding gap the async resolver
 * closes).
 *
 * @param {string} hostname
 * @returns {{ reason: string } | { dnsName: string } | null}
 */
function classifyHost(hostname) {
	// Normalise trailing dot (the root-zone form `localhost.`) and case.
	let host = hostname.toLowerCase();
	if (host.endsWith('.')) host = host.slice(0, -1);
	if (host.length === 0) return null;

	// Bracketed IPv6 literal.
	if (host.startsWith('[') && host.endsWith(']')) {
		const inner = host.slice(1, -1);
		const groups = parseIpv6(inner);
		if (groups === null) return { reason: 'parse-error' };
		const reason = classifyIpv6(groups);
		return reason ? { reason } : null;
	}

	// Hostname matches (case/trailing-dot already normalised).
	if (host === 'localhost') return { reason: 'loopback' };
	if (METADATA_HOSTNAMES.has(host)) return { reason: 'metadata' };

	// Numeric IPv4 in any encoding.
	const v4 = parseIpv4(host);
	if (v4 !== null) {
		const reason = classifyIpv4(v4);
		return reason ? { reason } : null;
	}

	// A DNS name. Not a private literal; the rebinding gap.
	return { dnsName: host };
}

/**
 * @typedef {'strict' | 'allowlist' | 'off'} SafeUrlMode
 */

/**
 * @typedef {Object} SafeUrlOptions
 * @property {SafeUrlMode} [mode] - Policy posture. `strict` (default) blocks
 *   every private/loopback/metadata literal. `allowlist` additionally
 *   requires the host to be in `allow`. `off` skips the range checks - for an
 *   IP literal and, on the `checkUrlResolved` path, for a resolved address too
 *   - but still enforces the http(s) scheme gate.
 * @property {string[]} [allow] - Allowlisted hostnames for `allowlist` mode.
 *   Matched case-insensitively against `URL.hostname` (trailing dot
 *   stripped). The SSRF ranges are still enforced, so allowlisting a private
 *   host does not re-open it.
 * @property {(hostname: string) => Promise<string | string[]>} [resolve] -
 *   Resolver used only by `checkUrlResolved` to close the DNS-rebinding gap.
 */

/**
 * The full vocabulary of rejection reasons across this module. Not every
 * function produces every member: `unresolved-host` is only from
 * `checkUrlResolved`, `not-allowlisted` only in `allowlist` mode, and
 * `not-an-ip` only from `classifyAddress` (a non-IP string handed to the
 * address classifier).
 *
 * @typedef {('loopback' | 'rfc1918' | 'link-local' | 'metadata' | 'ula' | 'unspecified' | 'unresolved-host' | 'not-allowlisted' | 'bad-scheme' | 'parse-error' | 'not-an-ip')} SafeUrlReason
 */

/**
 * @typedef {Object} CheckUrlResult
 * @property {boolean} safe
 * @property {SafeUrlReason} [reason]
 */

/**
 * Validate a URL against the SSRF blocked ranges, returning the reason it
 * was rejected (or `{ safe: true }`). Pure and synchronous: classifies the
 * literal host. See module JSDoc for the blocked classes; pass a resolver to
 * `checkUrlResolved` to also defend against DNS rebinding.
 *
 * @param {string} url
 * @param {SafeUrlOptions} [options]
 * @returns {CheckUrlResult}
 */
export function checkUrl(url, options) {
	const mode = (options && options.mode) || 'strict';

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { safe: false, reason: 'parse-error' };
	}

	// Scheme gate is enforced in every mode (including `off`): a non-http(s)
	// scheme is never an intended outbound HTTP fetch.
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { safe: false, reason: 'bad-scheme' };
	}

	if (mode === 'off') return { safe: true };

	const classified = classifyHost(parsed.hostname);
	if (classified && 'reason' in classified) {
		return { safe: false, reason: /** @type {any} */ (classified.reason) };
	}

	// `allowlist` mode: the host must additionally be on the allow list. The
	// range check above already ran, so an allowlisted private host stays
	// blocked.
	if (mode === 'allowlist') {
		const allow = (options && options.allow) || [];
		let host = parsed.hostname.toLowerCase();
		if (host.endsWith('.')) host = host.slice(0, -1);
		const allowed = allow.some((entry) => {
			let e = String(entry).toLowerCase();
			if (e.endsWith('.')) e = e.slice(0, -1);
			return e === host;
		});
		if (!allowed) return { safe: false, reason: 'not-allowlisted' };
	}

	return { safe: true };
}

/**
 * Boolean SSRF gate. The zero-config default (`isSafeUrl(url)`) runs in
 * `strict` mode and never throws on a malformed URL - a URL that does not
 * parse returns `false`. The richer `checkUrl` reports the reason.
 *
 * @param {string} url
 * @param {SafeUrlOptions} [options]
 * @returns {boolean}
 */
export function isSafeUrl(url, options) {
	return checkUrl(url, options).safe;
}

/**
 * Classify a bare IP address literal against the SSRF blocked ranges - the
 * address-level companion to `checkUrl`'s URL-level check, for a caller that
 * already holds an address (a resolved DNS result, a proxied `X-Forwarded-For`
 * hop, a socket peer) rather than a full URL. Returns the matching blocked
 * reason for a private / loopback / metadata / link-local / ULA / unspecified
 * address, or `null` when the input is a real, public IP literal.
 *
 * Accepts every IPv4 encoding the URL parser normalises (dotted-decimal, dotted
 * octal `0177`, dotted/whole hex `0x7f`, short form `127.1`, bare integer
 * `2130706433`) and both bracketed (`[::1]`) and bare (`::1`) IPv6, including
 * the IPv4-mapped / IPv4-compatible forms (`::ffff:169.254.169.254`) which
 * unwrap to the embedded IPv4 and re-check, so the metadata IP cannot be
 * smuggled through an IPv6 wrapper.
 *
 * SECURITY: `null` means "a real IP literal that is public" and NOTHING else. A
 * non-IP input is never `null`: a DNS name (`example.com`) returns `'not-an-ip'`
 * and a malformed literal returns `'parse-error'`, so a hostname can never
 * masquerade as a safe address. A name is not classified by resolution here -
 * resolve it first (see `checkUrlResolved`) and classify the resulting address.
 * The hostnames `localhost` and `metadata.google.internal` are the two
 * name-based blocks and still report their range (`loopback` / `metadata`).
 *
 * @param {string} ip - A bare IP literal: an IPv4 in any encoding, or an IPv6
 *   with or without brackets.
 * @returns {SafeUrlReason | null}
 */
export function classifyAddress(ip) {
	// A bare (unbracketed) IPv6 must be bracketed before it reaches classifyHost,
	// which distinguishes IPv6 by the surrounding brackets; a bracketed value and
	// every IPv4 encoding pass through unchanged.
	if (typeof ip !== 'string') return 'not-an-ip';
	const host = ip.indexOf(':') !== -1 && ip[0] !== '[' ? '[' + ip + ']' : ip;
	const classified = classifyHost(host);
	if (classified === null) {
		// classifyHost returns null for a real PUBLIC IP literal AND for a host that
		// normalises to empty ('' or '.'). Only the former is null-safe; confirm the
		// input actually parses as an IP, else it is not an IP literal at all and
		// MUST be non-null (null would let an empty forwarded-for hop read as safe).
		const bare = host[0] === '[' ? host.slice(1, -1) : host;
		if (bare.length === 0) return 'not-an-ip';
		return (parseIpv4(bare) !== null || parseIpv6(bare) !== null) ? null : 'not-an-ip';
	}
	if ('reason' in classified) return /** @type {SafeUrlReason} */ (classified.reason);
	// classifyHost returned a DNS name: the input was not an IP literal at all.
	// This MUST be non-null - returning null would let a hostname pass as a safe
	// public address (the SSRF hole this classifier exists to close).
	return 'not-an-ip';
}

/**
 * Boolean address gate: `true` only when `ip` is a real, public IP literal -
 * the address-level companion to `isSafeUrl`. A private / loopback / metadata
 * address, a malformed literal, and a non-IP string (a DNS name) all return
 * `false`; a name is never treated as safe. Equivalent to
 * `classifyAddress(ip) === null`.
 *
 * `options` is accepted for signature symmetry with `isSafeUrl` and is reserved
 * for future policy knobs; the address check has no modes today (the `mode` /
 * `allow` / `resolve` posture is a URL-level concern).
 *
 * @param {string} ip
 * @param {SafeUrlOptions} [options]
 * @returns {boolean}
 */
export function isAddressSafe(ip, options) {
	return classifyAddress(ip) === null;
}

/**
 * DNS-rebinding closer. Runs the synchronous literal check first; if that
 * blocks, returns immediately. Otherwise, when the host is a DNS name (not
 * an IP literal) and a `resolve` function is supplied, resolves the name and
 * re-checks every resolved address against the SSRF ranges, so a
 * public-looking name that resolves to a private address is rejected with
 * the address's reason. A resolver that throws yields
 * `{ safe: false, reason: 'unresolved-host' }`.
 *
 * Without a resolver this is identical to `checkUrl`: a public DNS name
 * passes the literal check, and the residual rebinding gap is the caller's
 * to close by supplying `resolve`. In `off` mode the resolver path is skipped
 * entirely (the literal result is returned as-is), so `off` uniformly bypasses
 * the range checks for both IP literals and DNS names.
 *
 * @param {string} url
 * @param {SafeUrlOptions} [options]
 * @returns {Promise<CheckUrlResult>}
 */
export async function checkUrlResolved(url, options) {
	const literal = checkUrl(url, options);
	if (!literal.safe) return literal;

	// `off` skips the range checks by contract; that has to hold on the resolved
	// path too. Otherwise a literal private IP passes (checkUrl short-circuited)
	// while a DNS name resolving to the same private IP would be blocked here -
	// an asymmetry the `off` opt-out is meant to rule out.
	const mode = (options && options.mode) || 'strict';
	if (mode === 'off') return literal;

	const resolve = options && options.resolve;
	if (typeof resolve !== 'function') return literal;

	// Re-derive the host. The literal check passed, so the URL parses and
	// the scheme is http(s).
	const parsed = new URL(url);
	const classified = classifyHost(parsed.hostname);
	// Only a DNS name needs resolution; an IP literal was already classified.
	if (!classified || !('dnsName' in classified)) return literal;

	let addresses;
	try {
		const resolved = await resolve(classified.dnsName);
		addresses = Array.isArray(resolved) ? resolved : [resolved];
	} catch {
		return { safe: false, reason: 'unresolved-host' };
	}

	for (const addr of addresses) {
		if (typeof addr !== 'string' || addr.length === 0) {
			return { safe: false, reason: 'unresolved-host' };
		}
		// A resolver may hand back a bracketed or bare IPv6; classifyHost
		// accepts both.
		const c = classifyHost(addr.indexOf(':') !== -1 && addr[0] !== '[' ? '[' + addr + ']' : addr);
		if (c && 'reason' in c) {
			return { safe: false, reason: /** @type {any} */ (c.reason) };
		}
		if (c && 'dnsName' in c) {
			// The resolver returned a non-address string; treat as unresolved.
			return { safe: false, reason: 'unresolved-host' };
		}
	}

	return { safe: true };
}
