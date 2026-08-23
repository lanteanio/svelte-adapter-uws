// Configuration guards shared by the build-time adapter (src/index.js) and the
// dev plugin (src/vite.js).
//
// Both surfaces read the same user-facing flags out of a plain object, and both
// have shipped the same failure: an option the surface does not recognize is
// dropped in silence, so the app runs without a protection it believes it
// configured. A copy of these checks in each file would drift the same way the
// two surfaces already drifted, so they live here and are imported.
//
// Not a package export - internal, but it ships (package.json `files` includes
// `src`), so both published entry points can import it.

/**
 * The receiver cap every surface falls back to when an application configures
 * none.
 *
 * It existed as three separate `1024 * 1024` literals - the build-time adapter,
 * the dev plugin, and the test double - which is precisely what let them
 * disagree. The guard that VALIDATES this option was already shared; the value
 * it falls back to was not.
 *
 * Read it with `??`, never as a destructuring default. `assertProtectiveNumber`
 * treats `null` as absent, so `null` has to arrive at this default by the same
 * route `undefined` does. A destructuring default replaces only `undefined`,
 * and that is exactly how the test double came to report `null` from
 * `platform.maxPayloadLength` while handing `null` to the receiver.
 */
export const DEFAULT_MAX_PAYLOAD_LENGTH = 1024 * 1024;

/**
 * Refuse a non-boolean value for a flag whose purpose is to RESTRICT access.
 *
 * Restrictive flags are read with `=== true`, which silently treats every other
 * value as "off". For a permissive flag that is harmless - coercing yields the
 * SAFE state. For a restrictive one it is the inverted case: the app asked for
 * a protection and gets none, with no warning, because an unknown-KEY check
 * cannot help when the key is known and only the VALUE is wrong.
 *
 * `authorizeWireSubscribe: process.env.WS_AUTHZ` is the natural way to write
 * this and the reason the guard exists: `process.env.X` is a string when set
 * and `undefined` when not, so the flag is off either way.
 *
 * Absent is fine - the flag is simply not configured.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the flag being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and not a boolean
 */
export function assertRestrictiveBoolean(bag, key, surface = `websocket.${key}`) {
	const value = bag?.[key];
	if (value === undefined || typeof value === 'boolean') return;
	throw new Error(
		`${surface} must be true or false - got ${JSON.stringify(value)} (${typeof value}). ` +
		`This flag restricts access, so an unrecognized value is refused rather than read as ` +
		`"off", which would silently disable the protection it was set to enable. If the value ` +
		`comes from the environment, convert it explicitly (e.g. process.env.WS_AUTHZ === '1').`
	);
}

/**
 * Validate the wire-subscribe authorization policy. In addition to the legacy
 * boolean modes, `strict` requires BOTH an existing server grant and an
 * application subscribe-hook allow.
 *
 * @param {Record<string, any> | null | undefined} bag
 * @param {string} key
 * @param {string} [surface]
 * @returns {void}
 */
export function assertWireSubscribeAuthorization(bag, key, surface = `websocket.${key}`) {
	const value = bag?.[key];
	if (value === undefined || typeof value === 'boolean' || value === 'strict') return;
	throw new Error(
		`${surface} must be true, false, or 'strict' - got ${JSON.stringify(value)} (${typeof value}). ` +
		'An unrecognized value is refused because silently reading it as off would disable subscription authorization. ' +
		"If the value comes from the environment, convert it explicitly (e.g. process.env.WS_AUTHZ === 'strict' ? 'strict' : false)."
	);
}

/**
 * Refuse a non-numeric value for an option that sizes a PROTECTION.
 *
 * The rate limits are read as `wsOptions.x ?? default` and then compared with
 * `>` / `>=`, and the value survives a JSON round trip into the build. What
 * that actually produced, measured rather than assumed:
 *
 * - `''` (an empty or unset environment variable) DISABLED the limiter
 *   outright - `'' > 0` is false, so the whole block was skipped.
 * - `'30'` happened to work, because `>=` coerces a numeric string.
 * - `NaN` and `Infinity` serialize to `null` and fell back to the default.
 *
 * So only one of the three ever disabled anything - but `authPathRateLimit:
 * process.env.LIMIT` is the natural way to write it, and which of those three
 * you get depends on how the variable is set. A door whose enforcement depends
 * on that is refused rather than shipped.
 *
 * This is the same inversion {@link assertRestrictiveBoolean} exists for, in a
 * numeric option: coercion lands on the UNSAFE state, so the value is refused
 * instead. Absent (`undefined` / `null`) is fine and takes the default; `0` is
 * a real setting that disables the limit deliberately.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and not a finite number >= 0
 */
