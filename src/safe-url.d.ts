/**
 * SSRF-defence URL validator. Server-side handlers that fetch a
 * user-supplied URL (an outbound webhook, a link-preview, an avatar import)
 * are a server-side request forgery target: an attacker submits a URL
 * pointing at the cloud instance-metadata endpoint (`169.254.169.254`), a
 * loopback admin panel, or an RFC1918 service, and the server fetches it
 * from inside the trust boundary. `isSafeUrl` answers "is it safe to fetch
 * this URL" with a single boolean.
 *
 * Pure logic, no `node:dns` import: the synchronous `isSafeUrl` / `checkUrl`
 * classify the literal host (numeric IPs in any encoding are normalised and
 * range-checked; DNS names are classified on their literal text only). The
 * async `checkUrlResolved` takes a caller-supplied resolver to close the
 * DNS-rebinding gap.
 *
 * Blocked: loopback (`127.0.0.0/8`, `::1`, `localhost`), link-local IPv4
 * (`169.254.0.0/16`), cloud metadata (`169.254.169.254`, `fd00:ec2::254`,
 * `metadata.google.internal` and bare `metadata`), RFC1918 (`10/8`,
 * `172.16/12`, `192.168/16`), RFC 6598 CGNAT shared space (`100.64.0.0/10`,
 * incl. Alibaba Cloud's `100.100.100.200` metadata), IETF protocol assignments
 * (`192.0.0.0/24`), benchmark (`198.18.0.0/15`), multicast (`224.0.0.0/4`),
 * reserved (`240.0.0.0/4`), unspecified (`0.0.0.0/8`, `::`), IPv6 ULA
 * (`fc00::/7`) and site-local (`fec0::/10`), IPv6 link-local (`fe80::/10`),
 * IPv6 multicast (`ff00::/8`), and IPv4-mapped / compatible / translated IPv6
 * forms (unwrapped to the embedded IPv4).
 *
 * The IPv4-embedding transition mechanisms are covered the same way: NAT64
 * across the whole of `64:ff9b::/32` (the span holding the well-known
 * `64:ff9b::/96` from RFC 6052 and the local-use `64:ff9b:1::/48` from RFC
 * 8215, read at all six prefix lengths RFC 6052 defines, since the address text
 * does not record which one produced it - covering the whole `/32` is a
 * fail-closed choice over unassigned space, not a spec requirement, because the
 * RFC permits the well-known prefix only at `/96`), 6to4 (`2002::/16`), and
 * ISATAP (RFC 5214,
 * recognised by its `0000:5efe` / `0200:5efe` interface identifier under any
 * unicast prefix) unwrap to the embedded IPv4 and re-check, while Teredo
 * (`2001::/32`) is blocked outright as `reserved`.
 *
 * Non-http(s) schemes are rejected in every mode. IP-obfuscation evasions
 * (decimal / octal / hex / short-form IPv4, IPv4-mapped IPv6, userinfo
 * smuggling, trailing-dot, case) are normalised before matching.
 *
 * This is the single canonical copy: `svelte-adapter-uws-extensions/safe-url`
 * re-exports it and `svelte-realtime` imports it directly.
 */

/**
 * Policy posture. `strict` (default) blocks every private/loopback/metadata
 * literal. `allowlist` additionally requires the host to be in `allow`.
 * `off` is the explicit, reviewable opt-out: it skips the range checks - for
 * an IP literal and, on the `checkUrlResolved` path, for a resolved address
 * too - but still enforces the http(s) scheme gate.
 */
export type SafeUrlMode = 'strict' | 'allowlist' | 'off';

export interface SafeUrlOptions {
	/** Policy posture. Defaults to `strict`. */
	mode?: SafeUrlMode;
	/**
	 * Allowlisted hostnames for `allowlist` mode. Matched case-insensitively
	 * against the URL hostname (trailing dot stripped). The SSRF ranges are
	 * still enforced, so allowlisting a private host does not re-open it.
	 */
	allow?: string[];
	/**
	 * Resolver used only by `checkUrlResolved` to close the DNS-rebinding
	 * gap. Receives the hostname and returns one address or an array of
	 * addresses (e.g. a thin wrapper over `dns.promises.resolve`).
	 */
	resolve?: (hostname: string) => Promise<string | string[]>;
	/**
	 * The deployment's own NAT64 prefix, as `<address>/<length>`
	 * (`'64:ff9b::/96'`, `'64:ff9b:1:a::/96'`, `'2001:db8:1::/96'`). Optional,
	 * and only relevant on a NAT64 network. For a Network-Specific Prefix outside
	 * `64:ff9b::/32`, it is REQUIRED for this guard to recognise that the
	 * ordinary-looking IPv6 range carries IPv4.
	 *
	 * Without it the prefix length cannot be recovered from an address, so the
	 * embedded IPv4 is read at all six RFC 6052 lengths and the address is
	 * refused if any reading is private. That is fail-closed but not free: the
	 * readings that do not match the real prefix decode prefix bits and padding
	 * into a phantom IPv4, which lands in a blocked range for roughly a quarter
	 * of public destinations at `/48` and a third at `/32` and `/40`. For a
	 * `/96` sourced from `64:ff9b:1::/48` the subnet id becomes the phantom's
	 * leading octets, so about a quarter of subnet ids refuse every public
	 * destination.
	 *
	 * Declaring the exact prefix takes one reading, which removes both the
	 * over-block and the `0.0.0.0/8` residual. A private embedded address is still
	 * refused.
	 *
	 * DECLARE THE EXACT PREFIX YOUR TRANSLATOR USES. This option is a TRUSTED
	 * ASSERTION about the network. A parseable wrong length in EITHER direction
	 * can turn an address the guard would otherwise refuse into an allowed one: a
	 * shorter declaration reads prefix bits as the destination, while a longer
	 * declaration reads destination and suffix bits. The real length is not
	 * recoverable from the address text, and trying every length would restore the
	 * over-block this option exists to remove. A non-zero suffix proves some
	 * mismatches and is refused, but a clean suffix does not prove the declaration
	 * correct. Only an UNPARSEABLE value is safe by default - that one is ignored
	 * and every length is read.
	 *
	 * At `/96`, RFC 6052 also requires bits 64-71 of the prefix itself to be
	 * zero; a `/96` declaration that violates it refuses every destination in
	 * the range rather than none.
	 *
	 * @example
	 * isSafeUrl(url, { nat64Prefix: '64:ff9b::/96' });
	 */
	nat64Prefix?: string;
}

