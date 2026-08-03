import { microtask } from '../runtime.js';
import { formatDiagnostic } from '../diagnostic.js';

function assertionDiagnostic(severity, category, context, message = category) {
	try {
		return formatDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.assertion',
			event: 'invariant.violated',
			severity,
			message,
			attributes: { category, context: context ?? null }
		});
	} catch {
		return formatDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.assertion',
			event: 'invariant.violated',
			severity,
			message,
			attributes: { category, context: null, contextSerializationFailed: true }
		});
	}
}

// - Framework-internal assertions ------------------------------------------
// Library-author defensive coding only. App developers do not call these
// directly - they consume the read-only `platform.assertions` Map via
// handler.js's getter for ops dashboards, and the structured `console.error`
// output for issue reports. Categories follow a `<area>.<thing>` convention
// (e.g. `'relay.topic-type'`, `'ws.platform-missing'`); extension authors
// adopt a package prefix to avoid collisions (`'redis.*'`, `'realtime.*'`).
//
// Three tiers, distinguished by termination semantics (not by env):
// - assert() is the SOFT tier. In production it logs + increments the counter
//   but does NOT throw - a throw inside a uWS C++ callback frame can corrupt
//   the worker's binding state; the structured log + the queryable counter are
//   enough for ops to detect a regression and file an issue. In test mode
//   (`process.env.VITEST` set, or `NODE_ENV === 'test'`), assert() throws so
//   the runner fails loudly. The counter still increments either way.
// - fatal() is the HARD tier, for genuinely unrecoverable state. It shares the
//   same counter Map (one namespace; the severity rides the structured log,
//   labelled `severity: 'fatal'`), and in production schedules a DEFERRED
//   worker termination with exit code 78 AFTER the current callback frame
//   unwinds (a synchronous exit inside a uWS C++ callback risks the same
//   binding-state corruption assert() guards against). In test mode it throws
//   instead of exiting so the runner sees it without dying. The exit is
//   injectable via setFatalSink so the simulator captures fatals.
// - devAssert is dev-time only: it throws in dev and test, and is a complete
//   no-op in production. Use it for cosmetic / DX-shape checks where the
//   runtime cost of the comparison is unwelcome in production.

const assertionCounts = new Map();

// Optional Prometheus counter, bound via wireAssertionMetrics when the runtime
// handler is configured with a `metrics` registry. When set, every violation
// increments it (labelled by category and severity) alongside the in-memory
// Map; when null the assertion path stays allocation-free past the Map write.
/** @type {{ inc(labels: { category: string, severity: string }): void } | null} */
let boundCounter = null;

const isTestEnv = process.env.VITEST !== undefined ||
	process.env.NODE_ENV === 'test';
const isProdEnv = process.env.NODE_ENV === 'production';

// Per-call test-mode check for the hard tier. `assert`/`devAssert` keep their
// module-load snapshot (their behaviour is unchanged); `fatal` re-reads the env
// each call so a test can exercise the production deferred-exit branch by
// flipping the env without re-importing the module, and so the simulator (which
// installs a capturing sink) reaches the sink instead of throwing.
function isTestEnvNow() {
	return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
}

// Process exit code for a hard-tier invariant violation. Distinct from the
// supervisor's config-error exit (1) and a graceful shutdown (0) so ops can
// tell a crash-on-bad-state apart from a crash-on-bad-config in restart logs.
const FATAL_EXIT_CODE = 78;

// Injectable sink for the hard-tier termination. Defaults to the real
// process.exit. The simulator swaps this so a fatal is captured instead of
// killing the harness; tests swap it to assert the exit was scheduled.
let fatalSink = { exit: (code) => process.exit(code) };

// Shared violation recorder. Bumps the per-category counter Map and, when a
// Prometheus counter has been wired via wireAssertionMetrics, increments it too
// (labelled by category and severity). The metric path is best-effort: a
// throwing registry can never turn an invariant check into a crash.
/**
 * @param {string} category
 * @param {'soft' | 'fatal'} severity
 */
function recordViolation(category, severity) {
	assertionCounts.set(category, (assertionCounts.get(category) || 0) + 1);
	if (boundCounter) {
		try { boundCounter.inc({ category, severity }); } catch { /* metrics path is best-effort */ }
	}
}

/**
 * Always-on framework invariant assertion. On violation: increments
 * `assertionCounts.get(category)`, logs a structured `console.error`,
 * and (in test mode only) throws so vitest surfaces the failure.
 *
 * Hot-path safe: the success branch is one comparison, JIT-folded.
 *
 * @param {unknown} cond - any truthy expression
 * @param {string} category - dot-prefixed namespace (e.g. `'relay.topic-type'`)
 * @param {object} [context] - free-form context payload for logs / error
 */
