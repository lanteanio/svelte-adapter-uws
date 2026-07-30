/**
 * Trusted-proxy allowlist matching and proxy-aware client-IP resolution.
 *
 * `ADDRESS_HEADER` (and the PROXY-protocol address) name the *claimed* client
 * address; whether that claim is believable depends on who the direct socket
 * peer is. `TRUSTED_PROXIES` is the opt-in allowlist of peers (IPs or CIDRs)
 * whose claims are honored. When it is unset, header trust is unconditional
 * (the historical behavior); when set, a claim arriving from a peer outside
 * the list is ignored and the socket address is used instead, so a client
 * that can reach the listener directly cannot spoof its rate-limit identity
 * or `getClientAddress()`.
 *
 * This module is pure (no env, no uWS import) so it is unit-testable;
 * `runtime/handler/config.js` wires the env knobs into it.
 */

/**
 * Longest a non-XFF address header may be before it stops being an address.
 * The widest real spelling (expanded IPv6, brackets, port, zone id) is under
 * 90 characters.
 */
const MAX_ADDRESS_HEADER_LENGTH = 128;

/**
 * Bound on the X-Forwarded-For value that is parsed.
 *
 * Far larger than the single-address headers because this one legitimately
 * chains: every hop appends, so a long path is normal traffic rather than an
 * attack. Over the bound the HEAD is dropped, never the tail - see the resolver.
 */
const MAX_XFF_LENGTH = 8192;

/**
 * Return a copy of `value` that does not retain the header it came from.
 *
 * `split()` and `trim()` hand back a V8 SlicedString for anything 13
 * characters or longer, and a SlicedString keeps its PARENT alive. The client
 * IP derived from a multi-kilobyte header is therefore a small string holding
 * the whole header, and storing it as a rate-limit key pins that header for
 * the entry's lifetime - measured, 10,000 entries retained ~40 MB per worker
 * instead of the ~2 MB the entry cap implies, with the documented 128-character
 * key bound doing nothing about it because the bound counts characters and the
 * cost is in the parent.
 *
 * Concatenating and re-slicing forces a fresh, compact backing string, so what
 * survives is the address and nothing else. Only reached on the configured
 * address-header path; the default `getRemoteAddressAsText()` value is already
 * a standalone string and pays none of this.
 *
 * @param {string} value
 * @returns {string}
 */
function detachFromHeader(value) {
	if (value.length < 13) return value; // V8 copies these outright
	return (' ' + value).slice(1);
}

/**
 * Normalize a socket-layer or config IP literal for comparison: lowercase,
 * strip brackets and an IPv6 zone id, and unwrap an IPv4-mapped IPv6 address
 * to its dotted-quad form so `::ffff:10.0.0.1` and `10.0.0.1` agree.
 * @param {string} ip
 * @returns {string}
 */
function normalizeIp(ip) {
	let host = String(ip || '').trim().toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	const pct = host.indexOf('%');
	if (pct !== -1) host = host.slice(0, pct);
	if (host.startsWith('::ffff:') && host.indexOf('.') !== -1) host = host.slice(7);
	return host;
}

/**
 * Parse an IPv4 dotted quad to its 32-bit value, or null if not IPv4.
 * @param {string} host
 * @returns {number | null}
 */
function v4ToInt(host) {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
	const o = host.split('.');
	let out = 0;
	for (let i = 0; i < 4; i++) {
		const n = Number(o[i]);
		if (n > 255) return null;
		out = out * 256 + n;
	}
	return out;
}

/**
 * Parse an IPv6 literal (optionally with an embedded IPv4 tail) to a 128-bit
 * BigInt, or null if malformed.
 * @param {string} host
 * @returns {bigint | null}
 */
function v6ToBigInt(host) {
	if (host.indexOf(':') === -1) return null;
	let head = host;
	let tailGroups = [];
	// Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) becomes two 16-bit groups.
	const lastColon = host.lastIndexOf(':');
	const tail = host.slice(lastColon + 1);
	if (tail.indexOf('.') !== -1) {
		const v4 = v4ToInt(tail);
		if (v4 === null) return null;
		head = host.slice(0, lastColon + 1) + '0:0';
		tailGroups = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
	}
	const parts = head.split('::');
	if (parts.length > 2) return null;
	const left = parts[0] ? parts[0].split(':') : [];
	const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
	const missing = 8 - left.length - right.length;
	if (parts.length === 2 ? missing < 0 : missing !== 0) return null;
	const groups = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right];
	if (groups.length !== 8) return null;
	if (tailGroups.length) {
		groups[6] = tailGroups[0].toString(16);
		groups[7] = tailGroups[1].toString(16);
	}
	let out = 0n;
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		out = (out << 16n) | BigInt(parseInt(g, 16));
	}
	return out;
}

/**
 * Compile a comma-separated allowlist of IPs / CIDR ranges into a matcher.
 * Returns null when the spec is empty. Throws on a malformed entry - the
 * spec comes from boot-time configuration, and a typo that silently drops
 * an entry would fail open or closed unpredictably.
 *
 * @param {string} spec - e.g. "10.0.0.0/8, 172.16.0.5, 2001:db8::/32, ::1"
 * @returns {{ match(ip: string): boolean } | null}
 */
