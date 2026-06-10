/**
 * Server-side CRDT document plugin for svelte-adapter-uws.
 *
 * This unit ships the binary wire codec only: the frame shape that carries
 * opaque CRDT update bytes onto the existing `0x03` topic frame, with opcode
 * discrimination (UPDATE / SNAPSHOT / SYNC_REQUEST) and the `crdt.protocol:1`
 * capability. The per-topic document replica, the subscribe/sync handshake, and
 * the reactive client stores ride on top of this frame and are separate
 * concerns - the codec is the transport, intentionally library-agnostic, so the
 * bytes it frames stay opaque.
 *
 * Build the codec with {@link createCrdtWireCodec} and hand it to
 * `platform.publishWire` / `platform.sendWire`, exactly as the cursor and
 * presence plugins hand their codecs to the same primitives. A capable
 * subscriber (one that advertised `crdt.protocol:1`) receives a compact `0x03`
 * frame; everyone else transparently receives the identical JSON frame, so a
 * non-binary client keeps working with no app change.
 *
 * The same factory is exported for the cluster-backed CRDT backend
 * (`svelte-adapter-uws-extensions/redis/crdt`) so the in-memory and cluster
 * wires are built from one definition and never drift.
 *
 * @module svelte-adapter-uws/plugins/crdt
 */

export {
	createCrdtWireCodec,
	encodeCrdt,
	decodeCrdt,
	connectionAcceptsCrdtBinary,
	CRDT_CAPABILITY,
	CRDT_SCHEMA_VERSION
} from './codec.js';