export function assertProtectiveNumber(
	bag,
	key,
	surface = `websocket.${key}`,
	{ allowZero = true, zeroMeans = '', ceiling = 0 } = {}
) {
	const value = bag?.[key];
	if (value === undefined || value === null) return;
	const floor = allowZero ? 0 : 1;
	// A ceiling'd option is stored by the native layer in a fixed-width
	// integer: a larger or fractional value is silently truncated there while
	// the configured figure is what gets reported back, which is the same
	// report-versus-enforce split in the opposite direction.
	if (ceiling > 0 && typeof value === 'number' && Number.isFinite(value) && value >= floor &&
		(!Number.isSafeInteger(value) || value > ceiling)) {
		throw new Error(
			`${surface} must be an integer no greater than ${ceiling}, because the receiver ` +
			`stores this bound in a fixed-width integer and silently truncates anything larger ` +
			`- got ${describeValue(value)}.`
		);
	}
	if (typeof value === 'number' && Number.isFinite(value) && value >= floor) return;
	if (!allowZero && value === 0) {
		// The reason zero is refused differs per option, so the caller supplies
		// it. A single hardcoded explanation was written for the rate-limit
		// WINDOWS and read as nonsense - and self-referential - the moment a
		// size or a timeout was guarded the same way.
		throw new Error(
			`${surface} must be greater than 0. ${zeroMeans || 'Zero does not disable this option, it breaks it.'}`
		);
	}
	// `JSON.stringify` throws on a BigInt, so the value is described rather than
	// serialized: an option written as `1024n` otherwise failed the build with
	// "Do not know how to serialize a BigInt" from the message builder, which
	// says nothing about the option that was wrong.
	const shown = typeof value === 'bigint' ? `${value}n` : describeValue(value);
	throw new Error(
		`${surface} must be a number >= ${floor} - got ${shown} (${typeof value}). ` +
		`This option bounds a resource, and every comparison against a non-number is false, ` +
		`so an unrecognized value would disable the bound entirely rather than fall back to ` +
		`the default. If the value comes from the ` +
		`environment, convert it explicitly (e.g. Number(process.env.AUTH_LIMIT)).`
	);
}

/**
 * Validate the graduated protection posture level.
 *
 * The runtime reads this with `value || 'normal'` and builds the posture
 * machine for any other value, pinning only a level it recognizes - so a
 * misspelled level does not fail and does not pin: it silently runs the
 * machine in `'auto'` resolution, which is neither the pin the operator asked
 * for nor the inert default. Absent (`undefined` / `null`) is fine and stays
 * on the `'normal'` default by the same route it always took.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and not a recognized level
 */
export function assertProtectionPosture(bag, key, surface = `websocket.${key}`) {
	const value = bag?.[key];
	if (value === undefined || value === null) return;
	if (value === 'normal' || value === 'auto' || value === 'elevated' || value === 'siege') return;
	throw new Error(
		`${surface} must be 'normal', 'auto', 'elevated', or 'siege' - got ${describeValue(value)} (${typeof value}). ` +
		`The runtime pins only a level it recognizes, so an unrecognized level would silently ` +
		`resolve the posture from live pressure ('auto') instead of holding the pin that was asked for.`
	);
}

/**
 * Validate the WebSocket origin policy.
 *
 * The origin check recognizes exactly three forms - `'*'`, `'same-origin'`,
 * and an array of origin strings compared verbatim against the request's
 * `Origin` header. Every other TRUTHY value falls through every branch and the
 * check returns `false`, so a misspelled policy does not fail the build and
 * does not fall back to the default: it silently refuses every origin-bearing
 * connection while the build log reports the option as configured. A FALSY
 * value never reaches the check at all - the runtime reads the policy with
 * `|| 'same-origin'` - so it silently runs the default rather than expressing
 * anything; it is refused too, named for what it actually did. Array entries
 * are compared with `===` against a header string, so a non-string entry (a
 * RegExp, a number) can never match anything and is refused too; the strings
 * themselves are not second-guessed, because a non-browser client may
 * legitimately send an `Origin` no URL parser would normalize.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and not a recognized policy shape
 */
