import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { parentPort } from 'node:worker_threads';
import uWS from 'uWebSockets.js';
import { manifest, prerendered, base } from 'MANIFEST';
import { env } from 'ENV';
// IMPORTANT: ./_init.js MUST be imported before WS_HANDLER. It runs
// `await server.init({ env: process.env })` at module top level, which
// populates SvelteKit's `$env/dynamic/private` and `$env/dynamic/public`
// runtime proxies. ESM evaluates imports depth-first in source order, so
// _init.js's body (including the await) completes before the next import
// (WS_HANDLER) is processed - giving the user's hooks.ws / src/lib/server
// modules populated env values when their top-level code reads
// `env.DATABASE_URL` etc. Reordering these two imports re-introduces a
// real bug where `$env/dynamic/private` returns empty in the ws-handler
// import graph; do not move them.
import { server } from './_init.js';
import * as wsModule from 'WS_HANDLER';
import { parseCookies, createCookies } from './cookies.js';
import { mimeLookup, parse_as_bytes, parse_origin, writeChunkWithBackpressure, drainCoalesced, computePressureReason, computeTopPublishers, nextTopicSeq, createHlc, processEpoch, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, isOriginAllowed, isAuthOriginAccepted, describeUnsafeSameOriginConfig, createUpgradeAdmission, negotiateRejection, isCursorLaneUpgrade, resolveWaitingRoom, applyCapacityReason, createPosture, resolveRequestId, assert, fatal, readAssertionCounts, WS_SUBSCRIPTIONS, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, MAX_COALESCED_KEYS_PER_CONNECTION, TOPIC_SEQS_WARN_THRESHOLD, PUBLISH_WARN_DEDUP_MAX } from './utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leasePressureValue, leaseGrantSize, samplePressureValue, leaseGrantFrame, DEFAULT_GRANT } from './wire.js';
import { now, monotonicNow, randomUuid, randomFloat, randomU32, randomBytes, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from './runtime.js';

/* global ENV_PREFIX */
/* global PRECOMPRESS */
/* global WS_ENABLED */
/* global WS_PATH */
/* global WS_OPTIONS */
/* global WS_AUTH_PATH */
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

// - Error response helpers ---------------------------------------------------

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

// - State object pool --------------------------------------------------------
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

// Cache for pre-built envelope prefixes. Repeated publishes to the same
// topic+event (e.g. platform.topic('chat').created()) reuse the prefix
// instead of rebuilding it from 4 string concatenations each time.
const ENVELOPE_CACHE_MAX = 256;
/** @type {Map<string, string>} */
const envelopePrefixCache = new Map();

// Capacity caps (`MAX_SUBSCRIPTIONS_PER_CONNECTION`,
// `MAX_PENDING_REQUESTS_PER_CONNECTION`, `MAX_COALESCED_KEYS_PER_CONNECTION`,
// `TOPIC_SEQS_WARN_THRESHOLD`, `PUBLISH_WARN_DEDUP_MAX`) live in utils.js
// so handler.js, vite.js, and testing.js all enforce identical limits.

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

// - In-memory static file cache ---------------------------------------------

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

// The HTTP Date header string is rebuilt once per second from the runtime
// clock so the static handler never formats a fresh timestamp per response.
// The wall-clock value itself comes from the injectable runtime module's
// now(), which is already the ~1s-cached read - the rate limiter and per-
// upgrade checks read it directly, so this timer only refreshes the header
// string. Unref'd so it never holds the loop open.
let cachedDateHeader = new Date(now()).toUTCString(); // determinism-allow: formats the runtime clock value, not a clock read
setIntervalTimer(() => {
	cachedDateHeader = new Date(now()).toUTCString(); // determinism-allow: formats the runtime clock value, not a clock read
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

const _t_static = monotonicNow();
cacheDir(path.join(clientDir, base), base, true);
cacheDir(path.join(prerenderedDir, base), base, false);
console.log(`Static files indexed in ${(monotonicNow() - _t_static).toFixed(1)}ms (${staticCache.size} entries)`);

// - TLS config (must be before origin warning) ------------------------------

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

// - SvelteKit Server --------------------------------------------------------

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
		'  PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)\n' +
		'  See: https://svti.me/adapter-origin'
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

// Server instance + init have moved to ./_init.js so they run BEFORE the
// WS_HANDLER import is evaluated. See the comment above the import in the
// header block of this file for the init-order rationale. `server` is
// imported from there.

// - uWS App -----------------------------------------------------------------

const _t_app = monotonicNow();
const app = is_tls
	? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
	: uWS.App();

// - Cross-worker pub/sub relay (batched) ------------------------------------
// Batch postMessage calls within a single event-loop iteration. A SvelteKit
// action that publishes N events sends one structured-clone across the thread
// boundary instead of N. No-op in single-process mode (parentPort is null).
//
// Why `setTimeout(0)` and not `queueMicrotask`: uWS dispatches each WS message
// as its own JS task, and N-API drains microtasks at the C++/JS boundary
// between tasks. A microtask-deferred flush fires BEFORE the next socket's
// handler runs, so cross-socket coalescing is impossible at the microtask
// level - N publishes from N socket handlers in the same iteration produce N
// postMessage structured-clones instead of one batched. `setTimeout(0)` lands
// in libuv's timers phase, which fires only after the poll phase has
// dispatched every ready socket message in the current iteration. Same
// structural choice the 0.5.6 cursor always-tick rewrite locked in.

/** @type {Array<{topic: string, envelope: string}> | null} */
let relayBatch = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let relayTimer = null;

/**
 * @param {string} topic
 * @param {string} envelope
 * @param {boolean} [compress] - Per-frame compress intent carried across the
 *   worker boundary so a relayed frame compresses on the receiving worker the
 *   same way it did locally. Absent (e.g. publishWire callers) -> uncompressed.
 */
function batchRelay(topic, envelope, compress) {
	if (!relayBatch) {
		relayBatch = [];
		relayTimer = setTimer(() => {
			relayTimer = null;
			if (relayBatch) {
				parentPort.postMessage({ type: 'publish-batch', messages: relayBatch });
			}
			relayBatch = null;
		}, 0);
		if (relayTimer.unref) relayTimer.unref();
	}
	relayBatch.push({ topic, envelope, compress });
}

// - Platform (exposed to SvelteKit via event.platform) ----------------------

/** @type {Set<import('uWebSockets.js').WebSocket<any>>} */
const wsConnections = new Set();

// Monotonic counter for server-initiated requests. Refs are scoped per
// connection (looked up in ws.getUserData()[WS_PENDING_REQUESTS]) but
// the source is module-level so two requests on the same connection
// never collide. Wraps at MAX_SAFE_INTEGER, which at one request per
// nanosecond would still take 285 years.
let nextRequestRef = 1;

// WS_DEBUG=1 enables per-event logging for subscribe/publish/open/close.
// Read once at module load so it is never sampled inside a hot callback.
const wsDebug = WS_ENABLED && env('WS_DEBUG', '') === '1';

// Per-connection traffic counters are only populated when the user has
// wired a `close` hook - the only place they surface. Sampled once at
// module load so the bump helpers below early-return at near-zero cost
// when no hook is registered.
const closeHookRegistered = WS_ENABLED && !!wsModule.close;

/**
 * Bump the per-connection inbound counters. No-op when no `close` hook
 * is registered (zero-cost when the user does not need stats).
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {ArrayBuffer | string} message
 */
function bumpIn(ws, message) {
	if (!closeHookRegistered) return;
	let stats;
	try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
	if (!stats) return;
	stats.messagesIn++;
	stats.bytesIn += typeof message === 'string' ? message.length : message.byteLength;
}

/**
 * Bump the per-connection outbound counters for a direct send to this
 * connection (welcome / resumed / subscribe-ack / reply / send /
 * sendCoalesced / sendTo). Topic `publish()` fan-out is not counted -
 * uWS does the dispatch in C++ and counting per-recipient would mean
 * walking subscribers in JS on every publish, defeating the fast path.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} payload
 */
function bumpOut(ws, payload) {
	if (!closeHookRegistered) return;
	let stats;
	try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
	if (!stats) return;
	stats.messagesOut++;
	stats.bytesOut += payload.length;
}

// - Per-topic broadcast sequence numbers ------------------------------------
// Each platform.publish() stamps a monotonic per-topic seq into the envelope
// so reconnecting clients can detect gaps and resume from where they left
// off. Worker-local in clustered mode: cross-worker authority requires the
// extensions package's Lua INCR variant. See README "Sequence numbers" for
// the cluster caveat. The map persists for process lifetime; one entry per
// topic ever published. High-cardinality producers can opt out per-call
// via { seq: false }.
/** @type {Map<string, number>} */
const topicSeqs = new Map();

// Fires once when the topic registry first crosses the warn threshold.
// Apps with unbounded topic cardinality (e.g. publishing to a topic
// keyed on a per-user id) leak memory because each entry persists for
// the process lifetime - the resume protocol cannot evict without
// corrupting recovering clients. Surfacing the threshold loudly with
// the topN publishers lets ops identify the source before OOM.
let topicSeqsWarnFired = false;
let sendToAsyncWarned = false;
function maybeWarnTopicRegistry() {
	if (topicSeqsWarnFired) return;
	if (topicSeqs.size < TOPIC_SEQS_WARN_THRESHOLD) return;
	topicSeqsWarnFired = true;
	let top;
	try { top = computeTopPublishers(topicPublishStats, 0).slice(0, 5); }
	catch { top = []; }
	console.warn(
		'[ws] topic registry has grown to ' + topicSeqs.size +
		' distinct topics. Each entry persists for the process lifetime ' +
		'(required by the resume protocol). Reduce topic cardinality or ' +
		'opt out of seq stamping for high-cardinality publishes via ' +
		'{ seq: false }. Top recent publishers: ' + JSON.stringify(top) +
		'\n  See: https://svti.me/topic-cardinality'
	);
}

// - Pressure tracking -------------------------------------------------------
// Coarse 1 Hz sampler exposed as `platform.pressure` (snapshot) and
// `platform.onPressure(cb)` (transition callback). State lives at module
// scope so platform.publish() and the subscribe/unsubscribe handlers can
// bump counters with one integer add - no allocations on the hot path.

let publishCountWindow = 0;
let totalSubscriptions = 0;
// Worst per-connection send-gate saturation reading observed since the last
// sample. The 1 Hz sampler folds this into the worker pressure snapshot's
// `value` and decays it, so a single spike lifts the worker value for a tick
// without sticking. Stays 0 on a worker where no connection has opted into
// internal flow control.
let leaseSaturationPeak = 0;
// Count of best-effort operations that aborted because the underlying
// uWS WebSocket had already closed. The platform contract is that
// ws-targeted public methods (subscribe / unsubscribe / send /
// sendCoalesced / request) and internal helpers that may run after an
// `await` never propagate uWS's "Invalid access of closed
// uWS.WebSocket" exception to user code - they swallow it, return a
// no-op sentinel, and bump this counter. Operators can read
// `platform.closedWsAborts` to detect when mass-connect kernel /
// backpressure churn is closing sockets mid-async-setup at scale.
let closedWsAborts = 0;

/**
 * Per-topic publish counters for runaway-publisher detection. Single
 * Map keyed by topic, value object mutated in place so steady-state
 * publish only does two integer increments per call (no Map.set, no
 * allocation). The map is sampled and reset at every pressure tick.
 *
 * @type {Map<string, { m: number, b: number }>}
 */
const topicPublishStats = new Map();

/**
 * @typedef {{ topic: string, messagesPerSec: number, bytesPerSec: number }} TopicPublishRate
 */

/**
 * @typedef {{
 *   active: boolean,
 *   value: number,
 *   subscriberRatio: number,
 *   publishRate: number,
 *   memoryMB: number,
 *   reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CAPACITY',
 *   topPublishers: TopicPublishRate[]
 * }} PressureSnapshot
 */

/** @type {PressureSnapshot} */
const pressureSnapshot = {
	active: false,
	value: 0,
	subscriberRatio: 0,
	publishRate: 0,
	memoryMB: 0,
	reason: 'NONE',
	topPublishers: []
};

/** @type {Set<(snapshot: PressureSnapshot) => void>} */
const pressureListeners = new Set();

/** @type {Set<(events: TopicPublishRate[]) => void>} */
const publishRateListeners = new Set();

// Throttle the default console.warn output for runaway publishers to one
// message per topic per minute, so a sustained over-threshold publisher
// does not flood the log. Suppressed entirely when at least one
// onPublishRate callback is registered (the user owns the surface).
/** @type {Map<string, number>} */
const lastPublishWarnAt = new Map();

// Soft cap on a single batched WebSocket frame produced by
// platform.publishBatched. Above this size, uWS per-message-deflate may
// kick in (depending on user config) and large frames can surprise
// per-CPU-cycle budgets; we emit a throttled console.warn rather than
// hard-rejecting so the call still delivers. Callers chunk via repeated
// publishBatched calls when the warning fires.
const BATCH_FRAME_WARN_BYTES = 256 * 1024;
let lastBatchOversizeWarnAt = 0;
function warnLargeBatchFrame(size) {
	const t = now();
	if (t - lastBatchOversizeWarnAt < 60000) return;
	lastBatchOversizeWarnAt = t;
	console.warn('[ws] publishBatched frame is ' + size + ' bytes (>' + BATCH_FRAME_WARN_BYTES +
		'). Large frames may trip per-message-deflate and surprise CPU budgets. ' +
		'Consider chunking the batch into multiple publishBatched calls.' +
		'\n  See: https://svti.me/publish-batched');
}

/** @type {ReturnType<typeof setInterval> | null} */
let pressureTimer = null;

/**
 * Module-level holder for the live protection posture. Null until the upgrade
 * handler instantiates one (it needs the closure-local admission gate and the
 * resolved gate ceiling). samplePressure ticks it; the platform getter reads
 * its level. Stays null - and every read is a cheap null check - in the
 * zero-config deployment that never engages a protection posture.
 *
 * @type {ReturnType<typeof createPosture> | null}
 */
let activePosture = null;

/**
 * Default pressure thresholds. Designed to be safe rather than tight: the
 * goal is "no false positives in the steady state of a healthy small app,"
 * not "perfectly tuned for sustained five-figure publish rates." Override
 * per-deployment via the `pressure` field on the WebSocket options.
 */
const DEFAULT_PRESSURE_THRESHOLDS = {
	memoryHeapUsedRatio: 0.85,
	publishRatePerSec: 10000,
	subscriberRatio: 50,
	sampleIntervalMs: 1000,
	// Per-topic runaway-publisher thresholds. A topic that crosses
	// either of these in a sample window fires the configured callback
	// (or a throttled console.warn by default). Both can be set to
	// false to disable per-topic tracking entirely; in that case the
	// hot-path bump is skipped.
	topicPublishRatePerSec: 5000,
	topicPublishBytesPerSec: 10 * 1024 * 1024
};

/**
 * Sample once: read counters, fold them into the snapshot, fire listeners
 * iff `reason` changed. Called by the 1 Hz timer; also extracted so a test
 * harness can drive samples directly without spinning real timers.
 *
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, sampleIntervalMs: number, topicPublishRatePerSec: number | false, topicPublishBytesPerSec: number | false }} thresholds
 */
function samplePressure(thresholds) {
	const interval = thresholds.sampleIntervalMs / 1000;
	const publishRate = interval > 0 ? publishCountWindow / interval : 0;
	publishCountWindow = 0;

	const connections = wsConnections.size;
	const subscriberRatio = connections > 0 ? totalSubscriptions / connections : 0;

	const mem = process.memoryUsage();
	const heapUsedRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
	const memoryMB = mem.rss / (1024 * 1024);

	// Drain per-topic counters into per-second rates. The pure helper
	// reads but does not mutate; we clear the source map after to start
	// the next window fresh.
	const { topPublishers, overThreshold } = computeTopPublishers(
		topicPublishStats, interval, thresholds
	);
	topicPublishStats.clear();

	const reason = computePressureReason(
		{ heapUsedRatio, publishRate, subscriberRatio },
		thresholds
	);
	// Layer the protection posture's CAPACITY reason on top of the pure
	// pressure reason. When no posture is engaged this is byte-identical to
	// the base reason. The level read here is the one the gate enforced during
	// the window just measured; the posture advances for the NEXT sample below.
	const effectiveReason = activePosture !== null
		? applyCapacityReason(reason, activePosture.level)
		: reason;

	// Fold a worker-global 0..1 saturation scalar into `value`. Each active
	// threshold contributes its sample's distance toward the threshold
	// (worst-of), clamped to 0..1; a fully healthy worker reads 0. The worst
	// per-connection send-gate reading observed since the last sample is
	// folded in worst-of too, so a saturated opted-in connection lifts the
	// worker value even while the global counters look calm. The peak is then
	// decayed so a single spike does not stick across samples.
	const value = samplePressureValue(
		{ heapUsedRatio, publishRate, subscriberRatio },
		thresholds,
		leaseSaturationPeak
	);
	leaseSaturationPeak *= 0.5;

	const transitioned = effectiveReason !== pressureSnapshot.reason;
	pressureSnapshot.value = value;
	pressureSnapshot.subscriberRatio = subscriberRatio;
	pressureSnapshot.publishRate = publishRate;
	pressureSnapshot.memoryMB = memoryMB;
	pressureSnapshot.reason = effectiveReason;
	pressureSnapshot.active = effectiveReason !== 'NONE';
	pressureSnapshot.topPublishers = topPublishers;

	// Advance the posture once per sample, AFTER folding the snapshot - the
	// level just read drove this sample's reason; the tick decides the next.
	// Rides the existing pressure timer, so no new timer is introduced. The
	// posture must read the BASE pressure signal, not the CAPACITY-layered one:
	// once the level is engaged, `effectiveReason` is forced to CAPACITY every
	// sample, so feeding the layered activity back would mean the relaxation
	// dwell never sees a calm sample and the level could never relax. The base
	// `reason` is the true load signal that drives both directions.
	if (activePosture !== null) activePosture.tick({ active: reason !== 'NONE' });

	if (transitioned) {
		for (const cb of pressureListeners) {
			try {
				cb(pressureSnapshot);
			} catch (err) {
				console.error('[pressure] listener threw:', err);
			}
		}
	}

	if (overThreshold.length > 0) {
		if (publishRateListeners.size > 0) {
			for (const cb of publishRateListeners) {
				try {
					cb(overThreshold);
				} catch (err) {
					console.error('[pressure] publish-rate listener threw:', err);
				}
			}
		} else {
			// Default: throttled console.warn per topic so a sustained
			// runaway does not flood the log. Suppressed entirely when
			// the user has registered an onPublishRate callback - they
			// own the surface at that point.
			const t = now();
			for (const e of overThreshold) {
				const last = lastPublishWarnAt.get(e.topic) || 0;
				if (t - last < 60_000) continue;
				// FIFO-evict the oldest entry once at cap. Pure dedup
				// state, so dropping the oldest just resets the warn
				// throttle for that topic on its next over-threshold
				// publish - no correctness impact.
				if (lastPublishWarnAt.size >= PUBLISH_WARN_DEDUP_MAX && !lastPublishWarnAt.has(e.topic)) {
					const oldest = lastPublishWarnAt.keys().next().value;
					if (oldest !== undefined) lastPublishWarnAt.delete(oldest);
				}
				lastPublishWarnAt.set(e.topic, t);
				console.warn(
					'[ws] runaway publisher topic=%s msg/s=%d bytes/s=%d\n  See: https://svti.me/pressure',
					e.topic, Math.round(e.messagesPerSec), Math.round(e.bytesPerSec)
				);
			}
		}
	}
}

/**
 * Size the next send-gate window for an opted-in connection. Derived from the
 * same inputs that drive pressure: heap headroom and subscriber load narrow
 * the window so a tightening worker hands out smaller windows. Zero-config
 * defaults; never user exposed. Always floors to a window large enough that a
 * connection makes forward progress.
 *
 * @returns {{ count: number, ttlMs: number }}
 */
function grantSizeFor() {
	const mem = process.memoryUsage();
	const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
	const conns = wsConnections.size || 1;
	const subRatio = totalSubscriptions / conns;
	const count = leaseGrantSize({ heapRatio, subscriberRatio: subRatio });
	return { count, ttlMs: DEFAULT_GRANT.ttlMs };
}

/**
 * Merge user-supplied pressure options on top of the safe defaults. Each
 * threshold accepts `false` to disable that signal. `sampleIntervalMs` is
 * clamped to a sane minimum to avoid pathological tight-loop sampling if
 * a user passes 0 or a negative number.
 *
 * @param {{ memoryHeapUsedRatio?: number | false, publishRatePerSec?: number | false, subscriberRatio?: number | false, sampleIntervalMs?: number, topicPublishRatePerSec?: number | false, topicPublishBytesPerSec?: number | false } | undefined} opts
 */
function resolvePressureThresholds(opts) {
	const merged = { ...DEFAULT_PRESSURE_THRESHOLDS, ...(opts || {}) };
	if (typeof merged.sampleIntervalMs !== 'number' || merged.sampleIntervalMs < 100) {
		merged.sampleIntervalMs = DEFAULT_PRESSURE_THRESHOLDS.sampleIntervalMs;
	}
	return merged;
}

/**
 * Start the 1 Hz pressure sampler. Idempotent: a second call replaces the
 * existing timer with a new one using the supplied thresholds.
 *
 * @param {Parameters<typeof resolvePressureThresholds>[0]} opts
 */
function startPressureSampling(opts) {
	const thresholds = resolvePressureThresholds(opts);
	if (pressureTimer) clearIntervalTimer(pressureTimer);
	pressureTimer = setIntervalTimer(() => samplePressure(thresholds), thresholds.sampleIntervalMs);
	if (typeof pressureTimer.unref === 'function') pressureTimer.unref();
}

function stopPressureSampling() {
	if (pressureTimer) {
		clearIntervalTimer(pressureTimer);
		pressureTimer = null;
	}
}

/**
 * True when `ref` is a usable handle for subscribe acks. Numeric refs
 * are the canonical client-side shape; strings are accepted so external
 * clients that ID their requests with UUIDs interop without translation.
 *
 * @param {unknown} ref
 * @returns {ref is number | string}
 */
function hasRef(ref) {
	return typeof ref === 'number' || typeof ref === 'string';
}

/**
 * Run the user's subscribe hook (if any) and translate its return value
 * into either `null` (allow) or a string denial reason. The hook may
 * return `false` (deny with the default `'FORBIDDEN'`), a string (use
 * that string verbatim as the reason - the framework recognises
 * `'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_TOPIC' | 'RATE_LIMITED'`
 * but does not enforce the enum), or anything else (allow). Async hooks
 * are supported: the return value is awaited before its truthiness is
 * inspected, so `async () => false` denies just like `() => false`.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @returns {Promise<string | null>}
 */
async function runSubscribeHook(ws, topic) {
	if (!wsModule.subscribe) return null;
	try {
		const result = await wsModule.subscribe(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
		if (result === false) return 'FORBIDDEN';
		if (typeof result === 'string') return result;
		return null;
	} catch (err) {
		// Fail closed: a hook that throws (or rejects) denies access
		// rather than falling through to allow. Surfaces as a canonical
		// 'INTERNAL_ERROR' reason on the wire so the client can distinguish
		// it from 'FORBIDDEN' / 'UNAUTHENTICATED' / etc. Logging the actual
		// error keeps the cause visible without blowing up the message handler.
		console.error('[ws] subscribe hook threw:', err);
		return 'INTERNAL_ERROR';
	}
}

/**
 * Run the user's `subscribeBatch` hook (if any) once for an entire
 * batch of pre-validated topics. Returns a normalized denial map -
 * each entry is either a string denial reason or absent (= allow).
 * Returns `null` when no batch hook is exported, signalling the caller
 * to fall back to the per-topic `subscribe` hook (or open access).
 *
 * The user hook returns a `Record<string, boolean | string>` where
 * `false` means FORBIDDEN, a string is the verbatim reason, and any
 * other value (or absent key) means allow. Returning `undefined` or
 * an empty object both mean "allow everything". Async hooks are
 * supported: the returned map is awaited before its entries are read.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string[]} topics
 * @returns {Promise<Record<string, string> | null>}
 */
async function runSubscribeBatchHook(ws, topics) {
	if (!wsModule.subscribeBatch) return null;
	let result;
	try {
		result = await wsModule.subscribeBatch(ws, topics, { platform: ws.getUserData()[WS_PLATFORM] });
	} catch (err) {
		// Fail closed: deny every topic in the batch with 'INTERNAL_ERROR'
		// so a throwing (or rejecting) hook cannot let unauthorized
		// subscribes through.
		console.error('[ws] subscribeBatch hook threw:', err);
		/** @type {Record<string, string>} */
		const failed = {};
		for (let i = 0; i < topics.length; i++) failed[topics[i]] = 'INTERNAL_ERROR';
		return failed;
	}
	/** @type {Record<string, string>} */
	const denials = {};
	if (!result || typeof result !== 'object') return denials;
	for (const [topic, val] of Object.entries(result)) {
		if (val === false) denials[topic] = 'FORBIDDEN';
		else if (typeof val === 'string') denials[topic] = val;
		// truthy / true / undefined -> allow (skip)
	}
	return denials;
}

/**
 * Run the user's subscribe-hook chain for a single topic, mirroring the
 * precedence the wire-level subscribe-batch handler uses: if `subscribeBatch`
 * is exported, treat the single subscribe as a 1-element batch and route
 * through it; otherwise fall back to the per-topic `subscribe` hook. This
 * way a user who exports only `subscribeBatch` for centralized auth gets
 * their gate fired for individual subscribes too - not just batch frames.
 *
 * Used by `platform.subscribe`, `platform.checkSubscribe`, and the wire-
 * level single-subscribe path so all three entry points share one decision
 * function. Fail-closed semantics inherited from the helpers above.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @returns {Promise<string | null>}
 */
async function runUserSubscribeGate(ws, topic) {
	const batchDenials = await runSubscribeBatchHook(ws, [topic]);
	if (batchDenials !== null) {
		return batchDenials[topic] ?? null;
	}
	return await runSubscribeHook(ws, topic);
}

/**
 * Send a `subscribed` ack frame to the client when it provided a `ref`
 * with its subscribe op. No frame goes out for ref-less subscribes
 * (old clients) so backward compatibility is preserved.
 *
 * Carries the topic's current seq-space generation as `epoch` so a later
 * resume can tell whether the seq space it last saw still exists. The
 * value comes from the per-connection platform's `topicEpoch(topic)`: a
 * single worker returns the one per-process generation for every topic,
 * while a backend with its own per-topic seq authority (a shared store)
 * returns that topic's stored generation - so the same wire field carries
 * the right value per deployment with no wire change. The extra key is
 * additive: an old client ignores it and behaves exactly as before.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @param {number | string | null} ref
 */
function sendSubscribed(ws, topic, ref) {
	if (ref === null) return;
	// epoch is an additive best-effort field. A throw in the live topicEpoch
	// delegate (a per-topic store authority can be wired here in a cluster)
	// must not block the ack or be charged to closedWsAborts - that counter is
	// strictly for a closed-socket send failure. Fall back to PROCESS_EPOCH and
	// still send the ack.
	let epoch = processEpoch();
	try {
		const p = ws.getUserData()[WS_PLATFORM];
		if (p && typeof p.topicEpoch === 'function') epoch = p.topicEpoch(topic);
	} catch { epoch = processEpoch(); }
	const payload = JSON.stringify({ type: 'subscribed', topic, ref, epoch });
	try { ws.send(payload, false, false); } catch { closedWsAborts++; return; }
	bumpOut(ws, payload);
}

/**
 * Send a `subscribe-denied` ack frame. Same back-compat rule as
 * `sendSubscribed` - silent when the client did not supply a `ref`.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @param {string} reason
 */
function sendSubscribeDenied(ws, topic, ref, reason) {
	if (ref === null) return;
	const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
	try { ws.send(payload, false, false); } catch { closedWsAborts++; return; }
	bumpOut(ws, payload);
}

/**
 * Drain any pending coalesce-by-key messages on a single connection.
 * Serializes lazily: only the surviving (latest) value per key pays
 * JSON.stringify cost.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 */
function flushCoalescedFor(ws) {
	let userData;
	try { userData = ws.getUserData(); }
	catch { closedWsAborts++; return; }
	const pending = userData[WS_COALESCED];
	if (!pending || pending.size === 0) return;
	assert(pending instanceof Map, 'coalesce.pending-type', null);
	let aborted = false;
	drainCoalesced(pending, (msg) => {
		if (aborted) return 2;
		assert(typeof msg.topic === 'string', 'coalesce.entry-topic-type', null);
		assert(typeof msg.event === 'string', 'coalesce.entry-event-type', null);
		const payload = envelopePrefix(msg.topic, msg.event) + JSON.stringify(msg.data ?? null) + '}';
		let result;
		try { result = ws.send(payload, false, false); }
		catch {
			// Socket closed mid-drain. There will be no further `drain`
			// event to retry on, so dropping the rest of the buffer is
			// the only correct outcome - returning 1 (BACKPRESSURE) lets
			// drainCoalesced clear the current entry and stop iterating.
			closedWsAborts++;
			aborted = true;
			return 1;
		}
		// `result` MUST propagate to drainCoalesced. 0=SUCCESS removes the
		// entry; 1=BACKPRESSURE removes it and halts the loop; 2=DROPPED
		// retains the entry for retry on next drain. Don't refactor away
		// the explicit return - a previous refactor did and silently lost
		// every DROPPED message.
		if (result !== 2) bumpOut(ws, payload);
		return result;
	});
	if (aborted) pending.clear();
}

// - Binary wire (0x03) capability accounting + topic-id assignment ----------
// A connection opts into a binary plugin codec by advertising the codec's
// capability token in its `hello` frame (stored in WS_CAPS). capCounts tracks
// how many live connections advertised each token, so platform.publishWire
// takes a zero-cost JSON fast path when no connected client wants binary for a
// codec - a JSON-only deployment never enters the per-subscriber walk. The
// id-allocation, announce-frame, and cap-counting primitives are shared with
// the test / dev platforms via ./wire.js so the id space is identical.
const capCounts = createCapCounts();

/**
 * Resolve (allocating on first use) the per-connection binary topic-id for a
 * topic. On a fresh assignment, announce the `name -> id` mapping to the
 * client in a `{type:'wire-id'}` control frame so an inbound `0x03` frame's
 * numeric id resolves back to the topic name. The announce rides the same
 * socket immediately before the first binary frame for the topic, so ordering
 * guarantees the client records the mapping first - no ack/frame race.
 * Per-connection and reset on reconnect (a reconnect is a new connection with
 * fresh userData).
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {string} topic
 * @returns {number}
 */
function ensureWireId(ws, ud, topic) {
	const { id, isNew } = allocWireId(ud, WS_TOPIC_IDS, topic);
	if (isNew) {
		const announce = wireIdAnnounce(topic, id);
		try { ws.send(announce, false, false); } catch { closedWsAborts++; return id; }
		bumpOut(ws, announce);
	}
	return id;
}

/**
 * Resolve (allocating on first use) the per-connection state object for a
 * stateful wire codec, stored under the codec's capability in the
 * `WS_WIRE_STATE` slot. The codec's `wire.state.onAttach(ws)` factory runs once
 * per (connection, capability) - the decision it makes (e.g. which schema
 * version this connection negotiated, read from its `WS_CAPS`) is then fixed for
 * the life of the connection. A factory that throws or returns null degrades
 * that connection to JSON for the frame rather than crashing the publish.
 * Returns null for a stateless codec (no `wire.state`) or on attach failure.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {{ capability: string, state?: { onAttach: (ws: any) => any, onDetach?: (ws: any, state: any) => void } }} wire
 * @returns {any}
 */
function ensureWireState(ws, ud, wire) {
	if (!wire.state) return null;
	let m = ud[WS_WIRE_STATE];
	if (!m) {
		m = new Map();
		ud[WS_WIRE_STATE] = m;
	}
	let entry = m.get(wire.capability);
	if (entry === undefined) {
		let state = null;
		try {
			state = wire.state.onAttach(ws);
		} catch (err) {
			if (wsDebug) console.error('[ws] wire.state.onAttach threw for', wire.capability, err);
			state = null;
		}
		entry = { state, detach: wire.state.onDetach };
		m.set(wire.capability, entry);
	}
	return entry.state;
}

/**
 * Dispose every per-connection wire-codec state on close. Mirrors the
 * `capCounts.adjust(..., null)` release: a codec that holds resources (or just
 * wants its dictionary freed promptly) gets its `onDetach(ws, state)` called
 * exactly once. Safe to call when no stateful codec ever ran.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 */
function detachWireStates(ws, ud) {
	const m = ud[WS_WIRE_STATE];
	if (!m) return;
	for (const entry of m.values()) {
		if (entry && typeof entry.detach === 'function') {
			try { entry.detach(ws, entry.state); } catch (err) {
				if (wsDebug) console.error('[ws] wire.state.onDetach threw', err);
			}
		}
	}
	m.clear();
}

// The hybrid logical clock the platform projects as `platform.hlc()`. One
// per-process instance; its wall component is non-decreasing and a logical
// tiebreaker disambiguates same-millisecond and backward-step reads. Read only
// when an event needs a causal stamp, never on the per-publish hot path.
const readHlc = createHlc();

/** @type {import('./index.js').Platform} */
const platform = {
	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 * Auto-wraps in a { topic, event, data } envelope that the client store understands.
	 * No-op if no clients are subscribed - safe to call unconditionally.
	 */
	publish(topic, event, data, options) {
		publishCountWindow++;
		const seq = (options && options.seq === false)
			? null
			: nextTopicSeq(topicSeqs, topic);
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
		assert(envelope.length > 0, 'envelope.empty', { topic, event });
		// Per-topic counter for runaway-publisher detection. Allocates
		// one entry per topic on first publish, then mutates two int
		// fields in place forever. Sampler drains and resets at 1 Hz.
		let s = topicPublishStats.get(topic);
		if (!s) {
			s = { m: 0, b: 0 };
			topicPublishStats.set(topic, s);
			// Cold path: a brand-new topic just entered the registry. Cheap
			// place to check the topic-cardinality warn threshold without
			// touching the steady-state hot path.
			maybeWarnTopicRegistry();
		} else {
			assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape', { topic });
		}
		s.m++;
		s.b += envelope.length;
		// Compress this text frame when a compressor is configured; opt out per
		// call with `{ compress: false }` (e.g. a very high-rate text topic where
		// the per-subscriber deflate CPU would outweigh the bandwidth saving).
		const compress = WS_COMPRESSION_ON && (!options || options.compress !== false);
		const result = app.publish(topic, envelope, false, compress);
		// Relay to other workers via main thread (no-op in single-process mode).
		// Pass { relay: false } when the message originates from an external
		// pub/sub source (Redis, Postgres, etc.) that already fans out to
		// every process - relaying would cause duplicate delivery.
		const relayed = !!(parentPort && (!options || options.relay !== false));
		if (relayed) {
			batchRelay(topic, envelope, compress);
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
	send(ws, topic, event, data, options) {
		const payload = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		assert(payload.length > 0, 'envelope.send-empty', { topic, event });
		const compress = WS_COMPRESSION_ON && (!options || options.compress !== false);
		// `ws.send` throws on a freed native handle (callers may reach
		// here after an `await` that outlasted the socket). Return 2
		// (DROPPED, the uWS sentinel) so callers can pattern-match
		// without distinguishing closed from backpressure-dropped.
		let result;
		try { result = ws.send(payload, false, compress); }
		catch { closedWsAborts++; return 2; }
		bumpOut(ws, payload);
		return result;
	},

	/**
	 * Publish via a plugin-declared binary wire codec. Binary-capable
	 * subscribers (those that advertised `wire.capability`) receive a `0x03`
	 * frame; everyone else receives the identical JSON envelope `publish()`
	 * would have sent. When no connected client advertises the capability - or
	 * the codec declines this frame (`encode` returns null) - this takes the
	 * exact single `app.publish` JSON fan-out with no per-subscriber walk, so a
	 * JSON-only deployment pays nothing for the binary machinery.
	 *
	 * The framework owns the `0x03 | schemaVersion | topicId | seq | payload`
	 * envelope; the plugin's `encode` produces only the payload. seq is stamped
	 * once and carried in both the JSON and binary forms so resume keeps working.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: (event: string, data: any) => (Uint8Array | null) }} wire
	 * @param {{ seq?: boolean, relay?: boolean, compress?: boolean }} [options] -
	 *   `compress: true` opts this codec's frames (binary and JSON fallback) into
	 *   permessage-deflate when a compressor is configured; binary frames are
	 *   uncompressed by default (the cursor hot path leaves it off).
	 * @returns {boolean}
	 */
	publishWire(topic, event, data, wire, options) {
		publishCountWindow++;
		const seq = (options && options.seq === false)
			? null
			: nextTopicSeq(topicSeqs, topic);
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
		assert(envelope.length > 0, 'envelope.empty', { topic, event });
		let s = topicPublishStats.get(topic);
		if (!s) {
			s = { m: 0, b: 0 };
			topicPublishStats.set(topic, s);
			maybeWarnTopicRegistry();
		} else {
			assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape', { topic });
		}
		s.m++;
		s.b += envelope.length;

		const relayed = !!(parentPort && (!options || options.relay !== false));

		// Binary codec frames (and this call's JSON-fallback frames) compress only
		// when the codec/plugin opts in with `{ compress: true }` AND a compressor
		// is configured. One decision governs the whole call so a plugin's intent
		// (cursor: off, the 60 Hz hot path; presence: on, a low-frequency roster)
		// applies to its binary and JSON-fallback frames alike. Off by default
		// keeps the hot path uncompressed.
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);

		// JSON fast path: no live connection wants binary for this codec. Byte-
		// and instruction-identical to platform.publish - a JSON-only deployment
		// never enters the per-subscriber walk or touches the codec at all.
		if (!capCounts.has(wire.capability)) {
			const result = app.publish(topic, envelope, false, compress);
			if (relayed) batchRelay(topic, envelope);
			return result || relayed;
		}

		const seqOnWire = seq == null ? 0 : seq;

		// Stateful codec (per-connection dictionary / apply-state): the encoded
		// payload depends on the recipient's state, so encode-once-send-many no
		// longer holds for the binary recipients - each capable connection is
		// encoded against its own state. Connections whose onAttach returned null
		// (e.g. an older client that negotiated the stateless schema) share one
		// encode at `wire.schemaVersion`, memoized by topic-id, so a mixed room
		// keeps the single-encode fan-out for those clients.
		if (wire.state) {
			let sharedPayload;
			let sharedEncoded = false;
			/** @type {Map<number, Uint8Array>} */
			const sharedFrameById = new Map();
			for (const ws of wsConnections) {
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has(wire.capability)) {
					try { ws.send(envelope, false, compress); } catch { closedWsAborts++; }
					continue;
				}
				const state = ensureWireState(ws, ud, wire);
				if (state == null) {
					// Shared encode-once at the codec's baseline schema version.
					if (!sharedEncoded) { sharedPayload = wire.encode(event, data, null); sharedEncoded = true; }
					if (sharedPayload == null) { try { ws.send(envelope, false, compress); } catch { closedWsAborts++; } continue; }
					const id = ensureWireId(ws, ud, topic);
					let frame = sharedFrameById.get(id);
					if (!frame) { frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, sharedPayload); sharedFrameById.set(id, frame); }
					try { ws.send(frame, true, compress); } catch { closedWsAborts++; }
				} else {
					// Per-connection encode against this connection's state, stamped
					// with the schema version that state negotiated.
					const payload = wire.encode(event, data, state);
					if (payload == null) { try { ws.send(envelope, false, compress); } catch { closedWsAborts++; } continue; }
					const sv = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
					const frame = buildBinaryFrame(sv, ensureWireId(ws, ud, topic), seqOnWire, payload);
					try { ws.send(frame, true, compress); } catch { closedWsAborts++; }
				}
			}
			if (relayed) batchRelay(topic, envelope);
			return true;
		}

		// Stateless codec: encode once, send many. A null payload (the codec
		// declined this frame) falls through to the single C++ app.publish
		// fan-out, instruction-identical to platform.publish. The codec payload
		// is shared across recipients; only the tiny per-connection frame header
		// (topic-id + seq) differs, memoized per distinct id so the common
		// all-same-id case builds one frame and reuses it for every binary send.
		const payload = wire.encode(event, data);
		if (payload == null) {
			const result = app.publish(topic, envelope, false, compress);
			if (relayed) batchRelay(topic, envelope);
			return result || relayed;
		}
		/** @type {Map<number, Uint8Array>} */
		const frameById = new Map();
		for (const ws of wsConnections) {
			let ud;
			try { ud = ws.getUserData(); } catch { continue; }
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || !subs.has(topic)) continue;
			const caps = ud[WS_CAPS];
			if (caps && caps.has(wire.capability)) {
				const id = ensureWireId(ws, ud, topic);
				let frame = frameById.get(id);
				if (!frame) {
					frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload);
					frameById.set(id, frame);
				}
				try { ws.send(frame, true, compress); } catch { closedWsAborts++; }
			} else {
				try { ws.send(envelope, false, compress); } catch { closedWsAborts++; }
			}
		}
		// Cross-worker subscribers receive the JSON envelope (binary is
		// same-worker only); their worker re-publishes it to them as JSON.
		if (relayed) batchRelay(topic, envelope);
		if (wsDebug) {
			console.log('[ws] publishWire topic=%s event=%s payloadBytes=%d', topic, event, payload.length);
		}
		return true;
	},

	/**
	 * Single-target send via a plugin-declared binary wire codec. The target
	 * receives a `0x03` frame when it advertised `wire.capability` and the
	 * codec can encode this frame; otherwise it receives the JSON envelope
	 * `send()` would have sent. No seq is stamped (matches `send()`); the
	 * binary frame carries seq 0 ("no seq"). Used for snapshot/catalog frames.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: (event: string, data: any) => (Uint8Array | null) }} wire
	 * @param {{ compress?: boolean }} [options] - `{ compress: true }` opts this
	 *   low-frequency binary frame into permessage-deflate when a compressor is
	 *   configured (binary frames are uncompressed by default).
	 * @returns {number} uWS send status (0/1/2), or 2 on a freed handle
	 */
	sendWire(ws, topic, event, data, wire, options) {
		let ud;
		try { ud = ws.getUserData(); } catch { closedWsAborts++; return 2; }
		const caps = ud[WS_CAPS];
		// Binary codec frames compress only when the codec/plugin opts in with
		// `{ compress: true }` AND a compressor is configured. The high-frequency
		// hot path (cursor) leaves this off; low-frequency frames (presence) opt in.
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		let payload = null;
		let schemaVersion = wire.schemaVersion;
		if (caps && caps.has(wire.capability)) {
			if (wire.state) {
				// Share the connection's codec state with publishWire so a
				// snapshot CATALOG interns ids the following BULK (and every
				// later broadcast) references against the same dictionary.
				const state = ensureWireState(ws, ud, wire);
				payload = wire.encode(event, data, state);
				if (state != null && typeof state.schemaVersion === 'number') schemaVersion = state.schemaVersion;
			} else {
				payload = wire.encode(event, data);
			}
		}
		if (payload == null) {
			const json = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
			let result;
			try { result = ws.send(json, false, compress); } catch { closedWsAborts++; return 2; }
			bumpOut(ws, json);
			return result;
		}
		const id = ensureWireId(ws, ud, topic);
		const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
		let result;
		try { result = ws.send(frame, true, compress); } catch { closedWsAborts++; return 2; }
		bumpOut(ws, frame);
		return result;
	},

	/**
	 * Send a message to a single connection with coalesce-by-key semantics.
	 *
	 * Each (ws, key) pair holds at most one pending message. If a newer
	 * sendCoalesced for the same key arrives before the previous one drains
	 * out to the wire, the older message is dropped in place: latest value
	 * wins, original insertion order is preserved.
	 *
	 * Use for latest-value streams where intermediate values are noise:
	 * price ticks, cursor positions, presence state, typing indicators,
	 * scroll/scrub positions. For at-least-once delivery use send() or
	 * publish() instead.
	 *
	 * Serialization is deferred to the actual flush, so a stream that
	 * overwrites the same key 1000 times before a single drain pays only
	 * one JSON.stringify, not 1000.
	 *
	 * The flush attempts immediately and again on every uWS drain event.
	 * On BACKPRESSURE or DROPPED from ws.send, pumping stops and resumes
	 * on the next drain.
	 */
	sendCoalesced(ws, { key, topic, event, data }) {
		let userData;
		try { userData = ws.getUserData(); }
		catch { closedWsAborts++; return; }
		let pending = userData[WS_COALESCED];
		if (!pending) {
			pending = new Map();
			userData[WS_COALESCED] = pending;
		}
		assert(pending instanceof Map, 'coalesce.userdata-pending-type', null);
		// At cap with a brand-new key: drop the oldest insertion-order
		// entry. sendCoalesced is latest-value-wins by contract, so an
		// evicted oldest is simply a value the caller already replaced
		// with a fresher write under the same key (or, with unbounded
		// distinct keys, the caller is leaking and the oldest-pending
		// is the most stale value to lose).
		if (pending.size >= MAX_COALESCED_KEYS_PER_CONNECTION && !pending.has(key)) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		pending.set(key, { topic, event, data });
		flushCoalescedFor(ws);
	},

	/**
	 * Send a message to connections matching a filter.
	 * The filter receives each connection's userData (from the upgrade handler)
	 * and must return synchronously. An async filter is treated as
	 * fail-closed (the message is NOT sent to that connection) and a
	 * one-time warning is logged. Filters that touch a database or session
	 * store should resolve that data eagerly into `userData` from the
	 * `upgrade` hook, not from inside the filter.
	 *
	 * Returns the number of connections the message was sent to.
	 */
	sendTo(filter, topic, event, data, options) {
		const envelope = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		// Opt-in compression (default off): sendTo frames target a filtered
		// recipient set and are often one-off, so the safe default is
		// uncompressed. Pass { compress: true } to deflate for a large fan-out.
		// No-op while websocket.compression is off (the default).
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		let count = 0;
		for (const ws of wsConnections) {
			// uWS's close event fires synchronously and removes from
			// wsConnections before any user code runs, so under normal
			// flow every entry here is open. Defensive try/catch covers
			// pathological cases (e.g. user filter triggers a close via
			// side effect, or another worker raced through cleanup).
			let userData;
			try { userData = ws.getUserData(); }
			catch { closedWsAborts++; continue; }
			const decision = filter(userData);
			if (decision && typeof decision.then === 'function') {
				if (!sendToAsyncWarned) {
					sendToAsyncWarned = true;
					console.error(
						'[ws] platform.sendTo filter returned a Promise; treating as fail-closed.\n' +
						'  Async filters cannot be used here because sendTo iterates every active\n' +
						'  connection synchronously. Resolve the relevant fields into userData from\n' +
						'  your `upgrade` hook so the filter can read them synchronously.\n' +
						'  See: https://svti.me/sendto-async'
					);
				}
				continue;
			}
			if (decision) {
				try { ws.send(envelope, false, compress); }
				catch { closedWsAborts++; continue; }
				bumpOut(ws, envelope);
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
	 * Per-category counter of framework invariant violations. The
	 * returned value is the live `Map<string, number>` shared across
	 * the worker process - read-only, do not mutate. Categories follow
	 * a `<area>.<thing>` convention (e.g. `'envelope.malformed'`,
	 * `'ws.platform-missing'`, `'relay.topic-type'`).
	 *
	 * Most apps will see this map empty for the lifetime of the
	 * process; non-empty entries indicate a regression in the
	 * framework or a third-party plugin and should be reported as a
	 * GitHub issue with the category string. The structured
	 * `[adapter-uws/assert]` log lines accompanying each violation
	 * carry the context payload needed to reproduce.
	 *
	 * @returns {Map<string, number>}
	 */
	get assertions() {
		return readAssertionCounts();
	},

	/**
	 * Per-worker count of best-effort uWS operations that aborted
	 * because the underlying WebSocket had already closed.
	 *
	 * Ws-targeted platform methods (`subscribe`, `unsubscribe`, `send`,
	 * `sendCoalesced`, `sendTo`, `request`) and the wire-level
	 * subscribe / subscribe-batch handlers all swallow uWS's "Invalid
	 * access of closed uWS.WebSocket" exception so callers never need
	 * a per-site try/catch. Each swallow bumps this counter.
	 *
	 * A non-zero value is normal under churn (clients close mid-async-
	 * setup all the time). A rapidly-growing value under steady load
	 * indicates either pathological client behaviour or that the
	 * server's async setup path is too long for its connect rate -
	 * worth investigating but not, by itself, a bug.
	 *
	 * Monotonic, per-worker, reset only on process restart.
	 *
	 * @returns {number}
	 */
	get closedWsAborts() {
		return closedWsAborts;
	},

	/**
	 * Number of clients subscribed to a specific topic.
	 */
	subscribers(topic) {
		return app.numSubscribers(topic);
	},

	/**
	 * Invoke `fn(ws, userData)` once for every connection currently
	 * subscribed to `topic`, on THIS instance. Where `subscribers(topic)`
	 * returns a count, this yields the sockets themselves so a plugin can
	 * make a per-subscriber decision the shared `publish` fan-out cannot:
	 * send a culled / per-viewport slice, skip a back-pressured consumer,
	 * or vary the payload per recipient.
	 *
	 * Cost is O(connections) and is paid only by the caller, so reserve it
	 * for topics that genuinely need per-subscriber treatment (a high-fan-
	 * out cursor topic with viewport culling); the zero-config publish path
	 * never calls it. The walk is synchronous and matches the subscriber
	 * walk `publishBatched` already performs; pair it with `platform.send`
	 * (closed-WS safe) and `platform.bufferedAmount` inside `fn`.
	 *
	 * Cluster note: each instance holds only its own connections, so this
	 * walks the local subscriber set. A topic whose subscribers span
	 * instances is handled per-instance - the same locality the Redis-
	 * backed cursor / presence variants already rely on.
	 *
	 * @param {string} topic
	 * @param {(ws: import('uWebSockets.js').WebSocket<any>, userData: any) => void} fn
	 * @returns {void}
	 */
	forEachSubscriber(topic, fn) {
		for (const ws of wsConnections) {
			const ud = ws.getUserData();
			const subs = ud[WS_SUBSCRIPTIONS];
			if (subs && subs.has(topic)) fn(ws, ud);
		}
	},

	/**
	 * The configured maximum size, in bytes, of a single inbound WebSocket
	 * frame. Frames larger than this are rejected by uWS at the protocol
	 * level (the connection is closed). Read this from server-side code
	 * (RPC frameworks, upload primitives, chunked stream protocols) to
	 * size payloads against the actual cap rather than guessing or
	 * piggybacking the value on the wire.
	 *
	 * Configured via `websocket.maxPayloadLength` in svelte.config.js;
	 * defaults to 1 MB.
	 *
	 * @example
	 * ```js
	 * // svelte-realtime live.upload sizing chunks below the cap:
	 * const chunkSize = Math.floor(platform.maxPayloadLength * 0.9);
	 * ```
	 */
	get maxPayloadLength() {
		return WS_OPTIONS?.maxPayloadLength ?? (1024 * 1024);
	},

	/**
	 * Bytes currently queued on `ws` that uWS has accepted but not yet
	 * flushed to the OS socket buffer. Returns 0 for closed connections.
	 *
	 * Use this for backpressure-aware sends (skip / coalesce / pace when
	 * the queue is large) and per-connection memory-pressure telemetry.
	 * Reads cleanly through `ws.getBufferedAmount()` - one C++ call,
	 * constant-time, safe to call on every send.
	 *
	 * @example
	 * ```js
	 * // Skip publish to slow consumer above 4 MB queued:
	 * if (platform.bufferedAmount(ws) > 4 * 1024 * 1024) return;
	 * platform.send(ws, topic, event, data);
	 * ```
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @returns {number}
	 */
	bufferedAmount(ws) {
		try { return ws.getBufferedAmount(); } catch { return 0; }
	},

	/**
	 * Subscribe a connection to a topic from server-side code, running the
	 * user's `hooks.ws.subscribe` authorization hook first.
	 *
	 * Use this from any server-side path that needs to subscribe a
	 * connection on the user's behalf - RPC handlers, framework
	 * integration layers, plugins - to inherit the centralized
	 * `hooks.ws.subscribe` authorization gate. Calling `ws.subscribe(topic)`
	 * directly bypasses the gate: the wire-level subscribe hook fires only
	 * for `{type:'subscribe'}` and `{type:'subscribe-batch'}` wire frames,
	 * not for direct uWS API calls. Always route server-initiated
	 * subscriptions through this method when centralized authorization
	 * matters (data-leak risk: the loader / RPC response runs before the
	 * client's eventual wire-level subscribe is denied).
	 *
	 * Returns `null` on success, or a denial reason string on failure
	 * (`'INVALID_TOPIC'`, `'RATE_LIMITED'`, `'FORBIDDEN'`, or any custom
	 * string returned from the user's subscribe hook). On denial, no
	 * subscription is created and internal subscription state is unchanged
	 * - the caller decides how to surface the denial to the client (e.g.
	 * an error reply on the RPC frame).
	 *
	 * Idempotent: calling `subscribe(ws, topic)` twice for the same
	 * `(ws, topic)` returns `null` both times and does not double-charge
	 * the per-worker `totalSubscriptions` counter or trigger the hook a
	 * second time. The cap check fires only on the first subscribe.
	 *
	 * Updates `WS_SUBSCRIPTIONS` and `totalSubscriptions` so observability
	 * (`platform.subscribers(topic)`, `platform.pressure`, the close-hook
	 * `subscriptions` set) stays consistent with client-initiated subscribe
	 * frames.
	 *
	 * Does NOT send a `{type:'subscribed', topic, ref}` ack frame - there
	 * is no client `ref` for a server-initiated subscribe. If the caller
	 * needs to inform the client of the subscription, that is an
	 * application-level concern (typically via the RPC response).
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {string | null} denial reason string or `null` on success
	 */
	async subscribe(ws, topic) {
		// Server-side caller: trust the topic shape past the
		// always-illegal control / quote / backslash bytes. Apps using
		// non-ASCII topic names (`__signal:Jose`, presence rooms with
		// localized labels) must not be blocked at the platform layer.
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		// `ws.getUserData()` throws on a freed native handle. RPC and
		// plugin code paths routinely `await` something else before
		// reaching here, so the WS may already be closed by the time
		// this runs. Treat as a silent no-op.
		let subs;
		try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
		catch { closedWsAborts++; return null; }
		assert(subs instanceof Set, 'subs.shape', null);
		if (subs.has(topic)) return null;
		if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
		const denial = await runUserSubscribeGate(ws, topic);
		if (denial !== null) return denial;
		// Re-check after the await: a concurrent subscribe (wire frame
		// or another platform.subscribe call) may have raced through
		// while we awaited the user hook. Idempotent ack and skip the
		// counter bump in that case.
		if (subs.has(topic)) return null;
		if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
		// `ws.subscribe()` throws if the socket closed during the await
		// above. Under mass-connect / backpressure churn this is the
		// dominant abort mode (10-15% of connections close mid-setup).
		// Swallow, count, and return success-shaped null so callers can
		// fire-and-forget without per-site try/catch.
		try { ws.subscribe(topic); }
		catch { closedWsAborts++; return null; }
		subs.add(topic);
		totalSubscriptions++;
		return null;
	},

	/**
	 * Consult the user's subscribe-hook chain for a single topic without
	 * actually subscribing the connection. Returns `null` to allow or a
	 * string denial reason to deny.
	 *
	 * Use this when the caller wants to make the subscribe decision in one
	 * step and perform the actual `ws.subscribe` later as part of a
	 * different orchestration (e.g. an RPC framework that runs a loader
	 * between authorization and the subscribe, and wants the loader to
	 * fail cleanly without leaving a half-subscribed connection or a
	 * spurious 'join' broadcast).
	 *
	 * Mirrors the wire-level `subscribe-batch` precedence: if the user has
	 * exported `subscribeBatch`, that hook is consulted first (with the
	 * single topic in a 1-element array); otherwise the per-topic
	 * `subscribe` hook is consulted. A user who exports only one of the
	 * two still gets a consistent gate across single and batch entry
	 * points.
	 *
	 * Pure - does not modify subscription state, does not call
	 * `ws.subscribe`, does not increment `totalSubscriptions`. The cap
	 * (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) is NOT consulted here because
	 * no subscription is being created; cap enforcement belongs on the
	 * actual subscribe action. If the caller plans to follow a `null`
	 * return with a `ws.subscribe`, route through `platform.subscribe`
	 * for atomic gate + subscribe + cap + state update instead.
	 *
	 * Async and fail-closed. A throwing (or rejecting) user hook denies
	 * with `'INTERNAL_ERROR'` rather than crashing the caller. Returns a
	 * `Promise` so async user hooks (typically those touching a database
	 * or session store) deny correctly when they return `false`.
	 *
	 * @example
	 * ```js
	 * // Inside a stream-RPC handler that needs to gate before running
	 * // the loader, and subscribe only if the loader succeeds:
	 * const denial = await platform.checkSubscribe(ws, topic);
	 * if (denial) return reply({ id, ok: false, error: denial });
	 * const initial = await loader(args, ws);
	 * ws.subscribe(topic);
	 * onJoin(ws, topic);
	 * reply({ id, ok: true, data: initial, topic });
	 * ```
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {Promise<string | null>} denial reason string or `null` on allow
	 */
	async checkSubscribe(ws, topic) {
		// Server-side caller: same trust as platform.subscribe (see
		// note there). Wire-side gating happens earlier in the message
		// handler with the strict ASCII-only default.
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		return await runUserSubscribeGate(ws, topic);
	},

	/**
	 * Unsubscribe a connection from a topic from server-side code.
	 * Symmetric counterpart to `platform.subscribe()`.
	 *
	 * Idempotent: returns `false` if the connection was not subscribed to
	 * the topic, otherwise removes the subscription, decrements
	 * `totalSubscriptions`, fires `hooks.ws.unsubscribe` (informational, not
	 * a gate - mirrors the wire-level unsubscribe path), and returns
	 * `true`.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {boolean} `true` if a subscription was removed
	 */
	unsubscribe(ws, topic) {
		// Closed sockets get an early-out: there is no subscription
		// state to remove, no uWS bookkeeping to drop, no informational
		// hook to fire. The platform contract is "best effort; no throw
		// on closed WS" - mirrors subscribe / send.
		let subs;
		try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
		catch { closedWsAborts++; return false; }
		assert(subs instanceof Set, 'subs.shape-unsubscribe', null);
		if (!subs.has(topic)) return false;
		try { ws.unsubscribe(topic); }
		catch { closedWsAborts++; return false; }
		subs.delete(topic);
		totalSubscriptions--;
		assert(totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions });
		wsModule.unsubscribe?.(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
		return true;
	},

	/**
	 * Publish multiple messages, returning per-message delivery results.
	 *
	 * NOT wire-level batching: under the hood this is a `for` loop calling
	 * `publish()` once per message, so N submitted messages still produce
	 * N WebSocket frames per subscribed connection. The cross-worker
	 * relay coalesces per microtask (one postMessage no matter how many
	 * publish() calls the loop makes), but the client still pays N
	 * onmessage dispatches.
	 *
	 * For one-frame-per-subscriber wire batching, use `publishBatched()`
	 * instead. Two distinct contracts:
	 *
	 * - `batch(messages)` -> N frames per subscriber, returns boolean[].
	 * - `publishBatched(messages)` -> 1 frame per subscriber (events array),
	 *   returns void; opt-in by client capability ('batch').
	 *
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
	 * Publish a list of `{topic, event, data}` events as a single
	 * `{type:'batch',events:[...]}` WebSocket frame per affected
	 * subscriber. Each subscriber receives only the events whose topics
	 * are in their subscription set, in submitted order. Subscribers
	 * with no overlap with the batch's topics receive nothing.
	 *
	 * Compared to a `publish()` loop, the wire savings are
	 * one-frame-per-subscriber instead of N-frames-per-subscriber. The
	 * benefit grows with N (events per call) and with the
	 * subscriber-set overlap; tiny batches with disjoint topics may pay
	 * a small JS-fanout cost over the C++ TopicTree path used by
	 * `publish()` (the receiver decode is faster regardless).
	 *
	 * Capability gating: clients advertise `'batch'` support via a
	 * `{type:'hello', caps:['batch']}` frame after open. Connections
	 * that have not advertised the capability fall back to N
	 * individual frames automatically - mixing old and new clients in
	 * the same call is safe.
	 *
	 * Per-event seq stamping: every event in the batch is independently
	 * stamped with a per-topic monotonic seq, identical to `publish()`.
	 * Pass `{seq: false}` in an event's `options` to skip stamping for
	 * that one event.
	 *
	 * Cross-worker relay: events are relayed individually through the
	 * existing per-microtask relay path, so receiving workers see N
	 * relayed publishes (not a batched delivery). The wire-level
	 * batching applies to the originating worker's local fanout only.
	 * Pass `{relay: false}` in an event's `options` to skip the relay
	 * for messages that came from an external pub/sub source already
	 * fanning out to every worker.
	 *
	 * Frame-size budget: a batched frame larger than 256 KB triggers a
	 * throttled console warning (uWS per-message-deflate kicks in over
	 * a configurable threshold and large frames may surprise CPU
	 * budgets). Chunk large batches into multiple `publishBatched`
	 * calls to stay under the cap.
	 *
	 * Order guarantee: within one batched frame, events appear in call
	 * order. Across batches, same subscriber-side ordering as today.
	 *
	 * Coalesce interaction (v1): events submitted via `publishBatched`
	 * do NOT interact with `sendCoalesced` per-key replacement. The
	 * batch is delivered as-is, in submitted order, with no coalesce
	 * filtering. Mixing batched topics with sendCoalesced topics on
	 * the same subscriber is supported but the two paths produce
	 * separate frames.
	 *
	 * @example
	 * ```js
	 * platform.publishBatched([
	 *   { topic: 'org:42:items', event: 'updated', data: a },
	 *   { topic: 'org:42:items', event: 'updated', data: b },
	 *   { topic: 'org:42:audit', event: 'created', data: c }
	 * ]);
	 * // Subscribers of org:42:items only -> one frame, two events.
	 * // Subscribers of both topics      -> one frame, three events.
	 * // Subscribers of neither          -> no frame at all.
	 * ```
	 *
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: { relay?: boolean, seq?: boolean } }>} messages
	 * @returns {void}
	 */
	publishBatched(messages, options) {
		if (!Array.isArray(messages) || messages.length === 0) return;

		// Opt-in compression for the whole batch (default off). A batched frame
		// mixes event types, so the safe default is uncompressed; pass
		// { compress: true } to deflate. Applied uniformly to the fast (shared
		// frame) AND slow (per-event) paths so the two are consistent. No-op
		// while websocket.compression is off (the default).
		const compressOptIn = !!(options && options.compress === true);

		// Coalesce-by-key dedup runs first. Events that carry a
		// `coalesceKey` collapse so only the latest value per key
		// survives; events without a key pass through unchanged. This
		// is the same latest-value-wins primitive sendCoalesced offers
		// for streaming sends, lifted into the batched path so a single
		// publishBatched call carrying 100 cursor positions for the
		// same user delivers only the latest.
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;

		// Pick the fanout strategy before allocating per-event envelopes.
		// uWS's C++ TopicTree dispatch via app.publish is genuinely faster
		// than a JS-side per-subscriber loop for mixed-subscriber-set
		// batches; the wire-batching win is real only when every relevant
		// subscriber receives the same event slice. Two such cases:
		//
		//   1. Single-topic batch: every subscriber to that topic gets
		//      every event. Build one shared batch frame.
		//   2. All-see-all: a multi-topic batch where every connection
		//      subscribed to ANY batch topic is subscribed to ALL of
		//      them. Same shared-frame outcome.
		//
		// Otherwise we fall back to per-event publish() so the caller
		// pays no penalty for choosing publishBatched on small / disjoint
		// shapes (verified by `bench/27-publish-batched-ab.mjs`).
		const firstTopic = messages[0].topic;
		let allSameTopic = true;
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
		}

		// Combined detection pass: walk the subscriber set once to
		// determine whether the batch qualifies for the fast path
		// (single-topic or all-see-all) AND whether every interested
		// connection has advertised the 'batch' capability. We need
		// both: the shared-frame fast path is only safe when every
		// recipient can decode the {type:'batch',...} envelope.
		let allSeeAll = true;
		let everyoneCapable = true;
		/** @type {Set<string> | null} */
		let batchTopics = null;
		if (!allSameTopic) {
			batchTopics = new Set();
			for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
		}
		for (const ws of wsConnections) {
			const ud = ws.getUserData();
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || subs.size === 0) continue;
			let touchesAny = false;
			if (allSameTopic) {
				touchesAny = subs.has(firstTopic);
			} else {
				let touchesAll = true;
				for (const t of /** @type {Set<string>} */ (batchTopics)) {
					if (subs.has(t)) touchesAny = true;
					else touchesAll = false;
				}
				if (touchesAny && !touchesAll) { allSeeAll = false; break; }
			}
			if (!touchesAny) continue;
			const caps = ud[WS_CAPS];
			if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
		}

		// Slow-path fallback: per-event publish() so the caller pays
		// no penalty on small / disjoint shapes. Also the safe
		// degradation when any interested subscriber is non-cap-able -
		// they would otherwise receive an unparseable batch frame.
		if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				platform.publish(m.topic, m.event, m.data, { ...m.options, compress: compressOptIn });
			}
			return;
		}

		// Fast path: build per-event envelopes (also stamps seq + bumps
		// per-topic stats), wrap into a shared batch frame, and hand
		// fanout to uWS's C++ TopicTree via app.publish. In all-see-all
		// every interested subscriber is subscribed to every batch
		// topic, so dispatching on any one of them reaches them all.
		/** @type {Array<{ topic: string, env: string }>} */
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			publishCountWindow++;
			const seq = (m.options && m.options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, m.topic);
			const env = completeEnvelope(envelopePrefix(m.topic, m.event), m.data, seq);
			events[i] = { topic: m.topic, env };
			let s = topicPublishStats.get(m.topic);
			if (!s) {
				s = { m: 0, b: 0 };
				topicPublishStats.set(m.topic, s);
				maybeWarnTopicRegistry();
			} else {
				assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape-batch', { topic: m.topic });
			}
			s.m++;
			s.b += env.length;
		}

		// Cross-worker relay: a single 'publish-batched' IPC carrying the
		// pre-built per-event envelopes. The receiving worker re-runs the
		// detection (allSeeAll + everyoneCapable for ITS local subscriber
		// set) and dispatches via its own fast or slow path. This keeps
		// the wire-batching benefit cluster-wide instead of degrading to
		// per-event relays on worker boundaries.
		if (parentPort) {
			const relayed = [];
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				if (!m.options || m.options.relay !== false) {
					relayed.push({ topic: events[i].topic, env: events[i].env });
				}
			}
			if (relayed.length > 0) {
				parentPort.postMessage({ type: 'publish-batched', events: relayed, compress: compressOptIn });
			}
		}

		// Build the shared batch frame once.
		const slice = new Array(events.length);
		for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
		const sharedBatchEnv = wrapBatchEnvelope(slice);
		assert(sharedBatchEnv.length > 0, 'envelope.batch-empty', { events: events.length });
		if (sharedBatchEnv.length > BATCH_FRAME_WARN_BYTES) {
			warnLargeBatchFrame(sharedBatchEnv.length);
		}

		// Hand fanout to uWS's C++ TopicTree. Any batch topic works
		// as the dispatch channel because every interested subscriber
		// is subscribed to every batch topic in the all-see-all case
		// (single-topic is the trivial sub-case).
		const fanoutTopic = allSameTopic ? firstTopic : messages[0].topic;
		const result = app.publish(fanoutTopic, sharedBatchEnv, false, WS_COMPRESSION_ON && compressOptIn);

		if (wsDebug) {
			console.log('[ws] publishBatched events=%d single-topic=%s fanoutTopic=%s delivered=%s',
				events.length, allSameTopic, fanoutTopic, result);
		}
	},

	/**
	 * Send a request to a single connection and await its reply.
	 *
	 * The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`,
	 * and the returned Promise resolves with whatever the client's
	 * `onRequest` handler returns (or rejects with the error string the
	 * client sent back if the handler threw). Rejects with `'request timed out'`
	 * after `timeoutMs` (default 5000), and with `'connection closed'`
	 * if the WebSocket closes before a reply arrives.
	 *
	 * Pending requests live in `WS_PENDING_REQUESTS` on `ws.getUserData()`,
	 * so cleanup is automatic on close - no module-level leak risk.
	 */
	request(ws, event, data, options) {
		let userData;
		try { userData = ws.getUserData(); }
		catch {
			closedWsAborts++;
			return Promise.reject(new Error('connection closed'));
		}
		let pending = userData[WS_PENDING_REQUESTS];
		if (!pending) {
			pending = new Map();
			userData[WS_PENDING_REQUESTS] = pending;
		}
		assert(pending instanceof Map, 'request.pending-type', null);
		if (pending.size >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
			return Promise.reject(new Error(
				'pending requests exceeded ' + MAX_PENDING_REQUESTS_PER_CONNECTION +
				' on this connection'
			));
		}
		const ref = nextRequestRef++;
		const timeoutMs = (options && options.timeoutMs) || 5000;
		return new Promise((resolve, reject) => {
			const timer = setTimer(() => {
				if (pending.delete(ref)) reject(new Error('request timed out'));
			}, timeoutMs);
			pending.set(ref, { resolve, reject, timer });
			const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
			try { ws.send(payload, false, false); }
			catch {
				closedWsAborts++;
				clearTimer(timer);
				pending.delete(ref);
				reject(new Error('connection closed'));
				return;
			}
			bumpOut(ws, payload);
		});
	},

	/**
	 * Live snapshot of worker-local backpressure signals.
	 *
	 * `reason` is one of `'NONE'`, `'PUBLISH_RATE'`, `'SUBSCRIBERS'`,
	 * `'MEMORY'`, `'CAPACITY'`. Precedence is fixed
	 * (MEMORY > CAPACITY > PUBLISH_RATE > SUBSCRIBERS), so a worker under
	 * multiple stresses reports the most urgent one. `'CAPACITY'` appears only
	 * when the protection posture is engaged (`elevated`/`siege`).
	 *
	 * Sampled by a coarse 1 Hz timer. Reading the snapshot is a property
	 * access; no I/O or computation per read. Use `onPressure` for
	 * push-style reaction on transitions.
	 */
	get pressure() {
		return pressureSnapshot;
	},

	/**
	 * Live protection posture: `'normal'`, `'elevated'`, or `'siege'`. Resolves
	 * the operator's `protection` setting against the current pressure; a pinned
	 * value reads back as itself, and an absent setting reads `'normal'`.
	 * Reading is a property access. Governs only NEW-upgrade admission; existing
	 * connections are never affected at any level.
	 */
	get protection() {
		return activePosture !== null ? activePosture.level : 'normal';
	},

	/**
	 * Register a callback fired on each pressure-state transition (when
	 * `reason` changes between samples). Fired at most once per sample
	 * tick. Returns an unsubscribe function.
	 *
	 * Callbacks are invoked synchronously inside the sampler. A throwing
	 * listener does not break the sampler or other listeners; the error
	 * is logged and the next listener still runs.
	 */
	onPressure(cb) {
		pressureListeners.add(cb);
		return () => pressureListeners.delete(cb);
	},

	/**
	 * Register a callback fired once per sample window with the list of
	 * topics whose publish rate has crossed `topicPublishRatePerSec` or
	 * `topicPublishBytesPerSec` for that window. Each entry is
	 * `{ topic, messagesPerSec, bytesPerSec }`. Use this to log,
	 * page on-call, or apply a per-topic backpressure response.
	 *
	 * Registering at least one callback suppresses the default
	 * throttled `console.warn` output - the user owns the surface.
	 * Returns an unsubscribe function.
	 *
	 * @param {(events: TopicPublishRate[]) => void} cb
	 */
	onPublishRate(cb) {
		publishRateListeners.add(cb);
		return () => publishRateListeners.delete(cb);
	},

	/**
	 * Get a scoped helper for a topic - less repetition when publishing
	 * multiple events to the same topic.
	 */
	topic(name) {
		return createScopedTopic(platform.publish, name);
	},

	/**
	 * Current generation of a topic's seq space. The value a reconnecting
	 * client presents on resume is compared against this to decide whether
	 * its old per-topic offset is still valid (gap-fill) or points into a
	 * seq space that has since reset (cold-rehydrate).
	 *
	 * In a single worker the seq counters live in process memory and all
	 * reset together on a restart, so every topic shares the one
	 * per-process generation. A backend with its own per-topic seq
	 * authority (a shared store) overrides this with a per-topic value of
	 * the same shape.
	 *
	 * @param {string} topic
	 * @returns {number}
	 */
	topicEpoch(topic) {
		void topic;
		return processEpoch();
	},

	// Clock and RNG exposed through the same injectable runtime module the
	// adapter itself reads, so plugins and app code share one swappable source
	// a controlled harness can seed. Plain references to the imported helpers;
	// per-connection/request platform clones inherit them via the prototype.
	now: now,
	monotonic: monotonicNow,
	random: {
		float: randomFloat,
		u32: randomU32,
		uuid: randomUuid,
		bytes: randomBytes
	},
	// Causal stamp for events that must order consistently across workers
	// (or across a coarse / briefly-backward wall clock). Reads the injectable
	// runtime clock for its wall component and keeps it non-decreasing with a
	// logical tiebreaker. Only called when an event needs a stamp, so the
	// per-publish hot path stays untouched.
	hlc: readHlc
};

