import uWS from 'uWebSockets.js';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../env.js';
import { wsModule } from '../ws-handler-bridge.js';
import { parse_as_bytes, parse_origin } from '../utils.js';
import { monotonicNow } from '../runtime.js';
import { createTrustedProxyMatcher, createClientIpResolver } from '../utils/trusted-proxies.js';

export const textDecoder = new TextDecoder();

export const ssl_cert = env('SSL_CERT', '');

export const ssl_key = env('SSL_KEY', '');

export const is_tls = !!(ssl_cert && ssl_key);

/**
 * TLS certificate hot-reload. When SSL is configured the server watches the cert
 * directory and, on a renewed cert (certbot / cert-manager), swaps the SNI server
 * name in place so the fresh cert is served WITHOUT re-binding the listen socket
 * or dropping live connections. Default ON when SSL is set (zero-config renewal
 * "just works"); SSL_WATCH=0 opts out. A non-SNI / unmatched-SNI client keeps the
 * boot-time cert until a restart (the uWS default context is not hot-swappable).
 */
export const ssl_watch = is_tls && env('SSL_WATCH', '1') !== '0';

/** Debounce window (ms) coalescing a burst of cert-file writes into one reload. */
const _ssl_debounce_raw = parseInt(env('SSL_RELOAD_DEBOUNCE_MS', '500'), 10);
export const ssl_reload_debounce_ms = Number.isFinite(_ssl_debounce_raw) && _ssl_debounce_raw >= 0
	? _ssl_debounce_raw
	: 500;

/** Optional comma-separated SNI host override; empty = auto-discover from the cert SAN. */
export const ssl_sni_hosts = env('SSL_SNI_HOSTS', '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export const origin = parse_origin(env('ORIGIN', undefined));

export const xff_depth = parseInt(env('XFF_DEPTH', '1'), 10);

export const address_header = env('ADDRESS_HEADER', '').toLowerCase();

export const protocol_header = env('PROTOCOL_HEADER', '').toLowerCase();

export const host_header = env('HOST_HEADER', '').toLowerCase();

export const port_header = env('PORT_HEADER', '').toLowerCase();

export const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));

/**
 * Trusted-proxy allowlist (comma-separated IPs / CIDR ranges, IPv4 + IPv6).
 * When set, ADDRESS_HEADER and the PROXY-protocol address are honored ONLY
 * when the direct socket peer is in this set; a claim from any other peer is
 * ignored (the socket address is used) with a one-shot warning. Unset keeps
 * the historical trust-verbatim behavior byte-identical.
 */
export const trusted_proxies = createTrustedProxyMatcher(env('TRUSTED_PROXIES', ''));

/**
 * PROXY protocol v2 opt-in. When '1', a PP2 preamble's source address (parsed
 * natively by uWS) replaces the socket address as the effective client
 * address - gated on TRUSTED_PROXIES when that is set, because uWS accepts a
 * PP2 preamble from ANY peer, so an ungated deployment directly reachable by
 * clients would let them spoof their address the same way an ungated
 * ADDRESS_HEADER does.
 */
export const proxy_protocol = env('PROXY_PROTOCOL', '') === '1';

let warnedUntrustedClaim = false;
/** One-shot warning for an address claim arriving from an untrusted peer. */
export function warnUntrustedClaim(directIp, kind) {
	if (warnedUntrustedClaim) return;
	warnedUntrustedClaim = true;
	console.warn(
		`[adapter] Ignored a ${kind} client-address claim from untrusted peer ${directIp}: ` +
		'the peer is not in TRUSTED_PROXIES, so the socket address was used instead. ' +
		'If this peer is a legitimate proxy, add its address (or CIDR range) to TRUSTED_PROXIES.'
	);
}

/**
 * Graceful-shutdown reconnect dispersal window in ms. When > 0, `shutdown()`
 * advises every connected client to reconnect on a jittered schedule in
 * `[0, RECONNECT_DISPERSAL_MS)` before closing it, so a draining node's clients
 * scatter instead of all reconnecting in one backoff window and stampeding the
 * replacement. Default 5000 (zero-config gets the good behavior); 0 restores the
 * exact legacy shutdown (no advisory frame).
 */
const _reconnect_dispersal_raw = parseInt(env('RECONNECT_DISPERSAL_MS', '5000'), 10);
export const reconnect_dispersal_ms = Number.isFinite(_reconnect_dispersal_raw) && _reconnect_dispersal_raw >= 0
	? _reconnect_dispersal_raw
	: 5000;

/**
 * Resolve the real client IP from a raw socket address, applying the
 * configured proxy header when present - gated on TRUSTED_PROXIES when that
 * is set. Returns the raw IP on any error so rate limiting and userData
 * injection always get a usable string. The optional third argument is the
 * DIRECT socket peer (defaults to rawIp): header trust is decided on who
 * actually connected, never on a forwarded claim.
 * @type {(rawIp: string, headers: Record<string, string>, directIp?: string) => string}
 */
