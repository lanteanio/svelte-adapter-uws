// Accounted topic membership for code that joins or leaves a connection's
// topics outside the wire protocol - a presence join, a cursor snapshot, a
// group lane, a plugin in another package.
//
// Calling `ws.subscribe` directly changes native membership only: it bypasses
// the registry used for per-connection caps and subscriber walks such as
// publishWire. A hand-written registry entry instead raises the auditor's
// membership count without charging the worker counter (`subs.total-mismatch`);
// releasing that entry at close can drive the counter below zero
// (`subs.total-negative`). These are the runtime's own helpers, the ones its
// bundled plugins use: native membership, the registry, the per-connection
// cap, the shared-codec cohort and the
// accounting move together. Every slot they touch is a registered symbol or a
// global hook, so a copy of this module loaded by another package reaches the
// same connection state as the runtime that owns it.

export { trackedSubscribe, trackedUnsubscribe, releaseSubscription } from './runtime/utils/ws-symbols.js';
