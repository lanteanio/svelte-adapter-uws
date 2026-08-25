// Readiness-gated boot warmup.
//
// A cold SvelteKit SSR render costs about twenty times a warm one (measured:
// ~20 ms versus ~1 ms on the default fixture, the whole penalty attributable
// to the render path warming up, not to HTTP or connection setup). A load
// balancer will not route until the readiness probe reports ready, so a warmup
// pass run DURING the `starting` window - after the init hook, before the flip
// to `ready` - guarantees the render path is warm before the first real client
// is ever routed in. A bare boot-time request burst cannot make that guarantee:
// it races the balancer.
//
// Only the SSR lane is warmed, because only it was measured to pay - a cold
// static or health route already answers at warm latency. When the realtime
// surface is configured, one envelope build is warmed too, through its pure
// encoder (no response object, negligible cost).
//
// The warmup render goes straight through `server.respond`, the same engine
// entry a real request reaches, with a Request object this module constructs
// and tags in a WeakSet. The tag is by object identity, never a header, so a
// real client cannot forge a request that reads as synthetic; `isWarmupRequest`
// lets the app's own hooks recognize the warmup render and skip side effects
// (analytics, rate-count, audit log) that a real visit would incur.

import { server } from '../_init.js';
import { origin } from './config.js';
import { monotonicNow, setTimer, clearTimer } from '../runtime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { isDedupBufferable } from './ssr-dedup.js';
import { tagWarmupRequest } from './warmup-registry.js';

// A warmup runs on the readiness-critical boot path: readiness cannot commit
// until it returns, so it must be BOUNDED in every direction. Each render is
// aborted if it outlasts the per-render budget, and the whole pass is raced
// against a total budget so readiness flips even if a render ignores its
// abort (a synchronous stall in app code). Warmup is best-effort - a bound
// that trips loses the warmup, never readiness.
const WARMUP_RENDER_BUDGET_MS = 5000;
const WARMUP_TOTAL_BUDGET_MS = 15000;

/** A warmup render needs a client address only if the app asks for one. */
function warmupClientAddress() {
	return '127.0.0.1';
}

/**
 * Render each path once through the real SSR engine so the render path, the
 * app's lazy server modules, and the JIT are warm before readiness commits.
 * Never throws: a warmup is an optimization, not a correctness gate, so a
 * failed render is reported and boot continues to `ready`. Returns the number
 * of paths that rendered without error.
 *
 * @param {string[]} paths absolute pathnames, e.g. ['/']
 * @param {object} platform the request platform passed to `server.respond`
 * @returns {Promise<number>}
 */
export async function warmSSR(paths, platform) {
	// A warmup render has no incoming Host header to derive an origin from, so
	// it uses the configured ORIGIN when set and a loopback placeholder
	// otherwise. The render of a path does not depend on the exact origin - the
	// point is to warm the render engine, not to produce a client-facing URL.
	const base = origin || 'http://localhost';
	let warmed = 0;
	for (const p of paths) {
		try {
			// Abort a render that outlasts its budget: an app load awaiting a
			// resource not up at boot must not hold readiness. SvelteKit honors
			// the request signal, so an aborted render rejects here and is
			// contained by the catch.
			const request = new Request(base + p, {
				method: 'GET',
				signal: AbortSignal.timeout(WARMUP_RENDER_BUDGET_MS)
			});
			tagWarmupRequest(request);
			const response = await server.respond(request, {
				platform,
				getClientAddress: warmupClientAddress
			});
			// Drain a FINITE body so the full render completes rather than
			// parking half-done. A never-ending stream (an SSE route) must NOT
			// be buffered - arrayBuffer() on it would await forever and hang
			// readiness - so cancel it instead; its headers and first render
			// already warmed the path. This is the same rule the real SSR
			// dedup path applies.
			if (response.body) {
				if (isDedupBufferable(response)) await response.arrayBuffer();
				else await response.body.cancel();
			}
			warmed++;
		} catch (err) {
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.warmup',
				event: 'runtime.warmup.render-failed',
				severity: 'warn',
				dataClass: 'pseudonymous',
				message: 'A boot warmup render failed; readiness proceeds without it.',
				attributes: { path: p, error: diagnosticError(err) }
			});
		}
	}
	return warmed;
}

/**
 * Run the configured warmup during the `starting` window. Bounded and
 * best-effort: it logs what it warmed and how long it took, and never rejects.
 *
 * @param {{ paths: string[], platform: object }} config
 * @returns {Promise<void>}
 */
export async function runWarmup(config) {
	const paths = Array.isArray(config?.paths) && config.paths.length > 0 ? config.paths : ['/'];
	const t0 = monotonicNow();
	// The total-budget backstop: readiness commits within this bound no matter
	// what a render does. Resolves to a sentinel on timeout; a warmup still
	// running past it settles on its own per-render aborts and is discarded.
	const TIMED_OUT = -1;
	let timer;
	const budget = new Promise((resolve) => {
		timer = setTimer(() => resolve(TIMED_OUT), WARMUP_TOTAL_BUDGET_MS);
		if (typeof timer?.unref === 'function') timer.unref();
	});
	const warmed = await Promise.race([warmSSR(paths, config.platform), budget]);
	clearTimer(timer);
	const ms = (monotonicNow() - t0).toFixed(0);
	if (warmed === TIMED_OUT) {
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.warmup',
			event: 'runtime.warmup.render-failed',
			severity: 'warn',
			dataClass: 'pseudonymous',
			message: 'A boot warmup render failed; readiness proceeds without it.',
			attributes: { reason: 'total warmup budget exceeded', budgetMs: WARMUP_TOTAL_BUDGET_MS }
		});
	} else if (warmed > 0) {
		console.log(`[svelte-adapter-uws] Warmed ${warmed} SSR path(s) before readiness (${ms}ms)`);
	}
}
