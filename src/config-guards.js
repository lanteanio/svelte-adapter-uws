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