export const resolveClientIp = createClientIpResolver({
	addressHeader: address_header,
	xffDepth: xff_depth,
	matcher: trusted_proxies,
	onUntrusted: (directIp) => warnUntrustedClaim(directIp, `${address_header} header`)
});

/**
 * Decode the transport-level addresses for a request/upgrade: the direct
 * socket peer, and the effective client address after the optional PROXY
 * protocol v2 substitution (opt-in via PROXY_PROTOCOL=1, gated on
 * TRUSTED_PROXIES when set). The ADDRESS_HEADER resolution then applies on
 * top of `effective` via resolveClientIp, which composes the two proxy
 * layers: an LB speaking PP2 in front of an app proxy appending XFF.
 * @param {{ getRemoteAddressAsText(): ArrayBuffer, getProxiedRemoteAddressAsText(): ArrayBuffer }} res
 * @returns {{ direct: string, effective: string }}
 */
export function resolveTransportAddress(res) {
	const direct = textDecoder.decode(res.getRemoteAddressAsText());
	if (!proxy_protocol) return { direct, effective: direct };
	if (trusted_proxies && !trusted_proxies.match(direct)) {
		// Only warn when a preamble was actually present - an untrusted peer
		// without one is just a normal direct client.
		const claimed = textDecoder.decode(res.getProxiedRemoteAddressAsText());
		if (claimed) warnUntrustedClaim(direct, 'PROXY-protocol');
		return { direct, effective: direct };
	}
	const proxied = textDecoder.decode(res.getProxiedRemoteAddressAsText());
	return { direct, effective: proxied || direct };
}

export const _t_app = monotonicNow();

export const app = is_tls
	? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
	: uWS.App();

// Fingerprint of the certificate the SSLApp default context is SERVING,
// captured in the same tick as the app creation above. The TLS hot-reload's
// change gate must baseline against this, not against a later read: module
// eval continues for seconds on a real app (static cache indexing, SSR init),
// and a renewal completing in that window would otherwise be recorded as
// already-served and silently gated off forever - the server would sit on the
// old cert until it expired. Null when unreadable (uWS read the file a moment
// earlier, so this is near-impossible); a null baseline makes the first reload
// event bypass the gate and converge on the disk cert, which is the safe
// direction.
export const boot_cert_fingerprint = (() => {
	if (!is_tls) return null;
	try {
		return new X509Certificate(readFileSync(ssl_cert)).fingerprint256;
	} catch {
		return null;
	}
})();

// WS_DEBUG=1 enables per-event logging for subscribe/publish/open/close.
// Read once at module load so it is never sampled inside a hot callback.
export const wsDebug = WS_ENABLED && env('WS_DEBUG', '') === '1';

// Per-connection traffic counters are only populated when the user has
// wired a `close` hook - the only place they surface. Sampled once at
// module load so the bump helpers below early-return at near-zero cost
// when no hook is registered.
export const closeHookRegistered = WS_ENABLED && !!wsModule.close;

/**
 * Construct the origin from request headers.
 *
 * WARNING: PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER are trusted as-is.
 * Only use these behind a trusted reverse proxy that overwrites the headers.
 * Never expose them when the adapter is directly internet-facing.
 *
 * @param {Record<string, string>} headers
 * @returns {string}
 */
export function get_origin(headers) {
	// Default protocol matches the app type: 'https' for SSLApp, 'http' for App.
	const default_protocol = is_tls ? 'https' : 'http';
	const protocol = protocol_header
		? decodeURIComponent(headers[protocol_header] || default_protocol)
		: default_protocol;

	if (protocol !== 'http' && protocol !== 'https') {
		throw new Error(
			`The ${protocol_header} header specified '${protocol}' which is not a valid protocol. Only 'http' and 'https' are supported.`
		);
	}

	const host = (host_header && headers[host_header]) || headers['host'];
	if (!host) {
		throw new Error('Could not determine host. The request must have a host header.');
	}

	const port = port_header ? headers[port_header] : undefined;
	if (port && isNaN(+port)) {
		throw new Error(
			`The ${port_header} header specified ${port} which is an invalid port.`
		);
	}

	// Strip existing port from host before appending PORT_HEADER value
	// (the Host header often includes the port, e.g. "example.com:3000")
	const hostWithoutPort = port ? host.replace(/:\d+$/, '') : host;

	return port ? `${protocol}://${hostWithoutPort}:${port}` : `${protocol}://${host}`;
}

// Whether a WebSocket permessage-deflate compressor is configured (any non-DISABLED
// `websocket.compression`). Used by the platform publish/send methods to resolve
// the per-message `compress` flag: when this is false (the default), every send
// stays uncompressed exactly as before. Per-message compression is only ever
// requested when a compressor actually exists, because passing `compress: true`
// on a connection with no compressor is not free (measured in
// bench/ws-compression-cpu.mjs).
export const WS_COMPRESSION_ON = Boolean(WS_OPTIONS && WS_OPTIONS.compression);