export function assertAllowedOrigins(bag, key, surface = `websocket.${key}`) {
	const value = bag?.[key];
	if (value === undefined || value === null || value === '*' || value === 'same-origin') return;
	if (!value) {
		throw new Error(
			`${surface} must be '*', 'same-origin', or an array of origin strings ` +
			`(e.g. ['https://example.com']) - got ${describeValue(value)} (${typeof value}). ` +
			`A falsy value never reaches the origin check - the policy is read with a fallback, so ` +
			`it silently runs the 'same-origin' default while expressing no policy of its own. ` +
			`Omit the option (or write 'same-origin') to keep the default deliberately.`
		);
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`${surface} must be '*', 'same-origin', or an array of origin strings ` +
			`(e.g. ['https://example.com']) - got ${describeValue(value)} (${typeof value}). ` +
			`The origin check recognizes only these forms, so an unrecognized value would silently ` +
			`refuse every origin-bearing connection instead of applying the policy that was meant.`
		);
	}
	for (const entry of value) {
		if (typeof entry === 'string' && entry !== '') continue;
		throw new Error(
			`${surface} entries must be non-empty origin strings (e.g. 'https://example.com') - ` +
			`got ${describeValue(entry)} (${typeof entry}). An entry is compared verbatim against ` +
			`the request's Origin header string, so any other type can never match and would be a ` +
			`silently dead allowlist entry.`
		);
	}
}

/**
 * Validate the per-message-deflate configuration.
 *
 * The runtime maps this as: a number passes through to uWS, any other truthy
 * value becomes `SHARED_COMPRESSOR`, any falsy value disables. That coercion
 * INVERTS the natural env spelling - `compression: process.env.WS_COMPRESS`
 * set to `'0'` or `'false'` is a truthy string, so it turns compression ON.
 * Only the two documented forms pass: a boolean, or a uWS compression
 * constant, which is a non-negative integer bit set.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and neither boolean nor constant
 */
export function assertCompression(bag, key, surface = `websocket.${key}`) {
	const value = bag?.[key];
	if (value === undefined || value === null || typeof value === 'boolean') return;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
	throw new Error(
		`${surface} must be a boolean or a uWS compression constant (a non-negative integer such as ` +
		`uWS.SHARED_COMPRESSOR or uWS.DEDICATED_COMPRESSOR_4KB) - got ${describeValue(value)} (${typeof value}). ` +
		`Any other truthy value would silently enable SHARED_COMPRESSOR - including '0' or 'false' ` +
		`from an environment variable, which would turn compression ON.`
	);
}

/**
 * Milliseconds ceiling of a Node timer delay. `setInterval` stores the delay
 * in a signed 32-bit integer, and a larger delay overflows to fire every
 * millisecond - so an interval meant to slow a sampler or auditor down would
 * instead run it in the tightest loop the event loop allows.
 */
export const MAX_TIMER_INTERVAL_MS = 0x7fffffff;

/**
 * @param {string} surface
 * @param {unknown} value
 * @returns {never}
 */
function throwTimerOverflow(surface, value) {
	throw new Error(
		`${surface} must be no greater than ${MAX_TIMER_INTERVAL_MS} milliseconds, because Node ` +
		`stores a timer delay in a signed 32-bit integer and a larger delay overflows to fire ` +
		`every millisecond - the tight loop an interval this large was meant to avoid - got ` +
		`${describeValue(value)}.`
	);
}

/**
 * Validate a millisecond interval that feeds a Node timer.
 *
 * Same terms as {@link assertProtectiveNumber} - the runtime reads these as
 * `value > 0`, so a misshaped value silently disables the timer instead of
 * falling back to its default, and `0` stays the documented deliberate
 * disable - plus the 32-bit timer ceiling: a finite value above it passes a
 * `> 0` check and then overflows `setInterval` into a 1 ms loop. Fractional
 * milliseconds below the ceiling stay legal; Node timers accept them.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} key - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the value is present and not a usable timer delay
 */
export function assertIntervalMs(bag, key, surface = `websocket.${key}`) {
	assertProtectiveNumber(bag, key, surface);
	const value = bag?.[key];
	if (typeof value === 'number' && value > MAX_TIMER_INTERVAL_MS) throwTimerOverflow(surface, value);
}

