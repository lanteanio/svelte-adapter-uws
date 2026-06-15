import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { server } from '../_init.js';
import { resolveRequestId, writeChunkWithBackpressure } from '../utils.js';
import { randomUuid } from '../runtime.js';
import { PayloadTooLargeError, send413, send500 } from './http-helpers.js';
import { origin, address_header, xff_depth, body_size_limit, get_origin, WS_COMPRESSION_ON } from './config.js';
import { platform } from './platform.js';

// Maximum number of in-flight dedup keys tracked simultaneously.
const MAX_SSR_DEDUP = 500;

// Maximum response body size (bytes) that may be shared across waiters.
// Responses larger than this are not shared  - each waiter makes its own call.
const MAX_SSR_DEDUP_BODY = 512 * 1024;

/**
 * In-flight SSR dedup map. Key is "<METHOD>\0<URL>".
 * Value is a Promise that resolves to a SharedResponse (shareable) or null (not shareable).
 * @type {Map<string, Promise<SharedResponse | null>>}
 */
const ssrInflight = new Map();

// When Content-Length is known and fits in this threshold, pre-allocate
// a single Buffer and fill it as chunks arrive instead of creating a
// separate Buffer per chunk. Reduces GC pressure for typical form/JSON bodies.
const SMALL_BODY_THRESHOLD = 65536;

// Dynamic response compression: only compress text content types above a threshold.
// Static files use build-time precompression and are never affected by this.
const COMPRESS_MIN_SIZE = 1024;

// BREACH defense: dynamic compression of credentialed responses turns the
// response length into a side channel that leaks any secret reflected
// alongside attacker-influenced input (CSRF tokens, session IDs, API keys
// in the page body). Skip compression on every request that carries a
// `Cookie` or `Authorization` header. Apps that have audited their pages
// for BREACH defenses (random per-response masking, prefix randomization,
// no secrets reflected with attacker input) can opt back in via
// `websocket.compressCredentialedResponses: true`.
const COMPRESS_CREDENTIALED = WS_OPTIONS?.compressCredentialedResponses === true;

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
export function readBody(res, limit, state, contentLength) {
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
				// alloc (zero-fill), not allocUnsafe: prevents heap residue from
				// leaking via the trailing bytes when offset < contentLength.
				const buf = Buffer.alloc(contentLength);
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

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} remoteAddress - Client IP address
 * @param {{ aborted: boolean }} state
 */
