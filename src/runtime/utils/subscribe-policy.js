/**
 * The subscribe decisions, as pure functions of explicit inputs.
 *
 * WHY THIS MODULE EXISTS. `src/runtime/handler.js` (production),
 * `src/testing.js` (the published `svelte-adapter-uws/testing` server) and
 * `src/vite.js` (the dev server) each drive their own socket plumbing, and each
 * used to re-implement the same authorization decisions inline. Nothing
 * enforced that the three agreed, and they repeatedly did not: the same
 * decision appeared as `isNew` in one file and `!subs.has(topic)` in another,
 * the plugin-owned carve-out reached the batch path on all three surfaces and
 * the single path on one, the recover guard reached two of three, and the
 * gap-fill fall-through reached one. No test caught any of them, because a
 * hand-copied mirror has no oracle: three surfaces agreeing with each other is
 * not something a suite can check when nothing states what they should agree on.
 *
 * The seam is DECISIONS, not plumbing. A decision here is a pure function of
 * named inputs: no socket, no userData, no I/O, nothing to mock. Each surface
 * still owns its own effects - it reads its own state, sends its own frames -
 * but it may not invent its own answer. That makes the three surfaces provably
 * agree on the part that matters, and it is what `test/subscribe-policy.test.js`
 * and `test/surface-policy-parity.test.js` pin.
 *
 * Adding a decision here is cheap; re-deriving one inline in a surface is the
 * defect this module exists to make impossible.
 */

import { isPluginOwnedTopic } from './ws-symbols.js';

/**
 * Whether the wire-level system-topic guard must refuse `topic`.
 *
 * Registered plugin namespaces are the one narrow exception to the default
 * `__` block. They have to reach their own subscribe hook in order to establish
 * membership; {@link deniesWireSubscribeLanding} then requires that membership
 * even when the global grant gate is off or an app hook is present. This is
 * deliberately a policy decision shared by every socket surface, not another
 * inline prefix check for the mirrors to drift on.
 *
 * @param {object} input
 * @param {boolean} input.allowSystem - the broad system-topic opt-out is enabled
 * @param {string} input.topic
 * @returns {boolean}
 */
export function deniesWireSystemTopicSubscribe({ allowSystem, topic }) {
	if (allowSystem || typeof topic !== 'string') return false;
	if (topic.charCodeAt(0) !== 95 || topic.charCodeAt(1) !== 95) return false;
	return !isPluginOwnedTopic(topic);
}

/**
 * Whether a wire `subscribe` must be refused BEFORE the app's hook chain runs.
 *
 * The plugin-owned carve-out lives here and only here. It stands the gate aside
 * so a plugin's own subscribe hook can authorize its namespace, and it is safe
 * only because {@link deniesWireSubscribeLanding} re-tests real membership when
 * that hook lands - a plugin that authorizes without subscribing the socket is
 * refused there. Do not copy this exemption into any lane that has no landing
 * re-check behind it: the observer gate and the client-named resume filter are
 * exactly such lanes, and giving them this carve-out served a private group's
 * buffered history to any client that named it.
 *
 * @param {object} input
 * @param {boolean} input.armed - `authorizeWireSubscribe` is on
 * @param {boolean} input.hasUserHook - the app exports its own subscribe hook
 * @param {boolean} input.held - the connection already holds this topic
 * @param {string} input.topic
 * @returns {boolean} true when the frame must be refused before any hook runs
 */
export function deniesWireSubscribePreHook({ armed, hasUserHook, held, topic }) {
	if (!armed || hasUserHook) return false;
	if (held) return false;
	if (isPluginOwnedTopic(topic)) return false;
	return true;
}

/**
 * Whether a wire `subscribe` must be refused when its authorization LANDS.
 *
 * Deliberately carries no plugin-owned carve-out. This is the second line of
 * defence that makes the pre-hook exemption safe, so exempting a namespace here
 * too would leave the exemption as the entire gate.
 *
 * @param {object} input
 * @param {boolean} input.armed
 * @param {boolean} input.hasUserHook
 * @param {boolean} input.held - the connection holds the topic NOW, after the awaits
 * @param {string} input.topic
 * @returns {boolean}
 */
