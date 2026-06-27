// Symbol-keyed slots for adapter-internal scratch state on the
// per-connection userData object.
//
// The adapter needs to track per-connection state (the topic Set used
// to populate CloseContext.subscriptions, the coalesce-by-key buffer
// used by sendCoalesced) somewhere accessible from the WebSocket
// message handler. Stashing it on userData keeps the access pattern
// fast - the WS message handler already has userData in hand via
// ws.getUserData() and a property lookup is cheaper than a WeakMap.
//
// Using Symbol-keyed properties (rather than dunder strings like
// '__subscriptions') prevents collisions with arbitrary user upgrade
// hook returns: a user that does `return { __subscriptions: ... }`
// from upgrade() can no longer clobber the adapter's tracking, and
// Object.keys / JSON.stringify / spread on userData skip these slots
// so they do not leak into client serializations.
//
// The symbols use Symbol.for(...) so handler.js, vite.js, and testing.js
// (and downstream consumers like svelte-adapter-uws-extensions/redis/registry)
// all resolve to the SAME global symbol regardless of whether utils.js
// was bundled into a build artifact or loaded from node_modules at runtime.
// Plain `Symbol(description)` would create a new unique value per file
// instance, and a bundler that duplicates utils.js (vite's SSR output
// bundles handler.js + utils.js into build/) would produce two distinct
// symbols for the same conceptual slot - the handler would stamp under
// one symbol and a runtime-loaded extension (e.g. the cluster registry)
// would read under the other, silently dropping every cross-module lookup.
// The trade-off is that user code that calls Symbol.for('adapter-uws.ws.*')
// can now reach these slots; that is a deliberate accept since the
// alternative was a silent cluster-routing break in production.

export const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');

// Shared-fan-out cohort hooks. trackedSubscribe/Unsubscribe live in utils (the
// low-level membership primitive), but a subscribe to an already-shared topic must
// also join the matching cohort (and an unsubscribe must leave it + release the
// wire-id ref), or a plugin that establishes membership server-side silently misses
// every cohort-split publish. To avoid a utils -> handler import cycle, the handler
// installs the join/leave behavior here at boot via setCohortHooks; when unset (no
// shared codec in play, or the in-process test mirror which drives cohorts through
// its own per-server paths) the tracked* helpers behave exactly as before.
/** @type {((ws: any, ud: any, topic: string) => void) | null} */
let _onCohortJoin = null;
/** @type {((ws: any, ud: any, topic: string) => void) | null} */
let _onCohortLeave = null;
/**
 * Install the shared-fan-out cohort join/leave behavior for trackedSubscribe /
 * trackedUnsubscribe. Idempotent (last install wins); pass nulls to clear.
 * @param {((ws: any, ud: any, topic: string) => void) | null} onJoin
 * @param {((ws: any, ud: any, topic: string) => void) | null} onLeave
 */
export function setCohortHooks(onJoin, onLeave) {
	_onCohortJoin = onJoin || null;
	_onCohortLeave = onLeave || null;
}

/**
 * Subscribe a socket the way the wire-level subscribe path does: the uWS
 * native call PLUS the connection's subscription registry. The registry is
 * what `platform.publishWire`'s per-subscriber walk delivers by (native
 * membership is not enumerable from JS), so a plugin that subscribes a
 * socket natively but skips the registry silently excludes that socket from
 * every stateful-codec binary publish on the topic. Plugins establishing
 * server-side membership (a snapshot handshake, a presence join) must use
 * this instead of raw `ws.subscribe`.
 *
 * Returns false when the socket is already closed (uWS throws on access).
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean}
 */
export function trackedSubscribe(ws, topic) {
	try { ws.subscribe(topic); } catch { return false; }
	try {
		const ud = ws.getUserData();
		const subs = ud[WS_SUBSCRIPTIONS];
		if (subs) subs.add(topic);
		// Join the shared fan-out cohort if the topic is already shared.
		if (_onCohortJoin) _onCohortJoin(ws, ud, topic);
	} catch { /* socket died between the calls; close cleanup owns the registry */ }
	return true;
}

/**
 * Unsubscribe counterpart of {@link trackedSubscribe}: native unsubscribe
 * plus registry removal, so the per-subscriber binary walk stops delivering
 * the moment native membership ends.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean} false when the socket was already closed
 */