/**
 * The documented keys of the `pressure` section. The adapter's nested
 * unknown-key walk (`KNOWN_NESTED_WEBSOCKET_OPTION_KEYS` in src/index.js)
 * reads this same set, so the value judgment below and the unknown-key
 * warning can never recognize different keys.
 */
export const KNOWN_PRESSURE_OPTION_KEYS = new Set([
	'memoryHeapUsedRatio', 'publishRatePerSec', 'subscriberRatio', 'sampleIntervalMs',
	'topicPublishRatePerSec', 'topicPublishBytesPerSec',
	'psiCpuSome', 'psiMemoryFull', 'psiIoFull', 'cpuThrottledRatio'
]);

/**
 * Validate the pressure section: its shape, its thresholds, and the sample
 * cadence.
 *
 * A threshold fires on `sample >= threshold`, and a comparison against a
 * non-number is false - so a misshaped threshold silently stands its signal
 * down while `false` is the documented way to do that on purpose.
 * `sampleIntervalMs` degrades differently: the runtime replaces a non-number
 * or a number below 100 with the 1000 ms default, so a configured cadence
 * would be silently ignored - while NaN and Infinity are numbers the floor
 * comparison cannot place, and a finite value above the Node timer ceiling
 * passes it, so all three flow to `setInterval` and collapse into a 1 ms
 * loop. A
 * section that is not an object at all - `false` included - is silently
 * spread away and replaced by the full default thresholds, so the sampler
 * runs at complete default tuning under a config that plainly meant to change
 * or disable it; standing signals down is spelled per threshold.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} [key] - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the section or a value in it cannot be honored
 */
export function assertPressureSection(bag, key = 'pressure', surface = `websocket.${key}`) {
	const pressure = bag?.[key];
	if (pressure === undefined || pressure === null) return;
	if (!pressure || typeof pressure !== 'object' || Array.isArray(pressure)) {
		throw new Error(
			`${surface} must be an object of thresholds (or omitted) - got ` +
			`${describeValue(pressure)} (${typeof pressure}). Any other value - false included - is ` +
			`silently replaced by the full default thresholds, so neither the tuning nor the ` +
			`disable that was meant would ever apply. To stand individual signals down, set each ` +
			`threshold to false (e.g. { memoryHeapUsedRatio: false }).`
		);
	}
	for (const thresholdKey of Object.keys(pressure)) {
		// A key outside the documented set is the unknown-key warning's job,
		// not a value error.
		if (!KNOWN_PRESSURE_OPTION_KEYS.has(thresholdKey)) continue;
		const value = pressure[thresholdKey];
		if (value === undefined || value === null) continue;
		if (thresholdKey === 'sampleIntervalMs') {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 100) {
				throw new Error(
					`${surface}.sampleIntervalMs must be a number >= 100 (milliseconds between ` +
					`samples) - got ${describeValue(value)} (${typeof value}). The sampler silently ` +
					`replaces a non-number or a lower number with its 1000 ms default, while NaN and ` +
					`Infinity slip that floor check and collapse setInterval into a 1 ms loop.`
				);
			}
			if (value > MAX_TIMER_INTERVAL_MS) throwTimerOverflow(`${surface}.sampleIntervalMs`, value);
			continue;
		}
		if (value === false || (typeof value === 'number' && Number.isFinite(value) && value >= 0)) continue;
		throw new Error(
			`${surface}.${thresholdKey} must be false (disable the signal) or a number >= 0 - ` +
			`got ${describeValue(value)} (${typeof value}). A threshold compares as ` +
			`\`sample >= threshold\`, and every comparison against any other value is false, so ` +
			`the signal would be silently disabled rather than tuned.`
		);
	}
}

/**
 * The documented keys of the `egress` section and its two scope sub-sections.
 * The adapter's nested unknown-key walk (`KNOWN_NESTED_WEBSOCKET_OPTION_KEYS`
 * in src/index.js) reads these same sets, so the unknown-key warning and the
 * value guard below can never recognize different keys.
 */
export const KNOWN_EGRESS_OPTION_KEYS = new Set(['windowMs', 'maxKeys', 'evictionSample', 'topic', 'tenant']);
export const KNOWN_EGRESS_CEILING_KEYS = new Set(['messages', 'bytes', 'deliveries']);

