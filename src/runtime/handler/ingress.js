/**
 * Server-side binary ingress: the client->server counterpart of the `0x03`
 * topic frame. A client that advertised `wire.ingress:1` announces one or more
 * `id -> destination` bindings via `{type:'ingress-bind'}` control frames; each
 * later `0x03` frame it sends carries only that numeric id (plus a schema
 * version and seq) and a codec payload, which this module decodes and routes to
 * the destination's handler. It removes the per-frame `JSON.parse` a JSON
 * volatile-RPC envelope costs on a hot input path (the smooth 60Hz command
 * flush is the first consumer).
 *
 * The transport is generic: a consumer registers an ingress handler for a
 * `kind` (a decode + route pair), and a binding names that kind plus an opaque
 * `target` the handler interprets. For the smooth command channel the kind is
 * `smooth.command:1`, the target is `{ path, room }` (the volatile-RPC path and
 * its room args), decode turns the bytes back into the `Array<{id,cmd}>` batch,
 * and route replays it through the same volatile-RPC executor the JSON path
 * uses - so the decoded batch reaches `authority.enqueue(key, batch)`
 * identically, guards, unpack, ownership and cross-node relay included.
 *
 * The kind registry is a process-global keyed via `Symbol.for` on `globalThis`,
 * NOT a plain module-level Map: a consumer registers from the dynamically
 * imported `plugins/smooth` server module while the `0x03` demux reads from the
 * bundled runtime handler, and a bundler (vite SSR) can hand those two a
 * duplicate module instance. A plain module Map would then split registration
 * from lookup and the binding would never resolve; the global keeps one
 * registry regardless of how the graph was bundled.
 *
 * @module svelte-adapter-uws/src/runtime/handler/ingress
 */

import { parseBinaryFrame } from '../wire.js';
import { WS_INGRESS_BINDINGS } from '../utils.js';

/** The `0x03` ingress control token a client advertises in `hello.caps`. */
export const WIRE_INGRESS_CAP = 'wire.ingress:1';

// Process-global kind registry. See the module doc for why this is not a plain
// module-level Map.
const REGISTRY_KEY = Symbol.for('svelte-adapter-uws.ingress-registry');
/** @returns {Map<string, { decode: Function, route: Function, state?: { onAttach?: (ws: any) => any } }>} */
function registry() {
	let m = /** @type {any} */ (globalThis)[REGISTRY_KEY];
	if (m === undefined) {
		m = new Map();
		/** @type {any} */ (globalThis)[REGISTRY_KEY] = m;
	}
	return m;
}

/**
 * Register the server-side handler for an ingress `kind`. Idempotent; the last
 * registration for a kind wins (an HMR re-init simply replaces it). A consumer
 * (e.g. the smooth command channel) calls this once at setup.
 *
 * @param {string} kind - the binding kind (e.g. `'smooth.command:1'`)
 * @param {{
 *   decode: (payload: Uint8Array, schemaVersion: number, seq: number, state: any) => any,
 *   route: (ws: any, target: any, value: any, platform: any, seq: number) => void,
 *   state?: { onAttach?: (ws: any) => any }
 * }} handler
 *   `decode` turns a frame payload into the routed value (return null/undefined
 *   to drop the frame); `route` delivers it; the optional `state` factory makes
 *   one per-binding decoder state (stateless codecs omit it).
 */
export function registerIngress(kind, handler) {
	if (typeof kind === 'string' && handler && typeof handler.decode === 'function' && typeof handler.route === 'function') {
		registry().set(kind, handler);
	}
}

/**
 * Look up the handler for an ingress kind, or null.
 * @param {string} kind
 * @returns {{ decode: Function, route: Function, state?: { onAttach?: (ws: any) => any } } | null}
 */
export function getIngress(kind) {
	return (typeof kind === 'string' && registry().get(kind)) || null;
}

/** Test seam: clear the global ingress registry. @internal */
export function _resetIngressRegistry() {
	registry().clear();
}

/**
 * Bind a client-allocated ingress id to a destination for one connection, in
 * response to an `{type:'ingress-bind'}` control frame. Resolves the kind to a
 * registered handler and stores `id -> binding` in the connection's
 * `WS_INGRESS_BINDINGS` slot (created lazily). Returns true when the kind is
 * known and the binding was stored - the caller then acks with `ingress-bound`
 * so the client promotes the binding to binary. Returns false when the kind is
 * unregistered (an old/mismatched consumer): no binding, no ack, and the client
 * keeps that destination on its JSON fallback - never a silent drop.
 *
 * @param {any} ud - ws.getUserData()
 * @param {any} ws
 * @param {number} id - the client-allocated ingress id
 * @param {string} kind
 * @param {any} target - opaque destination the handler interprets
 * @returns {boolean}
 */
export function bindIngress(ud, ws, id, kind, target) {
	const handler = getIngress(kind);
	if (!handler) return false;
	let map = ud[WS_INGRESS_BINDINGS];
	if (!map) {
		map = new Map();
		ud[WS_INGRESS_BINDINGS] = map;
	}
	let state = null;
	if (handler.state && typeof handler.state.onAttach === 'function') {
		try { state = handler.state.onAttach(ws); } catch { state = null; }
	}
	map.set(id, { kind, target, decode: handler.decode, route: handler.route, state });
	return true;
}

/**
 * Decode and route one inbound `0x03` ingress frame. Called from the message
 * demux only for a connection that advertised `wire.ingress:1` and a frame
 * whose leading byte is `0x03`. Always consumes the frame (returns nothing);
 * a malformed frame, an unbound id, or a declined/throwing decode drops it
 * silently rather than falling through to the app message hook.
 *
 * @param {any} ws
 * @param {any} ud - ws.getUserData()
 * @param {ArrayBuffer | Uint8Array} message
 * @param {any} platform
 */
export function dispatchIngressFrame(ws, ud, message, platform) {
	const map = ud[WS_INGRESS_BINDINGS];
	if (!map) return;
	const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
	const parsed = parseBinaryFrame(bytes);
	if (!parsed) return;
	const binding = map.get(parsed.topicId);
	if (binding === undefined) return;
	let value;
	try {
		// A decode/route that throws drops just this one frame; the consumer owns
		// any logging inside its own decode/route (this module stays free of the
		// env/config chain so it is importable + unit-testable in isolation).
		value = binding.decode(parsed.payload, parsed.schemaVersion, parsed.seq, binding.state);
	} catch {
		return;
	}
	if (value === null || value === undefined) return;
	try {
		binding.route(ws, binding.target, value, platform, parsed.seq);
	} catch {
		/* one bad frame never crashes the demux */
	}
}

/**
 * The `{type:'ingress-ok'}` s->c frame: "this server understands binary
 * ingress; you may announce bindings". Emitted from the hello block when the
 * client advertised `wire.ingress:1`. Mirror of `lease-ok`.
 * @returns {string}
 */
export function ingressOkFrame() {
	return '{"type":"ingress-ok"}';
}

/**
 * The `{type:'ingress-bound','id':<id>}` s->c per-binding ack: the server
 * registered the binding, so the client may send `0x03` frames for this id.
 * @param {number} id
 * @returns {string}
 */
export function ingressBoundFrame(id) {
	return '{"type":"ingress-bound","id":' + (id | 0) + '}';
}