export function trackedUnsubscribe(ws, topic) {
	let ok = true;
	try { ws.unsubscribe(topic); } catch { ok = false; }
	try {
		const ud = ws.getUserData();
		const subs = ud[WS_SUBSCRIPTIONS];
		if (subs) subs.delete(topic);
		// Leave the shared fan-out cohort (drop both cohort subs + release the wire-id
		// ref) if the topic is shared, so the socket stops receiving cohort publishes.
		if (_onCohortLeave) _onCohortLeave(ws, ud, topic);
	} catch { /* socket died; close cleanup owns the registry */ }
	return ok;
}

export const WS_COALESCED = Symbol.for('adapter-uws.ws.coalesced');
export const WS_SESSION_ID = Symbol.for('adapter-uws.ws.session-id');
export const WS_PENDING_REQUESTS = Symbol.for('adapter-uws.ws.pending-requests');
export const WS_STATS = Symbol.for('adapter-uws.ws.stats');
export const WS_PLATFORM = Symbol.for('adapter-uws.ws.platform');
/**
 * Set of capabilities the connected client has advertised via a
 * `{type:'hello', caps: [...]}` frame. Read by `platform.publishBatched`
 * to decide whether to emit a wire-level batch envelope or fall back
 * to N individual frames for that connection. Empty / undefined is
 * the safe default - assume the client has no opt-in features.
 */
export const WS_CAPS = Symbol.for('adapter-uws.ws.caps');

/**
 * Per-connection binary wire-id allocation for `0x03` topic frames:
 * `{ byName: Map<topicName, number>, next: number }`. Allocated lazily on the
 * first binary publish to a connection (never for JSON-only connections, so
 * the common case pays nothing). The id replaces the topic string on the wire;
 * the server announces each `name -> id` assignment to the client in a
 * `{type:'wire-id'}` control frame the first time it emits a binary frame for
 * that topic. Per-connection and reset on reconnect - no cross-reconnect id
 * stability and no server-side schema registry.
 */
export const WS_TOPIC_IDS = Symbol.for('adapter-uws.ws.topic-ids');

/**
 * Per-connection per-codec wire state for stateful binary codecs:
 * `Map<capability, { state, detach }>`. A codec that declares a `wire.state`
 * factory (e.g. the cursor short-id dictionary, or a future apply-in-place
 * CRDT codec) gets one `state` object per connection, created lazily by
 * `wire.state.onAttach(ws)` on the first binary frame to that connection and
 * disposed by `wire.state.onDetach(ws, state)` on close. JSON-only and
 * stateless-codec connections never allocate this slot. The decision a codec
 * makes in `onAttach` (e.g. which schema version this connection negotiated)
 * is fixed for the life of the connection - reset on reconnect, not re-hello.
 */
export const WS_WIRE_STATE = Symbol.for('adapter-uws.ws.wire-state');

/**
 * Per-connection `Set<topic>` of the SHARED-codec topics for which this connection
 * holds a binary-cohort wire-id reference (shared binary fan-out). A topic marked
 * `shared: true` fans out via cohort uWS topics (`topic\0bin` / `topic\0json`) so
 * one publish is two native fan-outs instead of a per-connection walk; the cohort
 * subscriptions are kept OUT of WS_SUBSCRIPTIONS (they are a transport detail, not
 * logical topics, and would otherwise double-count the cap accountant and leak into
 * the close hook's `subscriptions`). This slot tracks exactly the topics whose
 * server-wide wire-id ref must be released when the connection leaves the topic or
 * closes - the JSON cohort holds no ref, so only binary-cohort membership is here.
 * Allocated lazily on the first binary-cohort join; absent for every connection that
 * never joins a shared topic's binary cohort.
 */
export const WS_SHARED_COHORTS = Symbol.for('adapter-uws.ws.shared-cohorts');

/**
 * Per-connection send-gate state for connections that have opted into
 * internal flow control (by advertising the matching capability token):
 * `{ gate, saturation }`. `gate` is the state machine from
 * `createLeaseState`; `saturation` is the connection's latest 0..1 reading
 * the 1 Hz sampler folds into the worker pressure snapshot. Allocated lazily,
 * only when a connection advertises the capability - a connection that never
 * advertises it never gets this slot and runs exactly the immediate send path.
 */
export const WS_LEASE = Symbol.for('adapter-uws.ws.lease');
