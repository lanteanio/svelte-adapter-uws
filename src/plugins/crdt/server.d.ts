/**
 * The CRDT binary wire codec, shaped for `platform.publishWire` /
 * `platform.sendWire`. Frames opaque CRDT update bytes onto the `0x03` topic
 * frame with opcode discrimination; the `encode` returns `null` for any frame
 * it cannot represent so the framework falls back to JSON for that frame.
 */
export interface CrdtWireCodec {
	/** Capability a connection must advertise to receive binary CRDT frames. */
	capability: string;
	/** 1-byte in-frame schema version stamped on every binary frame. */
	schemaVersion: number;
	/**
	 * Encode a CRDT wire event into a codec payload, or `null` to fall back to
	 * JSON for this frame.
	 */
	encode: (event: string, data: CrdtWireData) => Uint8Array | null;
}

/** The known CRDT wire opcodes (the stable public `op` surface). */
export type CrdtOp = 'update' | 'snapshot' | 'sync-request';

/**
 * The wire-event payload: a known op and the opaque CRDT bytes. `bytes` is a
 * `Uint8Array` from a replica or a plain `number[]` when carried over the JSON
 * fallback; the codec normalizes either.
 */
export interface CrdtWireData {
	op: CrdtOp;
	bytes: Uint8Array | number[];
}

/**
 * Build the CRDT binary wire codec (`crdt.protocol:1`). Hand the result to
 * `platform.publishWire` / `platform.sendWire`: a subscriber that advertised the
 * capability receives a compact `0x03` frame, everyone else transparently
 * receives the identical JSON frame.
 *
 * Exported so a cluster-backed CRDT backend
 * (`svelte-adapter-uws-extensions/redis/crdt`) builds the IDENTICAL codec from
 * one definition - the in-memory and cluster CRDT wires never drift.
 *
 * Returns `null` when `binary: false` (JSON for every client), mirroring the
 * cursor and presence codec factories.
 *
 * @param options - Only `binary` is read.
 */
export function createCrdtWireCodec(options?: { binary?: boolean }): CrdtWireCodec | null;

/**
 * Encode a CRDT wire event into a codec payload, or `null` to fall back to JSON.
 * Usually used via {@link createCrdtWireCodec}; exported for tests and a custom
 * relay.
 */
export function encodeCrdt(event: string, data: CrdtWireData): Uint8Array | null;

/**
 * Decode a CRDT codec payload back into `{ event, data }`, or `null` on an
 * unknown opcode / schema or a truncated frame. `data.bytes` is a zero-copy view
 * of the opaque update blob.
 */
export function decodeCrdt(
	payload: Uint8Array,
	state?: unknown,
	schemaVersion?: number
): { event: 'crdt'; data: { op: CrdtOp; bytes: Uint8Array } } | null;

/**
 * Whether a connection advertised `crdt.protocol:1` in its `hello` frame.
 * Mirrors the cursor codec's capability read so a server-side gate can branch on
 * the same token.
 */
export function connectionAcceptsCrdtBinary(ws: unknown): boolean;

/** Negotiated capability for the CRDT binary wire. */
export const CRDT_CAPABILITY: string;

/** 1-byte in-frame schema version for the CRDT wire. */
export const CRDT_SCHEMA_VERSION: number;

/** The reserved topic-name prefix CRDT frames ride on (`__crdt:`). */
export const CRDT_TOPIC_PREFIX: string;
