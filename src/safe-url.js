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
 * - cloud metadata: `169.254.169.254`, the IPv6 form `fd00:ec2::254`, and the
 *   `metadata.google.internal` and bare `metadata` hostnames (reported as
 *   `metadata`) - on GCP the DNS search domain makes the short spelling reach
 *   the same endpoint
 * - RFC1918 private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 * - RFC 6598 CGNAT shared address space: `100.64.0.0/10` (reported as
 *   `cgnat`) - carrier-grade NAT internals, Tailscale, and Alibaba Cloud's
 *   instance metadata at `100.100.100.200`
 * - other special-purpose IPv4: IETF protocol assignments `192.0.0.0/24`
 *   (which include the RFC 7050 NAT64 discovery names), benchmark
 *   `198.18.0.0/15`, multicast `224.0.0.0/4`, and reserved `240.0.0.0/4`
 * - unspecified IPv4 `0.0.0.0/8` and IPv6 `::`
 * - IPv6 unique-local (ULA): `fc00::/7` (both `fc00::/8` and `fd00::/8`), and
 *   deprecated site-local `fec0::/10`, still routed on older internal networks
 * - IPv6 link-local `fe80::/10` and multicast `ff00::/8`
 * - IPv4-mapped / IPv4-compatible / IPv4-translated IPv6 (`::ffff:a.b.c.d`,
 *   `::a.b.c.d`, `::ffff:0:a.b.c.d`) are unwrapped to the embedded IPv4 and
 *   re-checked against every IPv4 rule, so `::ffff:169.254.169.254` cannot
 *   smuggle the metadata IP past an IPv4-only check
 * - IPv4-embedding transition mechanisms, unwrapped and re-checked the same
 *   way: NAT64 across the whole of `64:ff9b::/32`, read at all six prefix
 *   lengths RFC 6052 section 2.2 defines, since the address text does not
 *   record which one produced it; 6to4 `2002::/16`; and ISATAP (RFC 5214),
 *   which has no prefix of its own and is recognised by its `0000:5efe` /
 *   `0200:5efe` interface identifier under any unicast prefix. Teredo
 *   `2001::/32` is blocked outright (reported as `reserved`): it embeds two
 *   IPv4 addresses, the client's obfuscated at bits 96-127 and the server's in
 *   the clear at 32-63, and the mechanism has no legitimate public web use, so
 *   the range is refused rather than decoded
 * - NOTE on the NAT64 span: IANA assigns only `64:ff9b::/96` (RFC 6052) and
 *   `64:ff9b:1::/48` (RFC 8215) inside `64:ff9b::/32`, and RFC 6052 section
 *   2.2 says the well-known prefix "can only be used in the last form of the
 *   table", i.e. at /96. Matching the whole /32 and reading the shorter
 *   layouts is therefore a deliberate fail-closed choice over space no
 *   deployment is entitled to use - NOT, as this once claimed, the literal
 *   reading of the RFC. It costs real destinations; see `checkUrl` on how a
 *   deployment pins its own prefix to avoid paying for it
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

