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

import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from './caps.js';
// Cyclic with subscribe-policy.js, which imports isPluginOwnedTopic from here.
// Safe and deliberate: neither module touches the other's bindings at module
// eval, only inside function bodies, so the live bindings are resolved by the
// time either can run. The alternative is the plugin subscribe lane keeping its
// own copy of the cap decision, which is the divergence this seam exists to end.
import { exceedsSubscriptionCap } from './subscribe-policy.js';

export const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');

/**
 * Per-connection `Map<topic, { epoch: number, inflight: number }>` tracking
 * subscribes currently IN FLIGHT: a wire `subscribe` frame parked in its
 * (possibly async) authorization-hook await, or a `platform.subscribe` in the
 * same window. A revocation (`platform.unsubscribe`) landing mid-await cannot
 * remove a subscription that does not exist yet, so it bumps the topic's
 * REVOCATION EPOCH instead; a landing whose captured epoch no longer matches
 * discards its grant rather than subscribing (revocation TOCTOU).
 *
 * A monotonic epoch rather than a plain tombstone flag, because a flag has one
 * slot per topic and a client can send the same `subscribe` frame twice: with
 * a flag, the second frame's arrival RE-ARMS the marker, so the first
 * (already-revoked) subscribe lands to find itself apparently un-revoked and
 * installs the grant, while the second is denied. The epoch is per-attempt and
 * only ever increases, so neither confusion is possible.
 *
 * Lives on userData, so a closed connection's entries are GC'd with it - no
 * close-path cleanup. Allocated lazily, and an entry is dropped once its last
 * in-flight attempt settles, so it holds nothing for an idle connection.
 */
export const WS_PENDING_SUBSCRIBES = Symbol.for('adapter-uws.ws.pending-subscribes');

/**
 * Open an in-flight subscribe for `topic`, returning the token the landing
 * must present to {@link settlePendingSubscribe}. The token is the topic's
 * current revocation epoch.
 *
 * `held` seeds the entry's authority flag: a topic ALREADY held when the
 * first attempt enrols is backed by a completed authorized path, so a later
 * denial must answer the frame without evicting it. Only the FIRST enrolment
 * seeds it - a topic that became held after the entry opened was installed
 * inside the await window (a plugin join from a hook), which is precisely the
 * membership {@link settleDeniedSubscribe} exists to unwind, so a later
 * attempt arriving while that is standing must not mistake it for authority.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {boolean} [held] - whether the connection already holds `topic`
 * @returns {number} token to hand back on landing
 */
export function beginPendingSubscribe(ud, topic, held = false) {
	let pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) pending = ud[WS_PENDING_SUBSCRIBES] = new Map();
	let entry = pending.get(topic);
	if (!entry) {
		entry = { epoch: 0, inflight: 0, granted: held === true };
		pending.set(topic, entry);
	}
	entry.inflight++;
	return entry.epoch;
}

/**
 * Close the in-flight subscribe opened with `token`. Returns `true` when the
 * grant may be installed, `false` when a revocation landed mid-await and the
 * grant must be discarded.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @param {boolean} [granted] - pass true on a landing that INSTALLS or
 * confirms fresh membership: it records this attempt as post-revocation
 * authority, so a revoked sibling landing afterwards still reads the grant
 * as current (see {@link settleHeldSubscribe})
 * @returns {boolean}
 */
export function settlePendingSubscribe(ud, topic, token, granted = false) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return false;
	const entry = pending.get(topic);
	if (!entry) return false;
	if (granted && entry.epoch === token) entry.granted = true;
	if (--entry.inflight <= 0) pending.delete(topic);
	return entry.epoch === token;
}

