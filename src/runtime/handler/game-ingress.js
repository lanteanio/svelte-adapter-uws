/**
 * The client-driven relay (`game` lane) binary twin: the `0x03` ingress kind
 * `game:1`. It is the compact-encoded counterpart of the JSON `game` frame (the
 * message-demux `game` guard + `platform.publishGame`) - identical semantics
 * (the topic is derived from the connection's publish grant, the server stamps
 * the per-room seq, the fan-out excludes the sender and echoes the client id),
 * carried on the shared `0x03` ingress transport (./ingress.js) instead of a
 * JSON control frame so a client can run its input path off `JSON.parse`. It is
 * a normal consumer of the ingress kind registry - no new leading byte, no new
 * framing.
 *
 * Wire (PROTOCOL.md section 6.6): a client that advertised `wire.ingress:1` binds
 * an ingress id to kind `game:1` with NO target (the destination topic is the
 * grant, resolved server-side), then sends
 * `[0x03][schemaVersion:u8][ingressId:varint][seq:varint][payload]`, where the
 * payload is `encodeValue([event, data])` or `encodeValue([event, data, id])` -
 * the generic value codec (../wire-value.js), the same codec the smooth command
 * channel uses. The frame's own `seq` is the per-binding ingress counter; the
 * authoritative ROOM seq is the one `publishGame` stamps on fan-out.
 *
 * @module svelte-adapter-uws/src/runtime/handler/game-ingress
 */

import { registerIngress } from './ingress.js';
import { decodeValue, encodeValue } from '../wire-value.js';
import { WS_PUBLISH_GRANT, WS_STATS } from '../utils.js';

/** The ingress kind a client binds to publish `game` frames as `0x03`. */
export const GAME_INGRESS_KIND = 'game:1';
/** The frame schema version for the `game:1` payload layout (value-codec `[event, data, id?]`). */
export const GAME_INGRESS_SCHEMA_VERSION = 1;

/**
 * The capability a SUBSCRIBER advertises to receive the `game` lane fan-out
 * compact-encoded (PROTOCOL.md section 6.7 / 5.1) instead of the JSON
 * data-event envelope. The EGRESS mirror of the `game:1` ingress twin;
 * independent of `wire.ingress:1` (a connection may receive compact fan-out
 * while sending JSON inputs, or vice versa).
 */
export const GAME_FANOUT_CAP = 'game.fanout:1';
/** The fan-out frame schema version. Shares the `game:1` layout, so it shares its version. */
export const GAME_FANOUT_SCHEMA_VERSION = GAME_INGRESS_SCHEMA_VERSION;

/**
 * Encode a game fan-out payload: the byte-inverse of {@link decodeGameFrame}.
 * A SINGLE value-codec value `[event, data]`, or `[event, data, id]` when the
 * relayed event carries the sender's echoed input id (the `id !== undefined`
 * rule matches decode's `v.length > 2`). The framework wraps this in the
 * `[0x03][schemaVersion][topicId][seq]` header (see `buildBinaryFrame`).
 *
 * @param {string} event
 * @param {unknown} data
 * @param {number | string | undefined} id
 * @returns {Uint8Array}
 */
export function encodeGameFanoutPayload(event, data, id) {
	return encodeValue(id === undefined ? [event, data] : [event, data, id]);
}

/**
 * Decode a `game:1` payload into `{ event, data, id }`. The payload is a single
 * value-codec value: `[event, data]` or `[event, data, id]`. A truncated /
 * malformed buffer (`decodeValue` throws) drops the frame (returns `null`); a
 * decoded non-array surfaces as `event: undefined` so the route answers a granted
 * connection `game-denied INVALID` rather than dropping it silently.
 *
 * @param {Uint8Array} payload
 * @returns {{ event: unknown, data: unknown, id: number | string | undefined } | null}
 */
export function decodeGameFrame(payload) {
	let v;
	try { v = decodeValue(payload); } catch { return null; }
	if (Array.isArray(v)) return { event: v[0], data: v[1], id: v.length > 2 ? v[2] : undefined };
	return { event: undefined, data: undefined, id: undefined };
}

/**
 * Route a decoded `game:1` frame: gate on the connection's publish grant and
 * relay via `platform.publishGame` (byte-identical fan-out to the JSON lane), or
 * answer the sender `game-denied` (`FORBIDDEN` no grant / `INVALID` non-string
 * event). The frame's ingress `seq` is ignored - `publishGame` stamps the
 * authoritative room seq. `ws` is the platform's connection handle (the uWS
 * socket in production/test, the wrapper in dev); both expose `getUserData()` /
 * `send()`, and the outbound denial is counted into `WS_STATS` the same way every
 * platform's bump helper does.
 *
 * @param {any} ws
 * @param {any} _target  the binding target - unused (topic comes from the grant)
 * @param {{ event: unknown, data: unknown, id: number | string | undefined }} value
 * @param {any} platform
 * @param {number} _seq  the per-binding ingress seq - unused (the room seq is stamped on fan-out)
 */
export function routeGameFrame(ws, _target, value, platform, _seq) {
	let ud;
	try { ud = ws.getUserData(); } catch { return; }
	const grantTopic = ud[WS_PUBLISH_GRANT];
	if (!grantTopic || typeof value.event !== 'string') {
		const reason = grantTopic ? 'INVALID' : 'FORBIDDEN';
		const denied = value.id === undefined
			? JSON.stringify({ type: 'game-denied', reason })
			: JSON.stringify({ type: 'game-denied', reason, id: value.id });
		try {
			ws.send(denied, false, false);
			const stats = ud[WS_STATS];
			if (stats) { stats.messagesOut++; stats.bytesOut += denied.length; }
		} catch { /* socket closed mid-route */ }
		return;
	}
	platform.publishGame(ws, grantTopic, value.event, value.data, value.id);
}

/**
 * Register the `game:1` ingress kind. Idempotent (the registry keeps the last
 * registration per kind), so each server platform calls it at setup: a client
 * that advertised `wire.ingress:1` can then bind an id to `game:1` and publish
 * game frames as `0x03`. Cost is zero for a connection that never binds it.
 */
export function registerGameIngress() {
	registerIngress(GAME_INGRESS_KIND, { decode: (payload) => decodeGameFrame(payload), route: routeGameFrame });
}
