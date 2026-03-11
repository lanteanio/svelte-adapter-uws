import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
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

const textDecoder = new TextDecoder();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

		/** @type {[string, string][]} */
		const headers = [];
		let etag = '';
		if (immutable && relPath.startsWith(`${manifest.appPath}/immutable/`)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${createHash('md5').update(buffer).digest('hex').slice(0, 12)}"`;
			headers.push(['cache-control', 'no-cache'], ['etag', etag]);
		}

		/** @type {StaticEntry} */
		const entry = { buffer, contentType, etag, headers };

		if (PRECOMPRESS) {
			const brPath = absPath + '.br';
			const gzPath = absPath + '.gz';
			if (fs.existsSync(brPath)) entry.brBuffer = fs.readFileSync(brPath);
			if (fs.existsSync(gzPath)) entry.gzBuffer = fs.readFileSync(gzPath);
		}

		staticCache.set(urlPath, entry);

		// Prerendered pages are written as index.html or about/index.html, but
		// SvelteKit's builder.prerendered.paths lists them as "/" and "/about".
		// Register the clean pathname alias so tryPrerendered() can find them.
		if (!immutable) {
			if (relPath === 'index.html') {
				staticCache.set(urlPrefix || '/', entry);
			} else if (relPath.endsWith('/index.html')) {
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`, entry);
			} else if (relPath.endsWith('.html')) {
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry);
			}
		}
	});
}

const clientDir = path.join(__dirname, 'client');
const prerenderedDir = path.join(__dirname, 'prerendered');

cacheDir(path.join(clientDir, base), base, true);
cacheDir(path.join(prerenderedDir, base), base, false);

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

const asset_dir = `${__dirname}/client${base}`;

const server = new Server(manifest);
await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(`${asset_dir}/${file}`)))
});

// -- uWS App -----------------------------------------------------------------

const app = is_tls
	? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
	: uWS.App();

// -- Platform (exposed to SvelteKit via event.platform) ----------------------

/** @type {Set<import('uWebSockets.js').WebSocket<any>>} */
const wsConnections = new Set();

/** @type {import('./index.js').Platform} */
const platform = {
	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 * Auto-wraps in a { topic, event, data } envelope that the client store understands.
	 * No-op if no clients are subscribed - safe to call unconditionally.
	 */
	publish(topic, event, data) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
		const result = app.publish(topic, envelope, false, false);
		// Relay to other workers via main thread (no-op in single-process mode)
		if (parentPort) {
			parentPort.postMessage({ type: 'publish', topic, envelope });
		}
		return result;
	},

	/**
	 * Send a message to a single WebSocket connection.
	 * Wraps in the same { topic, event, data } envelope as publish().
	 */
	send(ws, topic, event, data) {
		return ws.send('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}', false, false);
	},

	/**
	 * Send a message to connections matching a filter.
	 * The filter receives each connection's userData (from the upgrade handler).
	 * Returns the number of connections the message was sent to.
	 */
	sendTo(filter, topic, event, data) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
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

// -- Body reading ------------------------------------------------------------

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {number} limit
 * @param {AbortSignal} signal - Aborted when the client disconnects
 * @returns {ReadableStream<Uint8Array>}
 */
function readBody(res, limit, signal) {
	return new ReadableStream({
		start(controller) {
			if (signal.aborted) {
				controller.error(new Error('Request aborted'));
				return;
			}
			signal.addEventListener('abort', () => {
				try { controller.error(new Error('Request aborted')); } catch { /* already closed */ }
			}, { once: true });

			let size = 0;
			let done = false;
			res.onData((chunk, isLast) => {
				if (done) return;
				// MUST copy - uWS reuses the ArrayBuffer after callback returns
				const copy = Buffer.from(chunk.slice(0));
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
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {StaticEntry} entry
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 */
function serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly = false) {
	if (entry.etag && ifNoneMatch === entry.etag) {
		res.cork(() => {
			res.writeStatus('304 Not Modified').end();
		});
		return;
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

		if (entry.brBuffer || entry.gzBuffer) {
			res.writeHeader('vary', 'Accept-Encoding');
		}

		res.writeStatus('200 OK');
		res.writeHeader('content-type', entry.contentType);
		res.writeHeader('content-length', String(body.byteLength));
		// Pre-computed [key, value] tuples - no Object.entries() allocation per request
		for (let i = 0; i < entry.headers.length; i++) {
			res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
		}
		if (headOnly) {
			res.endWithoutBody();
		} else {
			res.end(body);
		}
	});
}

// -- Prerendered page check --------------------------------------------------

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} pathname
 * @param {string} search
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @returns {boolean}
 */
function tryPrerendered(res, pathname, search, acceptEncoding, ifNoneMatch, headOnly = false) {
	// Fast path: skip decodeURIComponent when there are no encoded characters
	const needsDecode = pathname.includes('%');
	let decoded;
	if (needsDecode) {
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			res.cork(() => {
				res.writeStatus('400 Bad Request');
				res.writeHeader('content-type', 'text/plain');
				res.end('Bad Request');
			});
			return true;
		}
	} else {
		decoded = pathname;
	}

	if (prerendered.has(decoded)) {
		const entry = staticCache.get(decoded);
		if (entry) {
			serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly);
			return true;
		}
	}

	const alt = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded + '/';
	if (prerendered.has(alt)) {
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
 * @param {AbortSignal} abortSignal
 */
async function handleSSR(res, method, url, headers, remoteAddress, state, abortSignal) {
	try {
		const base_origin = origin || get_origin(headers);

		// Reject oversized bodies early when Content-Length is known
		if (method !== 'GET' && method !== 'HEAD' && body_size_limit !== Infinity) {
			const contentLength = parseInt(headers['content-length'], 10);
			if (contentLength > body_size_limit) {
				res.cork(() => {
					res.writeStatus('413 Content Too Large');
					res.writeHeader('content-type', 'text/plain');
					res.end('Content Too Large');
				});
				return;
			}
		}

		const body =
			method === 'GET' || method === 'HEAD'
				? undefined
				: readBody(res, body_size_limit, abortSignal);

		const request = new Request(base_origin + url, {
			method,
			headers: Object.entries(headers),
			body,
			// @ts-expect-error
			duplex: 'half'
		});

		const response = await server.respond(request, {
			platform,
			getClientAddress: () => {
				if (address_header) {
					if (!(address_header in headers)) {
						throw new Error(
							`Address header was specified with ${ENV_PREFIX + 'ADDRESS_HEADER'}=${address_header} but is absent from request`
						);
					}

					const value = headers[address_header] || '';

					if (address_header === 'x-forwarded-for') {
						const addresses = value.split(',');

						if (xff_depth < 1) {
							throw new Error(`${ENV_PREFIX + 'XFF_DEPTH'} must be a positive integer`);
						}
						if (xff_depth > addresses.length) {
							throw new Error(
								`${ENV_PREFIX + 'XFF_DEPTH'} is ${xff_depth}, but only found ${addresses.length} addresses`
							);
						}
						return addresses[addresses.length - xff_depth].trim();
					}

					return value;
				}
				return remoteAddress;
			}
		});

		if (state.aborted) return;
		await writeResponse(res, response, state);
	} catch (err) {
		if (state.aborted) return;
		if (err instanceof PayloadTooLargeError) {
			res.cork(() => {
				res.writeStatus('413 Content Too Large');
				res.writeHeader('content-type', 'text/plain');
				res.end('Content Too Large');
			});
			return;
		}
		console.error('SSR error:', err);
		if (!state.aborted) {
			res.cork(() => {
				res.writeStatus('500 Internal Server Error');
				res.writeHeader('content-type', 'text/plain');
				res.end('Internal Server Error');
			});
		}
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
		if (key === 'set-cookie') continue;
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
 */
async function writeResponse(res, response, state) {
	// No body - write headers + end in a single cork (one syscall)
	if (!response.body) {
		if (state.aborted) return;
		res.cork(() => {
			writeHeaders(res, response);
			res.end();
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
				res.cork(() => {
					writeHeaders(res, response);
					res.end(first.value);
				});
			}
			return;
		}

		// Multi-chunk streaming response - write headers + first two chunks in one cork.
		// cork() batches these writes into a single syscall, so backpressure from
		// individual res.write() calls inside cork is not actionable — the data is
		// buffered and flushed together when cork returns. The backpressure loop
		// below handles all subsequent chunks.
		if (state.aborted) return;
		streaming = true;
		res.cork(() => {
			writeHeaders(res, response);
			res.write(first.value);
			res.write(second.value);
		});

		// Stream remaining chunks with backpressure
		for (;;) {
			const { done, value } = await reader.read();
			if (done || state.aborted) break;

			const ok = res.write(value);
			if (!ok) {
				await new Promise((resolve) =>
					res.onWritable(() => { resolve(undefined); return true; })
				);
				if (state.aborted) break;
			}
		}
	} finally {
		if (streaming && !state.aborted) res.cork(() => res.end());
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
	// and only toUpperCase() for SSR where the Request constructor expects it.
	const method = req.getMethod();
	const pathname = req.getUrl();

	// === STATIC FILE FAST PATH ===
	// Minimum work: 1 Map lookup + 2 header reads. No header collection,
	// no query string handling, no remoteAddress decode, no toUpperCase().
	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'get' || method === 'head')) {
		return serveStatic(
			res, staticFile,
			req.getHeader('accept-encoding'),
			req.getHeader('if-none-match'),
			method === 'head'
		);
	}

	// Build full URL only for SSR - static files never reach here
	const query = req.getQuery();
	const METHOD = method.toUpperCase();

	// === PRERENDERED CHECK ===
	// Lightweight: only 2 header reads, no full collection, no remoteAddress decode
	if (METHOD === 'GET' || METHOD === 'HEAD') {
		if (tryPrerendered(res, pathname, query ? `?${query}` : '',
			req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD')) {
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

	// Set onAborted BEFORE any async work (mandatory uWS pattern)
	const abortController = new AbortController();
	const state = { aborted: false };
	res.onAborted(() => {
		state.aborted = true;
		abortController.abort();
	});

	// === ASYNC PHASE: SSR ===
	inFlightCount++;
	handleSSR(res, METHOD, url, headers, remoteAddress, state, abortController.signal)
		.finally(requestDone);
}

// -- WebSocket support -------------------------------------------------------

// WS_ENABLED is set by the adapter at build time - no inference from exports needed
if (WS_ENABLED) {
	// Warn about unrecognized exports - catches typos like "mesage" or "opn"
	const knownWsExports = new Set(['open', 'message', 'upgrade', 'close', 'drain', 'subscribe']);
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

	app.ws(WS_PATH, {
		// Handle HTTP -> WebSocket upgrade with user-provided auth
		upgrade: (res, req, context) => {
			// Read everything synchronously - uWS req is stack-allocated
			/** @type {Record<string, string>} */
			const headers = {};
			req.forEach((key, value) => {
				headers[key] = value;
			});
			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');

			// Origin validation - reject cross-origin WebSocket connections.
			// Non-browser clients (no Origin header) are always allowed.
			const reqOrigin = headers['origin'];
			if (reqOrigin && allowedOrigins !== '*') {
				let allowed = false;
				if (allowedOrigins === 'same-origin') {
					try {
						const parsed = new URL(reqOrigin);
						const requestHost = (host_header && headers[host_header]) || headers['host'];
						if (!requestHost) {
							allowed = true;
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
			// no cookie parsing, no remoteAddress decode)
			if (!wsModule.upgrade) {
				res.cork(() => {
					res.upgrade({}, secKey, secProtocol, secExtensions, context);
				});
				return;
			}

			// -- User upgrade handler path (may be async) --
			const url = req.getUrl();
			const remoteAddress = textDecoder.decode(res.getRemoteAddressAsText());

			let aborted = false;
			res.onAborted(() => {
				aborted = true;
			});

			const cookies = parseCookies(headers['cookie']);

			const upgradeTimeoutMs = (wsOptions.upgradeTimeout || 10) * 1000;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				if (!aborted) {
					res.cork(() => {
						res.writeStatus('504 Gateway Timeout');
						res.writeHeader('content-type', 'text/plain');
						res.end('Upgrade timed out');
					});
				}
			}, upgradeTimeoutMs);

			Promise.resolve(wsModule.upgrade({ headers, cookies, url, remoteAddress }))
				.then((userData) => {
					clearTimeout(timer);
					if (aborted || timedOut) return;
					if (userData === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						return;
					}
					res.cork(() => {
						res.upgrade(
							userData || {},
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
			wsConnections.add(ws);
			wsModule.open?.(ws, { platform });
		},

		message: (ws, message, isBinary) => {
			// Built-in: handle subscribe/unsubscribe from the client store.
			// Control messages are JSON text: {"type":"subscribe","topic":"..."}
			// Byte-prefix check: {"type" has byte[3]='y' (0x79), while user
			// envelopes {"topic" have byte[3]='o' (0x6F). Only JSON.parse when
			// the prefix matches - skips parsing for 99%+ of messages.
			if (!isBinary && message.byteLength < 512 &&
				(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
				try {
					const msg = JSON.parse(Buffer.from(message).toString());
					if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
						// If a subscribe hook exists, let it gate access
						if (wsModule.subscribe && wsModule.subscribe(ws, msg.topic, { platform }) === false) {
							return;
						}
						ws.subscribe(msg.topic);
						return;
					}
					if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
						ws.unsubscribe(msg.topic);
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
			wsConnections.delete(ws);
			wsModule.close?.(ws, { code, message, platform });
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
			console.log(`Listening on ${is_tls ? 'https' : 'http'}://${host}:${port}`);
		} else {
			console.error(`Failed to listen on ${host}:${port}`);
			process.exit(1);
		}
	});
}

/**
 * Stop the server.
 */
export function shutdown() {
	if (listenSocket) {
		uWS.us_listen_socket_close(listenSocket);
		listenSocket = null;
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