export function assert(cond, category, context) {
	if (cond) return;
	recordViolation(category, 'soft');
	if (isTestEnv) {
		const err = new Error('adapter-uws assert: ' + category);
		// @ts-ignore augment with context for test diagnostics
		err.context = context ?? null;
		throw err;
	}
	console.error(assertionDiagnostic('warn', category, context));
}

/**
 * Hard-tier framework invariant, for genuinely unrecoverable worker state.
 * On violation: increments the SAME `assertionCounts` map as `assert` (one
 * namespace; the severity rides the structured log as `severity: 'fatal'`),
 * logs an `[lantean/diagnostic source=svelte-adapter-uws component=runtime.assertion event=invariant.violated severity=fatal]` line, and - in production only - schedules a
 * DEFERRED worker termination with exit code 78. The termination is deferred
 * to a microtask so the current callback frame (often a uWS C++ callback)
 * unwinds before the process goes down; a synchronous exit there risks the
 * same binding-state corruption `assert` already avoids. In test mode it
 * throws instead of exiting so the runner sees the failure without dying.
 *
 * Hot-path safe: the success branch is one comparison, JIT-folded.
 *
 * @param {unknown} cond - any truthy expression
 * @param {string} category - dot-prefixed namespace (e.g. `'relay.topic-type'`)
 * @param {object} [context] - free-form context payload for logs / error
 */
export function fatal(cond, category, context) {
	if (cond) return;
	recordViolation(category, 'fatal');
	console.error(assertionDiagnostic('fatal', category, context));
	if (isTestEnvNow()) {
		const err = new Error('adapter-uws fatal: ' + category);
		// @ts-ignore augment with context for test diagnostics
		err.context = context ?? null;
		throw err;
	}
	// Production: defer the termination so the current callback frame completes
	// first. The metric + log above have already flushed.
	microtask(() => { fatalSink.exit(FATAL_EXIT_CODE); });
}

/**
 * Install a custom hard-tier termination sink. The simulator uses this to
 * capture fatals into its result set instead of exiting the harness; tests
 * use it to assert an exit was scheduled without killing the runner. Never
 * call this from production code.
 *
 * @param {{ exit(code: number): void }} sink
 */
export function setFatalSink(sink) {
	if (!sink || typeof sink.exit !== 'function') {
		throw new Error('setFatalSink: sink must expose an exit(code) function');
	}
	fatalSink = sink;
}

/**
 * Restore the default termination sink (`process.exit`). Test/sim teardown.
 */
export function resetFatalSink() {
	fatalSink = { exit: (code) => process.exit(code) };
}

/**
 * Dev-time invariant. No-op in production (zero runtime cost when
 * `NODE_ENV === 'production'`); throws in dev / test so the violation
 * surfaces during development. Use for DX hints and cosmetic shape
 * checks that should not cost anything in shipped builds.
 *
 * @param {unknown} cond
 * @param {string} message
 * @param {object} [context]
 */
export function devAssert(cond, message, context) {
	if (cond) return;
	if (isProdEnv) return;
	const err = new Error('adapter-uws devAssert: ' + message);
	// @ts-ignore
	err.context = context ?? null;
	console.error(assertionDiagnostic('error', 'development.assertion', context, message));
	throw err;
}

/**
 * Read-only access to the per-category violation counts. The returned
 * Map is the live module-level instance - do not mutate. Surfaced via
 * `platform.assertions` for ops dashboards and integration tests.
 *
 * @returns {Map<string, number>}
 */
export function readAssertionCounts() {
	return assertionCounts;
}

/**
 * Wire the assertion counters into a Prometheus registry. Registers
 * `framework_assertion_violations_total{category,severity}` as a counter that
 * both `assert` (severity="soft") and `fatal` (severity="fatal") increment on
 * every violation alongside the in-memory `assertionCounts` Map. Cardinality is
 * bounded by the distinct categories declared at the call sites (all
 * module-level constants, never user-input-driven) times the two severities.
 *
 * The runtime handler calls this once when the `metrics` option is supplied.
 * Calling again replaces the bound counter (most-recent registry wins);
 * pre-existing in-memory counts are not replayed into the new counter.
 *
 * @param {{ counter(name: string, help: string, labelNames?: string[]): { inc(labels?: object): void } }} metrics
 */
export function wireAssertionMetrics(metrics) {
	if (!metrics || typeof metrics.counter !== 'function') {
		throw new Error('wireAssertionMetrics: metrics registry is required');
	}
	boundCounter = metrics.counter(
		'framework_assertion_violations_total',
		'Framework production-assertion violations by category and severity',
		['category', 'severity']
	);
}

/**
 * Reset the assertion counter map. Test-only utility - production code
 * should never call this. Exists so unit tests can isolate counters
 * between cases without leaking state across `describe` blocks.
 */
export function _resetAssertionCountsForTest() {
	assertionCounts.clear();
	boundCounter = null;
	resetFatalSink();
}
