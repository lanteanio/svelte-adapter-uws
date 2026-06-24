import { randomFloat, setImmediateTimer } from '../runtime.js';

/**
 * Build a self-contained admission controller for WebSocket upgrades.
 *
 * Two independent layers, both opt-in (zero or unset = disabled):
 *
 * - `maxConcurrent` caps how many upgrades may be in flight at once.
 *   Crossed requests get rejected before any per-request work, so a
 *   connection storm can be shed without spending CPU on TLS / header
 *   parsing.
 * - `perTickBudget` caps how many `res.upgrade()` calls run per
 *   event-loop tick. Once the budget is spent, subsequent calls are
 *   deferred via `setImmediate` so the loop is not starved by 10K
 *   synchronous handshakes from one I/O batch.
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
 * @param {{ maxConcurrent?: number, perTickBudget?: number, cursorLane?: { fraction?: number } }} [opts]
 */
export function createUpgradeAdmission(opts) {
	const maxConcurrent = (opts && opts.maxConcurrent) || 0;
	const perTickBudget = (opts && opts.perTickBudget) || 0;
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
	let perTickCount = 0;
	/** @type {Array<() => void>} */
	const deferred = [];
	let drainScheduled = false;

	function drain() {
		drainScheduled = false;
		perTickCount = 0;
		while (perTickCount < perTickBudget && deferred.length > 0) {
			const fn = /** @type {() => void} */ (deferred.shift());
			perTickCount++;
			try { fn(); } catch (err) { console.error('[ws] deferred upgrade failed:', err); }
		}
		if (deferred.length > 0) {
			drainScheduled = true;
			setImmediateTimer(drain);
		}
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
		 * ask "is there room?" without ever consuming a slot. When
		 * `maxConcurrent` is `0`/unset the gate never rejects, so this is
		 * always `true`.
		 *
		 * @returns {boolean}
		 */
		hasCapacity() { return !(maxConcurrent > 0 && inFlight >= maxConcurrent); },
		/**
		 * Run `fn` (the actual `res.upgrade()` call) under the per-tick
		 * budget. Returns `true` if `fn` ran synchronously, `false` if
		 * deferred to a later tick.
		 *
		 * @param {() => void} fn
		 * @returns {boolean}
		 */
		admit(fn) {
			if (perTickBudget <= 0) { fn(); return true; }
			if (perTickCount < perTickBudget) {
				perTickCount++;
				fn();
				return true;
			}
			deferred.push(fn);
			if (!drainScheduled) {
				drainScheduled = true;
				setImmediateTimer(drain);
			}
			return false;
		}
	};
}

/**
 * Decide the shape of an at-capacity upgrade rejection from the request
 * `Accept` header. A browser navigation (Accept contains `text/html`) gets
 * the holding page; everything else - a real WebSocket upgrade, a library
 * client, `Accept: * / *` - keeps the `503` + `Retry-After` contract. A
 * WebSocket upgrade never renders HTML, so it must land in the `'retry'`
 * bucket; a normal upgrade carries an `Accept` without `text/html` (or no
 * `Accept` at all) and is handled correctly by that rule.
 *
 * @param {string | undefined | null} accept
 * @returns {'html' | 'retry'}
 */