/**
 * Why a URL or address was rejected. Not every function produces every member:
 * `unresolved-host` is reported by `checkUrlResolved` when the resolver throws
 * or returns a non-address; `not-allowlisted` only in `allowlist` mode;
 * `not-an-ip` only by `classifyAddress` when handed a non-IP string.
 */
export type SafeUrlReason =
	| 'loopback'
	| 'rfc1918'
	| 'link-local'
	| 'metadata'
	| 'ula'
	| 'unspecified'
	| 'cgnat'
	| 'benchmark'
	| 'multicast'
	| 'reserved'
	| 'unresolved-host'
	| 'not-allowlisted'
	| 'bad-scheme'
	| 'parse-error'
	| 'not-an-ip';

export interface CheckUrlResult {
	safe: boolean;
	reason?: SafeUrlReason;
}

/**
 * Boolean SSRF gate. The zero-config default (`isSafeUrl(url)`) runs in
 * `strict` mode and never throws on a malformed URL - a URL that does not
 * parse returns `false`.
 *
 * @example
 * import { isSafeUrl } from 'svelte-adapter-uws/safe-url';
 *
 * if (!isSafeUrl(userWebhookUrl)) {
 *   throw new Error('Webhook URL is not allowed');
 * }
 */
export function isSafeUrl(url: string, options?: SafeUrlOptions): boolean;

/**
 * Validate a URL against the SSRF blocked ranges, returning the reason it
 * was rejected (or `{ safe: true }`). Pure and synchronous: classifies the
 * literal host. Pass a resolver to `checkUrlResolved` to also defend against
 * DNS rebinding.
 */
export function checkUrl(url: string, options?: SafeUrlOptions): CheckUrlResult;

/**
 * Classify a bare IP address literal against the SSRF blocked ranges - the
 * address-level companion to `checkUrl`, for a caller that already holds an
 * address (a resolved DNS result, a proxied forwarded-for hop) rather than a
 * full URL. Returns the blocked reason, or `null` when the input is a real,
 * public IP literal. Accepts every IPv4 encoding and bracketed or bare IPv6
 * (IPv4-mapped and the IPv4-embedding transition forms unwrap and re-check).
 *
 * `options` is consulted for `nat64Prefix` only, which applies to a bare address
 * exactly as it does to a URL - see `SafeUrlOptions.nat64Prefix`, including the
 * warning about declaring a prefix that does not match the network.
 *
 * SECURITY: `null` means "a real public IP literal" and nothing else. A DNS
 * name returns `'not-an-ip'` and a malformed literal returns `'parse-error'`,
 * so a hostname can never masquerade as a safe address - resolve a name first
 * (see `checkUrlResolved`), then classify the address.
 *
 * @example
 * import { classifyAddress } from 'svelte-adapter-uws/safe-url';
 *
 * classifyAddress('169.254.169.254'); // 'metadata'
 * classifyAddress('8.8.8.8');         // null (public)
 * classifyAddress('example.com');     // 'not-an-ip' (never null)
 */
export function classifyAddress(ip: string, options?: SafeUrlOptions): SafeUrlReason | null;

/**
 * Boolean address gate: `true` only when `ip` is a real, public IP literal -
 * the address-level companion to `isSafeUrl`. A private/loopback/metadata
 * address, a malformed literal, and a non-IP string (a DNS name) all return
 * `false`. Equivalent to `classifyAddress(ip) === null`. `options` is accepted
 * consulted for `nat64Prefix` only; the mode and allow-list posture is a URL-level
 * concern and is ignored here.
 */
export function isAddressSafe(ip: string, options?: SafeUrlOptions): boolean;

/**
 * DNS-rebinding closer. Runs the synchronous literal check first; if that
 * blocks, returns immediately. Otherwise, when the host is a DNS name and a
 * `resolve` function is supplied, resolves the name and re-checks every
 * resolved address against the SSRF ranges. A resolver that throws yields
 * `{ safe: false, reason: 'unresolved-host' }`. Without a resolver this is
 * identical to `checkUrl`. In `off` mode the resolver path is skipped, so the
 * range checks are bypassed for both IP literals and DNS names.
 */
export function checkUrlResolved(url: string, options?: SafeUrlOptions): Promise<CheckUrlResult>;