export async function handleSSR(res, method, url, headers, remoteAddress, state) {
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

		// Per-request platform: same surface as the shared platform (publish,
		// pressure, connections, etc.) plus a unique requestId for structured
		// logging. Object.create keeps the live-getters intact via the
		// prototype chain - a flat spread would freeze `connections` and
		// `pressure` to their snapshot value at clone time.
		const requestId = resolveRequestId(headers['x-request-id']) || randomUuid();
		const requestPlatform = Object.create(platform);
		requestPlatform.requestId = requestId;

		// Dedup: for anonymous GET/HEAD requests that arrive concurrently for the
		// same URL, only the first (the leader) calls server.respond(). Subsequent
		// requests (waiters) await the leader's promise and reconstruct a Response
		// from the shared buffer. This prevents redundant SSR work during traffic
		// spikes on public pages.
		//
		// Dedup is skipped for:
		//   - Non-GET/HEAD methods (mutations must not be coalesced)
		//   - Authenticated requests (cookie or authorization header present)
		//   - When the dedup map is at capacity (safety valve)
		//
		// The earlier `x-no-dedup: 1` opt-out was anonymous-callable - a
		// hostile client could stamp it on every request to defeat the
		// shared-leader fan-in and amplify server-side SSR cost. Since
		// the only legitimate caller of an opt-out (debug tooling) can
		// always send a Cookie / Authorization header to skip dedup
		// naturally, the header is no longer consulted.
		const isCredentialedRequest = !!(headers.cookie || headers.authorization);
		const canDedup =
			(method === 'GET' || method === 'HEAD') &&
			!isCredentialedRequest &&
			ssrInflight.size < MAX_SSR_DEDUP;
		// BREACH defense: suppress the accept-encoding signal for credentialed
		// requests so writeResponse() leaves the body uncompressed. Apps that
		// have audited their reflected-input surface can opt back in via the
		// COMPRESS_CREDENTIALED module flag.
		const respAcceptEncoding = (isCredentialedRequest && !COMPRESS_CREDENTIALED)
			? ''
			: headers['accept-encoding'];

		if (canDedup) {
			// Include base_origin so virtual-hosting deployments (one uWS
			// instance behind multiple `Host` aliases) keep per-tenant
			// dedup buckets - SvelteKit consults `request.url`'s host
			// when rendering, so the response IS host-dependent.
			const dedupKey = method + '\0' + base_origin + '\0' + url;
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
						respAcceptEncoding
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
					const response = await server.respond(request, { platform: requestPlatform, getClientAddress });
					if (state.aborted) { resolveShared(null); return; }

					// Responses with Set-Cookie must not be shared (they're personalized).
					// Responses that declare Vary on anything other than Accept-Encoding
					// are personalized by some other request header (Accept-Language,
					// geo, feature flags, tenant, etc.)  - sharing would serve the
					// leader's content to waiters that may legitimately differ.
					if (response.headers.has('set-cookie') || !response.body) {
						resolveShared(null);
						await writeResponse(res, response, state, respAcceptEncoding);
						return;
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							await writeResponse(res, response, state, respAcceptEncoding);
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
						respAcceptEncoding
					);
				} catch (err) {
					resolveShared(null);
					throw err;
				}
				return;
			}
		}

		// Normal (non-dedup) path
		const response = await server.respond(request, { platform: requestPlatform, getClientAddress });
		if (state.aborted) return;
		await writeResponse(res, response, state, respAcceptEncoding);
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

/**
 * Write response headers inside a cork. Injects a default
 * `x-content-type-options: nosniff` if the response did not already set
 * one - the header is safe in every legitimate scenario (it tells the
 * browser not to MIME-sniff away the server's declared content-type)
 * and closes a known MIME-confusion vector for any future SSR response
 * whose author forgets to set the header explicitly. Apps that want to
 * override (e.g. set to a different X-Content-Type-Options policy) can
 * just include their own header on the Response - the default-fill
 * only fires when the response is silent on the matter.
 *
 * Other header defaults (Referrer-Policy, X-Frame-Options, CSP) are
 * intentionally NOT defaulted here. CSP needs app-specific care for
 * inline-hydration / iframe shapes; X-Frame-Options breaks legitimate
 * embeds; Referrer-Policy choices vary by app. Those are app-level
 * decisions and the right tier is `hooks.server.js`.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {Response} response
 */
function writeHeaders(res, response) {
	res.writeStatus(String(response.status));
	let hasContentTypeOptions = false;
	for (const [key, value] of response.headers) {
		if (key === 'set-cookie' || key === 'content-length') continue;
		if (key === 'x-content-type-options') hasContentTypeOptions = true;
		res.writeHeader(key, value);
	}
	if (!hasContentTypeOptions) {
		res.writeHeader('x-content-type-options', 'nosniff');
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

		// Multi-chunk streaming response. Headers + first two chunks share one
		// cork so they flush as a single syscall. Subsequent chunks are each
		// written inside their own cork via writeChunkWithBackpressure, which
		// also captures the drain signal from res.write() without tripping the
		// uWS "writes must be made from within a corked callback" warning.
		if (state.aborted) return;
		streaming = true;
		res.cork(() => {
			writeHeaders(res, response);
			res.write(first.value);
			res.write(second.value);
		});

		for (;;) {
			const { done, value } = await reader.read();
			if (done || state.aborted) break;

			const result = writeChunkWithBackpressure(res, value);
			if (result !== true) {
				const drained = await result;
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
				res.cork(() => res.close());
			} else {
				res.cork(() => res.end());
			}
		}
		reader.cancel().catch(() => {});
	}
}
