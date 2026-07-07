// Injectable runtime environment for the BROWSER client bundle: the clock, RNG
// and timers that the client reads through named helpers instead of touching the
// native primitives directly. Same helper API and env shape as the server-side
// runtime module so call sites are identical, but backed by browser globals (no
// node: imports) so the client bundles can import it. A simulator running the
// client code under node still drives it via setRuntimeEnv.
//
// The browser clock is a DIRECT wall read (the clients never had a 1Hz cache,
// so a direct read preserves their existing behavior). `performance` is used for
// monotonic duration math when present; a fake-timer Date mock therefore
// propagates straight into now() with no extra bridge.

const _hasPerf = typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function';
// Snapshot at load: the wall time at performance.now() === 0. Adding
// performance.now() yields a monotonic ms-since-epoch value immune to clock steps.
const _processStartEpoch = _hasPerf ? Date.now() - globalThis.performance.now() : 0;
const _webcrypto = (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : undefined;

// v4-shaped fallback when Web Crypto randomUUID is unavailable (non-secure
// context / old browser). Uses the env RNG so a seeded run still reproduces it.
function _uuidFallback(rngFloat) {
	let out = '';
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
		if (i === 14) { out += '4'; continue; }
		const r = (rngFloat() * 16) | 0;
		out += (i === 19 ? ((r & 0x3) | 0x8) : r).toString(16);
	}
	return out;
}

// One frozen environment object, one stable hidden class. In a real browser
// `current === defaultEnv` for the whole page lifetime (no override ever
// installs), so V8 sees a monomorphic shape and inlines the helpers to the
// native primitives - zero measurable overhead on the hot path.
const defaultEnv = Object.freeze({
	clock: Object.freeze({
		now: () => Date.now(),                                          // exact wall clock; direct read
		monotonic: _hasPerf ? () => _processStartEpoch + globalThis.performance.now() : () => Date.now(), // duration math
		wallEpoch: () => Date.now()                                     // exact wall clock; process-identity baseline
	}),
	rng: Object.freeze({
		float: () => Math.random(),
		u32: () => (Math.random() * 0x100000000) >>> 0,
		uuid: (_webcrypto && typeof _webcrypto.randomUUID === 'function')
			? () => _webcrypto.randomUUID()
			: () => _uuidFallback(() => Math.random()),
		bytes: (_webcrypto && typeof _webcrypto.getRandomValues === 'function')
			? (n) => _webcrypto.getRandomValues(new Uint8Array(n))
			: (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0; return a; }
	}),
	timers: Object.freeze({
		set: (cb, ms, ...a) => setTimeout(cb, ms, ...a),
		setInterval: (cb, ms, ...a) => setInterval(cb, ms, ...a),
		// No setImmediate in the browser: a zero-delay macrotask is the closest.
		setImmediate: (cb, ...a) => setTimeout(cb, 0, ...a),
		clear: (h) => clearTimeout(h),
		clearInterval: (h) => clearInterval(h),
		queueMicrotask: (typeof globalThis.queueMicrotask === 'function')
			? (cb) => globalThis.queueMicrotask(cb)
			: (cb) => Promise.resolve().then(cb)
	}),
	tz: undefined // effective timezone for cron evaluation; undefined = real local TZ
});

let current = defaultEnv;

// The named helpers are the ONLY thing client code imports. Each is a one-line
// read over `current` - monomorphic in a real browser, inlined by V8.
export const now = () => current.clock.now();
export const monotonicNow = () => current.clock.monotonic();
export const wallEpoch = () => current.clock.wallEpoch();
export const randomFloat = () => current.rng.float();
export const randomU32 = () => current.rng.u32();
export const randomUuid = () => current.rng.uuid();
export const randomBytes = (n) => current.rng.bytes(n);
export const setTimer = (cb, ms, ...a) => current.timers.set(cb, ms, ...a);
export const setIntervalTimer = (cb, ms, ...a) => current.timers.setInterval(cb, ms, ...a);
export const setImmediateTimer = (cb, ...a) => current.timers.setImmediate(cb, ...a);
export const clearTimer = (h) => current.timers.clear(h);
export const clearIntervalTimer = (h) => current.timers.clearInterval(h);
export const microtask = (cb) => current.timers.queueMicrotask(cb);
export const effectiveTimeZone = () => current.tz;