// `metadata` bare is deliberate alongside the FQDN: on a GCP instance the
// DNS search domain makes `http://metadata/computeMetadata/v1/` reach the
// instance metadata server just as `metadata.google.internal` does, so
// blocking only the fully-qualified form leaves the obvious short spelling
// open on exactly the platform the rule exists for.
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata']);

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
 * @returns {('loopback' | 'link-local' | 'metadata' | 'rfc1918' | 'unspecified' | 'cgnat' | 'benchmark' | 'multicast' | 'reserved') | null}
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
	// 100.64.0.0/10 RFC 6598 CGNAT shared space - carrier NAT internals,
	// Tailscale, and Alibaba Cloud's metadata endpoint (100.100.100.200).
	if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
	// 198.18.0.0/15 RFC 2544 benchmarking - never a public destination.
	if (a === 198 && (b === 18 || b === 19)) return 'benchmark';
	// 192.0.0.0/24 IETF protocol assignments, which include the RFC 7050
	// NAT64 discovery names 192.0.0.170 / .171 - infrastructure, not a
	// destination an app should be fetching.
	if (a === 192 && b === 0 && c === 0) return 'reserved';
	// 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255).
	if (a >= 224 && a <= 239) return 'multicast';
	if (a >= 240) return 'reserved';
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
 * Classify an eight-group IPv6 address. Unwraps IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-compatible (`::/96`, excluding `::` and `::1`) and IPv4-translated
 * (`::ffff:0:0:0/96`) forms to their embedded IPv4 and re-checks against the
 * IPv4 rules, so a private or metadata IPv4 cannot be smuggled through an IPv6
 * host. The IPv4-embedding transition mechanisms get the same treatment:
 *
 * - NAT64 across the whole of `64:ff9b::/32`, the span holding the well-known
 *   `64:ff9b::/96` (RFC 6052) and the local-use `64:ff9b:1::/48` (RFC 8215).
 *   The address text does not record which prefix length produced it, so the
 *   embedded IPv4 is read at all six lengths RFC 6052 section 2.2 defines and
 *   the shortest reading that lands in a blocked range decides. Covering the
 *   whole /32 is a fail-closed choice over unassigned space, not a spec
 *   requirement - the RFC permits the well-known prefix only at /96.
 * - 6to4 `2002::/16`, from groups 1-2. A public embedded address falls through
 *   rather than returning, so an ISATAP identifier in the same address is
 *   still examined.
 * - ISATAP (RFC 5214), recognised by its `0000:5efe` / `0200:5efe` interface
 *   identifier under any unicast prefix, since it has no prefix of its own.
 * - Teredo `2001::/32`, blocked outright as `reserved`.
 *
 * Native IPv6 ranges are matched directly: `::` unspecified, `::1` loopback,
 * the `fd00:ec2::254` metadata endpoint, unique-local `fc00::/7`, link-local
 * `fe80::/10`, site-local `fec0::/10`, and multicast `ff00::/8`.
 *
 * @param {number[]} g - Eight 16-bit groups.
 * @returns {('loopback' | 'link-local' | 'metadata' | 'rfc1918' | 'unspecified' | 'ula' | 'cgnat' | 'benchmark' | 'multicast' | 'reserved') | null}
 */
