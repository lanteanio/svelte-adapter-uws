import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUuid } from './runtime/runtime.js';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { normalizeStaticCacheControl, normalizeStaticHeaders } from './build-config.js';
import { listExcludedDotPaths } from './static-scan.js';
import {
	assertWireSubscribeAuthorization,
	assertProtectiveNumber,
	DEFAULT_MAX_PAYLOAD_LENGTH
} from './config-guards.js';
import { uwsLoadErrorMessage, readAdapterPackageJson } from './uws-load-hint.js';
import { writeAndCloseRollupBundle } from './build/rollup-lifecycle.js';
import { compileAccessibleWaitingRoomTemplate } from './runtime/utils/waiting-room-template.js';
import { normalizeMessageAdmission } from './runtime/utils/message-admission.js';

const runtimeDir = fileURLToPath(new URL('./runtime', import.meta.url).href);

// Empty default WebSocket handler - subscribe/unsubscribe is handled
// by handler.js for ALL messages regardless of user handler.
const DEFAULT_WS_HANDLER = '// Built-in: subscribe/unsubscribe handled by the runtime\n';

/**
 * Scan a bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })`
 * usage. Emits a loud warning at build time because Cloudflare Tunnel and some
 * other strict edge proxies silently drop WebSocket connections whose 101
 * response carries Set-Cookie - symptom is 1006 TCP FIN immediately after
 * open fires server-side. The recommended fix is the `authenticate` hook.
 *
 * @param {string} source
 * @returns {boolean}
 */