/**
 * Settle an in-flight subscribe whose landing found the topic ALREADY held,
 * answering whether the held membership may be acked.
 *
 * The plain settle cannot answer this branch: it reports only 'was this
 * attempt revoked', but a held membership has a provenance the landing must
 * respect. platform.unsubscribe removes the membership when it tombstones,
 * so a topic held at the landing was installed DURING the await window, by
 * one of two authors:
 *
 * - a fresh post-revoke attempt (a wire/batch subscribe or a
 *   platform.subscribe) whose own authorization completed - current
 *   authority. That attempt marks the topic granted on its way out (the
 *   'granted' flag on the entry, reset by every tombstone), and this
 *   landing must ack; or
 * - the revoked attempt's OWN hook - a plugin join installing tracked
 *   membership in the middle of the authorization the tombstone cancelled.
 *   The tombstone was meant to defeat exactly this, so the membership must
 *   not stand.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @returns {'ack' | 'deny' | 'deny-unwind'}
 *   'ack' - the attempt survived, or a fresh grant was minted after the
 *   revocation; the membership is current authority.
 *   'deny' - the attempt was revoked, but another in-flight attempt still
 *   owns the membership's fate (its own landing re-validates); answer the
 *   denial but leave the membership alone.
 *   'deny-unwind' - the attempt was revoked and no live authority backs
 *   the membership; run the full revocation unwind (derived taps, publish
 *   grant, membership, the app's unsubscribe hook - platform.unsubscribe
 *   does all of it) before answering the denial.
 */
export function settleHeldSubscribe(ud, topic, token) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	const entry = pending?.get(topic);
	// Unreachable from a lane that enrolled: the entry lives until the last
	// in-flight attempt settles, and this settle is such an attempt. Held
	// membership with no record is current authority, not a revocation.
	if (!entry) return 'ack';
	if (entry.epoch === token) {
		// A live attempt confirmed this membership; record it so a revoked
		// sibling landing afterwards still reads it as current authority.
		entry.granted = true;
		if (--entry.inflight <= 0) pending.delete(topic);
		return 'ack';
	}
	const granted = entry.granted === true;
	const last = entry.inflight <= 1;
	if (--entry.inflight <= 0) pending.delete(topic);
	if (granted) return 'ack';
	return last ? 'deny-unwind' : 'deny';
}

/**
 * Settle an in-flight subscribe whose own authorization DENIED it, answering
 * whether a membership the connection currently holds must be unwound.
 *
 * The denial exit needs its own reading for the same reason the held-ack branch
 * does, and missing it left the tombstone defeatable. {@link settleHeldSubscribe}
 * defers to a sibling attempt ('deny' rather than 'deny-unwind') on the grounds
 * that the sibling's landing re-validates the membership - which is true only of
 * the sibling's SUCCESS path. A sibling whose hook denies returns from here, and
 * if this exit settles blindly, the LAST attempt leaves the tree: a membership
 * installed mid-window by a revoked attempt's own hook stands with every attempt
 * answered with a denial and nothing left in flight to judge it.
 *
 * Unlike the held-ack branch this never acks and never marks the entry granted -
 * a denied attempt is not authority for anything. The reading is 'does any live
 * authority back this membership', NOT 'was I revoked': the attempt whose hook
 * denies is typically a FRESH post-revocation attempt, so its own token still
 * matches the current epoch while the membership standing was installed by the
 * revoked one. Testing the epoch here would answer 'not revoked' and leave that
 * membership behind with every frame answered by a denial.
 *
 * A topic the connection already held when the first attempt enrolled carries
 * that authority on the entry (see {@link beginPendingSubscribe}), so an app
 * hook denying a re-subscribe answers the frame without evicting the standing
 * subscription.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @param {boolean} held - whether the connection currently holds the topic;
 * `false` short-circuits to 'deny' (nothing exists to unwind)
 * @returns {'deny' | 'deny-unwind'}
 *   'deny' - answer the denial and leave membership alone: either nothing is
 *   held, live authority backs the membership, or another attempt is still in
 *   flight to judge it.
 *   'deny-unwind' - the membership is held, this is the last attempt to leave,
 *   and no live authority backs it; unwind before answering the denial.
 */
export function settleDeniedSubscribe(ud, topic, token, held) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	const entry = pending?.get(topic);
	if (!entry) return 'deny';
	const granted = entry.granted === true;
	const last = entry.inflight <= 1;
	if (--entry.inflight <= 0) pending.delete(topic);
	if (!held || granted || !last) return 'deny';
	return 'deny-unwind';
}

/**
 * Undo a membership a REVOKED subscribe attempt installed from its own hook -
 * the 'deny-unwind' half of {@link settleHeldSubscribe} and
 * {@link settleDeniedSubscribe}.
 *
 * NOT platform.unsubscribe, on purpose. A membership installed mid-window via
 * trackedSubscribe was never counted in the runtime's totalSubscriptions
 * (only wire landings count their own installs), and platform.unsubscribe
 * decrements unconditionally - so unwinding through it drove the counter
 * negative on the very first revoked group join (caught by the
 * subs.total-negative invariant in the built-runtime suite). The removal here
 * is counter-neutral for exactly that reason.
 *
 * Covers everything the revoked attempt could have installed: derived
 * observer taps first (mirroring platform.unsubscribe's order), then the
 * base membership with its publish grant and cohort. What it deliberately
 * does NOT do is run the app's unsubscribe hook: the caller does that with
 * its own surface's hook reference, because plugin state (a group roster)
 * only unwinds through it.
 *
 * @param {any} ws
 * @param {string} topic
 */