export function deniesWireSubscribeLanding({ armed, hasUserHook, held, topic }) {
	// A plugin-owned namespace was allowed through the system-topic guard and
	// the pre-hook grant gate solely so its plugin could establish tracked
	// membership. Require that proof in every posture, including the default
	// unarmed gate and an app wrapper that counts as a user hook. Otherwise
	// importing the groups plugin would make every unhandled `__group:*` topic
	// wire-subscribable.
	if (isPluginOwnedTopic(topic)) return !held;
	if (!armed || hasUserHook) return false;
	return !held;
}

/**
 * Whether this frame asked for a gap-fill that the server can actually serve.
 *
 * Load-bearing beyond its size: a socket that turns out to be subscribed while
 * its authorization was parked is NOT caught up, because live membership
 * carries no history. Acking such a frame early left a client believing it had
 * recovered with the tail between its last-seen seq and now missing entirely.
 *
 * @param {object} input
 * @param {unknown} input.hasResumeHook - the app exports a `resume` hook
 * @param {any} input.recover - the frame's `recover` member
 * @returns {boolean}
 */
export function wantsRecover({ hasResumeHook, recover }) {
	return Boolean(hasResumeHook)
		&& Boolean(recover) && typeof recover === 'object'
		&& Number.isInteger(recover.offset) && recover.offset >= 0;
}

/**
 * Whether the recover lane must refuse to serve a topic's replay history.
 *
 * MEMBERSHIP FIRST. The revocation epoch only ever rises, so consulting it
 * alone can never see a revoke followed by a legitimate re-grant inside one
 * await window - the gap-fill was refused forever while the subscription was
 * acked, which is a positive ack with a silently dropped replay. Reading the
 * epoch only when the socket does NOT hold the topic makes the re-grant
 * visible, because a re-grant is exactly what puts the topic back.
 *
 * @param {object} input
 * @param {boolean} input.held - the connection holds the topic now
 * @param {boolean} input.wireAuthz - armed AND no app subscribe hook
 * @param {boolean} input.cancelled - a revocation bumped this subscribe's epoch
 * @param {string} input.topic
 * @returns {boolean} true when the history must NOT be served
 */
export function recoverIsRevoked({ held, wireAuthz, cancelled, topic }) {
	// Production and the test server reach recovery before the landing check.
	// A plugin-owned topic that its hook did not actually join must therefore
	// be stopped here too, or it can receive replay history and only then be
	// denied by the landing.
	return !held && (isPluginOwnedTopic(topic) || wireAuthz || cancelled);
}

/**
 * Whether a per-connection subscription cap refuses this frame.
 *
 * Scoped to a topic the socket does not already hold: the recover fall-through
 * can reach the cap check with the topic already a membership, and refusing
 * there answers RATE_LIMITED to a connection that is not growing at all.
 *
 * @param {object} input
 * @param {boolean} input.held
 * @param {number} input.size - current subscription count
 * @param {number} input.max
 * @returns {boolean}
 */
export function exceedsSubscriptionCap({ held, size, max }) {
	if (held) return false;
	// A missing or non-numeric cap REFUSES. Every comparison against `undefined`
	// is false, so the bare `size >= max` this replaces answered "not at the
	// cap" for a caller that forgot the argument - silently removing the
	// per-connection subscription limit rather than failing. Refusing is loud
	// and survivable; admitting without a bound is neither.
	if (typeof max !== 'number' || Number.isNaN(max)) return true;
	return size >= max;
}

/**
 * Whether the per-connection in-flight authorization cap refuses this
 * subscribe attempt. Counts attempts parked in their hook await - repeated
 * frames for ONE topic stack in-flight work exactly like distinct topics do,
 * so the total is what bounds, not the map's key count. No `held` exemption
 * on purpose: a re-subscribe to a held topic still runs the hook chain, and
 * that concurrent work is the resource this cap bounds.
 *
 * @param {object} input
 * @param {number} input.pending - current in-flight attempt count
 * @param {number} input.max
 * @returns {boolean}
 */
export function exceedsPendingSubscribeCap({ pending, max }) {
	// Fail closed on a missing cap, same reasoning as exceedsSubscriptionCap.
	if (typeof max !== 'number' || Number.isNaN(max)) return true;
	// The count too, unlike the landed cap's `size`: that one reads a Set the
	// callers already guard, while this one reads a userData slot reachable
	// through its published `Symbol.for` key. A non-numeric value would make
	// every comparison false and silently remove the bound.
	if (typeof pending !== 'number' || Number.isNaN(pending)) return true;
	return pending >= max;
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