function detectSetCookieOnUpgrade(source) {
	// Scan each upgradeResponse( call for a 'set-cookie' / "Set-Cookie" literal
	// inside its arguments. Works against bundler output (esbuild/rollup/Vite),
	// which preserves these as literals even after minification rewrites the
	// surrounding identifiers.
	const re = /upgradeResponse\s*\(/gi;
	let match;
	while ((match = re.exec(source)) !== null) {
		// Walk forward matching parens to find the end of the call
		let depth = 1;
		let i = match.index + match[0].length;
		let inStr = '';
		let esc = false;
		for (; i < source.length && depth > 0; i++) {
			const c = source[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === inStr) inStr = '';
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
			if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		const args = source.slice(match.index + match[0].length, i - 1);
		if (/['"`]\s*set-cookie\s*['"`]/i.test(args)) return true;
	}
	return false;
}

/**
 * Every `websocket.*` option key the adapter consumes - either serialized
 * into `wsOpts` (see {@link serializeWsOptions}) or used at build time
 * (handler / path / authPath / metrics / primaryInit / workers). Options
 * are baked into the build, so a key the adapter does not know is dropped
 * SILENTLY; the build warns on any key outside this set so a typo'd or
 * renamed option is loud instead of dead config.
 */
export const KNOWN_WEBSOCKET_OPTION_KEYS = new Set([
	'handler', 'path', 'authPath', 'adminPath', 'adminAuthAcknowledged', 'metrics', 'primaryInit', 'workers',
	'maxPayloadLength', 'idleTimeout', 'maxBackpressure', 'closeOnBackpressureLimit', 'maxTopicSeqEntries',
	'sendPingsAutomatically', 'compression', 'allowedOrigins',
	'upgradeTimeout', 'upgradeRateLimit', 'upgradeRateLimitWindow', 'upgradeAdmission',
	'messageAdmission',
	'authPathRateLimit', 'authPathRateLimitWindow',
	'pressure', 'protection', 'stateHashIntervalMs', 'consistencyAuditIntervalMs',
	'resourceGrowthAuditIntervalMs', 'postureExport',
	'allowSystemTopicSubscribe', 'authorizeWireSubscribe', 'allowNonAsciiTopics',
	'authPathRequireOrigin', 'compressCredentialedResponses', 'unsafeSameOriginWithoutHostPin'
]);

/**
 * Object-valued options whose CONTENTS are also checked, keyed by dotted path.
 *
 * A top-level-only walk cannot see a typo one level down, and for
 * `upgradeAdmission` that is not cosmetic: `maxConcurent: 500` leaves the
 * handshake ceiling and cursor lane switched off (and the waiting room too
 * unless the separate `maxConnections` ceiling is enabled), silently. The
 * whole-lifetime socket bound is a separate option by design.
 *
 * `pressure` is milder - its thresholds are merged over defaults, so a typo
 * leaves the default threshold rather than "off" - but a dropped key there
 * still means the operator's tuning silently did nothing.
 */
export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {
	upgradeAdmission: new Set(['maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred', 'cursorLane', 'waitingRoom']),
	'upgradeAdmission.cursorLane': new Set(['fraction']),
	'upgradeAdmission.waitingRoom': new Set([
		'path', 'admitCheckPath', 'pollIntervalMs', 'retryAfterSeconds', 'template',
		'renderer', 'appName', 'statusUrl', 'supportUrl', 'incidentId'
	]),
	messageAdmission: new Set([
		'perConnectionRate', 'globalRate', 'rateWindowMs',
		'perConnectionConcurrent', 'globalConcurrent', 'maxQueue'
	]),
	pressure: new Set([
		'memoryHeapUsedRatio', 'publishRatePerSec', 'subscriberRatio', 'sampleIntervalMs',
		'topicPublishRatePerSec', 'topicPublishBytesPerSec',
		'psiCpuSome', 'psiMemoryFull', 'psiIoFull', 'cpuThrottledRatio'
	]),
	// `workers: { comptue: 2 }` silently runs zero compute workers - the same
	// failure class, one level down, on a different option.
	workers: new Set(['compute']),
	postureExport: new Set(['path'])
};

/**
 * Keys present on the user's `websocket` option that the adapter does not
 * recognize, as dotted paths. The adapt step warns on every returned key.
 *
 * @param {Record<string, unknown> | null} websocket - normalized websocket options
 * @returns {string[]}
 */
export function unknownWebsocketOptionKeys(websocket) {
	if (!websocket || typeof websocket !== 'object') return [];
	/** @type {string[]} */
	const out = [];
	collectUnknownKeys(websocket, KNOWN_WEBSOCKET_OPTION_KEYS, '', out);
	return out;
}

/**
 * @param {Record<string, unknown>} bag
 * @param {Set<string>} known
 * @param {string} prefix
 * @param {string[]} out
 */
function collectUnknownKeys(bag, known, prefix, out) {
	for (const key of Object.keys(bag)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (!known.has(key)) {
			out.push(path);
			continue;
		}
		const nested = KNOWN_NESTED_WEBSOCKET_OPTION_KEYS[path];
		const value = bag[key];
		// `false` disables a whole section (waitingRoom, pressure) and an array
		// is never a section - neither has keys worth walking.
		if (nested && value && typeof value === 'object' && !Array.isArray(value)) {
			collectUnknownKeys(/** @type {Record<string, unknown>} */ (value), nested, path, out);
		}
	}
}

/**
 * What the Vite plugin recorded about the module it bundled as the WS handler,
 * written beside the emitted chunk. Null when there is no record - an app can
 * place a `ws-handler.js` of its own, and older plugin builds wrote none.
 *
 * @param {string} tmp - the adapter build directory, which is also the SSR output dir
 * @returns {{ source: string, absolute: string | null, from: string } | null}
 */
export function readHandlerOrigin(tmp) {
	try {
		const parsed = JSON.parse(readFileSync(`${tmp}/ws-handler.origin.json`, 'utf8'));
		if (typeof parsed?.source !== 'string' || !parsed.source) return null;
		return {
			source: parsed.source,
			// Absolute where the plugin recorded one. `source` is relative to the
			// VITE root while this side resolves against its own cwd, so the two
			// only agree when those coincide - comparing the relative form would
			// report the same file as a mismatch in a monorepo or under an
			// explicit Vite `root`.
			absolute: typeof parsed.absolute === 'string' && parsed.absolute ? parsed.absolute : null,
			from: typeof parsed.from === 'string' ? parsed.from : 'unknown'
		};
	} catch {
		return null;
	}
}

/**
 * Two paths naming the same file. Compared after resolution so `./src/x.js`
 * and `src/x.js` agree, and case-insensitively on the platforms whose file
 * systems are, so a drive-letter or casing difference is not reported as a
 * configuration conflict.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
	const left = path.resolve(a);
	const right = path.resolve(b);
	if (left === right) return true;
	return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase();
}

/**
 * Refuse a build whose `websocket.handler` names a different module than the
 * one the Vite plugin actually bundled.
 *
 * The plugin resolves the handler and emits `ws-handler.js` before the adapter
 * runs, and the adapter then takes that file as it stands. So when the two
 * disagree the adapter's option loses - silently, while the build log reports
 * a handler was built. That is not a cosmetic drop: the module that wins
 * decides WHICH authorization hooks exist, and an app-supplied `subscribe`
 * hook stands the server-grant model down, so an accidental substitution can
 * disarm a gate the operator explicitly enabled.
 *
 * The plugin honors `websocket.handler` itself, so agreement is the normal
 * case; this catches the paths where it could not - an unreadable Svelte
 * config, a hand-written `ws-handler.js`, or a plugin from a different install.
 *
 * @param {string | null | undefined} handler - the adapter's `websocket.handler`
 * @param {{ source: string, absolute?: string | null, from: string } | null} origin - what the plugin recorded
 * @param {{ warn: (msg: string) => void }} log - builder.log
 */
export function assertBundledHandlerMatches(handler, origin, log) {
	if (!handler) return;

	if (!origin) {
		log.warn(
			`websocket.handler is set to '${handler}', but the WebSocket handler was already built ` +
			'by the Vite plugin and carries no record of which module it used, so the adapter ' +
			'cannot confirm the two agree.\n' +
			'  If the plugin and the adapter come from the same svelte-adapter-uws install this ' +
			'should not happen - check for a stale or duplicated copy of the package.'
		);
		return;
	}

	if (samePath(handler, origin.absolute ?? origin.source)) return;

	throw new Error(
		`websocket.handler names a different module than the one that was built.\n` +
		`  SvelteKit config  websocket.handler: ${JSON.stringify(handler)}\n` +
		`  actually bundled: ${JSON.stringify(origin.source)} (${origin.from})\n` +
		(origin.from.startsWith('auto-discovered')
			? '  The plugin fell back to auto-discovery, which also happens when it cannot read ' +
			  'the active SvelteKit adapter config - check that it exports this adapter instance.\n'
			: '') +
		'The Vite plugin resolves the WebSocket handler before the adapter runs, so the ' +
		'bundled module is the one that decides which upgrade/subscribe hooks your app has. ' +
		'Refusing the build rather than shipping the wrong one.\n' +
		'  Name the handler in ONE place - websocket.handler on the adapter is honored ' +
		'by the dev plugin too.'
	);
}

/**
 * The `wsOpts` payload serialized into the build as `WS_OPTIONS` (the
 * production handler's `wsOptions`). Every runtime-tunable `websocket.*`
 * key must be threaded through here - a documented key missing from this
 * object is silently dropped at build time (`authorizeWireSubscribe` was,
 * which left the wire-subscribe authorization arming in handler.js dead).
 *
 * @param {Record<string, any> | null} websocket - normalized websocket options
 * @param {string | false} adminPath - validated admin route prefix (or false)
 * @returns {Record<string, unknown>}
 */
export function serializeWsOptions(websocket, adminPath) {
	// A flag that RESTRICTS access must never be coerced. The reads below are
	// `=== true`, which treats every other value as "off" - so
	// `authorizeWireSubscribe: process.env.WS_AUTHZ` (a string when set,
	// undefined when not) would emit `"authorizeWireSubscribe":false` with no
	// warning and leave the gate disarmed. That is the same silent no-op as
	// dropping the key entirely, moved from the key to the value, and the
	// unknown-key warning cannot catch it because the key is known. The
	// permissive siblings (allowSystemTopicSubscribe, allowNonAsciiTopics) can
	// coerce safely because coercing them yields the SAFE state; this one is
	// the inverted case, so a misshaped value is a build error instead.
	assertWireSubscribeAuthorization(websocket, 'authorizeWireSubscribe');
	// The same inversion in the numeric options that size the two doors: a
	// non-number does not fall back to the default, it disables the limiter.
	assertProtectiveNumber(websocket, 'upgradeRateLimit');
	assertProtectiveNumber(websocket, 'authPathRateLimit');
	// The WINDOWS additionally refuse 0. It reads like "disable", and it does
	// the opposite of what the limit's own 0 does: a zero window makes every
	// request a fresh window, the sliding estimate evaluates to NaN, and
	// `NaN >= limit` is false - so everything is admitted, silently.
	const ZERO_WINDOW =
		'A zero WINDOW does not disable the limiter, it breaks it: every request then looks ' +
		'like a fresh window, the estimate evaluates to NaN, and NaN >= limit is false - so ' +
		'everything is admitted. Set the limit itself to 0 to disable it deliberately.';
	assertProtectiveNumber(websocket, 'upgradeRateLimitWindow', 'websocket.upgradeRateLimitWindow', { allowZero: false, zeroMeans: ZERO_WINDOW });
	assertProtectiveNumber(websocket, 'authPathRateLimitWindow', 'websocket.authPathRateLimitWindow', { allowZero: false, zeroMeans: ZERO_WINDOW });
	// The SIZE and TIMEOUT bounds are protective too, and they are handed
	// straight to uWS. The guard covered only the rate limits, so
	// `maxPayloadLength: '1000'` serialized into the build as a STRING with no
	// warning - a value the operator wrote to bound a resource, arriving at the
	// native layer as something it never validates back. Same reasoning as the
	// limits above: a bound that silently does not apply is worse than a loud
	// refusal at build time, which is the only place anyone is watching.
	// These four are handed straight to uWS, which never validates them back, so
	// a misshaped value is a bound that silently does not apply. The floor is no
	// longer a guess: it was measured against the real binary, and for two of
	// them zero INVERTS the option.
	assertProtectiveNumber(websocket, 'maxPayloadLength', 'websocket.maxPayloadLength', {
		allowZero: false,
		ceiling: 0x7fffffff,
		zeroMeans:
			'uWS closes the connection on any message when the maximum payload is 0, so it does ' +
			'not disable the limit - it refuses all traffic. Raise the limit instead.'
	});
	assertProtectiveNumber(websocket, 'maxBackpressure', 'websocket.maxBackpressure', {
		allowZero: false,
		zeroMeans:
			'uWS reads 0 as UNLIMITED buffering, the opposite of what it looks like: measured ' +
			'against the real binary, a slow client buffered 99.75 MB at 0 against 1.00 MB at ' +
			'the default. One slow reader would grow the worker without bound.'
	});
	// These two genuinely do disable in uWS - unlike the pair above, where 0
	// inverts the option - so 0 stays legal for both. Both now say so in the
	// README, including what disabling costs: `idleTimeout: 0` also stands down
	// the automatic ping, so a peer that vanished silently is never reaped.
	// Documenting it is the fix; a guard would refuse a legitimate setting.
	assertProtectiveNumber(websocket, 'idleTimeout');
	assertProtectiveNumber(websocket, 'upgradeTimeout');
	// 0 genuinely disables here (an unbounded registry is the pre-existing
	// behavior an operator may deliberately keep), so 0 stays legal.
	assertProtectiveNumber(websocket, 'maxTopicSeqEntries');
	const maxConnections = websocket?.upgradeAdmission?.maxConnections;
	if (
		maxConnections !== undefined &&
		(!Number.isSafeInteger(maxConnections) || maxConnections < 0)
	) {
		throw new Error(
			'websocket.upgradeAdmission.maxConnections must be a non-negative safe integer. ' +
			'Use 0 to disable the live-connection ceiling deliberately.'
		);
	}
	const maxDeferred = websocket?.upgradeAdmission?.maxDeferred;
	if (
		maxDeferred !== undefined &&
		(!Number.isSafeInteger(maxDeferred) || maxDeferred < 0)
	) {
		throw new Error(
			'websocket.upgradeAdmission.maxDeferred must be a non-negative safe integer. ' +
			'Use 0 to reject once the current tick budget is spent, without retaining a queue.'
		);
	}
	normalizeMessageAdmission(websocket?.messageAdmission, 'websocket.messageAdmission');
	return {
		// Default raised from 16 KB to 1 MB in 0.5. uWS's own
		// default is also 16 KB, which the adapter previously
		// matched - that was excessively conservative and forced
		// chunked-upload frameworks to use ~12 KB chunks (~9000
		// chunks for a 100 MB file). 1 MB handles typical app
		// payloads in a single frame without per-app tuning. DoS
		// exposure can be bounded by `upgradeAdmission.maxConnections`
		// (reserved plus live connection count) and `maxBackpressure` (per-conn
		// outbound queue, also 1 MB), so per-frame cost stays
		// predictable. Apps that want a stricter cap can pin via
		// `websocket.maxPayloadLength` in svelte.config.js.
		maxPayloadLength: websocket?.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH,
		// Ceiling on the per-topic seq registries (topicSeqs / maxSeenSeq).
		// Undefined defers to the runtime default (the cardinality warn
		// threshold); 0 deliberately disables the bound - the pre-existing
		// unbounded behavior.
		maxTopicSeqEntries: websocket?.maxTopicSeqEntries,
		idleTimeout: websocket?.idleTimeout ?? 120,
		maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
		// When true, uWS closes a connection that stays pinned over
		// maxBackpressure instead of perpetually shedding its frames -
		// the bounded-recovery knob for a chronically slow consumer that
		// would otherwise wedge a worker's outbound queue. Default false
		// keeps the zero-config shed-and-continue behavior byte-identical.
		closeOnBackpressureLimit: websocket?.closeOnBackpressureLimit ?? false,
		sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
		compression: websocket?.compression ?? false,
		allowedOrigins: websocket?.allowedOrigins ?? 'same-origin',
		upgradeTimeout: websocket?.upgradeTimeout ?? 10,
		upgradeRateLimit: websocket?.upgradeRateLimit ?? 10,
		upgradeRateLimitWindow: websocket?.upgradeRateLimitWindow ?? 10,
		authPathRateLimit: websocket?.authPathRateLimit ?? 30,
		authPathRateLimitWindow: websocket?.authPathRateLimitWindow ?? 10,
		upgradeAdmission: websocket?.upgradeAdmission,
		messageAdmission: websocket?.messageAdmission,
		pressure: websocket?.pressure,
		// Graduated protection posture ('normal' | 'auto' | 'elevated' |
		// 'siege'). A plain string enum, so it rides the JSON placeholder
		// cleanly; the runtime applies the 'normal' default and only builds
		// the posture machine when this is non-'normal'.
		protection: websocket?.protection,
		// Interval (ms) for the per-worker resource-growth auditor, and the
		// posture export socket. Both are read off wsOptions at runtime
		// (handler.js), so both have to be threaded through here - being on
		// KNOWN_WEBSOCKET_OPTION_KEYS without being serialized is precisely
		// the silent-drop failure this function was extracted to prevent, and
		// it also suppresses the unknown-key warning that would have caught it.
		resourceGrowthAuditIntervalMs: websocket?.resourceGrowthAuditIntervalMs ?? 0,
		postureExport: websocket?.postureExport,
		// Interval (ms) for the clustered cross-worker state-hash
		// reporter. 0 (default) disables it - no reporter timer is
		// scheduled and a single-process deployment never runs it.
		// When > 0 in clustered mode each worker reports a
		// structure-only hash of its delivered-seq map to the
		// primary, which logs a `state-divergence` event if the live
		// workers disagree at rest. The auto-restart of a diverged
		// worker is a separate primary env switch
		// (`RESTART_ON_STATE_DIVERGENCE`), default off.
		stateHashIntervalMs: websocket?.stateHashIntervalMs ?? 0,
		// Interval (ms) for the per-worker consistency auditor. Default
		// 5000; 0 disables it (no timer scheduled, zero cost). On a slow,
		// jittered, unref'd timer each worker runs the shared invariant
		// predicates against a bounded structure-only snapshot of its live
		// connections. A violation logs + increments the assertion counter
		// (soft); only a subscription-slot type corruption that persists
		// across two audits escalates to a worker restart. Off the hot
		// path - publish/send/subscribe/close pay nothing. Runs
		// single-process AND clustered (a per-worker safety net).
		consistencyAuditIntervalMs: websocket?.consistencyAuditIntervalMs ?? 5000,
		// Wire-level subscribes to '__'-prefixed system topics
		// (e.g. '__signal:userId', '__rpc', plugin '__presence:*'
		// '__group:*' '__replay:*') are reserved for internal
		// framework / plugin use. Default off; set to `true` only
		// for advanced apps that intentionally let clients listen
		// on framework-internal channels.
		allowSystemTopicSubscribe: websocket?.allowSystemTopicSubscribe === true,
		// Wire-subscribe authorization. When true, a CLIENT-initiated
		// subscribe / subscribe-batch frame is honored only for a topic
		// the server already authorized for that connection via
		// `platform.subscribe`, unless the app exports its own subscribe
		// hook. Serialized as a strict boolean like its siblings; the
		// runtime arming lives in handler.js (`subscribeAuth.enabled`).
		authorizeWireSubscribe: websocket?.authorizeWireSubscribe === 'strict'
			? 'strict'
			: websocket?.authorizeWireSubscribe === true,
		// Wire-level subscribe topics default to printable ASCII
		// only (0x20-0x7E, minus the always-illegal `"` and `\\`).
		// This closes Unicode line separators, RTL override, and
		// the byte-order mark - all of which survive the wire
		// and surprise log dashboards / admin tools that render
		// topics back to a human. Apps that legitimately use
		// non-ASCII topic names can opt back in.
		allowNonAsciiTopics: websocket?.allowNonAsciiTopics === true,
		// CSRF defense for the `/__ws/auth` POST endpoint. By
		// default, the request must carry one of:
		//   - `x-requested-with: XMLHttpRequest`
		//   - `Sec-Fetch-Site: same-origin`
		//   - an `Origin` header matching `allowedOrigins`
		// Apps that need to accept this endpoint from native
		// (non-browser) clients without these headers can set
		// `authPathRequireOrigin: false` here.
		authPathRequireOrigin: websocket?.authPathRequireOrigin !== false,
		// BREACH defense: dynamic compression of credentialed
		// responses turns the response length into a side channel
		// that leaks any secret reflected alongside attacker
		// input. Compression is skipped on every request that
		// carries a `Cookie` or `Authorization` header. Apps that
		// have audited their reflected-input surface (random
		// per-response masking, no secrets reflected with attacker
		// input) can opt back in by setting
		// `compressCredentialedResponses: true`.
		compressCredentialedResponses: websocket?.compressCredentialedResponses === true,
		// When `allowedOrigins: 'same-origin'` is set without any
		// fronting trust to pin Host against (no ORIGIN env, no
		// HOST_HEADER env, no native TLS, no upgrade() hook), the
		// runtime refuses to start because the same-origin check
		// then compares two attacker-controlled headers and
		// trivially passes for any non-browser scripted client.
		// Apps that have audited this and want the previous
		// warn-only behavior can set
		// `unsafeSameOriginWithoutHostPin: true`.
		unsafeSameOriginWithoutHostPin: websocket?.unsafeSameOriginWithoutHostPin === true,
		// Silences the boot warning that the admin route carries no
		// adapter-level authentication. Set it once the app's admin() handler
		// gates its own requests - the adapter cannot detect that itself.
		adminAuthAcknowledged: websocket?.adminAuthAcknowledged === true,
		// Admin route prefix (validated above): a normalized path string
		// (default `/__realtime`) or `false` to disable the auto-mount.
		adminPath
	};
}
/** @type {import('./index.js').default} */
export default function (opts = {}) {
	const { out = 'build', precompress = true, envPrefix = '', healthCheckPath = '/healthz', readinessCheckPath = '/readyz' } = opts;
	const tracingOption = opts.tracing;
	if (tracingOption != null && (typeof tracingOption !== 'string' || tracingOption.trim() === '')) {
		throw new Error(
			"tracing must be a non-empty module path string (e.g. './src/lib/server/tracing.js') " +
			'whose default or named tracing export implements startSpan(name, options).'
		);
	}
	const tracingPath = typeof tracingOption === 'string' ? tracingOption.trim() : null;

	// Readiness probe path (distinct from the `healthCheckPath` liveness probe):
	// reports 503 once graceful shutdown begins so a load balancer drains the
	// instance. Default `/readyz`; set `false` to disable. Validated here so a
	// misconfiguration fails the build rather than silently no-op'ing.
	if (readinessCheckPath !== false) {
		if (typeof readinessCheckPath !== 'string' || readinessCheckPath[0] !== '/') {
			throw new Error(
				`readinessCheckPath must be an absolute path string starting with '/' ` +
				`(e.g. '/readyz'), or false to disable the readiness route - ` +
				`got ${JSON.stringify(readinessCheckPath)}.`
			);
		}
		if (healthCheckPath !== false && readinessCheckPath === healthCheckPath) {
			throw new Error(
				`readinessCheckPath ('${readinessCheckPath}') must differ from healthCheckPath ('${healthCheckPath}') - ` +
				`liveness and readiness are distinct probes (a readiness 503 during drain must not trip a liveness restart).`
			);
		}
	}

	// Validate `staticHeaders` eagerly so a misshaped value fails before any
	// build work. The reserved-key warning needs builder.log, so it is emitted
	// inside adapt(); the throw-on-bad-shape path runs here at factory time.
	const staticHeadersResult = normalizeStaticHeaders(opts.staticHeaders);
	const staticCacheControl = normalizeStaticCacheControl(opts.staticCacheControl);

	if (opts.staticDotfiles !== undefined && typeof opts.staticDotfiles !== 'boolean') {
		// JSON.stringify throws on a BigInt and erases functions and Symbols;
		// String() throws on a null-prototype object. The tag form renders any
		// object, String() everything else.
		const shown = typeof opts.staticDotfiles === 'object' && opts.staticDotfiles !== null
			? Object.prototype.toString.call(opts.staticDotfiles)
			: String(opts.staticDotfiles);
		throw new Error(
			`staticDotfiles must be a boolean - got ${shown} (${typeof opts.staticDotfiles}). ` +
			'The default (false) refuses every dot-segment static path except .well-known/*; ' +
			'true indexes and serves them all.'
		);
	}
	const staticDotfiles = opts.staticDotfiles === true;

	// Normalize websocket config: true -> {}, false/undefined -> null
	const websocket =
		opts.websocket === true
			? {}
			: opts.websocket || null;
	const waitingRoomTemplate = websocket?.upgradeAdmission?.waitingRoom?.template;
	const waitingRoomRenderer = websocket?.upgradeAdmission?.waitingRoom?.renderer;
	if (waitingRoomRenderer != null && typeof waitingRoomRenderer !== 'string') {
		throw new Error(
			`websocket.upgradeAdmission.waitingRoom.renderer must be a module path string ` +
			`(e.g. './src/lib/server/waiting-room.js') - got ${JSON.stringify(waitingRoomRenderer)}.`
		);
	}
	if (typeof waitingRoomRenderer === 'string' && waitingRoomRenderer.trim() === '') {
		throw new Error(
			'websocket.upgradeAdmission.waitingRoom.renderer must not be an empty module path.'
		);
	}
	if (waitingRoomRenderer && waitingRoomTemplate != null) {
		throw new Error(
			'websocket.upgradeAdmission.waitingRoom.renderer and .template are mutually exclusive.'
		);
	}
	if (typeof waitingRoomTemplate === 'string') {
		compileAccessibleWaitingRoomTemplate(waitingRoomTemplate);
	}

	if (websocket?.handler != null && typeof websocket.handler !== 'string') {
		throw new Error(
			`websocket.handler must be a path string (e.g. './src/lib/server/ws.js') - ` +
			`got ${JSON.stringify(websocket.handler)}.`
		);
	}

	return {
		name: 'adapter-uws',

		// Read by the Vite plugin (src/vite.js) so this one value drives both
		// surfaces. The plugin resolves the WS handler and emits it BEFORE the
		// adapter runs, so without this the plugin could not see the adapter's
		// choice and would bundle whatever auto-discovery found instead.
		websocketHandler: websocket?.handler ?? null,

		async adapt(builder) {
			// Verify the native addon is present before starting build work.
			try {
				await import('uWebSockets.js');
			} catch (cause) {
				throw new Error(uwsLoadErrorMessage(readAdapterPackageJson(), cause), { cause });
			}

			const tmp = builder.getBuildDirectory('adapter-uws');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`)
				]);
			}

			builder.log.minor('Building server');

			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			// Lazily-initialized esbuild bundler for user-authored server modules
			// (the ws-handler fallback and the metrics registry). Resolves SvelteKit
			// aliases ($lib, kit.alias) and the $env / $app virtual modules the same
			// way the Vite plugin would, so a user module that imports them bundles
			// correctly. The shared config is built once on first use.
			/** @type {{ esbuild: any, aliasMap: Record<string,string>, publicPrefix: string, allEnv: Record<string,string>, version: string } | null} */
			let esbuildCtx = null;
			/**
			 * @param {string} entry - path to the user module to bundle
			 * @param {string} outfile - destination in the build temp dir
			 */
			async function esbuildServerModule(entry, outfile) {
				if (!esbuildCtx) {
					const esbuild = await import('esbuild');
					const { loadEnv } = await import('vite');
					const libDir = path.resolve(builder.config.kit.files?.lib || 'src/lib');
					const publicPrefix = builder.config.kit.env?.publicPrefix ?? 'PUBLIC_';
					const allEnv = loadEnv('production', process.cwd(), '');
					const version = builder.config.kit.version?.name ?? '';
					const aliasMap = { '$lib': libDir };
					const kitAliases = builder.config.kit.alias;
					if (kitAliases) {
						for (const [key, value] of Object.entries(kitAliases)) {
							if (!(key in aliasMap)) aliasMap[key] = path.resolve(value);
						}
					}
					esbuildCtx = { esbuild, aliasMap, publicPrefix, allEnv, version };
				}
				const { esbuild, aliasMap, publicPrefix, allEnv, version } = esbuildCtx;
				await esbuild.build({
					entryPoints: [path.resolve(entry)],
					bundle: true,
					format: 'esm',
					platform: 'node',
					outfile,
					alias: aliasMap,
					packages: 'external',
					plugins: [{
						name: 'sveltekit-virtual-modules',
						setup(build) {
							build.onResolve({ filter: /^\$(env|app)\// }, (args) => ({
								path: args.path,
								namespace: 'sveltekit'
							}));
							build.onLoad({ filter: /.*/, namespace: 'sveltekit' }, (args) => {
								if (args.path === '$app/environment') {
									return { contents: `export const dev = false;\nexport const building = false;\nexport const version = ${JSON.stringify(version)};` };
								}
								const isPublic = args.path.includes('/public');
								const isStatic = args.path.includes('/static');
								if (!isStatic) {
									if (isPublic) {
										return { contents: `export const env = new Proxy(process.env, { get(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) ? t[k] : undefined; }, ownKeys(t) { return Object.keys(t).filter(k => k.startsWith(${JSON.stringify(publicPrefix)})); }, has(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t; }, getOwnPropertyDescriptor(t, k) { if (typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t) return { value: t[k], enumerable: true, configurable: true }; return undefined; } });` };
									}
									return { contents: 'export const env = process.env;' };
								}
								const entries = Object.entries(allEnv).filter(([k]) =>
									(isPublic ? k.startsWith(publicPrefix) : !k.startsWith(publicPrefix))
									&& /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
								);
								return { contents: entries.map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n') || 'export {};' };
							});
						}
					}]
				});
			}

			// Write the WebSocket handler module
			if (websocket) {
				// If the Vite plugin was used, ws-handler.js is already in the
				// writeServer output - built through the same Vite pipeline as
				// hooks.server.ts, with $lib/$env/$app resolved and shared modules.
				if (existsSync(`${tmp}/ws-handler.js`)) {
					// The plugin already resolved and emitted the handler. Confirm it
					// bundled the module this adapter was configured with, and name
					// that module in the log - the old line asserted a handler was
					// built without saying which, which is why a substitution stayed
					// invisible.
					const origin = readHandlerOrigin(tmp);
					assertBundledHandlerMatches(websocket.handler, origin, builder.log);
					builder.log.minor(
						origin
							? `WebSocket handler: ${origin.source} (${origin.from}, built by Vite plugin)`
							: 'WebSocket handler: built by Vite plugin'
					);
				} else {
					// Vite plugin not installed - resolve handler ourselves
					let handlerFile = websocket.handler;

					if (!handlerFile) {
						const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
						for (const candidate of candidates) {
							if (existsSync(candidate)) {
								handlerFile = candidate;
								break;
							}
						}
					}

					if (handlerFile) {
						// Bundle through esbuild to resolve SvelteKit aliases and handle TS.
						// This is the fallback path - the Vite plugin is preferred because
						// it shares modules with the server bundle (no duplication).
						await esbuildServerModule(handlerFile, `${tmp}/ws-handler.js`);
						builder.log.minor(`WebSocket handler: ${handlerFile} (esbuild fallback)`);
						builder.log.warn(
							'Add the Vite plugin to share modules between hooks.ws and the server bundle:\n' +
							"  import uws from 'svelte-adapter-uws/vite';\n" +
							'  export default { plugins: [sveltekit(), uws()] };'
						);
					} else {
						// No handler found - use built-in default (subscribe/unsubscribe only)
						writeFileSync(`${tmp}/ws-handler.js`, DEFAULT_WS_HANDLER);
						builder.log.minor('WebSocket enabled (built-in handler)');
					}
				}
			} else {
				// No WebSocket - empty module
				writeFileSync(`${tmp}/ws-handler.js`, '// No WebSocket handler configured\n');
			}

			// Metrics registry module. `websocket.metrics` is a module path (like
			// `handler`): adapter options are serialized into the build, so a live
			// registry object could never reach the runtime - it must arrive as
			// bundled code. The generated module re-exports the user's registry as
			// its default export; the runtime imports it, populates it, and exposes
			// it on `platform.metrics` for a scrape route to read. A `null` stub is
			// always written (even with WS off) so the placeholder import resolves.
			const metricsPath = websocket?.metrics;
			if (metricsPath && existsSync(`${tmp}/metrics-registry.js`)) {
				builder.log.minor('Metrics registry: built by Vite plugin');
			} else if (metricsPath) {
				// Not '__'-prefixed: the extra-entry discovery loop below only
				// bundles '__' files, and this is an esbuild source, not a Rollup
				// entry (its OUTPUT metrics-registry.js is the entry).
				const metricsEntry = `${tmp}/metrics-entry-src.js`;
				// Pass the namespace through a function so esbuild does not statically
				// resolve `.default`/`.metrics`/`.registry` against the user's module
				// and warn for whichever export form they did not use.
				writeFileSync(
					metricsEntry,
					`import * as m from ${JSON.stringify(path.resolve(metricsPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.metrics ?? ns.registry ?? null;\n' +
					'export default pick(m);\n'
				);
				await esbuildServerModule(metricsEntry, `${tmp}/metrics-registry.js`);
				builder.log.minor(`Metrics registry: ${metricsPath}`);
			} else {
				writeFileSync(`${tmp}/metrics-registry.js`, 'export default null;\n');
			}

			// Optional vendor-neutral trace provider. Like the metrics registry,
			// this is a module path because adapter options are serialized into the
			// production build. A null stub keeps the runtime import monomorphic and
			// makes the unconfigured hot path one branch with no span allocation.
			if (tracingPath) {
				const tracingEntry = `${tmp}/tracing-provider-entry-src.js`;
				writeFileSync(
					tracingEntry,
					`import * as m from ${JSON.stringify(path.resolve(tracingPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.tracing ?? ns.provider ?? null;\n' +
					'const selected = pick(m);\n' +
					"if (!selected || typeof selected.startSpan !== 'function') {\n" +
					"  throw new Error('[adapter-uws] configured tracing module must export a provider with startSpan(name, options).');\n" +
					'}\n' +
					'export default selected;\n'
				);
				await esbuildServerModule(tracingEntry, `${tmp}/tracing-provider.js`);
				builder.log.minor(`Tracing provider: ${tracingPath}`);
			} else {
				writeFileSync(`${tmp}/tracing-provider.js`, 'export default null;\n');
			}

			// Per-request waiting-room renderer. This is a module path rather
			// than a live function for the same serialization reason as metrics
			// and primaryInit. Bundle the user's default or named
			// renderWaitingRoom export into an isolated server entry; a null stub
			// keeps the runtime bridge resolvable when the feature is unused.
			const waitingRoomRendererPath =
				websocket?.upgradeAdmission?.waitingRoom &&
				typeof websocket.upgradeAdmission.waitingRoom === 'object'
					? websocket.upgradeAdmission.waitingRoom.renderer
					: null;
			if (waitingRoomRendererPath) {
				const rendererEntry = `${tmp}/waiting-room-renderer-entry-src.js`;
				writeFileSync(
					rendererEntry,
					`import * as m from ${JSON.stringify(path.resolve(waitingRoomRendererPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.renderWaitingRoom ?? null;\n' +
					'export default pick(m);\n'
				);
				await esbuildServerModule(rendererEntry, `${tmp}/waiting-room-renderer.js`);
				builder.log.minor(`Waiting-room renderer: ${waitingRoomRendererPath}`);
			} else {
				writeFileSync(`${tmp}/waiting-room-renderer.js`, 'export default null;\n');
			}

			// primaryInit module. Like `metrics`, this is a module PATH, not a live
			// function: adapter options are serialized into the build, so a function
			// passed in svelte.config.js could never reach the runtime. The module's
			// default export (or a named `primaryInit` export) runs ONCE in the primary
			// thread before any worker spawns; its return value is attached to every
			// worker's `workerData` (replayed identically on respawn) and surfaced to
			// the `init` hook. Bundled as its own entry so the primary loads only this
			// module, never the app graph (a top-level side effect in hooks.ws must not
			// run in the supervisor). A `null` stub is always written so the placeholder
			// import resolves even when unused.
			if (websocket?.primaryInit != null && typeof websocket.primaryInit !== 'string') {
				throw new Error(
					"websocket.primaryInit must be a module path string (e.g. './src/lib/server/cluster.js') " +
					'whose default (or named `primaryInit`) export is a function run once in the primary thread ' +
					'before workers spawn. A live function cannot be passed: adapter options are serialized into ' +
					'the build, so it would never reach the production runtime.'
				);
			}
			const primaryInitPath = websocket?.primaryInit;
			if (primaryInitPath && existsSync(`${tmp}/primary-init.js`)) {
				builder.log.minor('primaryInit: built by Vite plugin');
			} else if (primaryInitPath) {
				const primaryInitEntry = `${tmp}/primary-init-src.js`;
				// Pass the namespace through a pick() so esbuild does not statically
				// resolve `.default`/`.primaryInit` against the user's module and warn
				// for whichever export form they did not use.
				writeFileSync(
					primaryInitEntry,
					`import * as m from ${JSON.stringify(path.resolve(primaryInitPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.primaryInit ?? null;\n' +
					'export default pick(m);\n'
				);
				await esbuildServerModule(primaryInitEntry, `${tmp}/primary-init.js`);
				builder.log.minor(`primaryInit: ${primaryInitPath}`);
			} else {
				writeFileSync(`${tmp}/primary-init.js`, 'export default null;\n');
			}

			// Worker roles: `websocket.workers.compute` is how many of the cluster's
			// workers are dedicated compute workers (no listen socket; app-driven via
			// the primaryInit shared memory). io = total - compute. Serialized into the
			// primary-visible WORKERS_CONFIG placeholder (plain data - the count - so it
			// rides the JSON cleanly, unlike primaryInit).
			let computeWorkers = 0;
			if (websocket?.workers != null) {
				const w = websocket.workers;
				if (typeof w !== 'object' || Array.isArray(w)) {
					throw new Error('websocket.workers must be an object, e.g. { compute: 2 }.');
				}
				if (w.compute != null) {
					if (!Number.isInteger(w.compute) || w.compute < 0) {
						throw new Error(
							`websocket.workers.compute must be a non-negative integer (how many of the ` +
							`CLUSTER_WORKERS total are compute workers), got ${JSON.stringify(w.compute)}.`
						);
					}
					computeWorkers = w.compute;
				}
			}

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			/** @type {Record<string, string>} */
			const input = {
				index: `${tmp}/index.js`,
				manifest: `${tmp}/manifest.js`,
				'ws-handler': `${tmp}/ws-handler.js`,
				'metrics-registry': `${tmp}/metrics-registry.js`,
				'tracing-provider': `${tmp}/tracing-provider.js`,
				'waiting-room-renderer': `${tmp}/waiting-room-renderer.js`,
				'primary-init': `${tmp}/primary-init.js`
			};

			if (builder.hasServerInstrumentationFile?.()) {
				input['instrumentation.server'] = `${tmp}/instrumentation.server.js`;
			}

			// Include extra entry files written by Vite plugins (e.g. __live-registry.js).
			// Only picks up __-prefixed files to avoid bundling SvelteKit internals.
			const knownEntries = new Set(Object.values(input).map(f => path.basename(f)));
			/** @type {string[]} */
			const extraEntries = [];
			for (const file of readdirSync(tmp)) {
				if (file.startsWith('__') && file.endsWith('.js') && !knownEntries.has(file)) {
					const name = file.replace(/\.js$/, '');
					input[name] = `${tmp}/${file}`;
					extraEntries.push(name);
				}
			}

			// Bundle the Vite output so that deployments only need
			// their production dependencies. Anything in devDependencies
			// will get included in the bundled code.
			const bundle = await rollup({
				input,
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`)),
					// uWebSockets.js must stay external - it's a native addon
					/^uWebSockets\.js$/
				],
				plugins: [
					nodeResolve({
						preferBuiltins: true,
						exportConditions: ['node']
					}),
					commonjs({ strictRequires: true }),
					json()
				]
			});

			await writeAndCloseRollupBundle(bundle, {
				dir: `${out}/server`,
				format: 'esm',
				sourcemap: true,
				chunkFileNames: 'chunks/[name]-[hash].js'
			});

			// WebSocket config - serialized as globals for the runtime template
			const wsPath = websocket?.path ?? '/ws';
			if (wsPath[0] !== '/') {
				throw new Error(
					`websocket.path must start with '/' - got '${wsPath}'. ` +
					`Use '/${wsPath}' instead.`
				);
			}
			const wsAuthPath = websocket?.authPath ?? '/__ws/auth';
			if (wsAuthPath[0] !== '/') {
				throw new Error(
					`websocket.authPath must start with '/' - got '${wsAuthPath}'. ` +
					`Use '/${wsAuthPath}' instead.`
				);
			}
			if (wsAuthPath === wsPath) {
				throw new Error(
					`websocket.authPath ('${wsAuthPath}') must differ from websocket.path ('${wsPath}').`
				);
			}
			// Admin / observability route prefix. The adapter auto-mounts the WS
			// handler's `admin(request)` export here (before the SSR catch-all)
			// when it is exported. Default `/__realtime`; set a string to relocate
			// it; set `false` to disable the auto-mount entirely (e.g. when mounting
			// it yourself via a SvelteKit `+server.js` route with your own
			// middleware). The realtime admin handler is mount-prefix agnostic, so a
			// custom path is configured in this one place.
			let adminPath = websocket?.adminPath;
			if (adminPath === undefined || adminPath === null) adminPath = '/__realtime';
			if (adminPath !== false) {
				if (typeof adminPath !== 'string' || adminPath[0] !== '/') {
					throw new Error(
						`websocket.adminPath must be an absolute path string starting with '/' ` +
						`(e.g. '/__realtime'), or false to disable the auto-mounted admin route - ` +
						`got ${JSON.stringify(adminPath)}.`
					);
				}
				adminPath = adminPath.replace(/\/+$/, '');
				if (adminPath === '') {
					throw new Error(
						`websocket.adminPath cannot be '/' or empty - use a non-root prefix like '/__realtime', or false to disable.`
					);
				}
				if (adminPath === wsPath || adminPath === wsAuthPath) {
					throw new Error(
						`websocket.adminPath ('${adminPath}') must differ from websocket.path ('${wsPath}') and websocket.authPath ('${wsAuthPath}').`
					);
				}
			}
			if (websocket?.metrics != null && typeof websocket.metrics !== 'string') {
				throw new Error(
					"websocket.metrics must be a module path string (e.g. './src/lib/server/metrics.js') " +
					'whose default export is your registry. Passing a live registry object no longer works: ' +
					'adapter options are serialized into the build, so a live object never reached the ' +
					'production runtime. Move `export const metrics = createMetrics()` into its own module, ' +
					'point `websocket.metrics` at that path, and read the populated registry at runtime via ' +
					'`platform.metrics` (e.g. in a /metrics +server.js route). See the README metrics section.'
				);
			}
			const wsOpts = serializeWsOptions(websocket, adminPath);

			// Loud on unknown websocket.* keys: adapter options are serialized
			// into the build, so a key the adapter does not recognize is dropped
			// silently - warn so a typo'd or renamed option surfaces instead of
			// no-op'ing (the documented authorizeWireSubscribe was dropped exactly
			// this way before it was threaded into wsOpts).
			const unknownWsKeys = unknownWebsocketOptionKeys(websocket);
			if (unknownWsKeys.length) {
				builder.log.warn(
					`[adapter-uws] unknown websocket option(s): ${unknownWsKeys.join(', ')} - ` +
					'not recognized by the adapter and ignored. Check the spelling against the ' +
					'documented websocket options (WebSocketOptions in index.d.ts).'
				);
			}

			// Scan the bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })`
			// and warn loudly. Cloudflare Tunnel and some other strict edge proxies
			// silently close WebSocket connections whose 101 response carries
			// Set-Cookie (1006 TCP FIN immediately after the server-side open fires).
			if (websocket && existsSync(`${tmp}/ws-handler.js`)) {
				try {
					const handlerSrc = readFileSync(`${tmp}/ws-handler.js`, 'utf8');
					if (detectSetCookieOnUpgrade(handlerSrc)) {
						builder.log.warn(
							'[adapter-uws] Your upgrade() hook attaches Set-Cookie to the 101 response ' +
							'via upgradeResponse(). This fails silently behind Cloudflare Tunnel, ' +
							"Cloudflare's proxy, and some other strict edge proxies: the WebSocket " +
							'opens, then closes with code 1006 before any frames are exchanged.\n' +
							'\n' +
							'Migrate to the `authenticate` hook to refresh session cookies over a ' +
							'normal HTTP response that works behind every proxy:\n' +
							'\n' +
							'  export function authenticate({ cookies }) {\n' +
							"    const session = validateSession(cookies.get('session'));\n" +
							'    if (!session) return false;\n' +
							"    cookies.set('session', renewSession(session), { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });\n" +
							'  }\n' +
							'\n' +
							'Then opt in from the client: connect({ auth: true }).\n' +
							'This warning is safe to ignore if you do not deploy behind Cloudflare.'
						);
					}
				} catch {
					// Scanner is best-effort; ignore IO errors
				}
			}

			// staticHeaders: app-chosen response headers for static and prerendered
			// assets (CSP, HSTS, X-Frame-Options, ...). These bypass the SvelteKit
			// `handle` hook, which only runs on the SSR path - so security headers
			// set there never reach static/prerendered responses. Reserved
			// transfer/caching headers are stripped (the handler owns them); warn
			// so a dropped override is never silent.
			if (staticHeadersResult.dropped.length) {
				builder.log.warn(
					`[adapter-uws] staticHeaders ignored: ${staticHeadersResult.dropped.join(', ')}. ` +
					'These transfer/caching/range headers are managed by the static file ' +
					'handler and cannot be overridden (content-type, content-encoding, etag, ' +
					'cache-control, vary, accept-ranges, ...). Use staticCacheControl for ' +
					'path-specific cache policies. Every other header is applied.'
				);
			}

			// Dotfiles are excluded from the static index by default, so a
			// dot-path in the output would 404 in production with nothing saying
			// why. Say so here, where the file is still in front of the developer.
			if (!staticDotfiles) {
				const outBase = builder.config.kit.paths.base;
				const refused = [...new Set([
					...listExcludedDotPaths(`${out}/client${outBase}`),
					...listExcludedDotPaths(`${out}/prerendered${outBase}`)
				])];
				if (refused.length) {
					// Every offender is named - a refused directory collapses to one
					// entry, so the list stays proportionate to what the developer
					// actually dropped into static/.
					builder.log.warn(
						`[adapter-uws] not served - dotfiles are refused by default, .well-known/ is ` +
						`always served: ${refused.join(', ')}. Rename the file to serve it, or set ` +
						'staticDotfiles: true to serve every dotfile.'
					);
				}
			}

			// A function waiting-room template cannot be serialized into the build,
			// so it would be silently dropped. It is now an HTML string with
			// `{{token}}` placeholders - warn loudly on the old function form.
			const wrTemplate = websocket?.upgradeAdmission?.waitingRoom;
			if (wrTemplate && typeof wrTemplate === 'object' && typeof wrTemplate.template === 'function') {
				builder.log.warn(
					'[adapter-uws] upgradeAdmission.waitingRoom.template must now be an HTML string ' +
					'with {{queueDepth}} / {{estimatedSeconds}} / {{pollIntervalMs}} / ' +
					'{{retryAfterSeconds}} / {{admitCheckPath}} / {{appName}} / {{statusUrl}} / ' +
					'{{supportUrl}} / {{incidentId}} tokens. A function cannot be serialized ' +
					'into the build and was ignored; the built-in holding page is being used.'
				);
			}

			builder.copy(runtimeDir, out, {
				replace: {
					ENV: './env.js',
					HANDLER: './handler.js',
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					SHIMS: './shims.js',
					WS_HANDLER: './server/ws-handler.js',
					ENV_PREFIX: JSON.stringify(envPrefix),
					PRECOMPRESS: JSON.stringify(precompress),
					WS_ENABLED: JSON.stringify(!!websocket),
					WS_PATH: JSON.stringify(wsPath),
					WS_OPTIONS: JSON.stringify(wsOpts),
					WS_AUTH_PATH: JSON.stringify(wsAuthPath),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath),
					READINESS_CHECK_PATH: JSON.stringify(readinessCheckPath),
					STATIC_HEADERS: JSON.stringify(staticHeadersResult.headers),
					STATIC_CACHE_CONTROL: JSON.stringify(staticCacheControl),
					STATIC_DOTFILES: JSON.stringify(staticDotfiles),
					METRICS_REGISTRY: './server/metrics-registry.js',
					TRACING_PROVIDER: './server/tracing-provider.js',
					WAITING_ROOM_RENDERER: './server/waiting-room-renderer.js',
					PRIMARY_INIT: './server/primary-init.js',
					WORKERS_CONFIG: JSON.stringify({ compute: computeWorkers })
				}
			});
			const tracingRuntimePath = out + '/tracing.js';
			const tracingRuntimeSource = readFileSync(tracingRuntimePath, 'utf8');
			const generatedTracingRuntime = tracingRuntimeSource.replace(
				"from '../trace-context.js';",
				"from './trace-context.js';"
			);
			if (generatedTracingRuntime === tracingRuntimeSource) {
				throw new Error('Failed to rewrite the generated tracing helper import.');
			}
			writeFileSync(tracingRuntimePath, generatedTracingRuntime);
			writeFileSync(
				out + '/trace-context.js',
				readFileSync(new URL('./trace-context.js', import.meta.url), 'utf8')
			);

			// Runtime-readable identity metadata. Keep this as package/schema
			// files beside the copied runtime rather than compiling version
			// literals into JavaScript: diagnostics then report the adapter and
			// protocol artifacts that actually produced this server build.
			const metadataDir = out + '/meta/svelte-adapter-uws';
			mkdirSync(metadataDir, { recursive: true });
			writeFileSync(
				metadataDir + '/package.json',
				readFileSync(new URL('../package.json', import.meta.url), 'utf8')
			);
			writeFileSync(
				out + '/meta/protocol.schema.json',
				readFileSync(new URL('../protocol.schema.json', import.meta.url), 'utf8')
			);

			// Import discovered __-prefixed entries so they execute at startup
			if (extraEntries.length > 0) {
				const entryImports = extraEntries
					.map(name => `import './server/${name}.js';`)
					.join('\n');
				const indexPath = `${out}/index.js`;
				const indexContent = readFileSync(indexPath, 'utf8');
				writeFileSync(indexPath, entryImports + '\n' + indexContent);
				builder.log.minor(`Extra entries: ${extraEntries.join(', ')}`);
			}

			if (builder.hasServerInstrumentationFile?.()) {
				builder.instrument?.({
					entrypoint: `${out}/index.js`,
					instrumentation: `${out}/server/instrumentation.server.js`,
					module: {
						exports: ['host', 'port']
					}
				});
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		},

		emulate() {
			return {
				platform() {
					// Vite plugin sets this when installed. Wrap with a fresh
					// requestId per call - Kit invokes platform() once per
					// dev request, but without access to the request itself,
					// so X-Request-ID is not honoured in dev (production
					// reads the header).
					if (globalThis.__uws_dev_platform) {
						const clone = Object.create(globalThis.__uws_dev_platform);
						clone.requestId = randomUuid();
						return clone;
					}

					// No Vite plugin - if WebSocket isn't configured, that's fine
					if (!websocket) return undefined;

					// WebSocket IS configured but plugin is missing - return a
					// helpful proxy that throws only when actually used
					const msg =
						'WebSocket platform not available in dev. Add the Vite plugin to your vite.config.js:\n\n' +
						"  import uws from 'svelte-adapter-uws/vite';\n" +
						'  export default { plugins: [sveltekit(), uws()] };';
					return new Proxy(/** @type {any} */ ({}), {
						get(_, prop) {
							if (typeof prop === 'symbol' || prop === 'then') return undefined;
							throw new Error(msg);
						}
					});
				}
			};
		}
	};
}