export function unwindRevokedMembership(ws, topic) {
	releaseDerivedSubscriptions(ws, topic);
	trackedUnsubscribe(ws, topic);
}

/**
 * Whether the in-flight subscribe opened with `token` has been cancelled by a
 * revocation - WITHOUT closing it.
 *
 * {@link settlePendingSubscribe} both answers and closes, which is what the
 * landing wants. A lane that runs BETWEEN the hook await and the landing needs
 * the same answer while leaving the in-flight entry open for the landing to
 * settle: the batch resume/recover call is such a lane, and it hands the app's
 * resume hook a topic's replay history, so acting on a grant that has already
 * been revoked serves message history the connection is no longer entitled to.
 *
 * Absent state answers "cancelled", matching what `settlePendingSubscribe`
 * would have returned for it - unknown is not permission.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @returns {boolean}
 */
export function isPendingSubscribeCancelled(ud, topic, token) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return true;
	const entry = pending.get(topic);
	if (!entry) return true;
	return entry.epoch !== token;
}

/**
 * Platform slot carrying the surface's app unsubscribe-hook runner, for the
 * one deny-unwind exit that lives OUTSIDE the surfaces: the observer lane in
 * {@link authorizeDerivedSubscribe}. The wire and platform lanes follow
 * {@link unwindRevokedMembership} with the app's unsubscribe hook through
 * their own module-scoped hook reference; this module has no such reference
 * (importing one would be a cycle, and the hook container is surface state).
 * Each surface assigns the runner on its BASE platform object, so the
 * per-connection clone stamped into `ud[WS_PLATFORM]` reaches it through the
 * prototype chain. A slot per platform rather than per process, because the
 * in-process test surface hosts several servers in one process - a global
 * slot would run server A's unsubscribe hook for server B's connections.
 *
 * Signature: `(ws, topic, ud)`. `ud` is the caller's already-captured
 * userData, so the runner never re-enters `ws.getUserData()` on a handle
 * that may have been freed during the authorization await.
 */
export const WS_REVOKED_UNSUBSCRIBE = Symbol.for('adapter-uws.platform.revoked-unsubscribe');

/**
 * Run an observer lane's authorization await under the SAME revocation guard
 * the wire-subscribe path uses, and report whether the tap may be installed.
 *
 * An observer lane (a cursor snapshot handshake, a presence sync) authorizes
 * against the REAL topic and then subscribes the socket to a derived one
 * (`__cursor:{topic}`). Awaiting in between opens the identical window the
 * wire path closes with a tombstone - but a revocation can only cancel an
 * in-flight subscribe it can SEE, and `tombstonePendingSubscribe` bumps the
 * epoch only while `inflight > 0`. A lane that awaited without enrolling was
 * therefore invisible to revocation: `platform.unsubscribe` returned, released
 * the derived taps, and the parked lane then re-installed one afterwards. The
 * revoked client kept receiving the topic's fan-out, and for cursor kept
 * publishing into it, because that lane authorizes an outgoing frame by asking
 * whether the socket still holds the tap.
 *
 * Enrolling on the BASE topic is what makes this work: that is the name
 * `platform.unsubscribe` tombstones, not the derived one.
 *
 * This lane is an enroller like the surface lanes, so it carries the same
 * provenance obligations. The enrolment seeds the entry's authority from the
 * CURRENT membership - a topic already held when this call CREATES the entry
 * is backed by a completed authorized path, and a later denial (this lane's
 * or a wire sibling's) must answer without evicting it; enrolling without the
 * seed minted an authority-less entry for a legitimately held topic, and the
 * next denied re-subscribe unwound a membership nobody had revoked. And the
 * denial exit reads {@link settleDeniedSubscribe} like every surface lane's:
 * the `authorize` callback runs the app's subscribe-hook chain, which may
 * have installed tracked membership before refusing - settling blindly here
 * left that membership standing, the observer request answered "not allowed"
 * with the socket still subscribed to the base topic. The ALLOW exit reads
 * {@link settleHeldSubscribe} when the topic is held at its landing, for the
 * mirror-image escape: a revoked-mid-await observer still refuses its tap,
 * but it can be the last attempt left to judge a membership a revoked wire
 * sibling installed and deferred - current authority acks the tap, anything
 * else is unwound with the membership.
 *
 * @param {any} ws
 * @param {string} topic - the REAL topic, the one authorization is about
 * @param {() => Promise<any>} authorize - resolves to a denial, or falsy to
 * allow. Must consult the app's authorization chain (both bundled callers
 * pass `platform.checkSubscribe` with `requireGrant`): a completed allow for
 * a held topic marks its membership as live authority for sibling landings,
 * which is only sound when the allow really is the app's decision.
 * @returns {Promise<boolean>} true when the caller may install its tap
 */
