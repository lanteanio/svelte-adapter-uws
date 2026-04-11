import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { parentPort } from 'node:worker_threads';
import uWS from 'uWebSockets.js';
import { Server } from 'SERVER';
import { manifest, prerendered, base } from 'MANIFEST';
import { env } from 'ENV';
import * as wsModule from 'WS_HANDLER';
import { parseCookies } from './cookies.js';
import { mimeLookup, parse_as_bytes, parse_origin } from './utils.js';

/* global ENV_PREFIX */
/* global PRECOMPRESS */
/* global WS_ENABLED */
/* global WS_PATH */
/* global WS_OPTIONS */
/* global HEALTH_CHECK_PATH */

class PayloadTooLargeError extends Error {
	constructor() { super('Payload too large'); }
}

// Uppercase method lookup - avoids a string allocation from toUpperCase() per SSR request.
// uWS returns lowercase; the Request constructor expects uppercase.
const METHODS = /** @type {Record<string, string>} */ ({
	get: 'GET', head: 'HEAD', post: 'POST', put: 'PUT',
	delete: 'DELETE', patch: 'PATCH', options: 'OPTIONS'
});

// -- Error response helpers ---------------------------------------------------

/** @param {import('uWebSockets.js').HttpResponse} res */
function send400(res) {
	res.cork(() => {
		res.writeStatus('400 Bad Request');
		res.writeHeader('content-type', 'text/plain');
		res.end('Bad Request');
	});
}

/** @param {import('uWebSockets.js').HttpResponse} res */
function send413(res) {
	res.cork(() => {
		res.writeStatus('413 Content Too Large');
		res.writeHeader('content-type', 'text/plain');
		res.end('Content Too Large');
	});
}

/** @param {import('uWebSockets.js').HttpResponse} res */
function send500(res) {
	res.cork(() => {
		res.writeStatus('500 Internal Server Error');
		res.writeHeader('content-type', 'text/plain');
		res.end('Internal Server Error');
	});
}

// -- State object pool --------------------------------------------------------
// Avoids allocating { aborted: false } per SSR request. Objects survive to
// V8's old generation quickly and stay there, eliminating young-gen GC churn.

/** @type {{ aborted: boolean }[]} */
const statePool = [];
const STATE_POOL_MAX = 256;

function acquireState() {
	const s = statePool.pop();
	if (s) { s.aborted = false; return s; }
	return { aborted: false };
}

/** @param {{ aborted: boolean }} s */
function releaseState(s) {
	if (statePool.length < STATE_POOL_MAX) statePool.push(s);
}

/**
 * Safely quote a string for JSON embedding. Topics and events are
 * developer-defined identifiers  - a quote, backslash, or control character
 * is always a bug, so we throw instead of silently escaping.
 * @param {string} s
 * @returns {string} JSON-quoted string, e.g. '"todos"'
 */
function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

// Cache for pre-built envelope prefixes. Repeated publishes to the same
// topic+event (e.g. platform.topic('chat').created()) reuse the prefix
// instead of rebuilding it from 4 string concatenations each time.
const ENVELOPE_CACHE_MAX = 256;
/** @type {Map<string, string>} */
const envelopePrefixCache = new Map();

/**
 * Build or retrieve the JSON envelope prefix for a topic+event pair.
 * @param {string} topic
 * @param {string} event
 * @returns {string} e.g. '{"topic":"chat","event":"created","data":'
 */
function envelopePrefix(topic, event) {
	const key = topic + '\0' + event;
	let prefix = envelopePrefixCache.get(key);
	if (prefix === undefined) {
		prefix = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
		if (envelopePrefixCache.size >= ENVELOPE_CACHE_MAX) {
			envelopePrefixCache.delete(envelopePrefixCache.keys().next().value);
		}
		envelopePrefixCache.set(key, prefix);
	}
	return prefix;
}

// -- In-memory static file cache ---------------------------------------------

/**
 * @typedef {{
 *   buffer: Buffer,
 *   contentType: string,
 *   etag: string,
 *   headers: [string, string][],
 *   brBuffer?: Buffer,
 *   gzBuffer?: Buffer
 * }} StaticEntry
 */

/** @type {Map<string, StaticEntry>} */
const staticCache = new Map();

// File extensions that browsers cannot render inline. Serving these with
// Content-Disposition: attachment prompts a download dialog instead of
// showing a blank or error page.
const DOWNLOAD_EXTENSIONS = new Set([
	'.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
	'.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
	'.iso', '.img', '.bin'
]);

/**
 * Prerendered paths whose canonical URL has a trailing slash.
 * Detected from the filesystem: about/index.html means trailingSlash: 'always',
 * so /about should redirect to /about/ and /about/ is served directly.
 * @type {Set<string>}
 */
const prerenderedDirStyle = new Set();

const textDecoder = new TextDecoder();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Both values update together so the rate limiter and static handler share
// a single timer wakeup instead of two, and Date.now() is never called on
// the hot path for static file serving or per-upgrade rate checks.
let cachedNow = Date.now();
let cachedDateHeader = new Date(cachedNow).toUTCString();
setInterval(() => {
	cachedNow = Date.now();
	cachedDateHeader = new Date(cachedNow).toUTCString();
}, 1000).unref();

/**
 * Recursively walk a directory and call fn for each file.
 * @param {string} dir
 * @param {(relPath: string, absPath: string) => void} fn
 * @param {string} prefix
 */
function walk(dir, fn, prefix = '') {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir)) {
		const abs = path.join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (fs.statSync(abs).isDirectory()) {
			walk(abs, fn, rel);
		} else {
			fn(rel, abs);
		}
	}
}

/**
 * Load a directory into the static cache.
 * @param {string} dir
 * @param {string} urlPrefix
 * @param {boolean} immutable
 */