// - Origin construction -----------------------------------------------------

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

// - SSR request deduplication -----------------------------------------------
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

// - Body reading ------------------------------------------------------------

// When Content-Length is known and fits in this threshold, pre-allocate
// a single Buffer and fill it as chunks arrive instead of creating a
// separate Buffer per chunk. Reduces GC pressure for typical form/JSON bodies.
const SMALL_BODY_THRESHOLD = 65536; // 64 KB

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
// Whether a WebSocket permessage-deflate compressor is configured (any non-DISABLED
// `websocket.compression`). Used by the platform publish/send methods to resolve
// the per-message `compress` flag: when this is false (the default), every send
// stays uncompressed exactly as before. Per-message compression is only ever
// requested when a compressor actually exists, because passing `compress: true`
// on a connection with no compressor is not free (measured in
// bench/ws-compression-cpu.mjs).
const WS_COMPRESSION_ON = Boolean(WS_OPTIONS && WS_OPTIONS.compression);
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

// - Static file serving -----------------------------------------------------

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

// - Prerendered page check --------------------------------------------------

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

// - SSR handler -------------------------------------------------------------

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

// - Response writer (with backpressure) -------------------------------------

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

// - Main request handler ----------------------------------------------------

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

// - WebSocket support -------------------------------------------------------