export async function authorizeDerivedSubscribe(ws, topic, authorize) {
	let ud;
	try { ud = ws.getUserData(); } catch { return false; }
	const subs = ud[WS_SUBSCRIPTIONS];
	const token = beginPendingSubscribe(ud, topic, subs instanceof Set && subs.has(topic));
	let denied = true;
	try {
		denied = Boolean(await authorize());
	} catch {
		denied = true;
	}
	if (denied) {
		if (settleDeniedSubscribe(ud, topic, token, subs instanceof Set && subs.has(topic)) === 'deny-unwind') {
			unwindRevokedMembership(ws, topic);
			ud[WS_PLATFORM]?.[WS_REVOKED_UNSUBSCRIBE]?.(ws, topic, ud);
		}
		return false;
	}
	// Allow path. A topic HELD at this landing closes the enrolment through
	// the held-provenance read instead of the plain settle, for the same
	// reason the surface lanes' held branches do: the plain settle answers
	// only 'was this attempt revoked', and a revoked answer must still decide
	// what happens to the standing membership. settleHeldSubscribe's 'deny'
	// deferral hands that decision to the LAST in-flight attempt - which can
	// be this lane, when a revoked wire sibling's hook installed the
	// membership and its landing deferred here. Settling plain at this exit
	// refused the tap and walked away: revocation honored on paper, socket
	// still subscribed to the base topic until disconnect. An 'ack' means
	// current authority backs the membership (it predates every attempt, or
	// a re-grant landed after the revocation), so the tap may install.
	if (subs instanceof Set && subs.has(topic)) {
		const verdict = settleHeldSubscribe(ud, topic, token);
		if (verdict === 'ack') return true;
		if (verdict === 'deny-unwind') {
			unwindRevokedMembership(ws, topic);
			ud[WS_PLATFORM]?.[WS_REVOKED_UNSUBSCRIBE]?.(ws, topic, ud);
		}
		return false;
	}
	// settlePendingSubscribe closes the enrolment AND reports whether this
	// subscribe survived: false means a revocation bumped the epoch while the
	// authorization was parked.
	return settlePendingSubscribe(ud, topic, token);
}

/**
 * Whether an observer-lane gate (`platform.checkSubscribe` with
 * `requireGrant`) must refuse `topic` before the app's hook chain is even
 * consulted, under the pure-grant model.
 *
 * A pure function of the four inputs so it can be tested directly - the
 * modules that hold those inputs are built against rollup-injected globals
 * and cannot be imported in a unit run.
 *
 * The `hasUserHook` term mirrors the wire-level gate exactly. An app that
 * exports its own `subscribe` / `subscribeBatch` hook is documented as
 * deciding every topic itself, so hard-denying before that hook runs would
 * silently break the presence / cursor snapshot lanes for precisely the apps
 * that took control of authorization.
 *
 * @param {boolean} armed - `subscribeAuth.enabled`
 * @param {boolean} hasUserHook - app exports a subscribe / subscribeBatch hook
 * @param {unknown} grants - the connection's WS_SUBSCRIPTIONS slot
 * @param {string} topic
 * @returns {boolean} true when the gate must deny
 */