function cacheDir(dir, urlPrefix, immutable) {
	walk(dir, (relPath, absPath) => {
		if (relPath.endsWith('.br') || relPath.endsWith('.gz')) return;

		const urlPath = `${urlPrefix}/${relPath}`;
		const contentType = mimeLookup(relPath);
		const buffer = fs.readFileSync(absPath);
		const stat = fs.statSync(absPath);

		/** @type {[string, string][]} */
		const headers = [
			['x-content-type-options', 'nosniff'],
			['vary', 'Accept-Encoding'],
			['accept-ranges', 'bytes']
		];
		let etag = '';
		if (immutable && relPath.startsWith(`${manifest.appPath}/immutable/`)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
			headers.push(['cache-control', 'no-cache'], ['etag', etag]);
		}

		const ext = path.extname(relPath).toLowerCase();
		if (DOWNLOAD_EXTENSIONS.has(ext)) {
			const basename = path.basename(relPath);
			// Strip characters that are not allowed in a quoted Content-Disposition filename.
			const safe = basename.replace(/["\\]/g, '');
			headers.push(['content-disposition', `attachment; filename="${safe}"`]);
		}

		/** @type {StaticEntry} */
		const entry = { buffer, contentType, etag, headers };

		if (PRECOMPRESS) {
			const brPath = absPath + '.br';
			const gzPath = absPath + '.gz';
			if (fs.existsSync(brPath)) {
				const brBuf = fs.readFileSync(brPath);
				if (brBuf.byteLength < buffer.byteLength) entry.brBuffer = brBuf;
			}
			if (fs.existsSync(gzPath)) {
				const gzBuf = fs.readFileSync(gzPath);
				if (gzBuf.byteLength < buffer.byteLength) entry.gzBuffer = gzBuf;
			}
		}

		staticCache.set(urlPath, entry);

		// Prerendered pages: register clean pathname aliases for the static fast
		// path and tryPrerendered().
		//
		// SvelteKit writes directory-style output (about/index.html) when
		// trailingSlash is 'always', and file-style (about.html) otherwise.
		// builder.prerendered.paths always lists "/about" (no trailing slash).
		//
		// For directory-style pages we register the trailing-slash form in
		// staticCache (served on the fast path) and track the bare path in
		// prerenderedDirStyle so tryPrerendered() can redirect /about -> /about/.
		// For file-style pages we register the bare path (no trailing slash).
		if (!immutable) {
			if (relPath === 'index.html') {
				if (urlPrefix) {
					// Base root with non-empty base: /base/ is canonical
					staticCache.set(urlPrefix + '/', entry);
					prerenderedDirStyle.add(urlPrefix);
				} else {
					// Site root: / is already canonical
					staticCache.set('/', entry);
				}
			} else if (relPath.endsWith('/index.html')) {
				// Directory-style: trailing slash is canonical
				const cleanPath = `${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`;
				staticCache.set(cleanPath + '/', entry);
				prerenderedDirStyle.add(cleanPath);
			} else if (relPath.endsWith('.html')) {
				// File-style: bare path is canonical
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry);
			}
		}
	});
}

const clientDir = path.join(__dirname, 'client');
const prerenderedDir = path.join(__dirname, 'prerendered');

const _t_static = performance.now();
cacheDir(path.join(clientDir, base), base, true);
cacheDir(path.join(prerenderedDir, base), base, false);
console.log(`Static files indexed in ${(performance.now() - _t_static).toFixed(1)}ms (${staticCache.size} entries)`);

// -- TLS config (must be before origin warning) ------------------------------

const ssl_cert = env('SSL_CERT', '');
const ssl_key = env('SSL_KEY', '');
const is_tls = !!(ssl_cert && ssl_key);

if ((ssl_cert || ssl_key) && !is_tls) {
	throw new Error(
		'Incomplete TLS config: both SSL_CERT and SSL_KEY must be set.\n' +
		`  SSL_CERT: ${ssl_cert ? 'set' : 'missing'}\n` +
		`  SSL_KEY: ${ssl_key ? 'set' : 'missing'}`
	);
}

// -- SvelteKit Server --------------------------------------------------------

const origin = parse_origin(env('ORIGIN', undefined));
const xff_depth = parseInt(env('XFF_DEPTH', '1'), 10);
const address_header = env('ADDRESS_HEADER', '').toLowerCase();
const protocol_header = env('PROTOCOL_HEADER', '').toLowerCase();
const host_header = env('HOST_HEADER', '').toLowerCase();
const port_header = env('PORT_HEADER', '').toLowerCase();
const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));

if (isNaN(xff_depth) || xff_depth < 1) {
	throw new Error(
		`Invalid XFF_DEPTH: '${env('XFF_DEPTH', '1')}'. Must be a positive integer.`
	);
}

if (isNaN(body_size_limit)) {
	throw new Error(
		`Invalid BODY_SIZE_LIMIT: '${env('BODY_SIZE_LIMIT')}'. Please provide a numeric value.`
	);
}

if (!origin && !host_header && !protocol_header && !is_tls) {
	console.warn(
		'Warning: No ORIGIN, HOST_HEADER, or PROTOCOL_HEADER configured. ' +
		'The server will use http:// with the request Host header. ' +
		'For production, either:\n' +
		'  SSL_CERT + SSL_KEY for native TLS (no proxy needed)\n' +
		'  ORIGIN=https://example.com (behind a TLS proxy)\n' +
		'  PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)'
	);
}

/**
 * Resolve the real client IP from a raw socket address, applying the
 * configured proxy header when present. Returns the raw IP on any error
 * so rate limiting and userData injection always get a usable string.
 * @param {string} rawIp
 * @param {Record<string, string>} headers
 * @returns {string}
 */
function resolveClientIp(rawIp, headers) {
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

const asset_dir = `${__dirname}/client${base}`;

const _t_init = performance.now();
const server = new Server(manifest);
await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(`${asset_dir}/${file}`)))
});
console.log(`SvelteKit server initialized in ${(performance.now() - _t_init).toFixed(1)}ms`);

// -- uWS App -----------------------------------------------------------------

const _t_app = performance.now();
const app = is_tls
	? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
	: uWS.App();

// -- Cross-worker pub/sub relay (batched) ------------------------------------
// Batch postMessage calls within a single microtask. A SvelteKit action that
// publishes N events sends one structured-clone across the thread boundary
// instead of N. No-op in single-process mode (parentPort is null).

/** @type {Array<{topic: string, envelope: string}> | null} */
let relayBatch = null;

/**
 * @param {string} topic
 * @param {string} envelope
 */
function batchRelay(topic, envelope) {
	if (!relayBatch) {
		relayBatch = [];
		queueMicrotask(() => {
			if (relayBatch) {
				parentPort.postMessage({ type: 'publish-batch', messages: relayBatch });
			}
			relayBatch = null;
		});
	}
	relayBatch.push({ topic, envelope });
}

// -- Platform (exposed to SvelteKit via event.platform) ----------------------

/** @type {Set<import('uWebSockets.js').WebSocket<any>>} */
const wsConnections = new Set();

// WS_DEBUG=1 enables per-event logging for subscribe/publish/open/close.
// Read once at module load so it is never sampled inside a hot callback.
const wsDebug = WS_ENABLED && env('WS_DEBUG', '') === '1';