export function negotiateRejection(accept) {
	if (typeof accept !== 'string' || accept.length === 0) return 'retry';
	// Case-insensitive substring is sufficient: branch to HTML only when the
	// client explicitly lists text/html, which browser navigations always do.
	return accept.toLowerCase().indexOf('text/html') !== -1 ? 'html' : 'retry';
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
 * Build the default self-contained holding page served when an upgrade is
 * refused at capacity. No framework, no external fetch beyond the poll
 * endpoint. First paint shows real numbers (server injected), then the
 * inline script polls `admitCheckPath` on a jittered interval, ticks the
 * on-page estimate from each `202` body, and reloads on a `200` admit.
 *
 * All numeric context fields are coerced to integers before embedding and
 * `admitCheckPath` is embedded via `JSON.stringify`, so no value reaches the
 * HTML or the inline script unescaped.
 *
 * @param {{ queueDepth?: number, estimatedSeconds?: number, pollIntervalMs?: number, retryAfterSeconds?: number, admitCheckPath?: string }} ctx
 * @returns {string}
 */
export function buildWaitingRoomPage(ctx) {
	const queueDepth = Math.max(0, Math.floor(Number(ctx && ctx.queueDepth) || 0));
	const estimatedSeconds = Math.max(0, Math.floor(Number(ctx && ctx.estimatedSeconds) || 0));
	const pollIntervalMs = Math.max(250, Math.floor(Number(ctx && ctx.pollIntervalMs) || 2000));
	const checkPath = JSON.stringify((ctx && ctx.admitCheckPath) || '/__admit-check');
	return '<!doctype html>' +
		'<html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<title>Waiting room</title>' +
		'<style>body{font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;' +
		'align-items:center;justify-content:center;background:#0b0c10;color:#e8e8e8}' +
		'main{text-align:center;max-width:30rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .75rem}' +
		'p{margin:.4rem 0;color:#a9b0bd}strong{color:#e8e8e8}</style></head>' +
		'<body><main>' +
		'<h1>You are in line</h1>' +
		'<p>The server is at capacity. This page reloads automatically when a slot opens.</p>' +
		'<p>Ahead of you: <strong id="q">' + queueDepth + '</strong></p>' +
		'<p>Estimated wait: <strong id="eta">' + estimatedSeconds + '</strong> seconds</p>' +
		'</main>' +
		'<script>' +
		'(function(){' +
		'var url=' + checkPath + ';' +
		'var base=' + pollIntervalMs + ';' +
		'var q=document.getElementById("q");' +
		'var eta=document.getElementById("eta");' +
		'function jitter(ms){return ms+Math.floor(Math.random()*ms*0.5);}' + // determinism-allow: browser-side script text in the holding page, not a server primitive
		'function tick(delay){setTimeout(poll,delay);}' + // determinism-allow: browser-side script text in the holding page, not a server primitive
		'function poll(){' +
		'fetch(url,{headers:{accept:"application/json"},cache:"no-store"})' +
		'.then(function(r){return r.json().then(function(b){return {s:r.status,b:b};});})' +
		'.then(function(o){' +
		'if(o.s===200&&o.b&&o.b.admit){location.reload();return;}' +
		'if(o.b){if(typeof o.b.queueDepth==="number")q.textContent=o.b.queueDepth;' +
		'if(typeof o.b.estimatedSeconds==="number")eta.textContent=o.b.estimatedSeconds;}' +
		'var next=(o.b&&typeof o.b.pollAfterMs==="number")?o.b.pollAfterMs:base;' +
		'tick(jitter(next));' +
		'})' +
		'.catch(function(){tick(jitter(base));});' +
		'}' +
		'tick(jitter(base));' +
		'})();' +
		'</script></body></html>';
}

/**
 * Substitute the supported `{{token}}` placeholders in an operator-supplied
 * waiting-room template string. Numeric context values are coerced to integers
 * and the string value is HTML-escaped, so no token value reaches the page
 * unescaped; unknown tokens are left intact. A template is a JSON-serializable
 * string (not a function) so it survives the build-time options serialization
 * and reaches the production runtime.
 *
 * Supported tokens: `{{queueDepth}}`, `{{estimatedSeconds}}`,
 * `{{pollIntervalMs}}`, `{{retryAfterSeconds}}`, `{{admitCheckPath}}`.
 *
 * @param {string} tpl
 * @param {{ queueDepth: number, estimatedSeconds: number, pollIntervalMs: number, retryAfterSeconds: number, admitCheckPath: string }} ctx
 * @returns {string}
 */
export function renderWaitingRoomTemplate(tpl, ctx) {
	const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => (
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
	));
	/** @type {Record<string, string>} */
	const values = {
		queueDepth: String(Math.max(0, Math.floor(Number(ctx && ctx.queueDepth) || 0))),
		estimatedSeconds: String(Math.max(0, Math.floor(Number(ctx && ctx.estimatedSeconds) || 0))),
		pollIntervalMs: String(Math.max(250, Math.floor(Number(ctx && ctx.pollIntervalMs) || 2000))),
		retryAfterSeconds: String(Math.max(1, Math.floor(Number(ctx && ctx.retryAfterSeconds) || 1))),
		admitCheckPath: htmlEsc((ctx && ctx.admitCheckPath) || '/__admit-check')
	};
	return tpl.replace(
		/\{\{(queueDepth|estimatedSeconds|pollIntervalMs|retryAfterSeconds|admitCheckPath)\}\}/g,
		(_, k) => values[k]
	);
}