function classifyIpv6(g, nat64) {
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

	// ::ffff:0:a.b.c.d - RFC 2765 IPv4-TRANSLATED (`::ffff:0:0:0/96`), the
	// sibling of the IPv4-MAPPED form (`::ffff:0:0/96`) handled above; the two
	// differ by one group and must not be conflated. Unwrap and re-check so this
	// spelling cannot smuggle a private IPv4 the mapped form would have caught.
	if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
		return classifyIpv4(((g[6] << 16) | g[7]) >>> 0);
	}

	// fc00::/7 unique-local (covers fc00::/8 and fd00::/8).
	if ((g[0] & 0xfe00) === 0xfc00) return 'ula';
	// fe80::/10 link-local.
	if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
	// fec0::/10 site-local. Deprecated by RFC 3879 but still routed on plenty
	// of older internal networks, and never a public destination.
	if ((g[0] & 0xffc0) === 0xfec0) return 'ula';
	// ff00::/8 multicast. The IPv4 rules already block 224.0.0.0/4, and the
	// v6 equivalent (ff02::1 all-nodes, ff02::fb mDNS, ff05::1:3 site DHCP)
	// is just as unsuitable as an outbound HTTP destination.
	if ((g[0] & 0xff00) === 0xff00) return 'multicast';

	// 64:ff9b::/32 - the span containing the NAT64 well-known prefix
	// 64:ff9b::/96 and the RFC 8215 local-use prefix 64:ff9b:1::/48.
	//
	// Matching the whole /32 is a fail-closed choice, not a spec requirement:
	// IANA assigns only those two prefixes here, and RFC 6052 section 2.2 says
	// the well-known prefix can only be used at /96. Reading the /32 and /40
	// layouts therefore defends a deployment shape the RFC does not permit, and
	// it is not free - see the over-block note below.
	//
	// RFC 6052 section 2.2 defines SIX prefix lengths (/32 /40 /48 /56 /64 /96)
	// and the address text does not say which one produced it, so the embedded
	// IPv4 has to be read at every length. Each layout splits the address around
	// the reserved u-octet at bits 64-71; a contiguous 32-bit read would consume
	// that octet and shift every octet after it.
	//
	// Every length is read UNCONDITIONALLY. Nothing about the address is allowed
	// to disqualify a reading, because everything that could - the reserved
	// u-octet, the padding after the embedded address - is under the sender's
	// control and is not part of the embedded address at that length. Gating on
	// either one hands an attacker an off switch: dirty the bits that the
	// reading which sees the private address does not use, and that reading is
	// discarded while a public-looking one at another length acquits the
	// address. `64:ff9b:1:a9fe:a9:fe00:808:808` is 169.254.169.254 under the
	// RFC 8215 /48 with a junk suffix, and it must not be reachable.
	//
	// The only thing skipped is a reading landing in 0.0.0.0/8, which is the
	// padding artifact of a LONGER prefix's encoding rather than a destination -
	// unless every reading lands there, in which case the address really is
	// unspecified.
	//
	// That skip is bounded by construction, and the bound holds no matter how any
	// range is NAMED: the skip is a range test on the address bits themselves - a
	// zero leading octet - so the set it can suppress is exactly 0.0.0.0/8
	// whatever a future rule decides to call that space. It can never hide a
	// loopback, RFC1918, metadata or any other destination.
	//
	// What it does leave reachable is 0.0.0.0/8 itself, and that residual is real
	// rather than theoretical. Reaching loopback by way of 0.0.0.0 is not merely
	// a connect(2) quirk: Linux substitutes the loopback route inside
	// __ip_route_output_key_hash, the generic output-route lookup every in-kernel
	// caller reaches, so a NAT64 translator that routes its own translated packet
	// through it - Jool does, without validating the destination - lands on the
	// translator's loopback. RFC 7915 requires no destination validation, and RFC
	// 6052 section 3.1's MUST-drop is scoped to the well-known prefix, which none
	// of the reachable shapes use. The floor is therefore blind SSRF against the
	// translator appliance itself, and the bound above is what stops it reaching
	// the calling host's own metadata or RFC1918.
	//
	// ALL OF THE ABOVE is what a deployment that has NOT declared its prefix
	// pays. When the EXACT `nat64Prefix` is supplied, the ambiguity disappears:
	// the length is known, so exactly one reading is taken, nothing is padding,
	// and both the over-block and the 0.0.0.0/8 residual go to zero. The declared
	// prefix is honoured wherever it lives, since RFC 6052 lets an operator source
	// a Network-Specific Prefix from their own address space rather than from
	// 64:ff9b::/32. For such an NSP the declaration is required for protection;
	// without it this classifier cannot recognise the ordinary-looking IPv6 range
	// as carrying IPv4 at all.
	if (nat64 && nat64InPrefix(g, nat64.groups, nat64.len)) {
		const declared = classifyIpv4(nat64ReadAt(g, nat64.len));
		if (declared) return declared;
		if ((g[4] >>> 8) !== 0) return 'reserved';
		// A non-zero suffix means the address is not a conformant encoding at the
		// DECLARED length, which is what a too-short declaration looks like from
		// here: the real destination is sitting in the bits this reading treats as
		// padding. Refusing catches that case at no cost to a correct declaration.
		if (nat64SuffixDirty(g, nat64.len)) return 'reserved';
		// A clean suffix is not proof that the declaration matches the translator.
		// A wrong length in EITHER direction can make this reading public while the
		// real one is private. Trying alternate lengths cannot fix that ambiguity:
		// the same bits are also a conformant public address under a correct
		// declaration. For example, public 200.10.0.0 under a correct /48 reads as
		// private 10.0.0.0 at /56. Trust the exact configured length here; the public
		// option contract warns that any parseable mismatch can weaken the guard.
		// Falls through rather than returning: an address can carry an ISATAP
		// identifier regardless of the prefix it sits under.
	} else if (g[0] === 0x0064 && g[1] === 0xff9b) {
		/** @type {number[]} shortest prefix first, so the reason is the least padded one */
		const readings = [
			(((g[2] << 16) | g[3]) >>> 0),                                      // /32: bits 32-63
			((((g[2] & 0xff) << 24) | (g[3] << 8) | (g[4] & 0xff)) >>> 0),      // /40: 40-63 + 72-79
			(((g[3] << 16) | ((g[4] & 0xff) << 8) | (g[5] >>> 8)) >>> 0),       // /48: 48-63 + 72-87
			((((g[3] & 0xff) << 24) | ((g[4] & 0xff) << 16) | g[5]) >>> 0),     // /56: 56-63 + 72-95
			((((g[4] & 0xff) << 24) | (g[5] << 8) | (g[6] >>> 8)) >>> 0),       // /64: 72-103
			(((g[6] << 16) | g[7]) >>> 0)                                       // /96: 96-127
		];
		// Each layout steps around the reserved u-octet at bits 64-71; a
		// contiguous 32-bit read would consume it and shift every octet after it.
		// A reading landing in 0.0.0.0/8 is almost always an artifact rather than a
		// destination: read at a length SHORTER than the real prefix it picks up
		// prefix bits, and read at a LONGER one it reads into the zero padding.
		// Which of those applies cannot be decided from the address text, so a
		// 0.0.0.0/8 reading is discarded whenever any other reading carries a real
		// address, and honoured when none does.
		const allPadding = readings.every((v) => (v >>> 24) === 0);
		for (const v of readings) {
			if (!allPadding && (v >>> 24) === 0) continue;
			const r = classifyIpv4(v);
			if (r) return r;
		}
		// Nothing at all after the prefix: the address carries no destination at
		// ANY length, so it is the translator prefix itself. The rule above cannot
		// see this, because a reading shorter than the real prefix turns those
		// prefix bits into a public-looking address and vouches for the zeros.
		// Checked last, so an address that a shorter reading identifies as a real
		// range still reports that range instead of being flattened here.
		//
		// This is NOT a general "0.0.0.0 always blocks" rule and must not be
		// described as one: it requires groups 3-7 to be entirely zero, so junk in
		// a group the matching reading does not use switches it off, and
		// `64:ff9b:1:0:0:0:8:8` reads 0.0.0.0 at /48 yet is allowed. What makes
		// that acceptable is the bound above, not this guard.
		if (g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 0) {
			return 'unspecified';
		}
		// RFC 6052 section 2.2 reserves bits 64-71 and requires them to be zero in
		// every layout, so a non-zero value there is not a legal IPv4-embedded
		// address at ANY length. This is the one property of the address that can
		// be acted on without handing the sender an off switch, because the
		// polarity is refusal rather than discarding: gating a READING on it would
		// let an attacker disable whichever reading sees the private address,
		// while refusing the whole address cannot be used that way.
		//
		// Checked only after every reading has been consulted, so a private
		// destination still reports its own range instead of being flattened to
		// this one. What it closes is a divergence class: this reader steps around
		// the u-octet, a translator doing a contiguous 32-bit read would not, and a
		// non-conformant address is exactly where the two disagree.
		if ((g[4] >>> 8) !== 0) return 'reserved';
		return null;
	}
	// 2002::/16 (6to4, RFC 3056) - unwrap the embedded IPv4 from groups 1-2
	// (bits 16-47) and re-check. Falls through on a public embedded address
	// rather than returning: a 6to4 address can ALSO carry an ISATAP interface
	// identifier (the classic Windows pairing), and returning here would hide
	// the private address in the low 32 bits behind a public 6to4 one.
	if (g[0] === 0x2002) {
		const sixToFour = classifyIpv4(((g[1] << 16) | g[2]) >>> 0);
		if (sixToFour) return sixToFour;
	}
	// 2001::/32 (Teredo, RFC 4380) - block the whole range rather than decoding
	// it. A Teredo address embeds TWO IPv4 addresses: the server's in the clear
	// at bits 32-63 and the client's external address XOR-obfuscated at 96-127.
	// The range is refused because the mechanism has no legitimate public web
	// use, which stands on its own; the obfuscation is only why decoding the
	// client half would be the wrong way to handle it.
	if (g[0] === 0x2001 && g[1] === 0) return 'reserved';

	// ISATAP (RFC 5214) - the IPv4 sits in the low 32 bits behind a `0000:5efe`
	// or `0200:5efe` interface identifier, under ANY unicast prefix. Unlike 6to4
	// and NAT64 there is no prefix to match on, so the identifier is the only
	// signal available. The link-local spelling is already caught by fe80::/10
	// above; the globally-prefixed spelling is the one that reaches a tunnel
	// endpoint on the host's own /64, and it was previously read as public.
	//
	// Only a PRIVATE embedded address blocks: the identifier alone is not
	// grounds for refusing, since these bits can legitimately occur in an
	// ordinary address.
	if ((g[4] === 0x0000 || g[4] === 0x0200) && g[5] === 0x5efe) {
		const isatap = classifyIpv4(((g[6] << 16) | g[7]) >>> 0);
		if (isatap) return isatap;
	}

	return null;
}

