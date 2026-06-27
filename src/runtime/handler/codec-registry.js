// Server-side wire-codec registry: capability -> codec. Populated once per
// worker when a plugin's server factory builds its codec (the same place it
// already calls platform.publishWire). Read on the cross-worker relay receive
// path: a relayed wire publish carries only the capability token, so
// the receiving worker re-derives the codec here to re-encode binary against
// its OWN local connection state.
//
// Keyed by `capability` (e.g. 'cursor.protocol:3'), not by topic prefix: the
// capability is the precise, version-specific identity a receiver needs to
// re-encode at the correct schema. (The client keeps its own prefix-keyed
// registry for resolving an inbound frame's topic to a decoder - a different
// concern.)
//
// Zero hot-path cost: registration runs at setup; lookup runs only on the
// relay receive path, never on the local fan-out.

/** @type {Map<string, { capability: string, schemaVersion: number, encode: Function, state?: any }>} */
const byCapability = new Map();

/**
 * Register a wire codec under its capability. Idempotent; the last registration
 * for a capability wins, so an HMR re-init or a re-created plugin factory simply
 * replaces the entry. A codec with no string capability is ignored.
 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
 */
export function registerWireCodec(wire) {
	if (wire && typeof wire.capability === 'string') byCapability.set(wire.capability, wire);
}

/**
 * Look up the codec registered for a capability, or null if none.
 * @param {string} capability
 * @returns {{ capability: string, schemaVersion: number, encode: Function, state?: any } | null}
 */
export function getWireCodec(capability) {
	return (typeof capability === 'string' && byCapability.get(capability)) || null;
}

/** Test seam: clear the registry. @internal */
export function _resetWireCodecRegistry() {
	byCapability.clear();
}