/** @type {import('./index.js').Platform} */
const platform = {
	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 * Auto-wraps in a { topic, event, data } envelope that the client store understands.
	 * No-op if no clients are subscribed - safe to call unconditionally.
	 */
	publish(topic, event, data, options) {
		const envelope = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		const result = app.publish(topic, envelope, false, false);
		// Relay to other workers via main thread (no-op in single-process mode).
		// Pass { relay: false } when the message originates from an external
		// pub/sub source (Redis, Postgres, etc.) that already fans out to
		// every process -- relaying would cause duplicate delivery.
		const relayed = !!(parentPort && (!options || options.relay !== false));
		if (relayed) {
			batchRelay(topic, envelope);
		}
		if (wsDebug) {
			console.log('[ws] publish topic=%s event=%s bytes=%d delivered=%s',
				topic, event, envelope.length, result || relayed);
		}
		// In clustered mode, subscribers may be on other workers. Return true
		// when the relay fires even if the local worker has no subscribers,
		// because callers cannot query cross-worker subscriber counts.
		return result || relayed;
	},

	/**
	 * Send a message to a single WebSocket connection.
	 * Wraps in the same { topic, event, data } envelope as publish().
	 */
	send(ws, topic, event, data) {
		return ws.send(envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}', false, false);
	},

	/**
	 * Send a message to connections matching a filter.
	 * The filter receives each connection's userData (from the upgrade handler).
	 * Returns the number of connections the message was sent to.
	 */
	sendTo(filter, topic, event, data) {
		const envelope = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		let count = 0;
		for (const ws of wsConnections) {
			if (filter(ws.getUserData())) {
				ws.send(envelope, false, false);
				count++;
			}
		}
		return count;
	},

	/**
	 * Number of active WebSocket connections.
	 */
	get connections() {
		return wsConnections.size;
	},

	/**
	 * Number of clients subscribed to a specific topic.
	 */
	subscribers(topic) {
		return app.numSubscribers(topic);
	},

	/**
	 * Publish multiple messages in one call.
	 * Equivalent to calling publish() for each message, but the cross-worker
	 * relay sends one postMessage per microtask regardless of how many
	 * messages are in the batch (batching is always active for individual
	 * publish() calls too  - this method is purely a convenience).
	 * @param {{ topic: string, event: string, data?: unknown }[]} messages
	 * @returns {boolean[]} publish result for each message (false = no subscribers)
	 */
	batch(messages) {
		const results = [];
		for (let i = 0; i < messages.length; i++) {
			const { topic, event, data } = messages[i];
			results.push(platform.publish(topic, event, data));
		}
		return results;
	},

	/**
	 * Get a scoped helper for a topic - less repetition when publishing
	 * multiple events to the same topic.
	 */
	topic(name) {
		return {
			publish: (/** @type {string} */ event, /** @type {unknown} */ data) => {
				platform.publish(name, event, data);
			},
			created: (/** @type {unknown} */ data) => platform.publish(name, 'created', data),
			updated: (/** @type {unknown} */ data) => platform.publish(name, 'updated', data),
			deleted: (/** @type {unknown} */ data) => platform.publish(name, 'deleted', data),
			set: (/** @type {number} */ value) => platform.publish(name, 'set', value),
			increment: (/** @type {number} */ amount = 1) => platform.publish(name, 'increment', amount),
			decrement: (/** @type {number} */ amount = 1) => platform.publish(name, 'decrement', amount)
		};
	}
};

// -- Origin construction -----------------------------------------------------

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
function get_origin(headers) {
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

// -- SSR request deduplication -----------------------------------------------
// When multiple concurrent anonymous GET/HEAD requests arrive for the same URL,
// only one is dispatched to SvelteKit. The rest await the result and reconstruct
// their own Response from the shared buffer. This eliminates redundant SSR work
// during traffic spikes on public (non-personalized) pages.

// Maximum number of in-flight dedup keys tracked simultaneously.
const MAX_SSR_DEDUP = 500;
// Maximum response body size (bytes) that may be shared across waiters.
// Responses larger than this are not shared  - each waiter makes its own call.
const MAX_SSR_DEDUP_BODY = 512 * 1024; // 512 KB

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array }} SharedResponse
 */

/**
 * In-flight SSR dedup map. Key is "<METHOD>\0<URL>".
 * Value is a Promise that resolves to a SharedResponse (shareable) or null (not shareable).
 * @type {Map<string, Promise<SharedResponse | null>>}
 */
const ssrInflight = new Map();

// -- Body reading ------------------------------------------------------------

// When Content-Length is known and fits in this threshold, pre-allocate
// a single Buffer and fill it as chunks arrive instead of creating a
// separate Buffer per chunk. Reduces GC pressure for typical form/JSON bodies.
const SMALL_BODY_THRESHOLD = 65536; // 64 KB

// Dynamic response compression: only compress text content types above a threshold.
// Static files use build-time precompression and are never affected by this.
const COMPRESS_MIN_SIZE = 1024;
const COMPRESSIBLE_TYPES = new Set([
	'text/html', 'text/css', 'text/plain', 'text/xml', 'text/javascript',
	'text/csv', 'text/markdown',
	'application/json', 'application/xml', 'application/javascript',
	'application/xhtml+xml', 'application/ld+json', 'application/manifest+json',
	'application/rss+xml', 'application/atom+xml',
	'image/svg+xml'
]);

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {number} limit
 * @param {{ aborted: boolean }} state - Shared abort flag from request handler
 * @param {number} [contentLength] - Known Content-Length (NaN if unknown)
 * @returns {ReadableStream<Uint8Array>}
 */
function readBody(res, limit, state, contentLength) {
	// Fast path: pre-allocate one buffer when size is known and small.
	// Eliminates N allocations for chunked bodies  - one allocation + in-place fills.
	const usePrealloc = contentLength >= 0 && contentLength <= SMALL_BODY_THRESHOLD &&
		(limit === Infinity || contentLength <= limit);

	let initialized = false;
	return new ReadableStream({
		start(controller) {
			if (state.aborted) {
				controller.error(new Error('Request aborted'));
				return;
			}
		},
		pull(controller) {
			if (state.aborted) {
				try { controller.error(new Error('Request aborted')); } catch { /* already closed */ }
				return;
			}
			// Lazy: only register res.onData() when SvelteKit actually reads
			// the body. For redirects / actions that ignore the body, this
			// avoids the onData registration + per-chunk copy entirely.
			if (initialized) return;
			initialized = true;

			if (usePrealloc) {
				const buf = Buffer.allocUnsafe(contentLength);
				let offset = 0;
				let done = false;
				res.onData((chunk, isLast) => {
					if (done || state.aborted) return;
					const view = new Uint8Array(chunk);
					if (offset + view.byteLength > buf.byteLength) {
						// Body exceeded Content-Length - treat as too large
						done = true;
						controller.error(new PayloadTooLargeError());
						return;
					}
					// Zero-copy fill into pre-allocated buffer (no new Buffer per chunk)
					buf.set(view, offset);
					offset += view.byteLength;
					if (isLast) {
						done = true;
						controller.enqueue(buf.subarray(0, offset));
						controller.close();
					}
				});
				return;
			}

			let size = 0;
			let done = false;
			res.onData((chunk, isLast) => {
				if (done || state.aborted) return;
				// MUST copy - uWS reuses the ArrayBuffer after callback returns
				const copy = Buffer.from(new Uint8Array(chunk));
				size += copy.byteLength;
				if (limit !== Infinity && size > limit) {
					done = true;
					controller.error(new PayloadTooLargeError());
					return;
				}
				controller.enqueue(copy);
				if (isLast) {
					done = true;
					controller.close();
				}
			});
		}
	});
}

// -- Static file serving -----------------------------------------------------

/**
 * Parse an HTTP Range header value for a single byte range.
 * Returns { start, end } (both inclusive) or null when the range is absent,
 * malformed, multi-range, or would be unsatisfiable for the given file size.
 *
 * @param {string} header - Value of the Range header (e.g. "bytes=0-499")
 * @param {number} fileSize - Total number of bytes in the file
 * @returns {{ start: number, end: number } | null}
 */