/**
 * Parse a declared NAT64 prefix (`'64:ff9b::/96'`, `'64:ff9b:1:a::/96'`) into
 * the groups and length the classifier needs, or `null` when the option is
 * absent or unusable.
 *
 * An UNPARSEABLE value returns `null`, which falls back to reading every length
 * - the safe direction, so a malformed string costs over-blocking rather than
 * under-blocking.
 *
 * A PARSEABLE BUT WRONG value is a different matter and cannot be defended
 * against from the address text alone: it is a trusted statement of fact about
 * the network. A wrong length in EITHER direction can read different bits as a
 * public IPv4 while the translator reads a private one. A non-zero suffix at the
 * declared length proves some mismatches and refuses the address, but a clean
 * suffix is not proof that the declaration is correct. The caller must declare
 * the exact prefix in use.
 *
 * @param {string | undefined} spec
 * @returns {{ groups: number[], len: number } | null}
 */
/** The prefix lengths RFC 6052 section 2.2 defines, shortest first. */
const NAT64_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96];

function parseNat64Prefix(spec) {
	if (typeof spec !== 'string') return null;
	const slash = spec.lastIndexOf('/');
	if (slash === -1) return null;
	// RFC 6052 section 2.2 permits exactly these six lengths, and the text must
	// BE one of them: `Number()` would also accept '0x30', ' 48', '+48' and
	// '96.0', which is a looser contract than the six-length gate advertises.
	if (!/^(?:32|40|48|56|64|96)$/.test(spec.slice(slash + 1))) return null;
	const len = Number(spec.slice(slash + 1));
	const groups = parseIpv6(spec.slice(0, slash).replace(/^\[|\]$/g, ''));
	if (groups === null) return null;
	return { groups, len };
}

