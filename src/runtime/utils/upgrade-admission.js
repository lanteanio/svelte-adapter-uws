import { monotonicNow, randomFloat, setImmediateTimer } from '../runtime.js';
import {
	assertAccessibleWaitingDocument,
	compileAccessibleWaitingRoomTemplate,
	compileWaitingRoomTemplate
} from './waiting-room-template.js';
import { collectRequestHeaders } from './request-headers.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

const DEFAULT_MAX_DEFERRED = 1024;

/**
 * Build a self-contained admission controller for WebSocket upgrades.
 *
 * Three independent layers, all opt-in (zero or unset = disabled):
 *
 * - `maxConcurrent` caps how many upgrades may be in flight at once.
 *   Crossed requests get rejected before any per-request work, so a
 *   connection storm can be shed without spending CPU on TLS / header
 *   parsing.
 * - `maxConnections` caps reserved upgrades plus live WebSocket connections.
 *   A permit is acquired before per-request work and held until the socket's
 *   close callback, so sequential handshakes cannot bypass the live-connection
 *   ceiling.
 * - `perTickBudget` caps how many `res.upgrade()` calls run per
 *   event-loop tick. Once the budget is spent, subsequent calls are
 *   deferred via `setImmediate` so the loop is not starved by 10K
 *   synchronous handshakes from one I/O batch. Its queue is always finite:
 *   `maxDeferred` defaults to 1024 while pacing is enabled, and overflow is
 *   refused instead of retaining another response closure.
 * - `cursorLane.fraction` reserves a fraction of `maxConcurrent` for a
 *   deprioritised cursor-only upgrade lane (the worker's second
 *   WebSocket). A cursor upgrade is admitted only while both the main
 *   ceiling has room and the cursor sub-budget has room, so a flood of
 *   cursor reconnects can never starve main-WS admission. Unset (or
 *   `maxConcurrent` unset) keeps the second counter at zero and the main
 *   lane byte-identical.
 *
 * The returned object owns the counters and queue; one instance per
 * uWS app. Pure factory: no module-state capture, no globals - all
 * state lives in the closure so multiple instances do not interfere
 * (relevant for testing.js / vite.js parity in future work).
 *
 * @param {{ maxConcurrent?: number, maxConnections?: number, perTickBudget?: number, maxDeferred?: number, cursorLane?: { fraction?: number } }} [opts]
 */
