/**
 * Client-side CRDT document wire for svelte-adapter-uws.
 *
 * Registers the CRDT binary wire codec as a SINK on the `__crdt:` topic prefix:
 * an inbound `0x03` frame on a CRDT topic is decoded to its opaque
 * `{ op, bytes }` and applied in place, and the framework dispatches NO store
 * event for it (the `sink: true` contract). A sink codec drives its own
 * reactive surface and recovers its own resume position - a CRDT resyncs via a
 * state-vector SYNC_REQUEST rather than seq replay - so the framework does not
 * track per-topic seq for this topic.
 *
 * This unit ships the wire only. The document replica that consumes the bytes
 * (the `live.doc` / `live.map` / `live.array` reactive stores) is a separate
 * concern that subscribes to the frames exposed here via {@link onCrdtFrame}.
 * The bytes stay opaque end to end: this module never interprets an update.
 *
 * Registering at module load means the first `hello` already advertises
 * `crdt.protocol:1`, so the server sends compact `0x03` frames from the start; a
 * connection that imports this module is binary-capable. A client that does NOT
 * import it advertises no CRDT capability and transparently receives the JSON
 * frame instead, with no update lost.
 *
 * @module svelte-adapter-uws/plugins/crdt/client
 */

import { registerWireCodec } from '../../client.js';
import { decodeCrdt, CRDT_CAPABILITY, CRDT_TOPIC_PREFIX } from './codec.js';

const TOPIC_PREFIX = CRDT_TOPIC_PREFIX;

/**
 * Registered frame handlers. Each receives every decoded CRDT frame as the sink
 * applies it. The document replica unit registers here to feed the bytes into a
 * local replica; until then the set is empty and a frame is decoded and dropped
 * (a no-op apply), which is the correct behavior for a client that carries the
 * capability but mounts no document.
 * @type {Set<(frame: { op: string, bytes: Uint8Array, schemaVersion: number, seq: number, topic: string }) => void>}
 */
const frameHandlers = new Set();

/**
 * Subscribe to decoded CRDT frames as they are applied in place. The handler
 * receives `{ op, bytes, schemaVersion, seq, topic }` for each inbound CRDT
 * `0x03` frame, where `op` is `'update' | 'snapshot' | 'sync-request'`, `bytes`
 * is the opaque CRDT blob, and `topic` is the resolved topic name so a handler
 * serving several documents routes the frame to the right replica. A handler
 * that throws is isolated so one bad consumer cannot drop a frame for another.
 *
 * Returns an unsubscribe function.
 *
 * @param {(frame: { op: string, bytes: Uint8Array, schemaVersion: number, seq: number, topic: string }) => void} handler
 * @returns {() => void}
 */
export function onCrdtFrame(handler) {
	if (typeof handler !== 'function') {
		throw new TypeError('onCrdtFrame: handler must be a function');
	}
	frameHandlers.add(handler);
	return () => { frameHandlers.delete(handler); };
}

/**
 * The sink decode. Decodes the frame to `{ op, bytes }`, fans it out to every
 * registered handler (apply-in-place), and returns nothing so the framework
 * dispatches no store event. A decode miss (unknown opcode / schema, truncated
 * frame) yields no handler call and is silently dropped - a CRDT reconciles on
 * the next frame. The frame's `seq` is passed through so a handler that wants to
 * track received order can, without the framework tracking it; the resolved
 * `topic` is passed through so a multi-document handler can route the frame.
 *
 * @param {Uint8Array} payload
 * @param {any} state - unused at the codec layer (the replica holds the state)
 * @param {number} schemaVersion
 * @param {number} seq
 * @param {string} [topic]
 */
function applyCrdtFrame(payload, state, schemaVersion, seq, topic) {
	const decoded = decodeCrdt(payload, state, schemaVersion);
	if (!decoded) return; // decode miss: drop, reconcile on the next frame
	const frame = { op: decoded.data.op, bytes: decoded.data.bytes, schemaVersion, seq, topic: topic || '' };
	for (const handler of frameHandlers) {
		try { handler(frame); } catch { /* one bad consumer must not drop the frame for others */ }
	}
	// Return nothing: the sink contract suppresses the store dispatch.
}

// Opt this connection into binary CRDT frames: advertise `crdt.protocol:1` in
// the `hello` frame and route inbound `0x03` frames on `__crdt:` topics through
// the sink decode above. Registered at module load so the first `hello` already
// carries the capability. The codec is stateless at the wire layer; the
// document replica that applies the bytes holds all the state.
registerWireCodec(TOPIC_PREFIX, {
	capability: CRDT_CAPABILITY,
	capabilities: [CRDT_CAPABILITY],
	sink: true,
	decode: applyCrdtFrame
});

export { TOPIC_PREFIX as CRDT_TOPIC_PREFIX };
