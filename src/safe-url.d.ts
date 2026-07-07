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
 * `metadata.google.internal`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`),
 * unspecified (`0.0.0.0/8`, `::`), IPv6 ULA (`fc00::/7`), IPv6 link-local
 * (`fe80::/10`), and IPv4-mapped/compatible IPv6 forms (unwrapped to the
 * embedded IPv4). Non-http(s) schemes are rejected in every mode.
 * IP-obfuscation evasions (decimal / octal / hex / short-form IPv4,
 * IPv4-mapped IPv6, userinfo smuggling, trailing-dot, case) are normalised
 * before matching.
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
 * (IPv4-mapped forms unwrap and re-check).
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
export function classifyAddress(ip: string): SafeUrlReason | null;

/**
 * Boolean address gate: `true` only when `ip` is a real, public IP literal -
 * the address-level companion to `isSafeUrl`. A private/loopback/metadata
 * address, a malformed literal, and a non-IP string (a DNS name) all return
 * `false`. Equivalent to `classifyAddress(ip) === null`. `options` is accepted
 * for symmetry with `isSafeUrl` and is reserved; the address check has no modes.
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