/**
 * Compute the next reconnect delay using exponential backoff with
 * proportional jitter.
 *
 * The capped delay is `min(base * 2.2^attempt, maxDelay)`. A random factor
 * in `[0.75, 1.25]` is then applied multiplicatively, so the final delay
 * spans +/- 25% of the capped value. Multiplicative jitter keeps spread
 * meaningful at high attempt counts: with 10K clients all reconnecting
 * after a server restart, additive +/- 500ms jitter clusters reconnects
 * inside a 1 second window; proportional jitter spreads them across
 * a window proportional to the current backoff.
 *
 * The 2.2 exponent with a 5 minute cap is aggressive enough to back off
 * fast under sustained server pain (the default 3 second base hits the
 * cap by attempt 6) and gentle enough that a brief restart resolves
 * before the user notices.
 *
 * Pure given an explicit `randFactor`: no I/O, no globals. Pass a fixed
 * value for reproducible assertions in tests.
 *
 * Lives here (not client.js) because every socket owner shares one curve -
 * the main connection and any dedicated secondary socket - and this module
 * is the only client module such a socket owner can import without dragging
 * the whole connection surface (and Svelte) into its bundle. The default
 * `randFactor` is the runtime float source: backoff jitter spreads retries
 * across a fleet, never crosses a trust boundary, and routing it through
 * the runtime lets a seeded harness reproduce the reconnect schedule.
 *
 * @param {number} base       base interval in ms (e.g. 3000)
 * @param {number} maxDelay   cap in ms (e.g. 300000)
 * @param {number} attempt    zero-based attempt counter
 * @param {number} [randFactor]  random factor in [0, 1); defaults to randomFloat()
 * @returns {number}
 */
export function nextReconnectDelay(base, maxDelay, attempt, randFactor = randomFloat()) {
	const capped = Math.min(base * Math.pow(2.2, attempt), maxDelay);
	return capped * (0.75 + randFactor * 0.5);
}

/**
 * Roll this client's own reconnect delay for a server drain advisory, spreading
 * the reconnect across the advertised window so a draining node's whole fleet
 * does not stampede the replacement in one backoff window. The delay is uniform
 * in `[afterMs, afterMs + windowMs)`: each client rolls independently (the server
 * advertises the WINDOW, never a pre-rolled offset, exactly like the data-event
 * `j` de-herd field). Non-finite / negative inputs clamp to 0, so a malformed
 * advisory degrades to an immediate reconnect rather than NaN.
 *
 * Pure given an explicit `randFactor`; the default is the runtime float source
 * (routed through the seam so a seeded harness reproduces the schedule). Kept
 * internal, mirroring `nextReconnectDelay`.
 *
 * @param {number} afterMs      floor delay in ms (>= 0)
 * @param {number} windowMs     dispersal window width in ms (> 0)
 * @param {number} [randFactor] random factor in [0, 1); defaults to randomFloat()
 * @returns {number}
 */
export function dispersedReconnectDelay(afterMs, windowMs, randFactor = randomFloat()) {
	const floor = afterMs > 0 ? afterMs : 0;
	const width = windowMs > 0 ? windowMs : 0;
	const r = randFactor >= 0 && randFactor < 1 ? randFactor : 0;
	return floor + width * r;
}

// Install a virtual environment (the simulator/test harness only). Refuses under
// a node production build unless explicitly forced, so a stray call can never
// swap the clock under a live deployment; in a real browser there is no process
// and nothing calls this anyway. A partial env merges over the native defaults,
// so a harness can override just the clock and keep native rng/timers.
export function setRuntimeEnv(env, opts) {
	const force = opts && opts.force === true;
	if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production' && !force) {
		throw new Error('client runtime: setRuntimeEnv refused in production (pass { force: true } only inside a controlled simulation harness)');
	}
	current = Object.freeze({
		clock: Object.freeze({ ...defaultEnv.clock, ...(env && env.clock) }),
		rng: Object.freeze({ ...defaultEnv.rng, ...(env && env.rng) }),
		timers: Object.freeze({ ...defaultEnv.timers, ...(env && env.timers) }),
		tz: env && Object.prototype.hasOwnProperty.call(env, 'tz') ? env.tz : defaultEnv.tz
	});
	return current;
}

// Restore the native environment. Cheap wholesale reassignment (no per-field
// mutation), so the hidden class stays stable.
export function resetRuntimeEnv() { current = defaultEnv; }

// Read-only accessor for the active env (test/sim introspection only).
export function getRuntimeEnv() { return current; }
