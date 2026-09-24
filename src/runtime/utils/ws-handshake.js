// What a WebSocket opening handshake must carry before any capacity, origin or
// application decision is made about it (RFC 6455 4.2.1).
//
// One definition for every surface that accepts a handshake: the production
// upgrade handler, the in-process test server and the dev server. Each reads
// the request's header lines into the same shape - how many Upgrade, key and
// version lines arrived, whether any Connection line lists `upgrade`, and the
// first value of each - and asks the rule of that, ahead of every capacity
// answer.
//
// The rule is the native runtime's, line for line, so an app sees the same
// status from both: 400 for a request that is not a handshake anyone could
// complete, and 426 with `Sec-WebSocket-Version: 13` for one asking for a
// version this server does not speak, which is the answer RFC 6455 4.4 gives
// the client to retry with. Letter case is folded and whitespace trimmed in
// ASCII only, as the native runtime does.

/**
 * A Sec-WebSocket-Key is the base64 of exactly 16 octets: 22 significant
 * characters and `==`. The 22nd carries only two bits of the last octet, so
 * the four unused bits must be zero - `A`, `Q`, `g` or `w` - or the value is
 * not the canonical encoding of any 16 octets.
 */
const WEBSOCKET_KEY_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

/** The one version RFC 6455 defines, and the only one this server accepts. */
export const WEBSOCKET_VERSION = '13';

/**
 * The handshake headers of one request, as the rule reads them.
 *
 * @typedef {object} HandshakeLines
 * @property {number} upgrades how many Upgrade lines arrived
 * @property {number} keys how many Sec-WebSocket-Key lines arrived
 * @property {number} versions how many Sec-WebSocket-Version lines arrived
 * @property {boolean} connectionUpgrade whether any Connection line lists `upgrade`
 * @property {string} upgrade the first Upgrade value, or ''
 * @property {string} key the first key, or ''
 * @property {string} version the first version, or ''
 */

/**
 * Whether `value` is `lower` in any ASCII letter case. A non-ASCII character
 * that some case mapping folds onto an ASCII letter does not match.
 *
 * @param {string} value @param {string} lower
 */
function asciiEquals(value, lower) {
	if (value.length !== lower.length) return false;
	for (let i = 0; i < value.length; i++) {
		let c = value.charCodeAt(i);
		if (c >= 65 && c <= 90) c += 32;
		if (c !== lower.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * Whether a Connection value lists the `upgrade` option. The value is a
 * comma-separated list, so `keep-alive, Upgrade` does; each item is trimmed of
 * spaces and tabs only.
 *
 * @param {string} value
 */
function listsUpgrade(value) {
	// The value a browser sends, answered without splitting it.
	if (value.length === 7) return asciiEquals(value, 'upgrade');
	for (let token of value.split(',')) {
		let start = 0;
		let end = token.length;
		while (start < end && (token.charCodeAt(start) === 32 || token.charCodeAt(start) === 9)) start++;
		while (end > start && (token.charCodeAt(end - 1) === 32 || token.charCodeAt(end - 1) === 9)) end--;
		token = token.slice(start, end);
		if (asciiEquals(token, 'upgrade')) return true;
	}
	return false;
}

/**
 * Read the handshake headers off a uWS request. One walk of the header list,
 * because a repeated line is what a lookup cannot see.
 *
 * @param {any} req
 * @returns {HandshakeLines}
 */
export function readUwsHandshake(req) {
	let upgrades = 0;
	let keys = 0;
	let versions = 0;
	let connectionUpgrade = false;
	req.forEach((/** @type {string} */ name, /** @type {string} */ value) => {
		if (name === 'upgrade') upgrades++;
		else if (name === 'sec-websocket-key') keys++;
		else if (name === 'sec-websocket-version') versions++;
		else if (name === 'connection' && !connectionUpgrade) connectionUpgrade = listsUpgrade(value);
	});
	return {
		upgrades, keys, versions, connectionUpgrade,
		upgrade: req.getHeader('upgrade'),
		key: req.getHeader('sec-websocket-key'),
		version: req.getHeader('sec-websocket-version')
	};
}

/**
 * The same reading off a Node request's `rawHeaders`, which keeps every line
 * where `headers` joins them.
 *
 * @param {string[]} rawHeaders name, value, name, value, ...
 * @returns {HandshakeLines}
 */
export function readRawHandshake(rawHeaders) {
	let upgrades = 0;
	let keys = 0;
	let versions = 0;
	let connectionUpgrade = false;
	let upgrade = '';
	let key = '';
	let version = '';
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		const name = rawHeaders[i].toLowerCase();
		const value = rawHeaders[i + 1];
		if (name === 'upgrade') { if (upgrades++ === 0) upgrade = value; }
		else if (name === 'sec-websocket-key') { if (keys++ === 0) key = value; }
		else if (name === 'sec-websocket-version') { if (versions++ === 0) version = value; }
		else if (name === 'connection' && !connectionUpgrade) connectionUpgrade = listsUpgrade(value);
	}
	return { upgrades, keys, versions, connectionUpgrade, upgrade, key, version };
}

/**
 * Whether a request to the WebSocket path is trying to open a WebSocket: it
 * carries a key at all, or its Upgrade value is `websocket`. A plain GET, or an
 * upgrade to another protocol such as `h2c`, is not, and is served as the HTTP
 * request it is.
 *
 * @param {HandshakeLines} h
 */
export function isWebSocketUpgradeAttempt(h) {
	return h.keys > 0 || asciiEquals(h.upgrade, 'websocket');
}

/**
 * The status a handshake is refused with, or null when it may proceed.
 *
 * 400 unless there is exactly one Upgrade line and it is `websocket`, a
 * Connection line lists `upgrade`, there is exactly one key and it is the
 * canonical base64 of 16 octets, and there is at most one version line. 426
 * when that version is anything but 13, absent included.
 *
 * @param {HandshakeLines} h
 * @returns {400 | 426 | null}
 */
export function webSocketHandshakeRefusal(h) {
	if (h.upgrades !== 1 || h.keys !== 1 || h.versions > 1 || !h.connectionUpgrade ||
		!asciiEquals(h.upgrade, 'websocket') || !WEBSOCKET_KEY_RE.test(h.key)) return 400;
	return h.version === WEBSOCKET_VERSION ? null : 426;
}