export function deniesUngrantedObserve(armed, hasUserHook, grants, topic) {
	if (!armed || hasUserHook) return false;
	// NO plugin-owned exemption here, deliberately. This predicate answers for
	// two lanes that have no second line of defence: the observer gate and the
	// client-named RESUME filter, where the filter IS the gate. Exempting a
	// plugin-owned prefix here therefore served `__group:private-lobby`'s
	// buffered history to any client that simply named it in a resume frame -
	// refused on the live-subscribe path and served on the message-history path,
	// same server, same connection, same topic.
	//
	// The wire-subscribe pre-gate keeps its carve-out because it is the only
	// lane with a landing re-check behind it: it exempts the topic just long
	// enough for the plugin's hook to run, then re-tests real membership before
	// the subscription stands. Nothing is lost here, because a client the plugin
	// legitimately admitted is IN the subscription registry by then, so the
	// grant test below passes on its own.
	return !(grants instanceof Set) || !grants.has(topic);
}

/**
 * Revocation side of {@link beginPendingSubscribe}: bump `topic`'s revocation
 * epoch so every subscribe currently in flight for it discards its grant on
 * landing. Returns `true` when at least one in-flight subscribe was actually
 * cancelled - the truthful "a subscription was removed" answer for a revoke
 * that raced the grant.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @returns {boolean}
 */
export function tombstonePendingSubscribe(ud, topic) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return false;
	const entry = pending.get(topic);
	if (!entry || entry.inflight <= 0) return false;
	entry.epoch++;
	// A tombstone invalidates every grant recorded before it: only an
	// attempt that completes AFTER this revocation re-marks the entry.
	entry.granted = false;
	return true;
}

// The connection's client-publish binding: the single topic this connection is
// authorized to publish to via the client-driven `game` lane (the dual of the
// cached subscribe set above). Absent (undefined) until a trusted server-side
// `platform.grantPublish(ws, topic)` binds it; cleared by `revokePublish`. A
// client `game` frame carries NO topic and publishes to this binding, so a
// client can never publish to a room it was not granted. Single-valued (one
// session per connection), mirroring the native daemon's per-socket grant.
export const WS_PUBLISH_GRANT = Symbol.for('adapter-uws.ws.publish-grant');

// Shared-fan-out cohort hooks. trackedSubscribe/Unsubscribe live in utils (the
// low-level membership primitive), but a subscribe to an already-shared topic must
// also join the matching cohort (and an unsubscribe must leave it + release the
// wire-id ref), or a plugin that establishes membership server-side silently misses
// every cohort-split publish. To avoid a utils -> handler import cycle, the handler
// installs the join/leave behavior here at boot via setCohortHooks; when unset (no
// shared codec in play, or the in-process test mirror which drives cohorts through
// its own per-server paths) the tracked* helpers behave exactly as before.
// Held under a `Symbol.for` key on globalThis rather than module bindings, for
// the reason spelled out for the derived-prefix registry below: the bundler
// gives a plugin package and the runtime SEPARATE instances of this module, so
// the handler installs into one pair of bindings while the copy a plugin's
// trackedSubscribe reads stays permanently null - and Rollup, seeing a `let`
// that is never assigned in that copy, tree-shakes the call away entirely. A
// slot on globalThis is one slot however many copies of the module exist.
const COHORT_HOOKS = Symbol.for('adapter-uws.cohort-hooks');

/**
 * @returns {{ join: ((ws: any, ud: any, topic: string) => void) | null, leave: ((ws: any, ud: any, topic: string) => void) | null }}
 */
function cohortHooks() {
	let hooks = /** @type {any} */ (globalThis)[COHORT_HOOKS];
	if (!hooks) {
		hooks = { join: null, leave: null };
		/** @type {any} */ (globalThis)[COHORT_HOOKS] = hooks;
	}
	return hooks;
}

/**
 * Install the shared-fan-out cohort join/leave behavior for trackedSubscribe /
 * trackedUnsubscribe. Idempotent (last install wins); pass nulls to clear.
 * @param {((ws: any, ud: any, topic: string) => void) | null} onJoin
 * @param {((ws: any, ud: any, topic: string) => void) | null} onLeave
 */
export function setCohortHooks(onJoin, onLeave) {
	const hooks = cohortHooks();
	hooks.join = onJoin || null;
	hooks.leave = onLeave || null;
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
 * Returns false when the socket is already closed (uWS throws on access),
 * or when the connection's subscription registry is already at
 * `MAX_SUBSCRIPTIONS_PER_CONNECTION` for a new topic - the same cap the
 * wire-level and `platform.subscribe` paths enforce, so a plugin lane
 * (a snapshot handshake, a presence join) cannot grow a connection past
 * it. An already-present topic stays idempotent: no growth, no refusal.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean}
 */