/**
 * Validate the publish-egress section: its shape, its window, its ledger
 * sizing (`maxKeys`, `evictionSample`), and its six ceilings.
 *
 * Each ceiling is read as `value > 0`, so a misshaped value does not fall back
 * to a default - it leaves that ceiling open in silence, the same inversion
 * every other guard here exists for. `0` is each ceiling's documented
 * deliberate disable, so it stays legal. The window takes the same floor and
 * timer ceiling as the pressure cadence: a window below 100 ms would rotate
 * the usage ledger faster than anything can meaningfully accumulate in it, and
 * a value above the 32-bit timer bound is refused on the shared vocabulary
 * even though the ledger rotates lazily rather than on a timer.
 *
 * `tenantOf` is refused HERE, by name: the section survives a JSON round trip
 * into the build, so a function configured on it would be silently dropped and
 * every tenant-scoped ceiling would silently enforce nothing. The resolver is
 * a handler-module export (`egressTenantOf`), the same carrier as
 * `attribution`, which reaches the runtime on every surface.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} [key] - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the section or a value in it cannot be honored
 */
export function assertEgressSection(bag, key = 'egress', surface = `websocket.${key}`) {
	const egress = bag?.[key];
	if (egress === undefined || egress === null) return;
	if (!egress || typeof egress !== 'object' || Array.isArray(egress)) {
		throw new Error(
			`${surface} must be an object of publish-egress ceilings (or omitted) - got ` +
			`${describeValue(egress)} (${typeof egress}). The ledger reads its window and ceilings ` +
			`off the section object, so no other value can configure it; omit the option to leave ` +
			`every ceiling disabled deliberately.`
		);
	}
	if ('tenantOf' in egress) {
		throw new Error(
			`${surface}.tenantOf cannot be configured here: the section survives a JSON round trip ` +
			`into the build, so a function would be silently dropped and every tenant ceiling would ` +
			`silently enforce nothing. Export egressTenantOf(topic) from the WebSocket handler ` +
			`module instead (the same carrier as the attribution export).`
		);
	}
	const windowMs = egress.windowMs;
	if (windowMs !== undefined && windowMs !== null) {
		if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs < 100) {
			throw new Error(
				`${surface}.windowMs must be a number >= 100 (milliseconds per accounting window) - ` +
				`got ${describeValue(windowMs)} (${typeof windowMs}). A misshaped window would be ` +
				`silently replaced by the 1000 ms default, so the cadence that was configured would ` +
				`never apply.`
			);
		}
		if (windowMs > MAX_TIMER_INTERVAL_MS) throwTimerOverflow(`${surface}.windowMs`, windowMs);
	}
	const maxKeys = egress.maxKeys;
	if (maxKeys !== undefined && maxKeys !== null) {
		// The bounds are stated identically at the ledger (EGRESS_MAX_KEYS_FLOOR
		// and EGRESS_MAX_KEYS_CEILING in src/runtime/utils/egress-account.js),
		// which treats anything outside them as absent. The ceiling is V8's own
		// Map limit: a bound past 2^24 could never be reached - the Map throws
		// 'Map maximum size exceeded' on the insert first, on the publish path.
		// There is deliberately no `0 disables` here: an unbounded ledger turns
		// topic cardinality into that same crash, behind unbounded memory first.
		if (!Number.isSafeInteger(maxKeys) || maxKeys < 1024 || maxKeys > 2 ** 24) {
			throw new Error(
				`${surface}.maxKeys must be a safe integer between 1024 and 2^24 (keys per scope ` +
				`ledger; the ledger rounds it up to the next power of two, which holds no fewer ` +
				`keys in the same memory, and V8's Map cannot hold more than 2^24 entries at all) - ` +
				`got ${describeValue(maxKeys)} (${typeof maxKeys}). A ` +
				`misshaped value would be silently replaced by the 4096 default, so the sizing that ` +
				`was configured would never apply. The cap cannot be disabled: omit the option for ` +
				`the default, and size it to live key cardinality at ~56 bytes per seated key.`
			);
		}
	}
	const evictionSample = egress.evictionSample;
	if (evictionSample !== undefined && evictionSample !== null) {
		if (!Number.isSafeInteger(evictionSample) || evictionSample < 1) {
			throw new Error(
				`${surface}.evictionSample must be a safe integer >= 1 (entries an at-cap eviction ` +
				`inspects before taking the least-active one; the default is 8) - got ` +
				`${describeValue(evictionSample)} (${typeof evictionSample}). A misshaped value would ` +
				`be silently replaced by the default, so the width that was configured would never ` +
				`apply.`
			);
		}
	}
	for (const scope of ['topic', 'tenant']) {
		const section = egress[scope];
		if (section === undefined || section === null) continue;
		if (typeof section !== 'object' || Array.isArray(section)) {
			throw new Error(
				`${surface}.${scope} must be an object of ceilings ` +
				`({ messages?, bytes?, deliveries? }) - got ${describeValue(section)} ` +
				`(${typeof section}). Any other value leaves every ${scope} ceiling silently unset.`
			);
		}
		for (const ceiling of KNOWN_EGRESS_CEILING_KEYS) {
			const value = section[ceiling];
			if (value === undefined || value === null) continue;
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error(
					`${surface}.${scope}.${ceiling} must be a non-negative safe integer per window ` +
					`(0 disables this ceiling deliberately) - got ${describeValue(value)} ` +
					`(${typeof value}). Every comparison against any other value is false, so the ` +
					`ceiling would be silently disabled rather than sized.`
				);
			}
		}
	}
}