export function createTrustedProxyMatcher(spec) {
	const entries = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
	if (entries.length === 0) return null;

	/** @type {{ v4: boolean, net: number | bigint, bits: number }[]} */
	const rules = [];
	for (const entry of entries) {
		const slash = entry.indexOf('/');
		const hostRaw = slash === -1 ? entry : entry.slice(0, slash);
		const host = normalizeIp(hostRaw);
		const v4 = v4ToInt(host);
		const isV4 = v4 !== null;
		const v6 = isV4 ? null : v6ToBigInt(host);
		if (!isV4 && v6 === null) {
			throw new Error(`TRUSTED_PROXIES entry "${entry}" is not a valid IP address or CIDR range`);
		}
		const maxBits = isV4 ? 32 : 128;
		let bits = maxBits;
		if (slash !== -1) {
			bits = Number(entry.slice(slash + 1));
			if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
				throw new Error(`TRUSTED_PROXIES entry "${entry}" has an invalid prefix length (0-${maxBits})`);
			}
		}
		if (isV4) {
			const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
			rules.push({ v4: true, net: (v4 & mask) >>> 0, bits });
		} else {
			const shift = BigInt(128 - bits);
			rules.push({ v4: false, net: /** @type {bigint} */ (v6) >> shift << shift, bits });
		}
	}

	return {
		match(ip) {
			const host = normalizeIp(ip);
			const v4 = v4ToInt(host);
			if (v4 !== null) {
				for (const r of rules) {
					if (!r.v4) continue;
					const mask = r.bits === 0 ? 0 : (~0 << (32 - r.bits)) >>> 0;
					if (((v4 & mask) >>> 0) === r.net) return true;
				}
				return false;
			}
			const v6 = v6ToBigInt(host);
			if (v6 === null) return false;
			for (const r of rules) {
				if (r.v4) continue;
				const shift = BigInt(128 - r.bits);
				if ((v6 >> shift << shift) === r.net) return true;
			}
			return false;
		}
	};
}

/**
 * Build the client-IP resolver applying the configured proxy header on top
 * of the socket address, gated on the trusted-proxy allowlist.
 *
 * The returned function keeps the historical contract: it returns a usable
 * address string on ANY input so rate limiting and userData injection never
 * receive undefined. `rawIp` is the effective transport address (the
 * PROXY-protocol address when that is configured and trusted, else the
 * socket peer); `directIp` is always the socket peer - header trust is
 * decided on who actually connected, never on a forwarded claim.
 *
 * @param {{
 *   addressHeader: string,
 *   xffDepth: number,
 *   matcher: { match(ip: string): boolean } | null,
 *   onUntrusted?: (directIp: string) => void
 * }} opts
 * @returns {(rawIp: string, headers: Record<string, string>, directIp?: string) => string}
 */
export function createClientIpResolver({ addressHeader, xffDepth, matcher, onUntrusted }) {
	return function resolveClientIp(rawIp, headers, directIp = rawIp) {
		if (!addressHeader) return rawIp;
		const value = headers[addressHeader];
		if (!value) return rawIp;
		if (matcher && !matcher.match(directIp)) {
			onUntrusted?.(directIp);
			return rawIp;
		}
		if (addressHeader === 'x-forwarded-for') {
			// TRUNCATE FROM THE HEAD, do not fall back to the socket address.
			//
			// This branch used to answer `rawIp` for anything over the bound, which
			// is the behaviour the comment below this block argues is unacceptable
			// for the other headers: it merges every client behind one proxy into a
			// single rate-limit identity, and a client that can pad the header can
			// therefore force that merge on demand.
			//
			// The tail is the part to keep. Every hop APPENDS to X-Forwarded-For, so
			// the rightmost addresses are the ones infrastructure added and the
			// leftmost is the only region a client controls - which is also why
			// `xffDepth` counts from the right. Cutting the head keeps exactly the
			// addresses the depth selects while bounding the work, where cutting the
			// tail would throw away the only trustworthy end.
			const bounded = value.length > MAX_XFF_LENGTH
				? value.slice(value.length - MAX_XFF_LENGTH)
				: value;
			const addresses = bounded.split(',');
			// Slicing mid-address leaves a partial first element. It is not an
			// address, so it must not be counted when the depth is applied.
			if (bounded.length !== value.length) addresses.shift();
			if (xffDepth > addresses.length) return rawIp;
			return detachFromHeader(addresses[addresses.length - xffDepth].trim());
		}
		// TRUNCATE an over-long value; do NOT fall back to the socket address.
		//
		// Nothing bounded the non-XFF headers (`x-real-ip`, `cf-connecting-ip`,
		// `true-client-ip`, ...), so a client could name itself with kilobytes
		// and have that string become a rate-limit identity. But answering
		// `rawIp` for anything over the bound MERGES every client behind one
		// proxy into a single identity, and some of these headers legitimately
		// CHAIN: `x-original-forwarded-for` (ingress-nginx, the GCP external LB)
		// and RFC 7239 `Forwarded` carry every hop, so three IPv6 hops already
		// reach ~121 characters. Measured, thirty distinct clients behind such a
		// header collapsed to one bucket and two thirds of their upgrades were
		// refused. The limiter states the rule this broke: merging distinct
		// clients is a far worse error than failing to merge one client's
		// addresses.
		//
		// Truncation keeps the LEADING address, which is the client's, so
		// distinct clients stay distinct while the stored value stays bounded.
		// Only this branch detaches, and only when it slices: below the bound
		// the header value is already a standalone string from the uWS binding
		// (`request.js` builds it per key), so detaching it there would copy for
		// no reason on every single request.
		if (value.length > MAX_ADDRESS_HEADER_LENGTH) {
			return detachFromHeader(value.slice(0, MAX_ADDRESS_HEADER_LENGTH));
		}
		return value;
	};
}