export function createUpgradeAdmission(opts) {
	// A JSON round trip or a config spread writes an unconfigured section as
	// null, and every config guard reads null as absent. Folded to absent here
	// too - otherwise `opts && opts.maxConcurrent` yields null, which is not
	// undefined, so the safe-integer checks below would refuse a section that
	// configures nothing and crash the worker at boot under a config the
	// build passed.
	if (opts === null) opts = undefined;
	// Both `|| 0` ceilings below are read as `value > 0` throughout, so a
	// misshaped value would not fall back to "disabled" loudly - it would
	// leave the gate open in silence. Refused here on the same terms as
	// `maxConnections` and `maxDeferred`.
	const configuredMaxConcurrent = opts && opts.maxConcurrent;
	if (
		configuredMaxConcurrent !== undefined &&
		(!Number.isSafeInteger(configuredMaxConcurrent) || configuredMaxConcurrent < 0)
	) {
		throw new TypeError('upgradeAdmission.maxConcurrent must be a non-negative safe integer.');
	}
	const maxConcurrent = configuredMaxConcurrent || 0;
	const configuredMaxConnections = opts && opts.maxConnections;
	if (
		configuredMaxConnections !== undefined &&
		(!Number.isSafeInteger(configuredMaxConnections) || configuredMaxConnections < 0)
	) {
		throw new TypeError('upgradeAdmission.maxConnections must be a non-negative safe integer.');
	}
	const maxConnections = configuredMaxConnections || 0;
	const configuredPerTickBudget = opts && opts.perTickBudget;
	if (
		configuredPerTickBudget !== undefined &&
		(!Number.isSafeInteger(configuredPerTickBudget) || configuredPerTickBudget < 0)
	) {
		throw new TypeError('upgradeAdmission.perTickBudget must be a non-negative safe integer.');
	}
	const perTickBudget = configuredPerTickBudget || 0;
	const configuredMaxDeferred = opts && opts.maxDeferred;
	if (
		configuredMaxDeferred !== undefined &&
		(!Number.isSafeInteger(configuredMaxDeferred) || configuredMaxDeferred < 0)
	) {
		throw new TypeError('upgradeAdmission.maxDeferred must be a non-negative safe integer.');
	}
	const maxDeferred = perTickBudget > 0
		? (configuredMaxDeferred === undefined ? DEFAULT_MAX_DEFERRED : configuredMaxDeferred)
		: 0;
	// Cursor-lane sub-budget: a fraction of the main ceiling reserved for the
	// deprioritised cursor-only upgrade lane. Only meaningful when the gate has
	// a ceiling to carve from; with no ceiling the lane stays at zero and the
	// main lane is untouched. The floor of 1 keeps a configured lane usable even
	// for a small ceiling.
	const cursorFraction = (opts && opts.cursorLane && typeof opts.cursorLane.fraction === 'number' && opts.cursorLane.fraction > 0)
		? Math.min(1, opts.cursorLane.fraction)
		: 0.25;
	const cursorMaxConcurrent = (maxConcurrent > 0 && opts && opts.cursorLane)
		? Math.max(1, Math.floor(maxConcurrent * cursorFraction))
		: 0;
	let inFlight = 0;
	let cursorInFlight = 0;
	let connectionPermits = 0;
	let perTickCount = 0;
	/** @type {Array<{ fn: () => void, enqueuedAt: number } | undefined>} */
	const deferred = [];
	let deferredHead = 0;
	let deferredTail = 0;
	let deferredDepth = 0;
	let deferredRejectedTotal = 0;
	/** @type {null | ((depth: number, oldestAgeMs: number, rejectedTotal: number) => void)} */
	let deferredObserver = null;
	let drainScheduled = false;

	function oldestDeferredAgeMs() {
		if (deferredDepth === 0) return 0;
		const oldest = deferred[deferredHead];
		return oldest === undefined ? 0 : Math.max(0, monotonicNow() - oldest.enqueuedAt);
	}

	function notifyDeferredObserver() {
		if (deferredObserver === null) return;
		try {
			deferredObserver(deferredDepth, oldestDeferredAgeMs(), deferredRejectedTotal);
		} catch {
			// Metrics are observe-only: an exporter must never break admission.
		}
	}

	function scheduleDrain() {
		if (drainScheduled) return;
		drainScheduled = true;
		setImmediateTimer(drain);
	}

	function dequeue() {
		const entry = /** @type {{ fn: () => void, enqueuedAt: number }} */ (deferred[deferredHead]);
		deferred[deferredHead] = undefined;
		deferredHead = deferredHead + 1 === maxDeferred ? 0 : deferredHead + 1;
		deferredDepth--;
		if (deferredDepth === 0) {
			deferredHead = 0;
			deferredTail = 0;
		}
		return entry;
	}

	function drain() {
		drainScheduled = false;
		perTickCount = 0;
		while (perTickCount < perTickBudget && deferredDepth > 0) {
			const entry = dequeue();
			perTickCount++;
			try { entry.fn(); } catch (err) { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.UPGRADE_DEFERRED), err); }
		}
		notifyDeferredObserver();
		// A drain that ran callbacks consumed this tick's budget. Schedule one
		// final empty turn after the queue empties so the counter resets before a
		// later, otherwise-unrelated upgrade arrives.
		if (deferredDepth > 0 || perTickCount > 0) scheduleDrain();
	}

	return {
		/** `true` if there is room; caller is responsible for `release()`. */
		tryAcquire() {
			if (maxConcurrent > 0 && inFlight >= maxConcurrent) return false;
			inFlight++;
			return true;
		},
		release() { inFlight--; },
		/**
		 * Reserve one whole-lifetime connection permit. The reservation includes
		 * the upgrade window, preventing concurrent handshakes from overshooting
		 * the configured live-connection ceiling. Disabled ceilings are a no-op.
		 */
		tryAcquireConnection() {
			if (maxConnections <= 0) return true;
			if (connectionPermits >= maxConnections) return false;
			connectionPermits++;
			return true;
		},
		/** Release a permit acquired by `tryAcquireConnection()`. */
		releaseConnection() {
			if (maxConnections <= 0) return;
			if (connectionPermits <= 0) {
				throw new Error('upgradeAdmission connection permit released without an acquisition.');
			}
			connectionPermits--;
		},
		/**
		 * Acquire a slot for a cursor-only upgrade (the worker's second
		 * WebSocket). All-or-nothing, mirroring `tryAcquire()`: admitted only
		 * when both the main ceiling has room AND the cursor sub-budget has
		 * room. On success it consumes one slot from each counter and the
		 * caller is responsible for `releaseCursorInFlight()`. The main lane's
		 * `tryAcquire()` is never gated by the cursor sub-budget, so the cursor
		 * lane is sheddable without ever starving the main lane.
		 *
		 * @returns {boolean}
		 */
		tryAcquireCursor() {
			if (maxConcurrent > 0 && inFlight >= maxConcurrent) return false;
			if (cursorInFlight >= cursorMaxConcurrent) return false;
			inFlight++;
			cursorInFlight++;
			return true;
		},
		/**
		 * Release a slot taken by `tryAcquireCursor()`: decrements both the
		 * main in-flight counter and the cursor sub-budget counter, keeping the
		 * two in step so the cursor lane cannot leak across an aborted or
		 * timed-out cursor upgrade.
		 */
		releaseCursorInFlight() { inFlight--; cursorInFlight--; },
		/** Live snapshot, primarily for tests / introspection. */
		get inFlight() { return inFlight; },
		/** Configured concurrent-upgrade ceiling (`0` when the gate is open). */
		get maxConcurrent() { return maxConcurrent; },
		/** Configured reserved-or-live connection ceiling (`0` when disabled). */
		get maxConnections() { return maxConnections; },
		/** Effective finite deferred-callback ceiling (`0` when pacing is off). */
		get maxDeferred() { return maxDeferred; },
		/** Upgrade callbacks currently retained by the pacing queue. */
		get deferredDepth() { return deferredDepth; },
		/** Live age in milliseconds of the oldest retained callback, or `0`. */
		get deferredOldestAgeMs() { return oldestDeferredAgeMs(); },
		/** Callbacks refused because the finite pacing queue was full. */
		get deferredRejectedTotal() { return deferredRejectedTotal; },
		/**
		 * Install the internal metrics observer. It receives an initial snapshot
		 * and every later enqueue, overflow, and drain transition.
		 *
		 * @param {null | ((depth: number, oldestAgeMs: number, rejectedTotal: number) => void)} observer
		 */
		setDeferredObserver(observer) {
			deferredObserver = typeof observer === 'function' ? observer : null;
			notifyDeferredObserver();
		},
		/** Reserved upgrades plus live connections currently holding permits. */
		get connectionPermits() { return connectionPermits; },
		/** Remaining permits, or `null` when the live-connection gate is disabled. */
		get connectionHeadroom() {
			return maxConnections > 0 ? maxConnections - connectionPermits : null;
		},
		/** Live count of cursor-lane upgrades in flight. */
		get cursorInFlight() { return cursorInFlight; },
		/**
		 * Reserved cursor-lane ceiling (`0` when the lane is disabled - no
		 * `cursorLane` option or no main ceiling to carve from).
		 */
		get cursorMaxConcurrent() { return cursorMaxConcurrent; },
		/**
		 * Read-only: `true` if a `tryAcquire()` would currently succeed.
		 * Acquires nothing and mutates no counter, so a capacity probe can
		 * ask "is there room?" without ever consuming a slot. Pacing is full
		 * only when this tick's synchronous budget AND the finite deferred queue
		 * are both exhausted; a transient spent tick with queue room remains
		 * admissible.
		 *
		 * @returns {boolean}
		 */
		hasCapacity() {
			return !(maxConcurrent > 0 && inFlight >= maxConcurrent) &&
				!(maxConnections > 0 && connectionPermits >= maxConnections) &&
				!(perTickBudget > 0 && perTickCount >= perTickBudget && deferredDepth >= maxDeferred);
		},
		/**
		 * Run `fn` (the actual `res.upgrade()` call) under the per-tick
		 * budget. Returns `true` if `fn` ran synchronously, `false` if
		 * deferred to a later tick, or `null` when the finite queue is full.
		 *
		 * @param {() => void} fn
		 * @returns {boolean | null}
		 */
		admit(fn) {
			if (perTickBudget <= 0) { fn(); return true; }
			if (perTickCount < perTickBudget) {
				perTickCount++;
				// Reset on the next turn even when no request exceeds the budget;
				// otherwise a quiet request much later is mistaken for this tick.
				scheduleDrain();
				fn();
				return true;
			}
			if (deferredDepth >= maxDeferred) {
				deferredRejectedTotal++;
				notifyDeferredObserver();
				return null;
			}
			deferred[deferredTail] = { fn, enqueuedAt: monotonicNow() };
			deferredTail = deferredTail + 1 === maxDeferred ? 0 : deferredTail + 1;
			deferredDepth++;
			notifyDeferredObserver();
			scheduleDrain();
			return false;
		}
	};
}

/**
 * String-keyed carrier used only across `res.upgrade()`. uWebSockets.js does
 * not preserve Symbol keys in upgrade userData, so `open` immediately promotes
 * this marker to the collision-safe `WS_CONNECTION_PERMIT` symbol and deletes
 * the string property before application hooks observe the object.
 */
