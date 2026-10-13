/**
 * Accounted topic membership for code that joins or leaves a connection's
 * topics outside the wire protocol (presence, cursor, group lanes, plugins in
 * other packages). Use these instead of `ws.subscribe` / `ws.unsubscribe` or a
 * hand-written registry update, which leave the worker's subscription
 * accounting behind.
 */

/** The socket shape these helpers take: any connection the adapter handed you. */
export interface SubscribableConnection {
	getUserData(): unknown;
	subscribe(topic: string): unknown;
	unsubscribe(topic: string): unknown;
}

/**
 * Subscribe `ws` to `topic` natively and record it in the connection's
 * subscription registry, charging the worker's accounting once. Idempotent for
 * a topic the connection already holds.
 *
 * This records membership without minting an authorization grant. A denied wire
 * attempt already awaiting its hook can unwind membership installed here. When a
 * server grant must survive that denial, `await platform.subscribe(ws, topic)`:
 * once the application hook allows it, the grant it records survives.
 *
 * @returns false when the socket is already closed, or when the connection is
 *   at the per-connection subscription cap for a new topic; true otherwise.
 */
export function trackedSubscribe(ws: SubscribableConnection, topic: string): boolean;

/**
 * Unsubscribe `ws` from `topic` natively and remove it from the registry,
 * releasing the accounting. Also cancels a subscribe for the same topic still
 * waiting on its authorization hook, so it cannot land afterwards.
 *
 * @returns false when the socket was already closed.
 */
export function trackedUnsubscribe(ws: SubscribableConnection, topic: string): boolean;

/**
 * Release a framework's admitted membership after its loader or setup fails.
 * Removes native and logical membership, registered derived subscriptions,
 * shared-codec cohorts and the topic's publish grant, with accounted cleanup.
 * Independently pending subscribe attempts remain eligible to complete their
 * own authorization. This does not revive an attempt already revoked.
 *
 * This removes the physical membership, not an ownership reference. The caller
 * must coordinate already-completed concurrent admissions and perform its own
 * application cleanup. No application unsubscribe hook runs. For an explicit
 * unsubscribe, kick or revocation that must cancel pending attempts, use
 * `platform.unsubscribe` or `trackedUnsubscribe` instead.
 *
 * @returns true when membership or a publish grant was removed; false when
 *   already released, missing, or closed. Safe to repeat.
 */
export function releaseSubscription(ws: SubscribableConnection, topic: string): boolean;