/**
 * Read the IPv4 embedded at ONE RFC 6052 prefix length.
 *
 * @param {number[]} g - Eight 16-bit groups.
 * @param {number} len - One of 32, 40, 48, 56, 64, 96.
 * @returns {number} The embedded address as a uint32.
 */
function nat64ReadAt(g, len) {
	if (len === 32) return ((g[2] << 16) | g[3]) >>> 0;
	if (len === 40) return (((g[2] & 0xff) << 24) | (g[3] << 8) | (g[4] & 0xff)) >>> 0;
	if (len === 48) return ((g[3] << 16) | ((g[4] & 0xff) << 8) | (g[5] >>> 8)) >>> 0;
	if (len === 56) return (((g[3] & 0xff) << 24) | ((g[4] & 0xff) << 16) | g[5]) >>> 0;
	if (len === 64) return (((g[4] & 0xff) << 24) | (g[5] << 8) | (g[6] >>> 8)) >>> 0;
	return ((g[6] << 16) | g[7]) >>> 0;
}

/**
 * Are any bits set AFTER the embedded address, at the declared prefix length?
 *
 * RFC 6052 puts the embedded IPv4 immediately after the prefix (stepping around
 * the reserved u-octet) and specifies everything after it as a zero suffix. So a
 * non-zero suffix at the declared length is direct evidence that the declaration
 * does not describe the network: under a declaration SHORTER than the real
 * prefix, the real destination lives in exactly those bits.
 *
 * This detects some wrong declarations, but a clean suffix does not prove that
 * the declaration matches the translator. A conformant encoding under a CORRECT
 * declaration has a zero suffix by construction. The polarity is refusal of the
 * address, matching the u-octet rule, so it cannot be used as an off switch: an
 * attacker dirtying the suffix gets refused, not allowed.
 *
 * At `/96` there is no suffix, which is exactly the length at which a too-short
 * declaration cannot occur.
 *
 * @param {number[]} g - Eight 16-bit groups.
 * @param {number} len - One of 32, 40, 48, 56, 64, 96.
 * @returns {boolean}
 */