export const WS_CONNECTION_PERMIT_KEY = '__adapter_uws_connection_permit__';

/**
 * Decide the shape of an at-capacity request rejection. Only an explicitly
 * acceptable `text/html` media range on a non-WebSocket request gets HTML.
 * Lookalike media types, q=0 exclusions, library requests, and actual
 * WebSocket handshakes keep the bare retry response.
 *
 * @param {string | undefined | null} accept
 * @param {string | undefined | null} [upgrade]
 * @returns {'html' | 'retry'}
 */
export function negotiateRejection(accept, upgrade) {
	if (typeof upgrade === 'string' && upgrade.split(',').some((token) => token.trim().toLowerCase() === 'websocket')) {
		return 'retry';
	}
	if (typeof accept !== 'string' || accept.length === 0) return 'retry';
	const ranges = splitHttpHeaderValue(accept, ',');
	if (ranges === null) return 'retry';
	for (const range of ranges) {
		const rawSegments = splitHttpHeaderValue(range, ';');
		if (rawSegments === null) continue;
		const segments = rawSegments.map((segment) => segment.trim());
		if (segments.shift()?.toLowerCase() !== 'text/html') continue;
		const quality = segments.find((segment) => /^q\s*=/i.test(segment));
		if (quality === undefined) return 'html';
		const raw = quality.slice(quality.indexOf('=') + 1).trim();
		if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)) continue;
		if (Number(raw) > 0) return 'html';
	}
	return 'retry';
}

/**
 * Split an HTTP list only at delimiters outside quoted strings. Accept
 * parameters may legally quote commas and semicolons; treating those bytes as
 * separators can hide a later q=0 exclusion. Malformed unclosed quotes fail
 * closed instead of selecting HTML.
 *
 * @param {string} value
 * @param {',' | ';'} delimiter
 * @returns {string[] | null}
 */
function splitHttpHeaderValue(value, delimiter) {
	const parts = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quoted && escaped) {
			escaped = false;
			continue;
		}
		if (quoted && character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && character === delimiter) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	if (quoted || escaped) return null;
	parts.push(value.slice(start));
	return parts;
}

/**
 * The Sec-WebSocket-Protocol token the cursor-only upgrade lane is keyed on.
 * The worker's second (cursor) WebSocket sets this subprotocol; the upgrade
 * handler reads it to route the upgrade through the deprioritised cursor lane.
 * The token is read only; the server still echoes the negotiated subprotocol
 * back to the client unchanged.
 */
export const CURSOR_LANE_SUBPROTOCOL = 'svelte-realtime-cursor';

/**
 * `true` when the comma-separated `Sec-WebSocket-Protocol` request header lists
 * the cursor-lane token. Pure and uWS-free so the token parsing is unit-testable
 * and isolated from the upgrade hot path. Trims each offered token so the common
 * `"a, b"` spacing matches.
 *
 * @param {string | undefined | null} secProtocol the raw request header value
 * @returns {boolean}
 */
export function isCursorLaneUpgrade(secProtocol) {
	if (typeof secProtocol !== 'string' || secProtocol.length === 0) return false;
	const offered = secProtocol.split(',');
	for (let i = 0; i < offered.length; i++) {
		if (offered[i].trim() === CURSOR_LANE_SUBPROTOCOL) return true;
	}
	return false;
}

/**
 * Shortest gap between two unforced rewrites of the holding page's status line.
 * The line is a live region, so a rewrite is an announcement; at a sub-second
 * poll interval an estimate that drifts by one would otherwise announce
 * continuously. State changes bypass this floor - it exists to damp the count,
 * not to delay the news the visitor is waiting for.
 */
const ANNOUNCE_FLOOR_MS = 10000;

/**
 * Compose the holding page's status line for a live waiting count.
 *
 * The count is a rolling estimate of how many browsers are polling the holding
 * page right now. It is NOT a position and NOT a reservation: admission is a
 * concurrency gate that keeps no per-client identity, arrival order or hold, so
 * a waiting visitor can be overtaken by anyone and two tabs of one person count
 * twice. The wording therefore states a crowd size and nothing else, and a
 * count of zero - which is also what an unseeded first paint carries - renders
 * the neutral line instead of "0 people".
 *
 * The value is bucketed before it is shown. The underlying number is not
 * precise enough to justify single-unit churn, and the line is a live region:
 * rewriting it every poll interval because the estimate moved by one is worse
 * than silence for a screen reader.
 *
 * The source of this function is ALSO embedded verbatim into the page's inline
 * script, so the server's first paint and every polled update come from one
 * implementation and cannot drift apart in grammar or rounding. That embedding
 * is a hard constraint on the body: it must stay self-contained (no imports, no
 * module-scope reads) and must contain no `</` sequence, which would close the
 * script element early. The `'en'` locale is pinned for the same reason - the
 * page is `lang="en"` and the two sides must format an identical string.
 *
 * @param {number} waiting rolling count of browsers currently holding the page
 * @returns {string}
 */
export function waitingRoomStatusText(waiting) {
	const n = Math.floor(Number(waiting) || 0);
	if (!(n > 0)) return 'Waiting for a free slot.';
	const rounded = n < 10 ? n : n < 100 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;
	const shown = new Intl.NumberFormat('en').format(rounded);
	return 'About ' + shown + (rounded === 1 ? ' person is' : ' people are') + ' waiting for a free slot.';
}

/**
 * Escape operator-supplied identity text before it enters the built-in page or
 * a custom template token.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeWaitingRoomHtml(value) {
	return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
	));
}

/**
 * Keep status and support links useful without allowing an operator typo to
 * turn the holding page into a script URL. Relative URLs and the `http`,
 * `https`, `mailto` and `tel` schemes are accepted - one safe-scheme set for
 * every identity link, matching the accessibility validator's recovery-href
 * policy; anything else is omitted.
 *
 * @param {unknown} value
 * @returns {string}
 */
function waitingRoomHref(value) {
	if (typeof value !== 'string' || value.trim() === '') return '';
	const raw = value.trim();
	try {
		const parsed = new URL(raw, 'https://waiting-room.invalid/');
		// mailto: and tel: are the natural values for a support link and are
		// classified safe by the same policy the accessibility validator
		// applies to recovery hrefs - one safe-scheme set, not two.
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' &&
			parsed.protocol !== 'mailto:' && parsed.protocol !== 'tel:') return '';
		return escapeWaitingRoomHtml(raw);
	} catch {
		return '';
	}
}

const WAITING_ROOM_OWNED_HEADERS = new Set([
	'cache-control',
	'connection',
	'content-language',
	'content-length',
	'content-type',
	'transfer-encoding',
	'vary'
]);