export function trackedSubscribe(ws, topic) {
	let ud;
	try { ud = ws.getUserData(); } catch { return false; }
	const subs = ud[WS_SUBSCRIPTIONS];
	if (subs instanceof Set && exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return false;
	try { ws.subscribe(topic); } catch { return false; }
	try {
		if (subs) subs.add(topic);
		// Join the shared fan-out cohort if the topic is already shared.
		const _join = cohortHooks().join;
		if (_join) _join(ws, ud, topic);
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
	// Tombstone any in-flight subscribe for this topic FIRST, exactly as
	// platform.unsubscribe does. A plugin leave / evict path is a revocation
	// too: a subscribe still parked in its authorization await would otherwise
	// land afterwards and re-install the membership this call just removed,
	// leaving the socket subscribed to a topic it was evicted from. A no-op
	// (returning false) when nothing is in flight, which is the ordinary case.
	try { tombstonePendingSubscribe(ws.getUserData(), topic); }
	catch { /* socket already closed - nothing in flight to cancel */ }
	try { ws.unsubscribe(topic); } catch { ok = false; }
	try {
		const ud = ws.getUserData();
		const subs = ud[WS_SUBSCRIPTIONS];
		if (subs) subs.delete(topic);
		// Withdraw WRITE access with read access, as platform.unsubscribe does.
		// The client-driven `game` lane carries no topic and publishes to
		// whatever binding it holds, so a plugin evict that took the
		// subscription away otherwise left the sender still bound to the room
		// and still publishing into it - silently, to everyone who remained.
		if (ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
		// Leave the shared fan-out cohort (drop both cohort subs + release the wire-id
		// ref) if the topic is shared, so the socket stops receiving cohort publishes.
		const _leave = cohortHooks().leave;
		if (_leave) _leave(ws, ud, topic);
	} catch { /* socket died; close cleanup owns the registry */ }
	return ok;
}

/**
 * Topic prefixes under which a plugin establishes a DERIVED subscription on a
 * connection's behalf: presence's `__presence:<topic>` roster tap and cursor's
 * `__cursor:<topic>` position tap.
 *
 * Revoking a topic has to release these too. Both plugins deliberately keep the
 * tap alive across a participant leave (an observer's roster would otherwise
 * freeze) and release it only on socket close, so a `platform.unsubscribe` for
 * a kick, ban or lease expiry removed the grant while the client kept receiving
 * the full roster and every peer's cursor position on the tap channel - and
 * kept publishing, since the cursor lane authorizes a publish by asking whether
 * the socket is subscribed to the tap. That is precisely the access the
 * revocation was meant to withdraw.
 *
 * A prefix registry rather than a callback registry: prefixes are idempotent to
 * register and hold no reference to a tracker instance, so repeated plugin
 * construction (every test that builds one) cannot accumulate stale closures.
 * The plugins cannot be imported from here - they import the runtime - so each
 * registers its own prefix, the same way the cohort hooks are installed.
 *
 * Held on `globalThis` under a `Symbol.for` key rather than in a module-level
 * binding, because the bundler can and does give the plugin package and the
 * runtime SEPARATE instances of this module. With a plain module binding the
 * plugin registered its prefix into one Set while platform.unsubscribe read a
 * different, empty one - so the release silently did nothing in a real build
 * while passing in-process. Same reason the WS_* slot keys below are
 * `Symbol.for` rather than local symbols.
 *
 * @type {Set<string>}
 */
const DERIVED_PREFIXES_KEY = Symbol.for('adapter-uws.derived-topic-prefixes');
const _derivedTopicPrefixes = globalThis[DERIVED_PREFIXES_KEY]
	?? (globalThis[DERIVED_PREFIXES_KEY] = new Set());

/**
 * Topic prefixes a PLUGIN owns and decides for itself.
 *
 * The server-grant gate refuses any topic the server did not pre-authorize,
 * which is right for application topics and wrong for a plugin's own channel: a
 * group is joined by the client subscribing to `__group:<name>`, and the only
 * thing that ever authorizes that is the group's own subscribe hook - which the
 * gate would refuse before ever running. Marking that hook a side effect (so it
 * stops disarming the gate for every OTHER topic) therefore left the group
 * permanently unjoinable, trading a security hole for a broken plugin.
 *
 * Declaring the prefix says: the gate does not decide this one, the plugin's
 * hook does. That is not a hole - the hook still runs and its `false` still
 * refuses (a full or closed group is still refused) - it is the plugin taking
 * responsibility for its own namespace, scoped to that namespace instead of to
 * the whole connection. The system-topic guard consults the same registry, so
 * a registered namespace can reach its hook without the broad
 * `allowSystemTopicSubscribe` opt-out. That is safe because both the subscribe
 * landing and recover lane require the hook to have established tracked
 * membership; an unhandled topic under the prefix is still refused.
 *
 * Same globalThis + `Symbol.for` storage as the derived prefixes above, for the
 * same bundler-duplication reason.
 *
 * @type {Set<string>}
 */
const OWNED_PREFIXES_KEY = Symbol.for('adapter-uws.plugin-owned-topic-prefixes');
const _pluginOwnedPrefixes = globalThis[OWNED_PREFIXES_KEY]
	?? (globalThis[OWNED_PREFIXES_KEY] = new Set());

/**
 * Longest a plugin-owned prefix may be, and the shortest namespace that counts.
 *
 * `__x:` is the minimum: two underscores, at least one namespace character, and
 * the `:` terminator.
 */
const MIN_OWNED_PREFIX_LENGTH = 4;
const MAX_OWNED_PREFIX_LENGTH = 64;

/**
 * Declare that topics under `prefix` are decided by a plugin's own subscribe
 * hook rather than by the server-grant gate. Idempotent.
 *
 * VALIDATED, because this is a scoped deferral in both wire gates and an
 * unenforced comment is not a control. A prefix must be `__`-namespaced and
 * `:`-terminated, which confines it to the reserved system-topic namespace
 * and stops it from swallowing more than its own: `''` and `'__'` would have
 * made every internal topic plugin-owned, and an ordinary prefix like `'room:'`
 * would have handed the exemption to a whole class of APP topics - a client
 * refused by the gate still landing on the roster of a private room, holding a
 * live observer tap, because a plugin claimed the namespace.
 *
 * Throws rather than returning false: a plugin calls this at import time with a
 * literal, so a bad prefix is a programming error that must be loud, not a
 * silently inert registration that leaves the plugin believing it is exempt.
 *
 * THE CONTRACT a registering plugin must keep: its subscribe hook has to
 * SUBSCRIBE the socket (via `trackedSubscribe`) for the topics it admits. The
 * exemption only stands the pre-gate aside so the hook can run; the landing
 * re-check then re-tests real membership, and a hook that authorized without
 * subscribing is refused there. That re-check deliberately carries NO
 * plugin-owned allowance of its own - it requires membership in every posture.
 * The recover lane makes the same check before serving history, and the
 * observer/resume gates carry no namespace deferral at all. Refusing a hook
 * that does not subscribe is the safe end of that trade.
 *
 * @param {string} prefix
 * @returns {void}
 */
export function registerPluginOwnedPrefix(prefix) {
	if (typeof prefix !== 'string') {
		throw new TypeError(`registerPluginOwnedPrefix: prefix must be a string, got ${typeof prefix}`);
	}
	if (prefix.length < MIN_OWNED_PREFIX_LENGTH || prefix.length > MAX_OWNED_PREFIX_LENGTH) {
		throw new Error(
			`registerPluginOwnedPrefix: "${prefix}" must be ${MIN_OWNED_PREFIX_LENGTH}-${MAX_OWNED_PREFIX_LENGTH} characters`
		);
	}
	if (!prefix.startsWith('__') || !prefix.endsWith(':')) {
		throw new Error(
			`registerPluginOwnedPrefix: "${prefix}" must start with "__" and end with ":" - ` +
			'the exemption is only safe inside the system-topic namespace the wire gate already refuses'
		);
	}
	// The namespace between `__` and `:` carries the plugin's name, so it must
	// be a plain identifier. Anything else is either a second namespace or an
	// attempt to widen the claim.
	const namespace = prefix.slice(2, -1);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) {
		throw new Error(
			`registerPluginOwnedPrefix: "${prefix}" namespace must match [A-Za-z][A-Za-z0-9_-]*`
		);
	}
	// No overlap check is needed, and that is a property of the format rather
	// than an omission: every accepted prefix is `__<namespace>:` where the
	// namespace itself contains no `:`, so two DISTINCT valid prefixes can never
	// be prefixes of one another - `__gro:` and `__group:` diverge at the
	// terminator. One plugin therefore cannot claim another's topics without
	// registering its exact string, which is the idempotent case.
	_pluginOwnedPrefixes.add(prefix);
}

/**
 * Whether `topic` belongs to a plugin that decides its own subscribes.
 *
 * @param {string} topic
 * @returns {boolean}
 */
export function isPluginOwnedTopic(topic) {
	if (_pluginOwnedPrefixes.size === 0 || typeof topic !== 'string') return false;
	for (const prefix of _pluginOwnedPrefixes) {
		if (topic.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Declare that `prefix` + a topic name is a derived subscription which must be
 * released when that topic is revoked. Idempotent.
 *
 * @param {string} prefix
 * @returns {void}
 */
export function registerDerivedTopicPrefix(prefix) {
	if (typeof prefix === 'string' && prefix.length > 0) _derivedTopicPrefixes.add(prefix);
}

/**
 * Drop every derived subscription this connection holds for `topic`. No-op when
 * no plugin registered a prefix, which is the default deployment.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {void}
 */
export function releaseDerivedSubscriptions(ws, topic) {
	if (_derivedTopicPrefixes.size === 0) return;
	for (const prefix of _derivedTopicPrefixes) {
		// Skip a topic that IS the derived one, so revoking `__cursor:room`
		// directly cannot recurse into `__cursor:__cursor:room`.
		if (topic.startsWith(prefix)) continue;
		trackedUnsubscribe(ws, prefix + topic);
	}
}

/**
 * Marks a `subscribe` / `subscribeBatch` hook as a SIDE EFFECT rather than an
 * authorization decision.
 *
 * The server-grant gate steps aside whenever the app exports a subscribe hook,
 * on the documented reasoning that an app which took over the topic decision
 * owns it. A PLUGIN hook is not that. Presence's subscribe joins a roster and
 * returns undefined on every path, so it never denies anything - yet exporting
 * it, which is the documented wiring (`export const { subscribe, ... } =
 * presence.hooks`), satisfied the same test and disarmed the very gate the
 * plugin's own observer lane relies on. The result was that arming the gate and
 * following the presence README gave no enforcement at all.
 *
 * A marked hook still RUNS, exactly as before; it just does not count as the app
 * taking over authorization. An app that WRAPS a plugin hook in its own function
 * is deliberately not marked - the wrapper is app code that may decide, so the
 * gate steps aside as documented.
 */
export const WS_HOOK_SIDE_EFFECT_ONLY = Symbol.for('adapter-uws.hook.side-effect-only');

/**
 * Whether `fn` is a hook that can make an authorization DECISION, as opposed to
 * a plugin side effect that merely observes the subscribe.
 *
 * @param {unknown} fn
 * @returns {boolean}
 */
export function isAuthorizationHook(fn) {
	return typeof fn === 'function' && /** @type {any} */ (fn)[WS_HOOK_SIDE_EFFECT_ONLY] !== true;
}

/**
 * Mark every named hook on `hooks` as a side effect rather than a decision.
 * Used by the plugins on their own exported subscribe hooks.
 *
 * @param {Record<string, any>} hooks
 * @param {string[]} names
 * @returns {Record<string, any>} the same object, for chaining
 */
export function markSideEffectHooks(hooks, names) {
	for (const name of names) {
		if (typeof hooks?.[name] === 'function') hooks[name][WS_HOOK_SIDE_EFFECT_ONLY] = true;
	}
	return hooks;
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
 * Per-connection inbound binary-ingress bindings for `0x03` client->server
 * frames: `Map<ingressId, { kind, target, decode, route, state }>`. A client
 * that advertised `wire.ingress:1` announces `id -> destination` bindings via
 * `{type:'ingress-bind'}` control frames; each populates one entry here so an
 * inbound `0x03` ingress frame's numeric id resolves to the registered decoder
 * and route. Separate from `WS_TOPIC_IDS` (the egress s->c id space) so the two
 * directions never collide and neither needs a numeric partition. Allocated
 * lazily on the first successful bind; absent for every connection that never
 * opts into ingress. Per-connection and reset on reconnect (fresh userData), so
 * the client re-announces from a fresh id space, exactly like the egress reset.
 */
export const WS_INGRESS_BINDINGS = Symbol.for('adapter-uws.ws.ingress-bindings');

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