function nat64SuffixDirty(g, len) {
	// Where the address ends: /96 fills the tail; /64 runs 72-103; the shorter
	// layouts run from `len` to 63 and resume at 72, ending at len + 40.
	const start = len === 96 ? 128 : len === 64 ? 104 : len + 40;
	for (let bit = start; bit < 128; bit++) {
		if ((g[bit >> 4] >>> (15 - (bit & 15))) & 1) return true;
	}
	return false;
}

/**
 * Does `g` sit inside the declared prefix? Compares only the prefix bits, so a
 * /96 declaration matches every address sharing its first 96 bits.
 *
 * @param {number[]} g
 * @param {number[]} prefix
 * @param {number} len
 * @returns {boolean}
 */
function nat64InPrefix(g, prefix, len) {
	const whole = len >> 4;
	for (let i = 0; i < whole; i++) {
		if (g[i] !== prefix[i]) return false;
	}
	const rest = len & 15;
	if (rest !== 0) {
		const mask = (0xffff << (16 - rest)) & 0xffff;
		if ((g[whole] & mask) !== (prefix[whole] & mask)) return false;
	}
	return true;
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
function classifyHost(hostname, nat64) {
	// Normalise trailing dot (the root-zone form `localhost.`) and case.
	let host = hostname.toLowerCase();
	if (host.endsWith('.')) host = host.slice(0, -1);
	if (host.length === 0) return null;

	// Bracketed IPv6 literal.
	if (host.startsWith('[') && host.endsWith(']')) {
		const inner = host.slice(1, -1);
		const groups = parseIpv6(inner);
		if (groups === null) return { reason: 'parse-error' };
		const reason = classifyIpv6(groups, nat64);
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
 * @property {string} [nat64Prefix] - The deployment's own NAT64 prefix, in
 *   `<address>/<length>` form (`'64:ff9b::/96'`, `'64:ff9b:1:a::/96'`,
 *   `'2001:db8:1::/96'`). Optional, and only relevant on a NAT64 network. For
 *   a Network-Specific Prefix outside `64:ff9b::/32`, it is REQUIRED for this
 *   guard to recognise that the ordinary-looking IPv6 range carries IPv4.
 *
 *   Without it the prefix length is not recoverable from an address, so the
 *   embedded IPv4 must be read at all six RFC 6052 lengths and the address
 *   refused if ANY reading is private. That is fail-closed but not free: the
 *   readings that do not correspond to the real prefix decode prefix bits and
 *   padding into a phantom IPv4, which lands in a blocked range for roughly a
 *   quarter of public destinations at `/48` and a third at `/32` and `/40`. It
 *   is worse for a `/96` sourced from `64:ff9b:1::/48`, where the subnet id
 *   becomes the phantom's LEADING octets: about a quarter of subnet ids refuse
 *   every public destination outright.
 *
 *   Declaring the exact prefix removes the ambiguity: exactly one reading is
 *   taken, nothing is padding, and both the over-block and the `0.0.0.0/8`
 *   residual go to zero. A private embedded address is still refused.
 *
 *   DECLARE THE EXACT PREFIX THE TRANSLATOR USES. This option is a TRUSTED
 *   ASSERTION about the network. A parseable wrong length in EITHER direction
 *   can turn an address the guard would otherwise refuse into an allowed one:
 *   a shorter declaration reads prefix bits as the destination, while a longer
 *   declaration reads destination and suffix bits. The real length is not
 *   recoverable from the address text, and trying every length would restore the
 *   over-block this option exists to remove. A non-zero suffix proves some
 *   mismatches and is refused, but a clean suffix does not prove the declaration
 *   correct. Only an UNPARSEABLE value is safe by default - that one is ignored
 *   and every length is read.
 */

/**
 * The full vocabulary of rejection reasons across this module. Not every
 * function produces every member: `unresolved-host` is only from
 * `checkUrlResolved`, `not-allowlisted` only in `allowlist` mode, and
 * `not-an-ip` only from `classifyAddress` (a non-IP string handed to the
 * address classifier).
 *
 * @typedef {('loopback' | 'rfc1918' | 'link-local' | 'metadata' | 'ula' | 'unspecified' | 'cgnat' | 'benchmark' | 'multicast' | 'reserved' | 'unresolved-host' | 'not-allowlisted' | 'bad-scheme' | 'parse-error' | 'not-an-ip')} SafeUrlReason
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

	const classified = classifyHost(parsed.hostname, parseNat64Prefix(options && options.nat64Prefix));
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
 * reason for a private / loopback / metadata / link-local / ULA / unspecified /
 * CGNAT / benchmark / multicast / reserved address, or `null` when the input
 * is a real, public IP literal.
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
 * The hostnames `localhost`, `metadata.google.internal` and the bare `metadata`
 * are the name-based blocks and still report their range (`loopback` /
 * `metadata`).
 *
 * @param {string} ip - A bare IP literal: an IPv4 in any encoding, or an IPv6
 *   with or without brackets.
 * @param {SafeUrlOptions} [options] - Only `nat64Prefix` is consulted; the mode
 *   and allow-list posture is a URL-level concern.
 * @returns {SafeUrlReason | null}
 */
export function classifyAddress(ip, options) {
	// A bare (unbracketed) IPv6 must be bracketed before it reaches classifyHost,
	// which distinguishes IPv6 by the surrounding brackets; a bracketed value and
	// every IPv4 encoding pass through unchanged.
	if (typeof ip !== 'string') return 'not-an-ip';
	const host = ip.indexOf(':') !== -1 && ip[0] !== '[' ? '[' + ip + ']' : ip;
	const classified = classifyHost(host, parseNat64Prefix(options && options.nat64Prefix));
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
 * `options` is consulted for `nat64Prefix` only - a NAT64 declaration applies to
 * an address exactly as it does to a URL. The `mode` / `allow` / `resolve` posture
 * is a URL-level concern and is ignored here.
 *
 * @param {string} ip
 * @param {SafeUrlOptions} [options]
 * @returns {boolean}
 */
export function isAddressSafe(ip, options) {
	return classifyAddress(ip, options) === null;
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
	const nat64 = parseNat64Prefix(options && options.nat64Prefix);
	const classified = classifyHost(parsed.hostname, nat64);
	// Only a DNS name needs resolution; an IP literal was already classified.
	if (!classified || !('dnsName' in classified)) return literal;

	let addresses;
	try {
		const resolved = await resolve(classified.dnsName);
		addresses = Array.isArray(resolved) ? resolved : [resolved];
	} catch {
		return { safe: false, reason: 'unresolved-host' };
	}

	// An empty result must fail closed. The loop below is the entire rebinding
	// defence, and with zero addresses it simply does not run - so a custom
	// `resolve` returning [] on NODATA (a documented extension point) would
	// silently mark every host safe.
	if (addresses.length === 0) return { safe: false, reason: 'unresolved-host' };

	for (const addr of addresses) {
		if (typeof addr !== 'string' || addr.length === 0) {
			return { safe: false, reason: 'unresolved-host' };
		}
		// A resolver may hand back a bracketed or bare IPv6; classifyHost
		// accepts both.
		const c = classifyHost(addr.indexOf(':') !== -1 && addr[0] !== '[' ? '[' + addr + ']' : addr, nat64);
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