/**
 * Snapshot the request shape a localized renderer may inspect. A uWS request
 * object is valid only during its callback, so the facade is detached from it:
 * retaining the renderer context cannot retain or later touch native state.
 *
 * @param {{ getMethod?: () => string, getUrl?: () => string, getQuery?: () => string, forEach?: (visitor: (name: string, value: string) => void) => void } | null | undefined} req
 * @returns {{ method: string, url: string, headers: { get(name: string): string | null } }}
 */
export function createWaitingRoomRequest(req) {
	const method = typeof req?.getMethod === 'function'
		? String(req.getMethod() || 'GET').toUpperCase()
		: 'GET';
	const pathname = typeof req?.getUrl === 'function' ? String(req.getUrl() || '/') : '/';
	const query = typeof req?.getQuery === 'function' ? String(req.getQuery() || '') : '';
	const snapshot = Object.create(null);
	if (typeof req?.forEach === 'function') collectRequestHeaders(req, snapshot);
	const get = (name) => {
		if (typeof name !== 'string' || !/^[a-z0-9-]+$/i.test(name)) return null;
		const key = name.toLowerCase();
		if (!Object.prototype.hasOwnProperty.call(snapshot, key)) return null;
		return String(snapshot[key]);
	};
	return Object.freeze({
		method,
		url: query ? pathname + '?' + query : pathname,
		headers: Object.freeze({ get })
	});
}

/**
 * Make renderer language metadata authoritative for the document as well as
 * the HTTP response. A renderer module must return a full HTML document; the
 * adapter replaces any pre-existing lang/dir attributes so the body cannot
 * contradict Content-Language.
 *
 * @param {string} body
 * @param {string} lang
 * @param {'ltr' | 'rtl' | 'auto'} dir
 * @returns {string}
 */
function applyWaitingRoomDocumentLanguage(body, lang, dir) {
	const html = /^(\s*(?:<!doctype html>\s*)?)<html\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i;
	if (!html.test(body)) {
		throw new TypeError('waiting-room renderer result.body must contain a full <html> document.');
	}
	return body.replace(html, (_whole, prefix, attrs) => {
		const retained = String(attrs).replace(
			/\s+(?:lang|dir)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
			''
		);
		return prefix + '<html lang="' + escapeWaitingRoomHtml(lang) + '" dir="' + dir + '"' + retained + '>';
	});
}

/**
 * Validate one renderer result before any value reaches uWS response headers.
 *
 * @param {unknown} value
 * @param {{ validateDocument?: boolean }} [options]
 * @returns {{ body: string, lang: string, dir: 'ltr' | 'rtl' | 'auto', headers: Array<[string, string]>, varyAcceptLanguage: true }}
 */
function normalizeWaitingRoomRendererResult(value, options = {}) {
	if (!value || typeof value !== 'object' || typeof value.then === 'function') {
		throw new TypeError('waiting-room renderer must synchronously return { body, lang, dir, headers? }.');
	}
	const result = /** @type {Record<string, unknown>} */ (value);
	if (typeof result.body !== 'string') {
		throw new TypeError('waiting-room renderer result.body must be a string.');
	}
	let lang;
	try {
		const canonical = typeof result.lang === 'string'
			? Intl.getCanonicalLocales(result.lang.trim())
			: [];
		if (canonical.length !== 1) throw new RangeError('missing language');
		lang = canonical[0];
	} catch {
		throw new TypeError('waiting-room renderer result.lang must be a valid BCP 47 language tag.');
	}
	if (result.dir !== 'ltr' && result.dir !== 'rtl' && result.dir !== 'auto') {
		throw new TypeError('waiting-room renderer result.dir must be "ltr", "rtl", or "auto".');
	}
	if (
		result.headers != null &&
		(typeof result.headers !== 'object' || Array.isArray(result.headers))
	) {
		throw new TypeError('waiting-room renderer result.headers must be a string record.');
	}
	const headers = [];
	for (const [rawName, rawValue] of Object.entries(result.headers || {})) {
		const name = rawName.toLowerCase();
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
			throw new TypeError('waiting-room renderer returned an invalid response header name.');
		}
		if (WAITING_ROOM_OWNED_HEADERS.has(name)) {
			throw new TypeError('waiting-room renderer cannot override adapter-owned header "' + name + '".');
		}
		if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue)) {
			throw new TypeError('waiting-room renderer response header values must be strings without newlines.');
		}
		headers.push([name, rawValue]);
	}
	const dir = result.dir;
	const body = applyWaitingRoomDocumentLanguage(result.body, lang, dir);
	// The full parse5 accessibility walk runs on the FIRST response only (the
	// caller memoizes): the metadata and header checks above stay per call,
	// but an unauthenticated overload route must not pay a document parse per
	// request - overload protection has to be the cheap path.
	if (options.validateDocument !== false) {
		assertAccessibleWaitingDocument(body, 'waiting-room renderer result.body');
	}
	return {
		body,
		lang,
		dir,
		headers,
		varyAcceptLanguage: true
	};
}

/**
 * Minimal accessible document for an HTML navigation when the interactive
 * waiting room is disabled. It intentionally remains a 503 and performs no
 * polling; the manual form is the recovery path, while the persistent status
 * region gives the refusal one announced state instead of a plain-text orphan.
 *
 * @returns {string}
 */
export function buildAccessibleCapacityRefusalPage() {
	return '<!doctype html><html lang="en" dir="ltr"><head>' +
		'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<title>Service unavailable</title></head><body><main>' +
		'<h1>Server at capacity</h1>' +
		'<p role="status" aria-live="polite" aria-atomic="true">' +
		'New connections cannot be opened right now. Try again later.</p>' +
		'<form method="get"><button type="submit">Try again</button></form>' +
		'</main></body></html>';
}

/**
 * Write a normalized holding-page response through the shared uWS-shaped API.
 *
 * @param {{ cork(fn: () => void): void, writeStatus(status: string): unknown, writeHeader(name: string, value: string): unknown, end(body: string): unknown }} res
 * @param {{ body: string, lang: string | null, headers: Array<[string, string]>, varyAcceptLanguage: boolean }} page
 * @param {string} [status]
 * @returns {void}
 */
export function sendWaitingRoomPage(res, page, status = '200 OK') {
	res.cork(() => {
		res.writeStatus(status);
		res.writeHeader('content-type', 'text/html; charset=utf-8');
		res.writeHeader('cache-control', 'no-store');
		if (page.lang) res.writeHeader('content-language', page.lang);
		if (page.varyAcceptLanguage) res.writeHeader('vary', 'Accept-Language');
		for (const [name, value] of page.headers) res.writeHeader(name, value);
		res.end(page.body);
	});
}

/**
 * The `Retry-After` base a refusal answers when no waiting room supplies a
 * configured one: the same two seconds a default room derives from its poll
 * interval, so a server reads as one server whether the room is on or not.
 */