/**
 * Validate the upgrade-admission section and its four ceilings.
 *
 * Each ceiling is read as `value > 0`, so a misshaped value does not fall
 * back to a default - it leaves that gate open in silence. `0` is each
 * ceiling's documented deliberate disable, so it stays legal and the refusal
 * names what `0` means for that ceiling. The section itself must be an
 * object: the gate reads its ceilings off the section's properties, so no
 * other value can configure admission control - a bare number or `true`
 * silently leaves every ceiling unset. The runtime admission factory
 * (`createUpgradeAdmission`) enforces the same per-ceiling predicate, so a
 * value that slips past a surface without this guard still cannot construct
 * the gate.
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {string} [key] - the option being read
 * @param {string} [surface] - how the user names the option, for the message
 * @returns {void}
 * @throws {Error} when the section or a ceiling in it cannot be honored
 */
export function assertUpgradeAdmissionCeilings(bag, key = 'upgradeAdmission', surface = `websocket.${key}`) {
	const admission = bag?.[key];
	if (admission === undefined || admission === null) return;
	if (typeof admission !== 'object' || Array.isArray(admission)) {
		throw new Error(
			`${surface} must be an object of admission ceilings (or omitted) - got ` +
			`${describeValue(admission)} (${typeof admission}). The gate reads its ceilings off the ` +
			`section object, so no other value can configure admission control; omit the option to ` +
			`leave the gate disabled deliberately.`
		);
	}
	const ceilings = [
		['maxConcurrent', 'Use 0 to leave the concurrent-handshake ceiling disabled deliberately.'],
		['perTickBudget', 'Use 0 to leave upgrade pacing disabled deliberately.'],
		['maxConnections', 'Use 0 to disable the live-connection ceiling deliberately.'],
		['maxDeferred', 'Use 0 to reject once the current tick budget is spent, without retaining a queue.']
	];
	for (const [ceiling, zeroMeans] of ceilings) {
		const value = admission[ceiling];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`${surface}.${ceiling} must be a non-negative safe integer. ${zeroMeans}`);
		}
	}
}

/**
 * One value judgment for every intake surface.
 *
 * The adapter factory, the `uws()` dev plugin, and `createTestServer` each
 * read user options out of a plain bag, and each shipped the same failure
 * separately: a value one surface refuses rides through another, so a config
 * that "works" under `vite dev` or a test harness fails its first production
 * build. Every surface passes its bag through here, so the set of refused
 * values cannot differ between them - a surface that does not HONOR an option
 * still judges its value, on the terms the dev plugin already established for
 * `protection`.
 *
 * `surfaceFor` names the option the way the caller's users spell it, so the
 * refusal reads in the caller's vocabulary (`websocket.protection` at the
 * factory, `the uws() dev plugin option protection` in dev).
 *
 * @param {Record<string, any> | null | undefined} bag - the options object
 * @param {(key: string) => string} surfaceFor - names an option for this surface
 * @returns {void}
 * @throws {Error} when any judged value cannot be honored
 */
