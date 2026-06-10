/** The known CRDT wire opcodes (the stable public `op` surface). */
export type CrdtOp = 'update' | 'snapshot' | 'sync-request';

/** A decoded CRDT frame as the sink applies it in place. */
export interface CrdtFrame {
	/** Which kind of frame this is. */
	op: CrdtOp;
	/** The opaque CRDT update / snapshot / state-vector bytes. */
	bytes: Uint8Array;
	/** The frame's 1-byte schema version. */
	schemaVersion: number;
	/** The frame's per-topic seq, or 0 for "no seq". */
	seq: number;
}

/**
 * Subscribe to decoded CRDT frames as they are applied in place by the sink
 * codec. The handler receives `{ op, bytes, schemaVersion, seq }` for each
 * inbound CRDT `0x03` frame; `bytes` is the opaque CRDT blob, handed back
 * verbatim for a local replica to apply. A handler that throws is isolated so
 * one bad consumer cannot drop the frame for another.
 *
 * Importing this module opts the connection into binary CRDT frames: the first
 * `hello` advertises `crdt.protocol:1` and inbound CRDT frames are routed
 * through the sink decode, which dispatches no store event.
 *
 * @param handler - called with each applied frame
 * @returns an unsubscribe function
 *
 * @example
 * ```js
 * import { onCrdtFrame } from 'svelte-adapter-uws/plugins/crdt/client';
 *
 * const off = onCrdtFrame(({ op, bytes }) => {
 *   // hand the opaque bytes to a local document replica
 * });
 * ```
 */
export function onCrdtFrame(handler: (frame: CrdtFrame) => void): () => void;

/** The internal topic-name prefix CRDT frames ride on (`__crdt:`). */
export const CRDT_TOPIC_PREFIX: string;