export const REFUSAL_RETRY_AFTER_SECONDS = 2;

/**
 * One jittered `Retry-After` in whole seconds: the base plus a uniform draw
 * over a band of at least two values.
 *
 * The band floor is the point of this function. `Retry-After` carries whole
 * seconds, so a band that rounds below two values collapses to a constant -
 * at the default base of 2 a half-base spread is `floor(random() * 1)`,
 * which is 0 on every draw - and a constant answers every member of a
 * refused fleet with the same second, so the whole fleet returns together
 * into the same full gate and the jitter's anti-herd purpose is not served.
 * The floor guarantees at least two distinct answers at every base, which
 * splits any herd; what it costs is one extra second for at most half the
 * refused clients, on a path that is already shedding. Above the floor the
 * band is `ceil(base * spread)`, so a widened spread still widens the band
 * at every base and the growth with `spread` stays monotone.
 *
 * @param {number} baseSeconds - whole-second base (the minimum answered)
 * @param {number} [spread] - fraction of the base the band covers (default `0.5`)
 * @returns {number}
 */
export function jitterRetryAfter(baseSeconds, spread) {
	const s = typeof spread === 'number' && spread > 0 ? spread : 0.5;
	const band = Math.max(2, Math.ceil(baseSeconds * s));
	return baseSeconds + Math.floor(randomFloat() * band);
}

/**
 * Build the default self-contained holding page served when an upgrade is
 * refused at capacity. No framework, no external fetch beyond the poll
 * endpoint. The inline script polls `admitCheckPath` on a jittered interval,
 * recomposes the status line from each `202` body, and reloads on a `200`
 * admit.
 *
 * The page states only what the gate actually observes: that new connections
 * cannot be opened, and (when the caller seeds one) a rolling estimate of how
 * many browsers are waiting. There is no queue position and no wait estimate,
 * because nothing in the runtime orders waiting clients or measures the drain
 * rate. A caller that renders without a depth therefore gets an honest neutral
 * line rather than a fabricated zero.
 *
 * Accessibility contract of the emitted document, which the inline script has
 * to keep intact:
 * - the status line is one persistent `role="status"` region, present at first
 *   paint (a region injected at update time is unreliable across assistive
 *   tech) and rewritten whole, hence `aria-atomic`;
 * - it is rewritten only on a material change, and no more often than once per
 *   `ANNOUNCE_FLOOR_MS`, so a short poll interval cannot turn the region into a
 *   stream of near-identical announcements;
 * - a failed poll is a visible and announced state, not a silent retry behind a
 *   stale number, and the recovery is announced too;
 * - the auto-updating content has a native pause control. While paused the page
 *   stops rewriting the region and stops reloading itself, but it keeps polling:
 *   the only two things it still says are the ones its own paused wording
 *   promises - that a slot has opened, offered as a button rather than taken by
 *   navigating, and that an offered slot was taken by somebody else before the
 *   visitor acted on it;
 * - the region is never given `aria-live="off"`, not even while paused. Which
 *   rewrites happen is what pausing controls; muting the region instead would
 *   silence the two announcements above and the confirmation of the visitor's
 *   own press, which is the one moment they are certainly listening.
 *
 * All numeric context fields are coerced to integers before embedding and
 * `admitCheckPath` is embedded via `JSON.stringify`, so no value reaches the
 * HTML or the inline script unescaped; the status line is composed from a
 * coerced integer through a fixed template, so it carries no markup either.
 *
 * @param {{ queueDepth?: number, estimatedSeconds?: number, pollIntervalMs?: number, retryAfterSeconds?: number, admitCheckPath?: string, appName?: string, statusUrl?: string, supportUrl?: string, incidentId?: string }} ctx
 * @returns {string}
 */
