/**
 * String-keyed slot used to carry the per-connection requestId from
 * `upgrade` to `open`. Cannot be a Symbol: uWebSockets.js strips
 * Symbol-keyed properties from the userData object passed to
 * `res.upgrade()` (only string keys survive the C++ binding boundary).
 * The `open` hook deletes this slot after promoting the value into the
 * Symbol-keyed `WS_PLATFORM` clone, so it never leaks into hook code.
 */
export const WS_REQUEST_ID_KEY = '__adapter_uws_request_id__';

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