// parseRange returns:
//   { start, end } - valid range, serve 206
//   null           - syntactically valid but unsatisfiable (start >= fileSize), send 416
//   false          - syntactically invalid, ignore the header and serve full 200
function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	// Multi-range (comma-separated)  - not supported; serve full content instead
	if (spec.includes(',')) return false;

	const dash = spec.indexOf('-');
	if (dash < 0) return false;

	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);

	// Reject tokens with non-digit characters (e.g. "1oops"). RFC 7233 requires
	// range values to be pure integers (1*DIGIT grammar production).
	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;

	let start, end;
	if (rawStart === '') {
		// Suffix range: bytes=-N (last N bytes)
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return false;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			// Open-ended: bytes=N- (from N to EOF)
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}

	if (start >= fileSize) return null; // Syntactically valid but unsatisfiable
	end = Math.min(end, fileSize - 1);
	return { start, end };
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {StaticEntry} entry
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 */
function serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '') {
	if (entry.etag && ifNoneMatch === entry.etag) {
		res.cork(() => {
			res.writeStatus('304 Not Modified').end();
		});
		return;
	}

	// Range requests are only valid for files with an ETag (mutable assets).
	// Immutable versioned assets (_app/immutable/*) never need range requests.
	// When a Range header is present we always serve the uncompressed bytes so
	// the client gets the correct byte offsets (range + content-encoding don't mix).
	if (rangeHeader && entry.etag) {
		// If-Range: only honour Range if the client's cached ETag matches
		if (!ifRangeHeader || ifRangeHeader === entry.etag) {
			// Multi-range (bytes=0-499,600-700) is not supported. RFC 7233 allows
			// servers to ignore multiple ranges and respond with the full entity.
			if (!rangeHeader.includes(',')) {
				const range = parseRange(rangeHeader, entry.buffer.byteLength);
				if (range === null) {
					// Syntactically valid but start position is beyond EOF
					res.cork(() => {
						res.writeStatus('416 Range Not Satisfiable');
						res.writeHeader('content-range', `bytes */${entry.buffer.byteLength}`);
						res.end();
					});
					return;
				}
				if (range !== false) {
					// Valid range - serve partial content
					const slice = entry.buffer.subarray(range.start, range.end + 1);
					res.cork(() => {
						res.writeStatus('206 Partial Content');
						res.writeHeader('content-type', entry.contentType);
						res.writeHeader('content-range', `bytes ${range.start}-${range.end}/${entry.buffer.byteLength}`);
						res.writeHeader('date', cachedDateHeader);
						for (let i = 0; i < entry.headers.length; i++) {
							res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
						}
						if (headOnly) res.endWithoutBody(slice.byteLength);
						else res.end(slice);
					});
					return;
				}
				// range === false: syntactically invalid - fall through to full 200
			}
			// Multi-range or invalid range  - fall through to full 200 response
		}
		// If-Range mismatch  - fall through to full 200 response
	}

	res.cork(() => {
		let body = entry.buffer;
		if (entry.brBuffer && acceptEncoding.includes('br')) {
			res.writeHeader('content-encoding', 'br');
			body = entry.brBuffer;
		} else if (entry.gzBuffer && acceptEncoding.includes('gzip')) {
			res.writeHeader('content-encoding', 'gzip');
			body = entry.gzBuffer;
		}

		res.writeStatus('200 OK');
		res.writeHeader('content-type', entry.contentType);
		res.writeHeader('date', cachedDateHeader);
		// Pre-computed [key, value] tuples - no Object.entries() allocation per request
		for (let i = 0; i < entry.headers.length; i++) {
			res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
		}
		if (headOnly) {
			res.endWithoutBody(body.byteLength);
		} else {
			res.end(body);
		}
	});
}

// -- Prerendered page check --------------------------------------------------

// Bounded cache for decoded URI pathnames. Avoids repeated decodeURIComponent
// calls for the same encoded path. Uses Map insertion order for LRU eviction.
const DECODE_CACHE_MAX = 256;
/** @type {Map<string, string | null>} null = decode error */
const decodeCache = new Map();

/**
 * Decode a URI-encoded pathname, returning a cached result when available.
 * Returns null if the pathname is malformed (invalid percent-encoding).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePath(pathname) {
	if (!pathname.includes('%')) return pathname;
	let result = decodeCache.get(pathname);
	if (result !== undefined) return result;
	try {
		result = decodeURIComponent(pathname);
	} catch {
		result = null;
	}
	if (decodeCache.size >= DECODE_CACHE_MAX) {
		decodeCache.delete(decodeCache.keys().next().value);
	}
	decodeCache.set(pathname, result);
	return result;
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} pathname
 * @param {string} search
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 * @returns {boolean}
 */
function tryPrerendered(res, pathname, search, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '') {
	const decoded = decodePath(pathname);
	if (decoded === null) {
		send400(res);
		return true;
	}

	if (prerendered.has(decoded)) {
		// Directory-style page: bare path is not canonical, redirect to trailing slash
		if (prerenderedDirStyle.has(decoded)) {
			const location = decoded + '/' + search;
			res.cork(() => {
				res.writeStatus('308 Permanent Redirect');
				res.writeHeader('location', location);
				res.end();
			});
			return true;
		}
		const entry = staticCache.get(decoded);
		if (entry) {
			serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader);
			return true;
		}
	}

	// Check the alternate trailing-slash form
	const alt = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded + '/';
	if (prerendered.has(alt)) {
		// Request has trailing slash, prerendered path doesn't - if the prerendered
		// path is directory-style, the trailing-slash form is canonical: serve it
		if (prerenderedDirStyle.has(alt) && decoded.endsWith('/')) {
			const entry = staticCache.get(decoded);
			if (entry) {
				serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader);
				return true;
			}
		}
		// Otherwise redirect to the prerendered path (the canonical form)
		const location = alt + search;
		res.cork(() => {
			res.writeStatus('308 Permanent Redirect');
			res.writeHeader('location', location);
			res.end();
		});
		return true;
	}

	return false;
}

// -- SSR handler -------------------------------------------------------------

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} remoteAddress - Client IP address
 * @param {{ aborted: boolean }} state
 */