export function buildWaitingRoomPage(ctx) {
	const queueDepth = Math.max(0, Math.floor(Number(ctx && ctx.queueDepth) || 0));
	const pollIntervalMs = Math.max(250, Math.floor(Number(ctx && ctx.pollIntervalMs) || 2000));
	const checkPath = JSON.stringify((ctx && ctx.admitCheckPath) || '/__admit-check');
	const appName = escapeWaitingRoomHtml(ctx && ctx.appName);
	const statusUrl = waitingRoomHref(ctx && ctx.statusUrl);
	const supportUrl = waitingRoomHref(ctx && ctx.supportUrl);
	const incidentId = escapeWaitingRoomHtml(ctx && ctx.incidentId);
	const title = appName ? appName + ' - Waiting room' : 'Waiting room';
	const identity = appName ? '<p class="app-name">' + appName + '</p>' : '';
	const resources = statusUrl || supportUrl
		? '<nav class="links" aria-label="Service resources">' +
			(statusUrl ? '<a href="' + statusUrl + '">Service status</a>' : '') +
			(supportUrl ? '<a href="' + supportUrl + '">Get help</a>' : '') +
			'</nav>'
		: '';
	const incident = incidentId
		? '<p class="incident">Incident reference: <code>' + incidentId + '</code></p>'
		: '';
	return '<!doctype html>' +
		'<html lang="en" dir="ltr"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<title>' + title + '</title>' +
		'<style>:root{color-scheme:light dark;' +
		'--waiting-room-page-background:#f4f4f5;--waiting-room-panel-background:#fff;' +
		'--waiting-room-text:#18181b;--waiting-room-muted-text:#52525b;' +
		'--waiting-room-border:#d4d4d8;--waiting-room-link:#1d4ed8;' +
		'--waiting-room-control-background:#fff;--waiting-room-control-hover:#e4e4e7;' +
		'--waiting-room-focus-ring:#2563eb}' +
		'@media(prefers-color-scheme:dark){:root{' +
		'--waiting-room-page-background:#09090b;--waiting-room-panel-background:#18181b;' +
		'--waiting-room-text:#fafafa;--waiting-room-muted-text:#a1a1aa;' +
		'--waiting-room-border:#3f3f46;--waiting-room-link:#93c5fd;' +
		'--waiting-room-control-background:#27272a;--waiting-room-control-hover:#3f3f46;' +
		'--waiting-room-focus-ring:#93c5fd}}' +
		'body{font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;' +
		'align-items:center;justify-content:center;background:var(--waiting-room-page-background);' +
		'color:var(--waiting-room-text)}' +
		'main{text-align:center;max-width:30rem;margin:1rem;padding:2rem;' +
		'background:var(--waiting-room-panel-background);border:1px solid var(--waiting-room-border);' +
		'border-radius:.75rem}h1{font-size:1.4rem;margin:0 0 .75rem}' +
		'p{margin:.4rem 0;color:var(--waiting-room-muted-text)}' +
		'.app-name{font-weight:600;color:var(--waiting-room-text)}' +
		'.links{margin-top:1rem}.links a{color:var(--waiting-room-link)}' +
		'.links a+a{margin-left:1rem}.incident code{color:var(--waiting-room-text)}' +
		'button{font:inherit;margin:.75rem .25rem 0;padding:.5rem 1rem;' +
		'border:1px solid var(--waiting-room-border);border-radius:.4rem;' +
		'background:var(--waiting-room-control-background);color:var(--waiting-room-text);cursor:pointer}' +
		'button:hover{background:var(--waiting-room-control-hover)}' +
		'button:focus-visible{outline:3px solid var(--waiting-room-focus-ring);outline-offset:2px}' +
		'[hidden]{display:none}</style></head>' +
		'<body><main>' +
		identity +
		'<h1>Server at capacity</h1>' +
		'<p>New connections cannot be opened right now. This page checks for a free slot ' +
		'and reloads by itself as soon as one opens.</p>' +
		'<p id="s" role="status" aria-live="polite" aria-atomic="true">' +
		waitingRoomStatusText(queueDepth) + '</p>' +
		'<p><button type="button" id="p" aria-pressed="false">Pause live updates</button>' +
		'<button type="button" id="c" hidden>Reload now</button></p>' +
		resources +
		incident +
		'</main>' +
		'<script>' +
		'(function(){' +
		'var url=' + checkPath + ';' +
		'var base=' + pollIntervalMs + ';' +
		'var say=' + String(waitingRoomStatusText) + ';' +
		'var box=document.getElementById("s");' +
		'var pause=document.getElementById("p");' +
		'var go=document.getElementById("c");' +
		'var paused=false,open=false,missed=false,stale=false,depth=' + queueDepth + ';' +
		'var shown=box.textContent,last=0;' +
		// Every line the region can hold is derived here from the flags, and no
		// call site ever writes a literal. A branch that announced its own text
		// would keep asserting it after the condition behind it had passed, which
		// is how a paused page ends up frozen on a count that stopped being true
		// or on an offer of a slot somebody else already took.
		'function state(){' +
		'if(open)return "A slot is open. Choose Reload now to continue.";' +
		'if(paused)return missed?"That slot was taken before you chose Reload now. ' +
		'Live updates are still paused and this page keeps checking.":' +
		'"Live updates paused. This page will not reload by itself; it keeps checking ' +
		'and shows a Reload now button when a slot opens.";' +
		'return stale?"The last check did not reach the server. Retrying.":say(depth);' +
		'}' +
		// Rewrite levels, in rising order of what they may interrupt:
		//   0 the polled count - damped by the announce floor, silent while paused;
		//   1 a check failed or recovered - skips the floor, still silent while
		//     paused, because a paused page promised to stop reporting on its own
		//     polling and a blip is not news the visitor asked to keep hearing;
		//   2 a slot opened or was taken, or the visitor worked the control - the
		//     only rewrites a paused page performs, and exactly the ones its own
		//     wording promises.
		// The region keeps aria-live="polite" throughout. Muting it while paused
		// would also swallow the confirmation of the visitor's own press and the
		// free-slot news, which are the two things a paused visitor still has to
		// hear; the levels above, not the attribute, are what hold it quiet.
		'function show(level){' +
		'if(paused&&level<2)return;' +
		'var text=state();' +
		'if(text===shown)return;' +
		'var t=Date.now();' + // determinism-allow: browser-side script text in the holding page, not a server primitive
		'if(!level&&t-last<' + ANNOUNCE_FLOOR_MS + ')return;' +
		'shown=text;last=t;box.textContent=text;' +
		'}' +
		'function jitter(ms){return ms+Math.floor(Math.random()*ms*0.5);}' + // determinism-allow: browser-side script text in the holding page, not a server primitive
		'function tick(delay){setTimeout(poll,delay);}' + // determinism-allow: browser-side script text in the holding page, not a server primitive
		// The check reports live capacity and reserves nothing, so a slot seen
		// open can close again before the visitor acts on it. The loop therefore
		// keeps running across an offer instead of stopping on it: the offer is
		// withdrawn, and said out loud, the moment a later check disagrees. The
		// button itself is only withdrawn when it does not hold focus - pulling
		// the focused element out of the document mid-press is a worse failure
		// than an offer that is one poll interval stale, and pressing it then
		// simply re-serves this page.
		'function offer(on){' +
		'if(on)go.hidden=false;else if(document.activeElement!==go)go.hidden=true;' +
		'show(2);' +
		'}' +
		'function poll(){' +
		'fetch(url,{headers:{accept:"application/json"},cache:"no-store"})' +
		'.then(function(r){return r.json().then(function(b){return {s:r.status,b:b};});})' +
		'.then(function(o){' +
		'var admit=!!(o.s===200&&o.b&&o.b.admit);' +
		// Unpaused, an admit is the documented automatic reload and the page is
		// on its way out, so nothing further is scheduled.
		'if(admit&&!paused){location.reload();return;}' +
		'if(o.b&&typeof o.b.queueDepth==="number")depth=o.b.queueDepth;' +
		'var back=stale;stale=false;' +
		'if(admit!==open){missed=paused&&open&&!admit;open=admit;offer(admit);}' +
		'else show(back?1:0);' +
		'var next=(o.b&&typeof o.b.pollAfterMs==="number")?o.b.pollAfterMs:base;' +
		'tick(jitter(next));' +
		'})' +
		'.catch(function(){stale=true;show(1);tick(jitter(base));});' +
		'}' +
		// Pausing speaks even though it is the act of going quiet: it confirms a
		// key press the visitor just made. Resuming drops the record of a missed
		// slot, which is news about a pause that is over, and leaves the next
		// poll to reload if a slot is still open - re-checking beats navigating
		// off a reading that may already be a poll interval old.
		'pause.addEventListener("click",function(){' +
		'paused=!paused;' +
		'pause.setAttribute("aria-pressed",paused?"true":"false");' +
		'pause.textContent=paused?"Resume live updates":"Pause live updates";' +
		'if(!paused)missed=false;' +
		'show(2);' +
		'});' +
		'go.addEventListener("click",function(){location.reload();});' +
		'tick(jitter(base));' +
		'})();' +
		'</script></body></html>';
}

