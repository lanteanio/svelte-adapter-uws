/**
 * The string key the request id used to cross `res.upgrade()` on. Nothing is
 * stamped on it any more - the id rides {@link CARRY_REQUEST_ID} and lives on
 * `userData[WS_PLATFORM].requestId` from `open` on - and it stays exported so
 * an import of it still resolves.
 */
export const WS_REQUEST_ID_KEY = '__adapter_uws_request_id__';

/**
 * Keys the runtime carries per-connection values under from `res.upgrade()` to
 * `open`.
 *
 * `res.upgrade()` does not hand its argument through: uWS builds its own
 * userData object and copies the enumerable own properties across with plain
 * assignments, string and Symbol keys alike, so an accessor for a carried key
 * on Object.prototype would take the value and the far side would never see
 * it. A Symbol created here has no name any other code can reach, so no such
 * accessor can exist; `open` promotes each value and deletes the slot before
 * any hook runs.
 */
export const CARRY_REQUEST_ID = Symbol('adapter-uws.carry.request-id');
export const CARRY_TRACE_CONTEXT = Symbol('adapter-uws.carry.trace-context');

/**
 * Sanitize a possibly-present `X-Request-ID` header value into a value
 * safe to expose as `platform.requestId`. Returns `null` if the input is
 * absent, empty, longer than 128 chars, or contains anything outside the
 * printable ASCII range (0x21-0x7e). Callers fall back to `randomUUID()`
 * on `null`.
 *
 * The whitelist matters: `requestId` flows into structured logs and error
 * messages, where a smuggled control char (CR/LF, ANSI escape, NUL) can
 * fragment a log line or inject formatting. A single printable token is
 * the universal contract across logging libraries and tracing backends.
 *
 * @param {string | undefined | null} value
 * @returns {string | null}
 */
export function resolveRequestId(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 128) return null;
	for (let i = 0; i < trimmed.length; i++) {
		const c = trimmed.charCodeAt(i);
		if (c < 0x21 || c > 0x7e) return null;
	}
	return trimmed;
}
