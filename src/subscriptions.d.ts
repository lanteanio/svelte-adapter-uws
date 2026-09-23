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