async function handleSSR(res, method, url, headers, remoteAddress, state) {
	try {
		const base_origin = origin || get_origin(headers);

		// Parse Content-Length once for both the 413 check and the small-body
		// pre-allocation hint. Keep NaN when the header is absent or non-numeric.
		let contentLengthHint = NaN;
		if (method !== 'GET' && method !== 'HEAD') {
			const cl = parseInt(headers['content-length'], 10);
			if (!isNaN(cl)) {
				if (body_size_limit !== Infinity && cl > body_size_limit) {
					send413(res);
					return;
				}
				contentLengthHint = cl;
			}
		}

		const body =
			method === 'GET' || method === 'HEAD'
				? undefined
				: readBody(res, body_size_limit, state, contentLengthHint);

		const request = new Request(base_origin + url, {
			method,
			headers,
			body,
			// @ts-expect-error
			duplex: 'half'
		});

		// Branch at definition time on the module-level constant address_header.
		// In the common case (no proxy), the closure captures only remoteAddress
		// and V8 sees a trivially-inlinable one-liner. When address_header IS set,
		// the closure captures the full set of proxy variables.
		const getClientAddress = address_header
			? () => {
				if (!(address_header in headers)) {
					throw new Error(
						`Address header was specified with ${ENV_PREFIX + 'ADDRESS_HEADER'}=${address_header} but is absent from request`
					);
				}

				const value = headers[address_header] || '';

				if (address_header === 'x-forwarded-for') {
					// Reject absurdly long XFF headers (max ~8KB)
					if (value.length > 8192) {
						throw new Error('X-Forwarded-For header too large');
					}
					const addresses = value.split(',');

					if (xff_depth > addresses.length) {
						throw new Error(
							`${ENV_PREFIX + 'XFF_DEPTH'} is ${xff_depth}, but only found ${addresses.length} addresses`
						);
					}
					return addresses[addresses.length - xff_depth].trim();
				}

				return value;
			}
			: () => remoteAddress;

		// Dedup: for anonymous GET/HEAD requests that arrive concurrently for the
		// same URL, only the first (the leader) calls server.respond(). Subsequent
		// requests (waiters) await the leader's promise and reconstruct a Response
		// from the shared buffer. This prevents redundant SSR work during traffic
		// spikes on public pages.
		//
		// Dedup is skipped for:
		//   - Non-GET/HEAD methods (mutations must not be coalesced)
		//   - Authenticated requests (cookie or authorization header present)
		//   - Requests opting out via x-no-dedup: 1
		//   - When the dedup map is at capacity (safety valve)
		const canDedup =
			(method === 'GET' || method === 'HEAD') &&
			!headers.cookie &&
			!headers.authorization &&
			!headers['x-no-dedup'] &&
			ssrInflight.size < MAX_SSR_DEDUP;

		if (canDedup) {
			const dedupKey = method + '\0' + url;
			const existing = ssrInflight.get(dedupKey);

			if (existing) {
				// Waiter: await the leader's result
				const shared = await existing;
				if (state.aborted) return;
				if (shared) {
					// Reconstruct a fresh Response from the shared buffer (zero-copy view)
					await writeResponse(
						res,
						new Response(shared.body, {
							status: shared.status,
							statusText: shared.statusText,
							headers: shared.headers
						}),
						state,
						headers['accept-encoding']
					);
					return;
				}
				// Leader marked this non-shareable  - fall through to our own call
			} else {
				// Leader: register the promise before any await so waiters attach to it
				let resolveShared;
				const sharedPromise = /** @type {Promise<SharedResponse | null>} */ (
					new Promise((r) => { resolveShared = r; })
				);
				ssrInflight.set(dedupKey, sharedPromise);
				// Always remove when settled, even on throw
				sharedPromise.finally(() => ssrInflight.delete(dedupKey));

				try {
					const response = await server.respond(request, { platform, getClientAddress });
					if (state.aborted) { resolveShared(null); return; }

					// Responses with Set-Cookie must not be shared (they're personalized).
					// Responses that declare Vary on anything other than Accept-Encoding
					// are personalized by some other request header (Accept-Language,
					// geo, feature flags, tenant, etc.)  - sharing would serve the
					// leader's content to waiters that may legitimately differ.
					if (response.headers.has('set-cookie') || !response.body) {
						resolveShared(null);
						await writeResponse(res, response, state, headers['accept-encoding']);
						return;
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							await writeResponse(res, response, state, headers['accept-encoding']);
							return;
						}
					}

					// Buffer the body. Responses above the size cap are not shared.
					const ab = await response.arrayBuffer();
					if (state.aborted) { resolveShared(null); return; }

					const shared = ab.byteLength <= MAX_SSR_DEDUP_BODY
						? /** @type {SharedResponse} */ ({
							status: response.status,
							statusText: response.statusText,
							headers: /** @type {[string, string][]} */ ([...response.headers]),
							body: new Uint8Array(ab)
						})
						: null;

					resolveShared(shared);

					// Serve the leader's own response from the same buffer
					await writeResponse(
						res,
						new Response(ab, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers
						}),
						state,
						headers['accept-encoding']
					);
				} catch (err) {
					resolveShared(null);
					throw err;
				}
				return;
			}
		}

		// Normal (non-dedup) path
		const response = await server.respond(request, { platform, getClientAddress });
		if (state.aborted) return;
		await writeResponse(res, response, state, headers['accept-encoding']);
	} catch (err) {
		if (state.aborted) return;
		if (err instanceof PayloadTooLargeError) {
			send413(res);
			return;
		}
		console.error('SSR error:', err);
		if (!state.aborted) send500(res);
	}
}

// -- Response writer (with backpressure) -------------------------------------

/**
 * Write response headers inside a cork.
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {Response} response
 */
function writeHeaders(res, response) {
	res.writeStatus(String(response.status));
	for (const [key, value] of response.headers) {
		if (key === 'set-cookie' || key === 'content-length') continue;
		res.writeHeader(key, value);
	}
	for (const cookie of response.headers.getSetCookie()) {
		res.writeHeader('set-cookie', cookie);
	}
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean }} state
 * @param {string} [acceptEncoding]
 */
async function writeResponse(res, response, state, acceptEncoding) {
	// No body - write headers + end in a single cork (one syscall).
	// For HEAD responses SvelteKit sets Content-Length to the full body size;
	// pass it to endWithoutBody() so the client knows the entity size.
	if (!response.body) {
		if (state.aborted) return;
		const cl = response.headers.get('content-length');
		res.cork(() => {
			writeHeaders(res, response);
			if (cl) res.endWithoutBody(parseInt(cl, 10));
			else res.endWithoutBody(0);
		});
		return;
	}

	if (response.body.locked) {
		if (state.aborted) return;
		res.cork(() => {
			res.writeStatus('500 Internal Server Error');
			res.writeHeader('content-type', 'text/plain');
			res.end(
				'Fatal error: Response body is locked. ' +
					"This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
			);
		});
		return;
	}

	const reader = response.body.getReader();
	let streaming = false;
	let streamTimedOut = false;
	try {
		// Read first chunk - if it's also the last, write headers + body in one cork
		const first = await reader.read();
		if (first.done || state.aborted) {
			if (!state.aborted) res.cork(() => { writeHeaders(res, response); res.end(); });
			return;
		}

		const second = await reader.read();
		if (second.done || state.aborted) {
			// Single-chunk response (common for SSR) - one cork, one syscall
			if (!state.aborted) {
				let body = first.value;
				let encoding = '';
				if (acceptEncoding && body.byteLength >= COMPRESS_MIN_SIZE &&
					!response.headers.has('content-encoding')) {
					const ctRaw = response.headers.get('content-type') || '';
					const semi = ctRaw.indexOf(';');
					const ct = semi === -1 ? ctRaw : ctRaw.slice(0, semi).trimEnd();
					if (COMPRESSIBLE_TYPES.has(ct)) {
						const useBr = acceptEncoding.includes('br');
						const useGz = !useBr && acceptEncoding.includes('gzip');
						if (useBr || useGz) {
							const compressed = useBr
								? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
								: gzipSync(body, { level: 6 });
							if (compressed.byteLength < body.byteLength) {
								body = compressed;
								encoding = useBr ? 'br' : 'gzip';
							}
						}
					}
				}
				res.cork(() => {
					writeHeaders(res, response);
					if (encoding) {
						res.writeHeader('content-encoding', encoding);
						res.writeHeader('vary', 'Accept-Encoding');
					}
					res.end(body);
				});
			}
			return;
		}

		// Multi-chunk streaming response - write headers + first two chunks in one cork.
		// cork() batches these writes into a single syscall, so backpressure from
		// individual res.write() calls inside cork is not actionable  - the data is
		// buffered and flushed together when cork returns. The backpressure loop
		// below handles all subsequent chunks.
		if (state.aborted) return;
		streaming = true;
		res.cork(() => {
			writeHeaders(res, response);
			res.write(first.value);
			res.write(second.value);
		});

		// Stream remaining chunks with backpressure (30s timeout per drain)
		for (;;) {
			const { done, value } = await reader.read();
			if (done || state.aborted) break;

			const ok = res.write(value);
			if (!ok) {
				const drained = await new Promise((resolve) => {
					const timer = setTimeout(() => resolve(false), 30000);
					res.onWritable(() => { clearTimeout(timer); resolve(true); return true; });
				});
				if (!drained) { streamTimedOut = true; break; }
				if (state.aborted) break;
			}
		}
	} finally {
		if (streaming && !state.aborted) {
			if (streamTimedOut) {
				// Backpressure drained past the 30s deadline. Abruptly close the
				// connection rather than sending a clean EOF on a partial body,
				// which would look like a successful but truncated response.
				res.close();
			} else {
				res.cork(() => res.end());
			}
		}
		reader.cancel().catch(() => {});
	}
}