// WS_ENABLED is set by the adapter at build time - no inference from exports needed
if (WS_ENABLED) {
	// Warn about unrecognized exports - catches typos like "mesage" or "opn"
	const knownWsExports = new Set([
		'init', 'shutdown',
		'open', 'message', 'upgrade', 'close', 'drain',
		'subscribe', 'subscribeBatch', 'unsubscribe',
		'authenticate', 'resume'
	]);
	for (const name of Object.keys(wsModule)) {
		if (!knownWsExports.has(name)) {
			console.warn(
				`Warning: WebSocket handler exports unknown "${name}". ` +
				`Did you mean one of: ${[...knownWsExports].join(', ')}?\n` +
				'  See: https://svti.me/ws-hooks'
			);
		}
	}

	// One-shot runtime warning when a user upgrade handler attaches Set-Cookie
	// to the 101 Switching Protocols response. Cloudflare Tunnel and some other
	// strict edge proxies silently close WebSocket connections with 1006 when
	// the 101 carries Set-Cookie. The `authenticate` hook refreshes cookies
	// over a normal HTTP response and works behind every proxy.
	let warnedSetCookieOnUpgrade = false;
	/** @param {Record<string, string | string[]> | null | undefined} responseHeaders */
	function maybeWarnSetCookieOnUpgrade(responseHeaders) {
		if (warnedSetCookieOnUpgrade || !responseHeaders) return;
		for (const k of Object.keys(responseHeaders)) {
			if (k.toLowerCase() === 'set-cookie') {
				warnedSetCookieOnUpgrade = true;
				console.warn(
					'[adapter-uws] Set-Cookie on the 101 upgrade response is rejected by ' +
					'Cloudflare Tunnel and some other edge proxies (WebSocket opens, then ' +
					'closes with 1006 TCP FIN). Migrate to the `authenticate` hook to ' +
					'refresh session cookies over a normal HTTP response: ' +
					'export function authenticate({ cookies }) { cookies.set(...); }\n' +
					'  See: https://svti.me/cf-cookies'
				);
				return;
			}
		}
	}

	const wsOptions = WS_OPTIONS;
	const allowedOrigins = wsOptions.allowedOrigins || 'same-origin';

	// Refuse to start when the same-origin policy has no fronting trust to
	// pin against (no ORIGIN env, no HOST_HEADER env, no native TLS, no
	// upgrade hook). In that configuration the same-origin check compares
	// two attacker-controlled headers (Origin vs Host) and trivially passes
	// for any non-browser scripted client, leaving the WebSocket fully open
	// on a public-internet listener. Apps that have audited this and want
	// the previous warn-only behavior can opt out via
	// `websocket.unsafeSameOriginWithoutHostPin: true`.
	const _unsafeOriginErr = describeUnsafeSameOriginConfig({
		allowedOrigins,
		hasOriginEnv: !!origin,
		hasHostHeader: !!host_header,
		isTls: is_tls,
		hasUpgradeHook: !!wsModule.upgrade,
		optOut: wsOptions.unsafeSameOriginWithoutHostPin === true
	});
	if (_unsafeOriginErr) throw new Error(_unsafeOriginErr);

	// CSRF defense for the authenticate POST endpoint: by default the
	// request must carry one of `x-requested-with: XMLHttpRequest`,
	// `Sec-Fetch-Site: same-origin`, or an `Origin` header that matches the
	// configured `allowedOrigins`. Apps that need to accept this endpoint
	// from native (non-browser) clients without these headers can set
	// `websocket.authPathRequireOrigin: false` in svelte.config.js.
	const AUTH_PATH_REQUIRE_ORIGIN = wsOptions.authPathRequireOrigin !== false;

	// Wire-level subscribes to `__`-prefixed system topics are blocked by
	// default. Framework internals (`__signal:userId`, `__rpc`, plugin
	// channels like `__presence:*` / `__group:*` / `__replay:*`) reach
	// clients via per-connection `platform.send` or via server-initiated
	// `platform.publish` - never via a client `subscribe` frame. Allowing
	// clients to subscribe to these topics let any authenticated user
	// intercept other users' signals, presence rosters, and group
	// broadcasts. Apps that intentionally route public topics through the
	// `__` prefix can opt in via `websocket.allowSystemTopicSubscribe`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE = wsOptions.allowSystemTopicSubscribe === true;

	// Wire topics default to printable ASCII only - the loop in
	// `isValidWireTopic` rejects characters outside 0x20-0x7E (plus the
	// always-illegal `"` 0x22 and `\\` 0x5C). This closes a class of
	// look-alike attacks (Unicode line separators U+2028/9, RTL override
	// U+202E, BOM U+FEFF) and keeps the wire trivially log-safe. Apps
	// that legitimately use non-ASCII topic names can opt in.
	const ALLOW_NON_ASCII_TOPICS = wsOptions.allowNonAsciiTopics === true;

	// Keys that suggest sensitive or personally-identifying data being
	// stored in userData. userData is accessible to every server-side
	// handler via ws.getUserData() and ships out via platform.publish
	// fanout when callers stuff it into a publish payload, so storing
	// raw credentials or PII there is a footgun.
	const SENSITIVE_KEY_PATTERNS = [
		'token', 'secret', 'password', 'key', 'session', 'credential',
		'email', 'phone', 'ssn', 'dob', 'iban', 'creditcard', 'cc', 'pin'
	];
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

	// Upgrade admission control. Both layers opt-in via WebSocketOptions
	// (`upgradeAdmission: { maxConcurrent, perTickBudget }`); zero or unset
	// means disabled. State + queue live inside the factory closure.
	const admission = createUpgradeAdmission(wsOptions.upgradeAdmission);
	const ADMISSION_PER_TICK_BUDGET = wsOptions.upgradeAdmission?.perTickBudget ?? 0;

	// Content-negotiated rejection for over-capacity upgrades. Resolved once
	// here (or null when off); when null the gate emits today's bare 503.
	// On by default whenever the gate can reject (`maxConcurrent > 0`); the
	// escape is `waitingRoom: false`.
	const WAITING_ROOM = resolveWaitingRoom(wsOptions.upgradeAdmission);

	// Graduated protection posture over the 1 Hz pressure signal. Opt-in via
	// the `protection` option; absent or `'normal'` leaves `activePosture` null,
	// so the reject path, the pressure snapshot, and the poll response stay
	// byte-identical to a deployment that never sets it. `'auto'` resolves the
	// level from pressure; `'elevated'`/`'siege'` pin it for incident response.
	// The posture is module-ticked from `samplePressure` (no new timer) but
	// instantiated here because it reads the closure-local admission gate.
	const PROTECTION_MODE = wsOptions.protection || 'normal';
	const postureLevel = () => (activePosture !== null ? activePosture.level : 'normal');
	activePosture = (PROTECTION_MODE === 'normal')
		? null
		: createPosture({
			admission,
			getThresholds: () => resolvePressureThresholds(wsOptions.pressure),
			pin: PROTECTION_MODE === 'auto' ? undefined : PROTECTION_MODE
		});

	// Single 60-second interval for all periodic cache maintenance.
	// Keeps timer overhead to one wakeup per minute regardless of how many
	// caches exist. Add future periodic tasks here rather than creating
	// additional intervals.
	setIntervalTimer(() => {
		// 1. Purge rate-limit entries whose entire two-window history has expired,
		//    then evict the least active entries if the map exceeds the cap.
		//    Two windows must elapse with no activity before an entry is stale  -
		//    after one window the previous slot still contributes to the estimate.
		if (UPGRADE_MAX_PER_WINDOW > 0) {
			const t = now();
			for (const [ip, entry] of upgradeRateMap) {
				if (t - entry.windowStart >= 2 * UPGRADE_WINDOW_MS) upgradeRateMap.delete(ip);
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

	// - Authenticate endpoint (pre-upgrade HTTP hook) ---------------------
	// Optional `authenticate` export in hooks.ws.ts runs as a normal HTTP POST
	// so session cookies can be refreshed via a standard Set-Cookie on a 200
	// response. This works behind Cloudflare Tunnel and other strict edge
	// proxies that silently drop WebSocket connections whose 101 response
	// carries Set-Cookie. The client store POSTs here before opening the WS
	// when `connect({ auth: true })` is used.
	if (typeof wsModule.authenticate === 'function') {
		const authPath = WS_AUTH_PATH;
		// Body size cap for the authenticate endpoint. Most requests have no
		// body at all - the hook reads cookies from the Cookie header. Cap at
		// a small value to make malicious payloads cheap to reject.
		const AUTH_BODY_LIMIT = 64 * 1024;

		app.post(authPath, (res, req) => {
			/** @type {Record<string, string>} */
			const authHeaders = {};
			req.forEach((k, v) => { authHeaders[k] = v; });
			const method = 'POST';
			const url = req.getUrl() + (req.getQuery() ? '?' + req.getQuery() : '');
			const clientIp = resolveClientIp(textDecoder.decode(res.getRemoteAddressAsText()), authHeaders);

			if (AUTH_PATH_REQUIRE_ORIGIN && !isAuthOriginAccepted(authHeaders, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
				isTls: is_tls,
				hasUpgradeHook: false
			})) {
				res.cork(() => {
					res.writeStatus('403 Forbidden');
					res.writeHeader('content-type', 'text/plain');
					res.end('Origin not allowed');
				});
				return;
			}

			const state = acquireState();
			res.onAborted(() => { state.aborted = true; });

			const contentLength = parseInt(authHeaders['content-length'], 10);
			if (!isNaN(contentLength) && contentLength > AUTH_BODY_LIMIT) {
				send413(res);
				releaseState(state);
				return;
			}

			const body = readBody(res, AUTH_BODY_LIMIT, state, isNaN(contentLength) ? -1 : contentLength);

			const base_origin = origin || get_origin(authHeaders);
			const request = new Request(base_origin + url, {
				method,
				headers: authHeaders,
				body,
				// @ts-expect-error
				duplex: 'half'
			});

			const cookies = createCookies(authHeaders['cookie']);

			const authRequestId = resolveRequestId(authHeaders['x-request-id']) || randomUuid();
			const authPlatform = Object.create(platform);
			authPlatform.requestId = authRequestId;

			const event = {
				request,
				headers: authHeaders,
				cookies,
				url,
				remoteAddress: clientIp,
				getClientAddress: () => clientIp,
				platform: authPlatform
			};

			Promise.resolve()
				.then(() => wsModule.authenticate(event))
				.then(async (result) => {
					if (state.aborted) return;

					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						return;
					}

					if (result instanceof Response) {
						// User returned a full Response - honour it, but merge any
						// cookies set via cookies.set() so both APIs work together.
						const buf = result.body ? Buffer.from(await result.arrayBuffer()) : null;
						if (state.aborted) return;
						res.cork(() => {
							res.writeStatus(String(result.status));
							for (const [hk, hv] of result.headers) {
								if (hk === 'set-cookie' || hk === 'content-length') continue;
								res.writeHeader(hk, hv);
							}
							for (const c of result.headers.getSetCookie()) res.writeHeader('set-cookie', c);
							for (const c of cookies._serialize()) res.writeHeader('set-cookie', c);
							if (buf) res.end(buf);
							else res.end();
						});
						return;
					}

					// Implicit success: 204 No Content with any Set-Cookie headers
					res.cork(() => {
						res.writeStatus('204 No Content');
						for (const c of cookies._serialize()) res.writeHeader('set-cookie', c);
						res.endWithoutBody(0);
					});
				})
				.catch((err) => {
					if (state.aborted) return;
					if (err instanceof PayloadTooLargeError) {
						send413(res);
						return;
					}
					console.error('[adapter-uws] authenticate error:', err);
					if (!state.aborted) send500(res);
				})
				.finally(() => { releaseState(state); });
		});

		// Reject non-POST verbs on the auth path so GET/HEAD do not fall through
		// to the SSR catch-all (which would try to render a SvelteKit route).
		app.any(authPath, (res) => {
			res.cork(() => {
				res.writeStatus('405 Method Not Allowed');
				res.writeHeader('allow', 'POST');
				res.writeHeader('content-type', 'text/plain');
				res.end('Method Not Allowed');
			});
		});

		console.log(`WebSocket auth endpoint registered at ${authPath}`);
	}

	// - Waiting-room poll + holding page ----------------------------------
	// Registered whenever the waiting room is enabled (a sibling of the
	// authenticate block, not nested inside it, so the poll endpoint exists
	// regardless of whether an authenticate hook is present). Both routes are
	// read-only: the poll probes capacity via `admission.hasCapacity()` and
	// never calls `tryAcquire()`, so polling can never consume a gate slot.
	if (WAITING_ROOM !== null) {
		// Rolling poll counter: count polls seen in the current poll-interval
		// window. Cheap (one int plus a window marker), decayed by comparing
		// the shared 1s clock to the window start. Not a per-client structure,
		// so it cannot itself become a DoS vector.
		let pollWindowStart = now();
		let pollWindowCount = 0;
		let pollPrevCount = 0;
		const POLL_WINDOW_MS = WAITING_ROOM.pollIntervalMs;

		function recordPoll() {
			const t = now();
			const elapsed = t - pollWindowStart;
			if (elapsed >= POLL_WINDOW_MS) {
				// Carry one window back for a smoother depth across the
				// boundary, then roll.
				pollPrevCount = elapsed >= 2 * POLL_WINDOW_MS ? 0 : pollWindowCount;
				pollWindowCount = 0;
				pollWindowStart = t;
			}
			pollWindowCount++;
		}

		function currentQueueDepth() {
			// Polls observed in the trailing window (current plus faded bucket).
			const elapsed = now() - pollWindowStart;
			if (elapsed >= 2 * POLL_WINDOW_MS) return pollWindowCount;
			const faded = pollPrevCount * (1 - Math.min(elapsed, POLL_WINDOW_MS) / POLL_WINDOW_MS);
			return pollWindowCount + Math.round(faded);
		}

		app.get(WAITING_ROOM.admitCheckPath, (res) => {
			res.onAborted(() => {});
			recordPoll();
			// Siege never admits a reload into a full gate: it always reports
			// busy, even while the live gate has free slots. At normal/elevated
			// `hasCapacity()` stays the source of truth, so the poll only ever
			// ADDS the siege always-202 gate - it never admits a client the
			// real gate would reject.
			if (postureLevel() !== 'siege' && admission.hasCapacity()) {
				res.cork(() => {
					res.writeStatus('200 OK');
					res.writeHeader('content-type', 'application/json');
					res.writeHeader('cache-control', 'no-store');
					res.end('{"admit":true}');
				});
				return;
			}
			const queueDepth = currentQueueDepth();
			const estimatedSeconds = WAITING_ROOM.estimateSeconds(queueDepth);
			// Widen the poll cadence under siege so a packed room thins its own
			// retry rate; normal/elevated keep today's interval.
			const pollAfterMs = postureLevel() === 'siege'
				? WAITING_ROOM.pollIntervalMs * 2
				: WAITING_ROOM.pollIntervalMs;
			// 202 (not 503) so the poll itself is never treated as a failed or
			// rate-limited upgrade, holds no socket, and is distinguishable in
			// logs.
			res.cork(() => {
				res.writeStatus('202 Accepted');
				res.writeHeader('content-type', 'application/json');
				res.writeHeader('cache-control', 'no-store');
				res.end(
					'{"admit":false,"queueDepth":' + queueDepth +
					',"estimatedSeconds":' + estimatedSeconds +
					',"pollAfterMs":' + pollAfterMs + '}'
				);
			});
		});

		// Direct navigation to the configured path renders the same page the
		// gate serves on rejection, seeded from the live poll counter.
		app.get(WAITING_ROOM.path, (res) => {
			res.onAborted(() => {});
			const body = WAITING_ROOM.renderPage(currentQueueDepth());
			res.cork(() => {
				res.writeStatus('200 OK');
				res.writeHeader('content-type', 'text/html; charset=utf-8');
				res.writeHeader('cache-control', 'no-store');
				res.end(body);
			});
		});
	}

	app.ws(WS_PATH, {
		// Handle HTTP -> WebSocket upgrade with user-provided auth
		upgrade: (res, req, context) => {
			// Cursor-only upgrade lane (the worker's second WebSocket). Read the
			// requested subprotocol and route the upgrade through the reserved
			// cursor sub-budget only when a lane is configured; an unconfigured
			// deployment never reads the header for lane purposes and never
			// branches on the lane, so the main path is unchanged.
			const cursorLaneEnabled = admission.cursorMaxConcurrent > 0;
			const isCursor = cursorLaneEnabled && isCursorLaneUpgrade(req.getHeader('sec-websocket-protocol'));

			// Serve an at-capacity upgrade refusal without ever consuming a
			// gate slot. Shared by the gate-full reject and the siege
			// short-circuit so both content-negotiate identically: a browser
			// navigation gets the self-polling holding page (it holds no
			// socket), everything else keeps the `503` + jittered
			// `Retry-After`. The jitter band widens as the posture rises
			// (`0.5` at normal reproduces today's exact band). A cursor-lane
			// upgrade is never a browser navigation, so it always gets the bare
			// `503` - never the holding page - and skips the Accept negotiation.
			const serveUpgradeRefusal = () => {
				if (WAITING_ROOM === null || isCursor) {
					// `waitingRoom: false` (or maxConcurrent unset): the exact
					// bare 503 - same status, single content-type header, same
					// body, no Retry-After.
					res.cork(() => {
						res.writeStatus('503 Service Unavailable');
						res.writeHeader('content-type', 'text/plain');
						res.end('Server is at upgrade capacity, please retry');
					});
					return;
				}

				// One header read, no full walk on the reject path.
				const accept = req.getHeader('accept');
				if (negotiateRejection(accept) === 'html') {
					// Browser navigation: serve the self-polling holding page.
					const body = WAITING_ROOM.renderPage();
					res.cork(() => {
						res.writeStatus('200 OK');
						res.writeHeader('content-type', 'text/html; charset=utf-8');
						res.writeHeader('cache-control', 'no-store');
						res.end(body);
					});
					return;
				}

				// WebSocket upgrade / library client (Accept lacks text/html):
				// keep the 503, refined with a posture-widened jittered
				// Retry-After. At normal the spread is today's exact 0.5.
				const lvl = postureLevel();
				const spread = lvl === 'siege' ? 1.5 : lvl === 'elevated' ? 1.0 : 0.5;
				const retryAfter = WAITING_ROOM.jitteredRetryAfter(spread);
				res.cork(() => {
					res.writeStatus('503 Service Unavailable');
					res.writeHeader('content-type', 'text/plain');
					res.writeHeader('retry-after', String(retryAfter));
					res.end('Server is at upgrade capacity, please retry');
				});
			};

			// Siege refuses every NEW upgrade at static-serve cost, even
			// while the gate has free slots - no slot is acquired, so an
			// existing connection is never touched. Counted as an
			// over-capacity reject so an auto posture stays escalated.
			if (postureLevel() === 'siege') {
				if (activePosture !== null) activePosture.recordCapacityReject();
				serveUpgradeRefusal();
				return;
			}

			// Pre-upgrade soft filter: cap on concurrent upgrades currently
			// being processed. The cheapest possible rejection - no header
			// walk, no IP decode, no origin check - so a connection storm
			// is shed before it consumes per-request CPU. A cursor-lane
			// upgrade is admitted through its reserved sub-budget so it can
			// never starve main-WS admission; a saturated cursor lane is real
			// capacity pressure, so it counts as an over-capacity reject too.
			const acquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
			if (!acquired) {
				// Count the over-capacity reject (and only this one) so the
				// posture's rolling reject rate reflects true gate pressure.
				if (activePosture !== null) activePosture.recordCapacityReject();
				serveUpgradeRefusal();
				return;
			}
			let inFlightReleased = false;
			function releaseInFlight() {
				if (inFlightReleased) return;
				inFlightReleased = true;
				if (isCursor) admission.releaseCursorInFlight();
				else admission.release();
			}

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
				const t = now();
				let rateEntry = upgradeRateMap.get(clientIp);
				if (!rateEntry) {
					rateEntry = { prev: 0, curr: 0, windowStart: t };
					upgradeRateMap.set(clientIp, rateEntry);
				} else {
					const elapsed = t - rateEntry.windowStart;
					if (elapsed >= 2 * UPGRADE_WINDOW_MS) {
						rateEntry.prev = 0;
						rateEntry.curr = 0;
						rateEntry.windowStart = t;
					} else if (elapsed >= UPGRADE_WINDOW_MS) {
						rateEntry.prev = rateEntry.curr;
						rateEntry.curr = 0;
						rateEntry.windowStart = t;
					}
				}
				// Sliding estimate: the previous window's count fades out linearly as
				// the current window progresses. At 0% elapsed, prev counts fully.
				// At 100% elapsed, prev contributes nothing and we rotate next time.
				const elapsed = t - rateEntry.windowStart;
				const estimate = rateEntry.prev * (1 - elapsed / UPGRADE_WINDOW_MS) + rateEntry.curr;
				if (estimate >= UPGRADE_MAX_PER_WINDOW) {
					// Per-IP rate-limit reject. Reported on its own counter, never
					// the over-capacity one, so an attack-driven 429 storm can
					// never escalate the protection posture toward siege.
					if (activePosture !== null) activePosture.recordRateLimitReject();
					res.cork(() => {
						res.writeStatus('429 Too Many Requests');
						res.writeHeader('content-type', 'text/plain');
						res.end('Too many upgrade requests');
					});
					releaseInFlight();
					return;
				}
				rateEntry.curr++;
			}

			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');

			// Origin validation - reject cross-origin WebSocket connections.
			// Requests without an Origin header are also rejected unless the
			// user supplied an upgrade hook that can authenticate non-browser
			// clients itself.
			if (!isOriginAllowed(headers['origin'], headers, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
				isTls: is_tls,
				hasUpgradeHook: !!wsModule.upgrade
			})) {
				res.cork(() => {
					res.writeStatus('403 Forbidden');
					res.writeHeader('content-type', 'text/plain');
					res.end('Origin not allowed');
				});
				releaseInFlight();
				return;
			}

			// Per-connection requestId stamped at upgrade time. Honours an
			// X-Request-ID upgrade header if present, else generates a fresh
			// UUID. Carried across the upgrade boundary as a string-keyed
			// userData slot (uWebSockets.js strips Symbol keys when handing
			// userData to the WS binding). The `open` hook promotes this
			// string into the Symbol-keyed per-connection platform clone.
			const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();

			// No user upgrade handler - accept synchronously (no microtask yield,
			// no cookie parsing). Inject remoteAddress so plugins/ratelimit can
			// key on the real client IP via ws.getUserData().remoteAddress.
			if (!wsModule.upgrade) {
				// Track aborted so a deferred upgrade does not call res.upgrade()
				// on a connection the client already closed. Only relevant when
				// the per-tick budget pushes the call onto setImmediate.
				let fastPathAborted = false;
				if (ADMISSION_PER_TICK_BUDGET > 0) {
					res.onAborted(() => { fastPathAborted = true; releaseInFlight(); });
				}
				admission.admit(() => {
					if (fastPathAborted) return;
					res.cork(() => {
						res.upgrade({ remoteAddress: clientIp, [WS_REQUEST_ID_KEY]: wsRequestId }, secKey, secProtocol, secExtensions, context);
					});
					releaseInFlight();
				});
				return;
			}

			// - User upgrade handler path (may be async) --
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();

			let aborted = false;
			res.onAborted(() => {
				aborted = true;
				releaseInFlight();
			});

			const cookies = parseCookies(headers['cookie']);

			let timedOut = false;
			let timer;
			if (wsOptions.upgradeTimeout > 0) {
				timer = setTimer(() => {
					timedOut = true;
					if (!aborted) {
						res.cork(() => {
							res.writeStatus('504 Gateway Timeout');
							res.writeHeader('content-type', 'text/plain');
							res.end('Upgrade timed out');
						});
					}
					releaseInFlight();
				}, wsOptions.upgradeTimeout * 1000);
			}

			Promise.resolve(wsModule.upgrade({ headers, cookies, url, remoteAddress: clientIp, requestId: wsRequestId }))
				.then((result) => {
					clearTimer(timer);
					if (aborted || timedOut) return;
					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						releaseInFlight();
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
										'Store sensitive data outside userData and reference it by a non-sensitive ID.\n' +
										'  See: https://svti.me/userdata-sensitive'
									);
								}
							}
						}
					}
					const ud = userData || {};
					if (!ud.remoteAddress) ud.remoteAddress = clientIp;
					ud[WS_REQUEST_ID_KEY] = wsRequestId;
					if (responseHeaders) maybeWarnSetCookieOnUpgrade(responseHeaders);
					admission.admit(() => {
						// Recheck after possible setImmediate defer: the client
						// may have hung up between admission and execution.
						if (aborted || timedOut) { releaseInFlight(); return; }
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
						releaseInFlight();
					});
				})
				.catch((err) => {
					clearTimer(timer);
					console.error('WebSocket upgrade error:', err);
					if (!aborted && !timedOut) {
						res.cork(() => {
							res.writeStatus('500 Internal Server Error');
							res.writeHeader('content-type', 'text/plain');
							res.end('Internal Server Error');
						});
					}
					releaseInFlight();
				});
		},

		open: (ws) => {
			// Track which topics this connection is subscribed to.
			// Used to populate CloseContext.subscriptions for the user's close handler,
			// enabling deterministic cleanup of per-subscription server state.
			const userData = ws.getUserData();
			assert(!userData[WS_PLATFORM], 'ws.platform-double-init', null);
			userData[WS_SUBSCRIPTIONS] = new Set();
			// Promote the upgrade-time requestId (carried as a string slot
			// because Symbol keys do not survive res.upgrade) into a
			// per-connection platform clone on the Symbol slot, then drop
			// the string slot so userData stays clean for hook code.
			const wsPlatform = Object.create(platform);
			wsPlatform.requestId = userData[WS_REQUEST_ID_KEY];
			userData[WS_PLATFORM] = wsPlatform;
			delete userData[WS_REQUEST_ID_KEY];
			assert(userData[WS_REQUEST_ID_KEY] === undefined, 'ws.request-id-leak', null);
			// Stamp a fresh session id and announce it. The client stores it
			// in sessionStorage and presents it back via { type: 'resume' }
			// after a reconnect so the user's resume hook can fill the gap.
			const sessionId = randomUuid();
			userData[WS_SESSION_ID] = sessionId;
			// Per-connection traffic stats are only allocated when the user
			// has a `close` hook to receive them - keeps userData lean for
			// stats-uninterested apps.
			if (closeHookRegistered) {
				userData[WS_STATS] = {
					openedAt: monotonicNow(),
					messagesIn: 0,
					messagesOut: 0,
					bytesIn: 0,
					bytesOut: 0
				};
			}
			const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
			ws.send(welcome, false, false);
			bumpOut(ws, welcome);
			wsConnections.add(ws);
			if (wsDebug) console.log('[ws] open connections=%d session=%s', wsConnections.size, sessionId);
			wsModule.open?.(ws, { platform: userData[WS_PLATFORM] });
		},

		message: async (ws, message, isBinary) => {
			assert(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-message', null);
			bumpIn(ws, message);
			// Built-in: handle subscribe/unsubscribe from the client store.
			// Control messages are JSON text: {"type":"subscribe","topic":"..."}
			// Byte-prefix check: {"type" has byte[3]='y' (0x79), while user
			// envelopes {"topic" have byte[3]='o' (0x6F). Only JSON.parse when
			// the prefix matches - skips parsing for 99%+ of messages.
			// The 8192-byte ceiling is generous enough for subscribe-batch with
			// many topics (N * 256-char names) while keeping the JSON.parse
			// guard against truly large user messages.
			// `msg` is hoisted to outer scope so it can be forwarded to the user
			// handler in the fall-through delegation below. When the prefix
			// matched and JSON.parse produced an object that did NOT match any
			// known control type, the parsed value reaches plugin-layer
			// dispatchers (e.g. svelte-realtime's `onJsonMessage`) directly, so
			// they don't re-run TextDecoder + JSON.parse on every frame.
			/** @type {any} */
			let msg;
			if (!isBinary && message.byteLength < 8192 &&
				(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
				/** @type {any} */
				let parsed;
				try {
					parsed = JSON.parse(textDecoder.decode(message));
				} catch {
					parsed = undefined;
				}
				if (parsed === null || typeof parsed !== 'object') {
					// Not a JSON object envelope (parse failed, or parsed to
					// null / primitive / array). Forward raw bytes only.
					wsModule.message?.(ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] });
					return;
				}
				msg = parsed;
				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					const ref = hasRef(msg.ref) ? msg.ref : null;
					if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS)) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE && msg.topic.charCodeAt(0) === 95 && msg.topic.charCodeAt(1) === 95) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
					assert(subs instanceof Set, 'subs.shape', null);
					const isNew = !subs.has(msg.topic);
					if (isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					const denial = await runUserSubscribeGate(ws, msg.topic);
					if (denial !== null) {
						sendSubscribeDenied(ws, msg.topic, ref, denial);
						return;
					}
					// Post-await re-check: a concurrent subscribe (single or batch)
					// may have raced through and already added the topic while
					// the user hook awaited. Idempotent ack and skip the
					// totalSubscriptions++ to avoid double-counting.
					if (subs.has(msg.topic)) {
						sendSubscribed(ws, msg.topic, ref);
						return;
					}
					if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					try { ws.subscribe(msg.topic); }
					catch { closedWsAborts++; return; }
					subs.add(msg.topic);
					totalSubscriptions++;
					if (wsDebug) console.log('[ws] subscribe topic=%s', msg.topic);
					sendSubscribed(ws, msg.topic, ref);
					return;
				}
				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					ws.unsubscribe(msg.topic);
					const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
					assert(udSubs instanceof Set, 'subs.shape-unsubscribe', null);
					if (udSubs.delete(msg.topic)) {
						totalSubscriptions--;
						assert(totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions });
					}
					if (wsDebug) console.log('[ws] unsubscribe topic=%s', msg.topic);
					wsModule.unsubscribe?.(ws, msg.topic, { platform: ws.getUserData()[WS_PLATFORM] });
					return;
				}
				if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
					// Sent by the client store on reconnect to resubscribe all topics
					// in a single message instead of N individual subscribe messages.
					// Cap at 256 topics  - the client only sends what it was subscribed to.
					const topics = msg.topics.slice(0, 256);
					const ref = hasRef(msg.ref) ? msg.ref : null;
					const userData = ws.getUserData();
					assert(userData[WS_SUBSCRIPTIONS] instanceof Set, 'subs.shape-batch', null);

					// Pass 1: validate topics. INVALID_TOPIC denials emit immediately;
					// the batch hook (if any) only sees validated topics.
					const valid = [];
					for (const topic of topics) {
						if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS)) {
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE && typeof topic === 'string' &&
							topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						valid.push(topic);
					}

					// Pass 2: gather denial decisions. If a batch hook is exported,
					// call it once (typically backed by a single DB auth query) and
					// use its decisions. Otherwise fall back to the per-topic
					// `subscribe` hook for parity with single-subscribe behaviour.
					// Both paths are awaited so async hooks (the idiomatic style for
					// hooks that touch a session store or DB) gate correctly.
					const batchDenials = await runSubscribeBatchHook(ws, valid);
					// When falling back to per-topic, run the hooks in parallel so
					// a slow async hook on N topics is one round-trip not N.
					const perTopicDenials = batchDenials === null && wsModule.subscribe
						? await Promise.all(valid.map((t) => runSubscribeHook(ws, t)))
						: null;

					let subscribed = 0;
					for (let i = 0; i < valid.length; i++) {
						const topic = valid[i];
						const subs = userData[WS_SUBSCRIPTIONS];
						const denial = batchDenials !== null
							? (batchDenials[topic] ?? null)
							: (perTopicDenials !== null ? perTopicDenials[i] : null);
						if (denial !== null) {
							sendSubscribeDenied(ws, topic, ref, denial);
							continue;
						}
						// Post-await re-check: idempotent ack on race with another
						// concurrent subscribe.
						if (subs.has(topic)) {
							sendSubscribed(ws, topic, ref);
							continue;
						}
						if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
							sendSubscribeDenied(ws, topic, ref, 'RATE_LIMITED');
							continue;
						}
						try { ws.subscribe(topic); }
						catch { closedWsAborts++; continue; }
						subs.add(topic);
						totalSubscriptions++;
						subscribed++;
						sendSubscribed(ws, topic, ref);
					}
					if (wsDebug) console.log('[ws] subscribe-batch count=%d', subscribed);
					return;
				}
				if (msg.type === 'reply' && hasRef(msg.ref)) {
					// Reply to a server-initiated request. Look up the pending
					// promise on this connection's userData, clear its timeout,
					// and resolve / reject accordingly. Refs scoped per-WS so a
					// stray reply from one connection cannot affect another.
					const pending = ws.getUserData()[WS_PENDING_REQUESTS];
					const entry = pending?.get(msg.ref);
					if (entry) {
						assert(typeof entry.resolve === 'function', 'request.entry-resolve-shape', { ref: msg.ref });
						assert(typeof entry.reject === 'function', 'request.entry-reject-shape', { ref: msg.ref });
						pending.delete(msg.ref);
						clearTimer(entry.timer);
						if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
						else entry.resolve(msg.data);
					}
					return;
				}
				if (msg.type === 'hello' && Array.isArray(msg.caps)) {
					// Capability negotiation. Old clients never send 'hello',
					// so the absence of the WS_CAPS slot is the safe-default
					// "no opt-in features" signal that publishBatched relies
					// on to fall back to N individual frames per connection.
					const caps = new Set();
					for (let i = 0; i < msg.caps.length; i++) {
						if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
					}
					const ud = ws.getUserData();
					// Maintain the live per-capability connection counts so the
					// binary publish fast path knows whether any client wants
					// binary. A re-sent hello replaces the prior set; diff it.
					capCounts.adjust(ud[WS_CAPS], caps);
					ud[WS_CAPS] = caps;
					// Opt-in arm for internal flow control. Presence of the cap
					// turns the connection window-managed; absence keeps the
					// immediate send path byte-identical. Only the first hello
					// allocates the slot and emits the first window so a
					// re-sent hello (lazy-plugin re-advertise) does not reset it.
					if (caps.has('lease') && !ud[WS_LEASE]) {
						// The server is grant-and-observe, not enforcing: it sizes
						// and hands out windows the client paces itself against, and
						// reads pressureValue() for the worker saturation scalar. It
						// never consumes a permit (no tryAcquire here) - the same
						// state machine's acquire/enqueue surface is the CLIENT's,
						// where the flood risk lives and the pacing is enforced.
						const g = grantSizeFor();
						const window = createLeaseState({ requestCount: g.count, ttlMs: g.ttlMs });
						window.grant();
						ud[WS_LEASE] = { gate: window, saturation: window.pressureValue() };
						// Echo that the capability is honoured, then hand out
						// the first window. Additive: old clients never sent the
						// cap so never receive these.
						const echo = '{"type":"lease-ok"}';
						ws.send(echo, false, false);
						bumpOut(ws, echo);
						const frame = leaseGrantFrame(g.count, g.ttlMs);
						ws.send(frame, false, false);
						bumpOut(ws, frame);
					}
					if (wsDebug) console.log('[ws] hello caps=%o', [...caps]);
					return;
				}
				if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
					msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
					// Client presents the previous session id plus per-topic
					// lastSeenSeqs so the user's resume hook can fill the gap
					// (typically by calling replay.replay(ws, topic, sinceSeq, platform)
					// for each topic). The hook is optional - if unset, we still
					// ack so the client can switch to live mode.
					assert(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-resume', null);
					// Per-topic generation the client last saw, parallel to
					// lastSeenSeqs and keyed the same. Additive: an old client
					// omits it, and the hook then treats every topic as a match
					// (gap-fill as before). Forwarded raw so the hook compares
					// each topic's presented epoch to the live one
					// (`platform.topicEpoch(topic)`) and chooses gap-fill on a
					// match or cold-rehydrate on a mismatch - never serving a
					// seq space that has since reset as if it were contiguous.
					const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
						? msg.lastSeenEpochs
						: undefined;
					if (wsModule.resume) {
						try {
							// Await the hook so per-topic replay flushes
							// __replay frames before the `resumed` ack
							// tells the client to switch to live mode -
							// otherwise live publishes can arrive ahead of
							// gap-fill frames and produce out-of-order
							// events. Replay backends emit `denied` on
							// `__replay:{topic}` for denied subscribes;
							// the client store handles it like `truncated`.
							await wsModule.resume(ws, {
								sessionId: msg.sessionId,
								lastSeenSeqs: msg.lastSeenSeqs,
								lastSeenEpochs,
								platform: ws.getUserData()[WS_PLATFORM]
							});
						} catch (err) {
							console.error('[ws] resume hook threw:', err);
						}
					}
					ws.send('{"type":"resumed"}', false, false);
					bumpOut(ws, '{"type":"resumed"}');
					if (wsDebug) console.log('[ws] resume sessionId=%s', msg.sessionId);
					return;
				}
				if (msg.type === 'request-n') {
					// Window-replenish request from an opted-in connection.
					// Re-grant from the current worker posture and hand the
					// client a fresh window. Connections that never opted in
					// have no slot; the request is a no-op for them.
					const slot = ws.getUserData()[WS_LEASE];
					if (slot) {
						const g = grantSizeFor();
						slot.gate.requestN(g.count, g.ttlMs);
						const frame = leaseGrantFrame(g.count, g.ttlMs);
						ws.send(frame, false, false);
						bumpOut(ws, frame);
						slot.saturation = slot.gate.pressureValue();
						if (slot.saturation > leaseSaturationPeak) leaseSaturationPeak = slot.saturation;
					}
					return;
				}
			}
			// Delegate everything else to the user's handler (if provided).
			// `msg` is the JSON-parsed envelope when the prefix matched + parsed
			// to an object + no control type matched; otherwise undefined.
			wsModule.message?.(ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] });
		},

		drain: (ws) => {
			assert(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-drain', null);
			// Resume any sendCoalesced traffic held back by backpressure
			// before delegating to the user's drain hook.
			flushCoalescedFor(ws);
			wsModule.drain?.(ws, { platform: ws.getUserData()[WS_PLATFORM] });
		},

		close: (ws, code, message) => {
			const userData = ws.getUserData();
			assert(userData[WS_PLATFORM], 'ws.platform-missing-in-close', null);
			const subscriptions = userData[WS_SUBSCRIPTIONS] || new Set();
			// Reject any in-flight server-initiated requests so callers stop
			// awaiting promises that can never resolve. Clearing the timer
			// avoids the close-then-timer race that would otherwise reject
			// twice (delete from the map first so the timer's check is a no-op).
			const pending = userData[WS_PENDING_REQUESTS];
			if (pending && pending.size > 0) {
				for (const entry of pending.values()) {
					clearTimer(entry.timer);
					try { entry.reject(new Error('connection closed')); } catch {}
				}
				pending.clear();
			}
			// Build the per-connection stats meta when a close hook exists.
			// Counters were populated by the bumpIn / bumpOut helpers across
			// the connection's lifetime; this is the single read site.
			const stats = userData[WS_STATS];
			const closePlatform = userData[WS_PLATFORM];
			const ctx = stats
				? {
					code,
					message,
					platform: closePlatform,
					subscriptions,
					id: userData[WS_SESSION_ID],
					duration: monotonicNow() - stats.openedAt,
					messagesIn: stats.messagesIn,
					messagesOut: stats.messagesOut,
					bytesIn: stats.bytesIn,
					bytesOut: stats.bytesOut
				}
				: { code, message, platform: closePlatform, subscriptions };
			try {
				wsModule.close?.(ws, ctx);
			} finally {
				totalSubscriptions -= subscriptions.size;
				assert(totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions });
				// Release this connection's advertised capabilities from the
				// live counts so the binary publish fast path stays accurate.
				capCounts.adjust(userData[WS_CAPS], null);
				// Dispose any per-connection wire-codec state (e.g. the cursor
				// short-id dictionary) so a long-lived server frees it promptly.
				detachWireStates(ws, userData);
				// Free the per-connection send-gate slot (only present when the
				// connection opted into internal flow control).
				if (userData[WS_LEASE]) userData[WS_LEASE] = undefined;
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

	startPressureSampling(wsOptions.pressure);
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

// - In-flight request tracking -------------------------------------------

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

// - Exports -----------------------------------------------------------------

let listenSocket = null;

/**
 * Start the uWS server. Returns a promise that resolves once the listen
 * socket is bound AND the user's `hooks.ws.init` hook (if any) has
 * completed. Awaiting `start()` gives callers a "server is fully ready"
 * signal that includes app-level boot work (cron registration, warmup
 * tasks, external pubsub bridges).
 *
 * Listen failure logs and exits the process (preserves prior behavior).
 * Init-hook failure rejects the promise - boot is loud or nothing; the
 * caller decides whether to abort or recover.
 *
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
export async function start(host, port) {
	await new Promise((resolve) => {
		app.listen(host, port, (socket) => {
			if (socket) {
				listenSocket = socket;
				const startup = (monotonicNow() - _t_app).toFixed(0);
				console.log(`Listening on ${is_tls ? 'https' : 'http'}://${host}:${port} (ready in ${startup}ms)`);
				resolve();
			} else {
				console.error(`Failed to listen on ${host}:${port}`);
				process.exit(1);
			}
		});
	});

	// Fire the user's `init` hook (if exported) once per worker, after the
	// listen socket is bound and before this function resolves. Async hooks
	// are awaited so callers that `await start(...)` get a fully-ready
	// signal that includes app-level boot work. A throwing hook re-throws
	// to the caller - boot failure should be loud.
	if (WS_ENABLED && typeof wsModule.init === 'function') {
		await wsModule.init({ platform });
	}
}

/**
 * Stop the server gracefully.
 *
 * Order of operations:
 *   1. Fire the user's `hooks.ws.shutdown` hook (if any) so app-level code
 *      can flush cron state, last metrics, external bridge teardown, etc.
 *      Async hooks are awaited; throws are logged and ignored (we cannot
 *      refuse to shut down).
 *   2. Close the listen socket - stops accepting new connections.
 *   3. Send `code 1001 (Going Away)` to every WebSocket connection so
 *      clients reconnect to the new instance.
 *
 * In-flight HTTP requests continue until `drain()` resolves - the caller
 * (index.js) typically races `drain()` against a shutdown timeout.
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
	if (WS_ENABLED && typeof wsModule.shutdown === 'function') {
		try {
			await wsModule.shutdown({ platform });
		} catch (err) {
			// Log-and-continue: shutdown is best-effort, we cannot refuse.
			console.error('[ws] shutdown hook threw:', err);
		}
	}
	if (listenSocket) {
		uWS.us_listen_socket_close(listenSocket);
		listenSocket = null;
	}
	stopPressureSampling();
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
 * @param {boolean} [compress] - Compress intent carried from the originating
 *   worker; re-gated by this worker's WS_COMPRESSION_ON. Absent -> uncompressed.
 */
export function relayPublish(topic, envelope, compress) {
	// Hard tier: a non-string topic or an empty/non-string envelope arriving
	// from a sibling worker (trusted, same codebase) means our own cross-worker
	// relay serialization is structurally broken - publishing it would misroute
	// or send garbage to every local subscriber and, transitively, cluster-wide.
	// That is not recoverable by dropping one frame, so it escalates to a
	// deferred worker restart rather than a soft log.
	fatal(typeof topic === 'string', 'relay.topic-type', { topic: typeof topic });
	fatal(typeof envelope === 'string' && envelope.length > 0, 'relay.envelope-type', {
		envelopeType: typeof envelope,
		envelopeLen: typeof envelope === 'string' ? envelope.length : null
	});
	app.publish(topic, envelope, false, WS_COMPRESSION_ON && compress === true);
}

/**
 * Re-dispatch a relayed publishBatched call from another worker. The
 * detection (allSeeAll + everyoneCapable) is re-run against THIS
 * worker's local subscriber set: a worker with a different cap profile
 * or different subscription overlap may take the slow path even when
 * the originating worker took the fast path. Seqs were stamped by the
 * originator and ride along in each per-event envelope; we never
 * re-stamp and never re-relay.
 *
 * @param {Array<{ topic: string, env: string }>} events
 * @param {boolean} [compress] - Batch-level compress intent from the originating
 *   worker; re-gated by this worker's WS_COMPRESSION_ON. Absent -> uncompressed.
 */
export function relayPublishBatched(events, compress) {
	if (!Array.isArray(events) || events.length === 0) return;
	assert(typeof events[0].topic === 'string', 'relay.batched-topic-type', {
		first: typeof events[0].topic
	});
	assert(typeof events[0].env === 'string', 'relay.batched-env-type', {
		first: typeof events[0].env
	});

	const firstTopic = events[0].topic;
	let allSameTopic = true;
	for (let i = 1; i < events.length; i++) {
		if (events[i].topic !== firstTopic) { allSameTopic = false; break; }
	}

	let allSeeAll = true;
	let everyoneCapable = true;
	let batchTopics = null;
	if (!allSameTopic) {
		batchTopics = new Set();
		for (let i = 0; i < events.length; i++) batchTopics.add(events[i].topic);
	}
	for (const ws of wsConnections) {
		const ud = ws.getUserData();
		const subs = ud[WS_SUBSCRIPTIONS];
		if (!subs || subs.size === 0) continue;
		let touchesAny = false;
		if (allSameTopic) {
			touchesAny = subs.has(firstTopic);
		} else {
			let touchesAll = true;
			for (const t of /** @type {Set<string>} */ (batchTopics)) {
				if (subs.has(t)) touchesAny = true;
				else touchesAll = false;
			}
			if (touchesAny && !touchesAll) { allSeeAll = false; break; }
		}
		if (!touchesAny) continue;
		const caps = ud[WS_CAPS];
		if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
	}

	if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
		// Slow path: per-event app.publish, mirroring the local
		// fallback and matching the receive-side semantics that
		// cap-able subs on this worker would have seen if the
		// originator had taken its slow path too.
		for (let i = 0; i < events.length; i++) {
			app.publish(events[i].topic, events[i].env, false, WS_COMPRESSION_ON && compress === true);
		}
		return;
	}

	// Fast path: wrap and dispatch on the C++ TopicTree.
	const slice = new Array(events.length);
	for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
	const sharedBatchEnv = wrapBatchEnvelope(slice);
	const fanoutTopic = allSameTopic ? firstTopic : events[0].topic;
	app.publish(fanoutTopic, sharedBatchEnv, false, WS_COMPRESSION_ON && compress === true);
}
