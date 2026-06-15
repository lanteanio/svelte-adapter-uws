import uWS from 'uWebSockets.js';
import { env } from '../env.js';
import { wsModule } from '../ws-handler-bridge.js';
import { parse_as_bytes, parse_origin } from '../utils.js';
import { monotonicNow } from '../runtime.js';

export const textDecoder = new TextDecoder();

export const ssl_cert = env('SSL_CERT', '');

export const ssl_key = env('SSL_KEY', '');

export const is_tls = !!(ssl_cert && ssl_key);

export const origin = parse_origin(env('ORIGIN', undefined));

export const xff_depth = parseInt(env('XFF_DEPTH', '1'), 10);

export const address_header = env('ADDRESS_HEADER', '').toLowerCase();

export const protocol_header = env('PROTOCOL_HEADER', '').toLowerCase();

export const host_header = env('HOST_HEADER', '').toLowerCase();

export const port_header = env('PORT_HEADER', '').toLowerCase();

export const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));

/**
 * Resolve the real client IP from a raw socket address, applying the
 * configured proxy header when present. Returns the raw IP on any error
 * so rate limiting and userData injection always get a usable string.
 * @param {string} rawIp
 * @param {Record<string, string>} headers
 * @returns {string}
 */
export function resolveClientIp(rawIp, headers) {
	if (!address_header) return rawIp;
	const value = headers[address_header];
	if (!value) return rawIp;
	if (address_header === 'x-forwarded-for') {
		if (value.length > 8192) return rawIp;
		const addresses = value.split(',');
		if (xff_depth > addresses.length) return rawIp;
		return addresses[addresses.length - xff_depth].trim();
	}
	return value;
}

export const _t_app = monotonicNow();

export const app = is_tls
	? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
	: uWS.App();

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