// -- Main request handler ----------------------------------------------------

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {import('uWebSockets.js').HttpRequest} req
 */
function handleRequest(res, req) {
	// === SYNCHRONOUS PHASE ===
	// uWS HttpRequest is stack-allocated - MUST read everything before any await.
	// uWS returns lowercase method; we use lowercase comparisons on the fast path
	// and only the METHODS lookup for SSR where the Request constructor expects it.
	const method = req.getMethod();
	const pathname = req.getUrl();

	// === STATIC FILE FAST PATH ===
	// Minimum work: 1 Map lookup + 4 header reads. No header collection,
	// no query string handling, no remoteAddress decode.
	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'get' || method === 'head')) {
		return serveStatic(
			res, staticFile,
			req.getHeader('accept-encoding'),
			req.getHeader('if-none-match'),
			method === 'head',
			req.getHeader('range'),
			req.getHeader('if-range')
		);
	}

	// Windows: reject paths with : (Alternate Data Streams) or ~ (8.3 short names)
	if (process.platform === 'win32' && (pathname.includes(':') || pathname.includes('~'))) {
		return send400(res);
	}

	// Build full URL only for SSR - static files never reach here
	const query = req.getQuery();
	const METHOD = METHODS[method] || method.toUpperCase();

	// === PRERENDERED CHECK ===
	// Lightweight: only 4 header reads, no full collection, no remoteAddress decode
	if (METHOD === 'GET' || METHOD === 'HEAD') {
		if (tryPrerendered(res, pathname, query ? `?${query}` : '',
			req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD',
			req.getHeader('range'), req.getHeader('if-range'))) {
			return;
		}
	}

	const url = query ? `${pathname}?${query}` : pathname;

	// Full header collection - only for SSR paths
	/** @type {Record<string, string>} */
	const headers = {};
	req.forEach((key, value) => {
		headers[key] = value;
	});

	// Decode remote address eagerly - uWS may reuse the underlying buffer
	const remoteAddress = textDecoder.decode(res.getRemoteAddressAsText());

	// Set onAborted BEFORE any async work (mandatory uWS pattern).
	// No AbortController here - readBody uses the state flag directly,
	// avoiding 4-5 object allocations (controller + signal + event target)
	// on every request. GET/HEAD requests (majority of traffic) never
	// need an AbortController at all.
	const state = acquireState();
	res.onAborted(() => {
		state.aborted = true;
	});

	// === ASYNC PHASE: SSR ===
	inFlightCount++;
	handleSSR(res, METHOD, url, headers, remoteAddress, state)
		.finally(() => { releaseState(state); requestDone(); });
}

// -- WebSocket support -------------------------------------------------------

