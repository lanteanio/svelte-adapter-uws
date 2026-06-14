import type { CrdtAccess } from './replica.js';

/** The injected transport for one CRDT document channel. */
export interface CrdtChannelTransport {
	/**
	 * Reliable no-reply upstream send for one opaque update (bytes as a JSON
	 * `number[]`). Must not silently drop while the connection is open; while
	 * disconnected the channel does not call it (the next sync's state-vector
	 * exchange uploads everything the server lacks).
	 */
	sendUpdate: (bytes: number[]) => void;
	/**
	 * The awaited sync exchange: sends this replica's state vector and this
	 * mount's identity, resolves with the server's reply - the resolved wire
	 * topic (bare name, without the `__crdt:` prefix), the access record, the
	 * missing-structs diff, and the server's own state vector. The mount id
	 * lets the server count mounts (not syncs) when several channels on one
	 * connection resolve to the same document.
	 */
	sync: (stateVector: number[], mountId: number) => Promise<{
		topic?: string;
		access?: Partial<CrdtAccess> | null;
		diff?: number[] | Uint8Array | null;
		sv?: number[] | Uint8Array | null;
	} | null | undefined>;
	/** Optional: tell the server this mount is gone (reference release before socket close). */
	close?: (mountId: number) => void;
}

/** A keyed container facet over the local replica. */
export interface CrdtMapFacet<V = unknown> {
	get(key: string): V | undefined;
	has(key: string): boolean;
	readonly size: number;
	keys(): IterableIterator<string>;
	values(): IterableIterator<V>;
	entries(): IterableIterator<[string, V]>;
	toJSON(): Record<string, V>;
	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	set(key: string, value: V): void;
	delete(key: string): void;
	clear(): void;
	/** Observe changes; the callback receives the Set of changed keys. Returns unsubscribe. */
	onChange(cb: (changedKeys: Set<string>) => void): () => void;
}

/** One step of an ordered-container change delta. */
export interface CrdtArrayDeltaStep {
	retain?: number;
	insert?: unknown[];
	delete?: number;
}

/** An ordered container facet over the local replica. */
export interface CrdtArrayFacet<V = unknown> {
	at(index: number): V | undefined;
	readonly length: number;
	toArray(): V[];
	toJSON(): V[];
	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	push(...items: V[]): void;
	insert(index: number, ...items: V[]): void;
	delete(index: number, length?: number): void;
	/** Observe changes; the callback receives the positional delta. Returns unsubscribe. */
	onChange(cb: (delta: CrdtArrayDeltaStep[]) => void): () => void;
}

/** A collaborative text facet over the local replica. */
export interface CrdtTextFacet {
	toString(): string;
	readonly length: number;
	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	insert(index: number, content: string): void;
	delete(index: number, length?: number): void;
	/** Observe changes; read `toString()` for the value. Returns unsubscribe. */
	onChange(cb: () => void): () => void;
}

/**
 * The client-side channel for one CRDT document topic: a local replica every
 * read hits, kept converged with the server through an idempotent two-way
 * state-vector exchange on every connection open.
 */
export interface CrdtChannel {
	/** A keyed container facet (default name `'root'`). */
	map<V = unknown>(name?: string): CrdtMapFacet<V>;
	/** An ordered container facet (default name `'root'`). */
	array<V = unknown>(name?: string): CrdtArrayFacet<V>;
	/** A collaborative text facet (default name `'root'`). */
	text(name?: string): CrdtTextFacet;
	/** Batch several mutations into one transaction = one wire update. */
	transact(fn: () => void): void;
	/** Observe channel state transitions (one consumer; the reactive wrapper owns fan-out). */
	onState(cb: (state: { synced: boolean; degraded: boolean; access: CrdtAccess | null }) => void): void;
	/** Re-run the sync exchange now (also runs on every connection open). */
	resync(): void;
	/** The current access record, or null before the first sync reply. */
	readonly access: CrdtAccess | null;
	/** True when the guard granted read but not write (UI: disable inputs). */
	readonly readOnly: boolean;
	/** True after a successful sync on the current connection. */
	readonly synced: boolean;
	/** True while the last sync attempt failed and recovery is pending. */
	readonly degraded: boolean;
	/** The resolved wire topic (`__crdt:` + name), or null before the first sync reply. */
	readonly topic: string | null;
	/** Release the server reference (best-effort), unbind, destroy the local replica. */
	destroy(): void;
}

/**
 * Create the channel for one CRDT document topic. Importing this module also
 * registers the CRDT sink codec, so the connection's first `hello` advertises
 * `crdt.protocol:1`.
 */
export function createCrdtChannel(options: {
	transport: CrdtChannelTransport;
	/** CRDT garbage collection on the local replica. Default true. */
	gc?: boolean;
}): CrdtChannel;