export function assertSharedOptionValues(bag, surfaceFor) {
	assertProtectionPosture(bag, 'protection', surfaceFor('protection'));
	assertAllowedOrigins(bag, 'allowedOrigins', surfaceFor('allowedOrigins'));
	assertCompression(bag, 'compression', surfaceFor('compression'));
	// The observability timers are read as `value > 0` at runtime, and every
	// comparison against a non-number is false - so a misshaped interval does
	// not fall back to its default, it silently disables the auditor or
	// reporter it configures. 0 stays legal for all three: it is the
	// documented way to disable them deliberately.
	assertIntervalMs(bag, 'stateHashIntervalMs', surfaceFor('stateHashIntervalMs'));
	assertIntervalMs(bag, 'consistencyAuditIntervalMs', surfaceFor('consistencyAuditIntervalMs'));
	assertIntervalMs(bag, 'resourceGrowthAuditIntervalMs', surfaceFor('resourceGrowthAuditIntervalMs'));
	assertPressureSection(bag, 'pressure', surfaceFor('pressure'));
	assertUpgradeAdmissionCeilings(bag, 'upgradeAdmission', surfaceFor('upgradeAdmission'));
	assertEgressSection(bag, 'egress', surfaceFor('egress'));
}

/**
 * Render a rejected option value for a message without throwing on the exotic
 * ones. `JSON.stringify` handles most, returns `undefined` for a function or a
 * symbol, and throws on a BigInt or a circular object.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/**
 * Keys present on `bag` that are not in `known`.
 *
 * Used to warn rather than throw: an unknown key is usually a typo or a renamed
 * option, and refusing the build outright would break apps carrying a harmless
 * stale key. The warning is what makes the drop visible.
 *
 * @param {Record<string, any> | null | undefined} bag
 * @param {Set<string>} known
 * @returns {string[]}
 */
export function unknownOptionKeys(bag, known) {
	if (!bag || typeof bag !== 'object') return [];
	return Object.keys(bag).filter((k) => !known.has(k));
}

/**
 * The closest documented key to an unrecognized one, or `null` when nothing is
 * close enough to name.
 *
 * A casing slip is the most common way to type a known key wrong, so a
 * case-insensitive exact match wins outright. After that, a small bounded edit
 * distance (at most 2, and only between names of 4+ characters) catches the
 * transposed or dropped letter; anything further apart stays suggestion-free,
 * because a wrong guess in a warning is worse than none.
 *
 * @param {string} key - the unrecognized key
 * @param {Set<string>} known
 * @returns {string | null}
 */
export function suggestOptionKey(key, known) {
	const lower = key.toLowerCase();
	for (const candidate of known) {
		if (candidate.toLowerCase() === lower) return candidate;
	}
	if (key.length < 4) return null;
	let best = null;
	let bestDistance = 3;
	for (const candidate of known) {
		if (candidate.length < 4) continue;
		const distance = boundedEditDistance(lower, candidate.toLowerCase(), 2);
		if (distance !== null && distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Levenshtein distance capped at `bound`; `null` once the strings are provably
 * further apart, so the scan over a key set stays cheap.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} bound
 * @returns {number | null}
 */
function boundedEditDistance(a, b, bound) {
	if (Math.abs(a.length - b.length) > bound) return null;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
			row.push(value);
			if (value < rowMin) rowMin = value;
		}
		if (rowMin > bound) return null;
		previous = row;
	}
	return previous[b.length] <= bound ? previous[b.length] : null;
}

/**
 * Unknown keys of `bag`, each annotated with the closest documented key when
 * {@link suggestOptionKey} finds one. `fallbackSuggestion` lets a caller offer
 * a suggestion from outside `known` - the adapter uses it to point a
 * `websocket.*` option typed at the top level to its real home.
 *
 * @param {Record<string, any> | null | undefined} bag
 * @param {Set<string>} known
 * @param {(key: string) => string | null} [fallbackSuggestion]
 * @returns {string[]}
 */
export function describeUnknownOptionKeys(bag, known, fallbackSuggestion) {
	return unknownOptionKeys(bag, known).map((key) => {
		const suggestion = suggestOptionKey(key, known) ?? fallbackSuggestion?.(key) ?? null;
		return suggestion === null ? key : `${key} (did you mean '${suggestion}'?)`;
	});
}