// WS_ENABLED is set by the adapter at build time - no inference from exports needed
if (WS_ENABLED) {
	// Warn about unrecognized exports - catches typos like "mesage" or "opn"
	const knownWsExports = new Set(['open', 'message', 'upgrade', 'close', 'drain', 'subscribe', 'unsubscribe']);
	for (const name of Object.keys(wsModule)) {
		if (!knownWsExports.has(name)) {
			console.warn(
				`Warning: WebSocket handler exports unknown "${name}". ` +
				`Did you mean one of: ${[...knownWsExports].join(', ')}?`
			);
		}
	}

	const wsOptions = WS_OPTIONS;
	const allowedOrigins = wsOptions.allowedOrigins || 'same-origin';

	// Keys that suggest sensitive data being stored in userData.
	// userData is accessible to every server-side handler via ws.getUserData(),
	// so storing raw credentials there is a footgun.
	const SENSITIVE_KEY_PATTERNS = ['token', 'secret', 'password', 'key', 'session', 'credential'];
	/** @type {Set<string>} warned key names - suppress duplicate warnings across connections */
	const warnedUserDataKeys = new Set();

	// Per-IP upgrade rate limiter (configurable, 0 = disabled)
	const UPGRADE_MAX_PER_WINDOW = wsOptions.upgradeRateLimit ?? 10;
	const UPGRADE_WINDOW_MS = (wsOptions.upgradeRateLimitWindow ?? 10) * 1000;
	// Maximum number of IP entries to retain in the rate map under sustained DDoS.
	// Excess entries are evicted by lowest activity score during the 60s sweep.
	const MAX_RATE_ENTRIES = 10000;
	/** @type {Map<string, { prev: number, curr: number, windowStart: number }>} */
	const upgradeRateMap = new Map();

	// Single 60-second interval for all periodic cache maintenance.
	// Keeps timer overhead to one wakeup per minute regardless of how many
	// caches exist. Add future periodic tasks here rather than creating
	// additional intervals.
	setInterval(() => {
		// 1. Purge rate-limit entries whose entire two-window history has expired,
		//    then evict the least active entries if the map exceeds the cap.
		//    Two windows must elapse with no activity before an entry is stale  -
		//    after one window the previous slot still contributes to the estimate.
		if (UPGRADE_MAX_PER_WINDOW > 0) {
			const now = cachedNow;
			for (const [ip, entry] of upgradeRateMap) {
				if (now - entry.windowStart >= 2 * UPGRADE_WINDOW_MS) upgradeRateMap.delete(ip);
			}
			if (upgradeRateMap.size > MAX_RATE_ENTRIES) {
				const sorted = [...upgradeRateMap.entries()].sort(
					(a, b) => (a[1].prev + a[1].curr) - (b[1].prev + b[1].curr)
				);
				const excess = upgradeRateMap.size - MAX_RATE_ENTRIES;
				for (let i = 0; i < excess; i++) upgradeRateMap.delete(sorted[i][0]);
			}
		}
		// 2. Trim module-level LRU caches if they are full. When a cache is at
		//    capacity it evicts one entry per insertion, but traffic patterns can
		//    shift and leave the cache full of stale entries. Clearing the oldest
		//    half every 60 s lets hot entries reclaim the freed slots.
		if (decodeCache.size >= DECODE_CACHE_MAX) {
			let i = 0;
			for (const k of decodeCache.keys()) {
				if (i++ >= DECODE_CACHE_MAX / 2) break;
				decodeCache.delete(k);
			}
		}
		if (envelopePrefixCache.size >= ENVELOPE_CACHE_MAX) {
			let i = 0;
			for (const k of envelopePrefixCache.keys()) {
				if (i++ >= ENVELOPE_CACHE_MAX / 2) break;
				envelopePrefixCache.delete(k);
			}
		}
	}, 60000).unref();

	app.ws(WS_PATH, {
		// Handle HTTP -> WebSocket upgrade with user-provided auth
		upgrade: (res, req, context) => {
			// Read everything synchronously - uWS req is stack-allocated
			/** @type {Record<string, string>} */
			const headers = {};
			req.forEach((key, value) => {
				headers[key] = value;
			});
			// Decode the client IP once. resolveClientIp applies the configured
			// proxy header (ADDRESS_HEADER / XFF_DEPTH) so rate limiting keys
			// on the real client address, not the proxy address.
			const clientIp = resolveClientIp(textDecoder.decode(res.getRemoteAddressAsText()), headers);

			// Rate limit upgrade requests per IP using a sliding window (0 = disabled).
			// Sliding window prevents a client from doubling their effective rate by
			// placing requests at the boundary between two fixed windows.
			if (UPGRADE_MAX_PER_WINDOW > 0) {
				const now = cachedNow;
				let rateEntry = upgradeRateMap.get(clientIp);
				if (!rateEntry) {
					rateEntry = { prev: 0, curr: 0, windowStart: now };
					upgradeRateMap.set(clientIp, rateEntry);
				} else {
					const elapsed = now - rateEntry.windowStart;
					if (elapsed >= 2 * UPGRADE_WINDOW_MS) {
						rateEntry.prev = 0;
						rateEntry.curr = 0;
						rateEntry.windowStart = now;
					} else if (elapsed >= UPGRADE_WINDOW_MS) {
						rateEntry.prev = rateEntry.curr;
						rateEntry.curr = 0;
						rateEntry.windowStart = now;
					}
				}
				// Sliding estimate: the previous window's count fades out linearly as
				// the current window progresses. At 0% elapsed, prev counts fully.
				// At 100% elapsed, prev contributes nothing and we rotate next time.
				const elapsed = now - rateEntry.windowStart;
				const estimate = rateEntry.prev * (1 - elapsed / UPGRADE_WINDOW_MS) + rateEntry.curr;
				if (estimate >= UPGRADE_MAX_PER_WINDOW) {
					res.cork(() => {
						res.writeStatus('429 Too Many Requests');
						res.writeHeader('content-type', 'text/plain');
						res.end('Too many upgrade requests');
					});
					return;
				}
				rateEntry.curr++;
			}

			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');

			// Origin validation - reject cross-origin WebSocket connections.
			// Requests without an Origin header are also rejected (non-browser
			// clients must be authenticated via the upgrade handler instead).
			if (allowedOrigins !== '*') {
				const reqOrigin = headers['origin'];
				let allowed = false;
				if (!reqOrigin) {
					// No Origin header - reject unless an upgrade handler is
					// configured (it can authenticate non-browser clients itself)
					allowed = !!wsModule.upgrade;
				} else if (allowedOrigins === 'same-origin') {
					try {
						const parsed = new URL(reqOrigin);
						const requestHost = (host_header && headers[host_header]) || headers['host'];
						if (!requestHost) {
							allowed = false;
						} else {
							const requestScheme = protocol_header
								? (headers[protocol_header] || (is_tls ? 'https' : 'http'))
								: (is_tls ? 'https' : 'http');
							// Merge PORT_HEADER into the host the same way get_origin() does,
							// so proxies that split host/port across headers still match.
							const requestPort = port_header ? headers[port_header] : undefined;
							let expectedHost = requestHost;
							if (requestPort) {
								expectedHost = requestHost.replace(/:\d+$/, '') + ':' + requestPort;
							}
							// Strip default ports so "example.com" matches "example.com:443"
							// (URL.host omits the port when it is the default for the scheme)
							const defaultPort = requestScheme === 'https' ? '443' : '80';
							expectedHost = expectedHost.replace(':' + defaultPort, '');
							allowed = parsed.host === expectedHost && parsed.protocol === requestScheme + ':';
						}
					} catch {
						allowed = false;
					}
				} else if (Array.isArray(allowedOrigins)) {
					allowed = allowedOrigins.includes(reqOrigin);
				}
				if (!allowed) {
					res.cork(() => {
						res.writeStatus('403 Forbidden');
						res.writeHeader('content-type', 'text/plain');
						res.end('Origin not allowed');
					});
					return;
				}
			}

			// No user upgrade handler - accept synchronously (no microtask yield,
			// no cookie parsing). Inject remoteAddress so plugins/ratelimit can
			// key on the real client IP via ws.getUserData().remoteAddress.
			if (!wsModule.upgrade) {
				res.cork(() => {
					res.upgrade({ remoteAddress: clientIp }, secKey, secProtocol, secExtensions, context);
				});
				return;
			}

			// -- User upgrade handler path (may be async) --
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();

			let aborted = false;
			res.onAborted(() => {
				aborted = true;
			});

			const cookies = parseCookies(headers['cookie']);

			let timedOut = false;
			let timer;
			if (wsOptions.upgradeTimeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					if (!aborted) {
						res.cork(() => {
							res.writeStatus('504 Gateway Timeout');
							res.writeHeader('content-type', 'text/plain');
							res.end('Upgrade timed out');
						});
					}
				}, wsOptions.upgradeTimeout * 1000);
			}

			Promise.resolve(wsModule.upgrade({ headers, cookies, url, remoteAddress: clientIp }))
				.then((result) => {
					clearTimeout(timer);
					if (aborted || timedOut) return;
					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						return;
					}
					// Unpack upgradeResponse() wrapper if present
					let responseHeaders = null;
					let userData;
					if (result && result.__upgradeResponse === true) {
						userData = result.userData || {};
						responseHeaders = result.headers;
					} else {
						userData = result || {};
					}
					// Warn once per unique key name about potentially sensitive data in userData.
					// userData is readable by every server-side handler via ws.getUserData().
					if (userData && typeof userData === 'object') {
						for (const key of Object.keys(userData)) {
							if (!warnedUserDataKeys.has(key)) {
								const lower = key.toLowerCase();
								if (SENSITIVE_KEY_PATTERNS.some((s) => lower.includes(s))) {
									warnedUserDataKeys.add(key);
									console.warn(
										'[ws] userData key "' + key + '" may contain sensitive data. ' +
										'userData is accessible to all server-side handlers via ws.getUserData(). ' +
										'Store sensitive data outside userData and reference it by a non-sensitive ID.'
									);
								}
							}
						}
					}
					const ud = userData || {};
					if (!ud.remoteAddress) ud.remoteAddress = clientIp;
					res.cork(() => {
						if (responseHeaders) {
							for (const [hk, hv] of Object.entries(responseHeaders)) {
								if (Array.isArray(hv)) {
									for (const v of hv) res.writeHeader(hk, v);
								} else {
									res.writeHeader(hk, hv);
								}
							}
						}
						res.upgrade(
							ud,
							secKey,
							secProtocol,
							secExtensions,
							context
						);
					});
				})
				.catch((err) => {
					clearTimeout(timer);
					console.error('WebSocket upgrade error:', err);
					if (!aborted && !timedOut) {
						res.cork(() => {
							res.writeStatus('500 Internal Server Error');
							res.writeHeader('content-type', 'text/plain');
							res.end('Internal Server Error');
						});
					}
				});
		},

		open: (ws) => {
			// Track which topics this connection is subscribed to.
			// Used to populate CloseContext.subscriptions for the user's close handler,
			// enabling deterministic cleanup of per-subscription server state.
			ws.getUserData().__subscriptions = new Set();
			wsConnections.add(ws);
			if (wsDebug) console.log('[ws] open connections=%d', wsConnections.size);
			wsModule.open?.(ws, { platform });
		},

		message: (ws, message, isBinary) => {
			// Built-in: handle subscribe/unsubscribe from the client store.
			// Control messages are JSON text: {"type":"subscribe","topic":"..."}
			// Byte-prefix check: {"type" has byte[3]='y' (0x79), while user
			// envelopes {"topic" have byte[3]='o' (0x6F). Only JSON.parse when
			// the prefix matches - skips parsing for 99%+ of messages.
			// The 8192-byte ceiling is generous enough for subscribe-batch with
			// many topics (N * 256-char names) while keeping the JSON.parse
			// guard against truly large user messages.
			if (!isBinary && message.byteLength < 8192 &&
				(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
				try {
					const msg = JSON.parse(textDecoder.decode(message));
					if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
						// Validate topic name: max 256 chars, no control characters
						if (msg.topic.length === 0 || msg.topic.length > 256) return;
						for (let i = 0; i < msg.topic.length; i++) {
							if (msg.topic.charCodeAt(i) < 32) return;
						}
						// If a subscribe hook exists, let it gate access
						if (wsModule.subscribe && wsModule.subscribe(ws, msg.topic, { platform }) === false) {
							return;
						}
						ws.subscribe(msg.topic);
						ws.getUserData().__subscriptions.add(msg.topic);
						if (wsDebug) console.log('[ws] subscribe topic=%s', msg.topic);
						return;
					}
					if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
						ws.unsubscribe(msg.topic);
						ws.getUserData().__subscriptions.delete(msg.topic);
						if (wsDebug) console.log('[ws] unsubscribe topic=%s', msg.topic);
						wsModule.unsubscribe?.(ws, msg.topic, { platform });
						return;
					}
					if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
						// Sent by the client store on reconnect to resubscribe all topics
						// in a single message instead of N individual subscribe messages.
						// Cap at 256 topics  - the client only sends what it was subscribed to.
						const topics = msg.topics.slice(0, 256);
						const userData = ws.getUserData();
						let subscribed = 0;
						for (const topic of topics) {
							if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) continue;
							let valid = true;
							for (let i = 0; i < topic.length; i++) {
								if (topic.charCodeAt(i) < 32) { valid = false; break; }
							}
							if (!valid) continue;
							if (wsModule.subscribe && wsModule.subscribe(ws, topic, { platform }) === false) continue;
							ws.subscribe(topic);
							userData.__subscriptions.add(topic);
							subscribed++;
						}
						if (wsDebug) console.log('[ws] subscribe-batch count=%d', subscribed);
						return;
					}
				} catch {
					// Not valid JSON - fall through to user handler
				}
			}
			// Delegate everything else to the user's handler (if provided)
			wsModule.message?.(ws, { data: message, isBinary, platform });
		},

		drain: wsModule.drain ? (ws) => wsModule.drain(ws, { platform }) : undefined,

		close: (ws, code, message) => {
			const subscriptions = ws.getUserData().__subscriptions || new Set();
			try {
				wsModule.close?.(ws, { code, message, platform, subscriptions });
			} finally {
				wsConnections.delete(ws);
				if (wsDebug) console.log('[ws] close code=%d connections=%d', code, wsConnections.size);
			}
		},

		maxPayloadLength: wsOptions.maxPayloadLength,
		idleTimeout: wsOptions.idleTimeout,
		maxBackpressure: wsOptions.maxBackpressure,
		sendPingsAutomatically: wsOptions.sendPingsAutomatically,
		compression: typeof wsOptions.compression === 'number'
			? wsOptions.compression
			: wsOptions.compression
				? uWS.SHARED_COMPRESSOR
				: uWS.DISABLED
	});

	console.log(`WebSocket endpoint registered at ${WS_PATH}`);
	if (WS_PATH !== '/ws') {
		console.log(`Client must match: connect({ path: '${WS_PATH}' })`);
	}
}