/**
 * Substitute the supported `{{token}}` placeholders in an operator-supplied
 * waiting-room template string. Numeric context values are coerced to integers
 * and the string value is HTML-escaped, so no token value reaches the page
 * unescaped. The compiler rejects unknown or incomplete token syntax. A
 * template is a JSON-serializable string (not a function) so it survives the
 * build-time options serialization and reaches the production runtime.
 *
 * Supported tokens: `{{queueDepth}}`, `{{estimatedSeconds}}`,
 * `{{pollIntervalMs}}`, `{{retryAfterSeconds}}`, `{{admitCheckPath}}`,
 * `{{appName}}`, `{{statusUrl}}`, `{{supportUrl}}`, `{{incidentId}}`.
 *
 * What the two estimate tokens actually carry, so an operator page does not
 * repeat a claim the runtime cannot back: `{{queueDepth}}` is a rolling count
 * of browsers polling the holding page - a crowd size, never a position in a
 * line - and `{{estimatedSeconds}}` is that count projected at a nominal one
 * slot per second, never a measured wait. Both are kept for templates written
 * against them; the built-in page words the first honestly and shows no wait
 * estimate at all.
 *
 * @param {string} tpl
 * @param {{ queueDepth: number, estimatedSeconds: number, pollIntervalMs: number, retryAfterSeconds: number, admitCheckPath: string, appName?: string, statusUrl?: string, supportUrl?: string, incidentId?: string }} ctx
 * @returns {string}
 */
export function renderWaitingRoomTemplate(tpl, ctx) {
	return compileWaitingRoomTemplate(tpl)(waitingRoomTemplateValues(ctx));
}

/**
 * Normalize and escape one live template context.
 * @param {{ queueDepth: number, estimatedSeconds: number, pollIntervalMs: number, retryAfterSeconds: number, admitCheckPath: string, appName?: string, statusUrl?: string, supportUrl?: string, incidentId?: string }} ctx
 * @returns {Record<string, string>}
 */
function waitingRoomTemplateValues(ctx) {
	return {
		queueDepth: String(Math.max(0, Math.floor(Number(ctx && ctx.queueDepth) || 0))),
		estimatedSeconds: String(Math.max(0, Math.floor(Number(ctx && ctx.estimatedSeconds) || 0))),
		pollIntervalMs: String(Math.max(250, Math.floor(Number(ctx && ctx.pollIntervalMs) || 2000))),
		retryAfterSeconds: String(Math.max(1, Math.floor(Number(ctx && ctx.retryAfterSeconds) || 1))),
		admitCheckPath: escapeWaitingRoomHtml((ctx && ctx.admitCheckPath) || '/__admit-check'),
		appName: escapeWaitingRoomHtml(ctx && ctx.appName),
		statusUrl: waitingRoomHref(ctx && ctx.statusUrl),
		supportUrl: waitingRoomHref(ctx && ctx.supportUrl),
		incidentId: escapeWaitingRoomHtml(ctx && ctx.incidentId)
	};
}

/**
 * Resolve the waiting-room configuration once at handler setup. Returns a
 * ready-to-use object (with the rendering and jitter helpers bound to the
 * resolved settings) or `null` when the waiting room is off.
 *
 * The waiting room is on by default whenever the gate can actually reject -
 * that is, `maxConcurrent > 0`, `maxConnections > 0`, or bounded pacing via
 * `perTickBudget > 0` - unless the operator opts out with `waitingRoom: false`.
 * When it is off, an HTML navigation gets the
 * minimal accessible `503`; WebSocket and non-HTML clients keep the exact
 * bare response. The shape mirrors the gate's own "> 0 means active" rule so the
 * waiting room can only engage in a deployment that has opted into admission
 * control (there is nothing to queue for otherwise).
 *
 * @param {{ maxConcurrent?: number, maxConnections?: number, perTickBudget?: number, maxDeferred?: number, waitingRoom?: false | { path?: string, admitCheckPath?: string, retryAfterSeconds?: number, pollIntervalMs?: number, template?: string, renderer?: string | Function, appName?: string, statusUrl?: string, supportUrl?: string, incidentId?: string } } | undefined} upgradeAdmission
 * @param {Function | null} [rendererModule] bundled production renderer
 * @returns {null | { path: string, admitCheckPath: string, pollIntervalMs: number, retryAfterSeconds: number, jitteredRetryAfter(spread?: number): number, estimateSeconds(queueDepth: number): number, renderPage(queueDepth?: number): string, renderResponse(queueDepth?: number, request?: { method: string, url: string, headers: { get(name: string): string | null } }): { body: string, lang: string | null, dir: string | null, headers: Array<[string, string]>, varyAcceptLanguage: boolean } }}
 */