/**
 * Resolve the waiting-room configuration once at handler setup. Returns a
 * ready-to-use object (with the rendering and jitter helpers bound to the
 * resolved settings) or `null` when the waiting room is off.
 *
 * The waiting room is on by default whenever the gate can actually reject -
 * that is, `maxConcurrent > 0` - unless the operator opts out with
 * `waitingRoom: false`. When it is off, the caller emits today's exact bare
 * `503`. The shape mirrors the gate's own "> 0 means active" rule so the
 * waiting room can only engage in a deployment that has opted into admission
 * control (there is nothing to queue for otherwise).
 *
 * @param {{ maxConcurrent?: number, perTickBudget?: number, waitingRoom?: false | { path?: string, admitCheckPath?: string, retryAfterSeconds?: number, pollIntervalMs?: number, template?: string } } | undefined} upgradeAdmission
 * @returns {null | { path: string, admitCheckPath: string, pollIntervalMs: number, retryAfterSeconds: number, jitteredRetryAfter(spread?: number): number, estimateSeconds(queueDepth: number): number, renderPage(queueDepth?: number): string }}
 */
export function resolveWaitingRoom(upgradeAdmission) {
	const ua = upgradeAdmission;
	const wr = ua && ua.waitingRoom;
	if (!(ua && ua.maxConcurrent > 0 && wr !== false)) return null;

	const cfg = (wr && typeof wr === 'object') ? wr : {};
	const path = typeof cfg.path === 'string' ? cfg.path : '/__waiting-room';
	const admitCheckPath = typeof cfg.admitCheckPath === 'string' ? cfg.admitCheckPath : '/__admit-check';
	const pollIntervalMs = Number.isFinite(cfg.pollIntervalMs) && cfg.pollIntervalMs > 0
		? Math.floor(cfg.pollIntervalMs) : 2000;
	const retryAfterSeconds = Number.isFinite(cfg.retryAfterSeconds) && cfg.retryAfterSeconds > 0
		? Math.floor(cfg.retryAfterSeconds) : Math.max(1, Math.round(pollIntervalMs / 1000));
	// Operator override page. A string is the supported, serializable form
	// (token-substituted via renderWaitingRoomTemplate). A function is still
	// honoured if one is passed programmatically (e.g. the test harness), but it
	// cannot survive the build-time options serialization, so the documented
	// option is a string.
	const templateStr = typeof cfg.template === 'string' ? cfg.template : null;
	const templateFn = typeof cfg.template === 'function' ? cfg.template : null;

	return {
		path,
		admitCheckPath,
		pollIntervalMs,
		retryAfterSeconds,
		/**
		 * Spread the thundering-herd retry: base plus up to `spread` times the
		 * base, jittered per request so refused library clients do not
		 * synchronise. Called with no argument the spread defaults to `0.5` -
		 * base plus up to half the base, the byte-identical band today's reject
		 * path serves. A caller that widens the band under load passes a larger
		 * factor; the floor still keeps the value an integer >= base.
		 *
		 * @param {number} [spread] fraction of the base to jitter over (default `0.5`).
		 * @returns {number}
		 */
		jitteredRetryAfter(spread) {
			const s = typeof spread === 'number' && spread > 0 ? spread : 0.5;
			return retryAfterSeconds + Math.floor(randomFloat() * retryAfterSeconds * s);
		},
		/**
		 * Rolling drain estimate surfaced for UX only - never an admission
		 * input. The drain rate defaults to one slot per second when no
		 * better estimate is available.
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
		 * @param {number} [queueDepth]
		 * @returns {string}
		 */
		renderPage(queueDepth) {
			const ctx = {
				queueDepth: queueDepth || 0,
				estimatedSeconds: this.estimateSeconds(queueDepth || 0),
				pollIntervalMs,
				retryAfterSeconds,
				admitCheckPath
			};
			if (templateStr) return renderWaitingRoomTemplate(templateStr, ctx);
			if (templateFn) return templateFn(ctx);
			return buildWaitingRoomPage(ctx);
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