// Health check endpoint (before catch-all so it never hits SSR)
if (HEALTH_CHECK_PATH) {
	app.get(HEALTH_CHECK_PATH, (res) => {
		res.cork(() => {
			res.writeStatus('200 OK').end('OK');
		});
	});
}

// Register HTTP handler (after WS so the WS route takes priority)
app.any('/*', handleRequest);

// -- In-flight request tracking -------------------------------------------

let inFlightCount = 0;
/** @type {Array<() => void>} */
let drainResolvers = [];

function requestDone() {
	inFlightCount--;
	if (inFlightCount === 0 && drainResolvers.length > 0) {
		for (const resolve of drainResolvers) resolve();
		drainResolvers = [];
	}
}

/**
 * Returns a promise that resolves when all in-flight SSR requests have completed.
 * @returns {Promise<void>}
 */
export function drain() {
	if (inFlightCount === 0) return Promise.resolve();
	return new Promise((resolve) => { drainResolvers.push(resolve); });
}

// -- Exports -----------------------------------------------------------------

let listenSocket = null;

/**
 * Start the uWS server.
 * @param {string} host
 * @param {number} port
 */
export function start(host, port) {
	app.listen(host, port, (socket) => {
		if (socket) {
			listenSocket = socket;
			const startup = (performance.now() - _t_app).toFixed(0);
			console.log(`Listening on ${is_tls ? 'https' : 'http'}://${host}:${port} (ready in ${startup}ms)`);
		} else {
			console.error(`Failed to listen on ${host}:${port}`);
			process.exit(1);
		}
	});
}

/**
 * Stop the server.
 * Closes the listen socket (stops accepting new connections) and terminates
 * all idle WebSocket connections with code 1001 (Going Away) so clients
 * reconnect to the new instance. In-flight HTTP requests continue until
 * drain() resolves.
 */
export function shutdown() {
	if (listenSocket) {
		uWS.us_listen_socket_close(listenSocket);
		listenSocket = null;
	}
	for (const ws of wsConnections) {
		ws.close(1001, 'Server shutting down');
	}
}

/**
 * Get the app descriptor for worker thread distribution.
 * The main thread's acceptor app uses this to route connections to this worker.
 * @returns {any}
 */
export function getDescriptor() {
	return app.getDescriptor();
}

/**
 * Publish a relayed message from another worker thread.
 * Called by the main thread's relay when another worker publishes.
 * @param {string} topic
 * @param {string} envelope - Pre-serialized JSON envelope
 */
export function relayPublish(topic, envelope) {
	app.publish(topic, envelope, false, false);
}