export function resolveWaitingRoom(upgradeAdmission, rendererModule = null) {
	const ua = upgradeAdmission;
	const wr = ua && ua.waitingRoom;
	if (!(ua && (ua.maxConcurrent > 0 || ua.maxConnections > 0 || ua.perTickBudget > 0) && wr !== false)) return null;

	const cfg = (wr && typeof wr === 'object') ? wr : {};
	const path = typeof cfg.path === 'string' ? cfg.path : '/__waiting-room';
	const admitCheckPath = typeof cfg.admitCheckPath === 'string' ? cfg.admitCheckPath : '/__admit-check';
	const pollIntervalMs = Number.isFinite(cfg.pollIntervalMs) && cfg.pollIntervalMs > 0
		? Math.floor(cfg.pollIntervalMs) : 2000;
	const retryAfterSeconds = Number.isFinite(cfg.retryAfterSeconds) && cfg.retryAfterSeconds > 0
		? Math.floor(cfg.retryAfterSeconds) : Math.max(1, Math.round(pollIntervalMs / 1000));
	// Trimmed at the boundary: a whitespace-only value must behave like an
	// absent one, not render a dangling-dash title or an empty identity line.
	const appName = typeof cfg.appName === 'string' ? cfg.appName.trim() : '';
	const statusUrl = typeof cfg.statusUrl === 'string' ? cfg.statusUrl.trim() : '';
	const supportUrl = typeof cfg.supportUrl === 'string' ? cfg.supportUrl.trim() : '';
	const incidentId = typeof cfg.incidentId === 'string' ? cfg.incidentId.trim() : '';
	if (cfg.template != null && (cfg.renderer != null || rendererModule != null)) {
		throw new TypeError('waitingRoom.template and waitingRoom.renderer are mutually exclusive.');
	}
	// Operator override page. A string is the supported, serializable form
	// (token-substituted via renderWaitingRoomTemplate). A function is still
	// honoured if one is passed programmatically (e.g. the test harness), but it
	// cannot survive the build-time options serialization, so the documented
	// option is a string.
	const templateStr = typeof cfg.template === 'string' ? cfg.template : null;
	const templateFn = typeof cfg.template === 'function' ? cfg.template : null;
	const compiledTemplate = templateStr !== null
		? compileAccessibleWaitingRoomTemplate(templateStr)
		: null;
	const renderer = typeof rendererModule === 'function'
		? rendererModule
		: typeof cfg.renderer === 'function'
			? cfg.renderer
			: null;
	if (typeof cfg.renderer === 'string' && renderer === null) {
		throw new TypeError(
			'waitingRoom.renderer was configured, but its bundled module did not export a renderer function.'
		);
	}
	let rendererFailureReported = false;
	// First-render document-validation memos: the parse5 accessibility walk
	// runs once per surface, not per request.
	let templateFnDocument = null;
	let rendererDocumentValidated = false;

	const renderContext = (queueDepth) => {
		const normalizedDepth = Math.max(0, Math.floor(Number(queueDepth) || 0));
		return {
			queueDepth: normalizedDepth,
			estimatedSeconds: normalizedDepth,
			pollIntervalMs,
			retryAfterSeconds,
			admitCheckPath,
			appName,
			statusUrl,
			supportUrl,
			incidentId
		};
	};
	const templateDocument = compiledTemplate
		? assertAccessibleWaitingDocument(
			compiledTemplate(waitingRoomTemplateValues(renderContext(0))),
			'waitingRoom.template'
		)
		: null;
	assertAccessibleWaitingDocument(buildWaitingRoomPage(renderContext(0)), 'built-in waiting-room page');

	const builtInResponse = (ctx, varyAcceptLanguage = false) => ({
		body: buildWaitingRoomPage(ctx),
		lang: 'en',
		dir: 'ltr',
		headers: [],
		varyAcceptLanguage
	});

	return {
		path,
		admitCheckPath,
		pollIntervalMs,
		retryAfterSeconds,
		/**
		 * Spread the thundering-herd retry over this room's configured base:
		 * `jitterRetryAfter` with `retryAfterSeconds`, so refused library
		 * clients genuinely do not synchronise - the shared band floor
		 * guarantees at least two distinct answers at every base, including
		 * the default 2 where the previous half-base arithmetic collapsed to
		 * a constant. A caller that widens the band under load passes a
		 * larger factor.
		 *
		 * @param {number} [spread] fraction of the base to jitter over (default `0.5`).
		 * @returns {number}
		 */
		jitteredRetryAfter(spread) {
			return jitterRetryAfter(retryAfterSeconds, spread);
		},
		/**
		 * The polling-browser count projected at a nominal one slot per second.
		 * Nothing measures the real release rate, so this is a shape for a
		 * template that asks for it - never an admission input, and never shown
		 * by the built-in page, which does not claim a wait it cannot observe.
		 * Kept because it is a documented operator-facing field of the poll body
		 * and the template context.
		 *
		 * @param {number} queueDepth
		 * @returns {number}
		 */
		estimateSeconds(queueDepth) {
			const drain = 1;
			return Math.max(0, Math.ceil((queueDepth || 0) / drain));
		},
		/**
		 * Render the holding page for the given live queue depth, using the
		 * operator template when supplied or the built-in page otherwise.
		 *
		 * Called with no depth - which the refusal path does, having no counter
		 * of its own to read - the built-in page opens on its neutral status
		 * line and the first poll fills in the count. Nothing invents a zero
		 * crowd for a visitor who was just refused.
		 *
		 * Request-less body render. With a localizing renderer configured this
		 * DELIBERATELY yields the renderer's default locale (it is handed a
		 * synthetic request with an empty header snapshot) - localized output
		 * needs renderResponse(depth, request). Kept for template previews and
		 * the poll route's seed, which have no negotiating request.
		 *
		 * @param {number} [queueDepth]
		 * @returns {string}
		 */
		renderPage(queueDepth) {
			return this.renderResponse(queueDepth).body;
		},
		/**
		 * Render body plus response metadata. A bundled renderer receives the
		 * live request facade and may choose a locale per request. Invalid or
		 * throwing renderer output falls back to the built-in English page so a
		 * translation defect cannot turn overload protection into an outage.
		 *
		 * @param {number} [queueDepth]
		 * @param {{ method: string, url: string, headers: { get(name: string): string | null } }} [request]
		 * @returns {{ body: string, lang: string | null, dir: string | null, headers: Array<[string, string]>, varyAcceptLanguage: boolean }}
		 */
		renderResponse(queueDepth, request) {
			const ctx = renderContext(queueDepth);
			if (compiledTemplate) {
				return {
					body: compiledTemplate(waitingRoomTemplateValues(ctx)),
					lang: templateDocument.lang,
					dir: templateDocument.dir,
					headers: [],
					varyAcceptLanguage: false
				};
			}
			if (templateFn) {
				const body = String(templateFn(ctx));
				// Validate the first rendered document, then reuse its
				// metadata: the overload path must not pay a parse5 walk per
				// request. The template function sees only queue context, so
				// its language and direction do not vary per call.
				if (templateFnDocument === null) {
					templateFnDocument = assertAccessibleWaitingDocument(
						body,
						'waitingRoom.template function result'
					);
				}
				return {
					body,
					lang: templateFnDocument.lang,
					dir: templateFnDocument.dir,
					headers: [],
					varyAcceptLanguage: false
				};
			}
			if (renderer) {
				try {
					const normalized = normalizeWaitingRoomRendererResult(renderer({
						...ctx,
						request: request || createWaitingRoomRequest(null)
					}), { validateDocument: !rendererDocumentValidated });
					rendererDocumentValidated = true;
					return normalized;
				} catch (error) {
					if (!rendererFailureReported) {
						rendererFailureReported = true;
						console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WAITING_ROOM_FALLBACK), error);
					}
				}
			}
			return builtInResponse(ctx, renderer !== null);
		}
	};
}

/**
 * Rolling two-window poll counter behind the waiting room's queue-depth
 * estimate. `record(t)` counts a poll into the current window, rolling the
 * window once `windowMs` has elapsed; `depth(t)` reads the estimate without
 * recording. Both take the caller's clock reading instead of reading a clock,
 * so the math is pure and decays correctly from ANY call site - in particular
 * a periodic sampler that keeps reading after the last poll arrived: a window
 * nothing has rolled fades to zero instead of freezing at its final count.
 * Cheap by construction (two ints and a window marker, never per-client
 * state), so it cannot itself become a DoS vector.
 *
 * @param {number} windowMs
 * @returns {{ record(t: number): void, depth(t: number): number }}
 */
export function createPollCounter(windowMs) {
	// Both windows start fully stale so depth() reads 0 until the first poll.
	let windowStart = -Infinity;
	let count = 0;
	let prevCount = 0;

	return {
		record(t) {
			const elapsed = t - windowStart;
			if (elapsed >= windowMs) {
				// Carry one window back for a smoother depth across the
				// boundary, then roll.
				prevCount = elapsed >= 2 * windowMs ? 0 : count;
				count = 0;
				windowStart = t;
			}
			count++;
		},
		depth(t) {
			const elapsed = t - windowStart;
			// Nothing has polled for two full windows: the room is empty.
			if (elapsed >= 2 * windowMs) return 0;
			if (elapsed >= windowMs) {
				// No poll has rolled the window for a full interval, so the
				// current bucket is itself the fading one and nothing is
				// newer.
				return Math.round(count * (1 - (elapsed - windowMs) / windowMs));
			}
			return count + Math.round(prevCount * (1 - elapsed / windowMs));
		}
	};
}
