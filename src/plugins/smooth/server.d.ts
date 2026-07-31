import type { SharedRandom } from './random.js';

/** The apply context: stable across calls, fields swapped per application. */
export interface SmoothApplyContext {
	/**
	 * True only on a command's initial application (the client's first
	 * prediction and the server's one authoritative apply); false on every
	 * reconciliation replay. Guard one-shot side effects on it.
	 */
	firstTime: boolean;
	/**
	 * Deterministic generator reseeded from the command id before every
	 * application, so randomness drawn here is identical on prediction,
	 * replay, and authority. Never call `Math.random()` inside `apply`.
	 */
	rng: SharedRandom;
	/**
	 * The key of the entity whose command is being applied - the handle an
	 * authoritative side effect attributes to (who fired the shot, whose
	 * action to log). The authority sets it for every application
	 * (client-commanded and server-injected alike); the predicting client
	 * reports its own entity key, null until the first sync reply announces
	 * it. Both sides see the same key for the same command, so an `apply`
	 * that reads it stays deterministic.
	 */
	key: string | null;
	/**
	 * Emit a discrete one-shot event (a shot, a hit) that is NOT part of the
	 * reconciled continuous state. It fires once - on a command's first
	 * application - and is automatically suppressed on the client's
	 * reconciliation replays, so the author sees it exactly once; the authority
	 * always emits. Returns the event's correlation key: the developer-supplied
	 * `opts.key`, else `<commandId>:<ordinal>` minted identically on both sides
	 * so the optimistic and authoritative copies of one event share a key.
	 * `toAuthor` / `global` / `topic` shape the broadcast fanout downstream.
	 */
	emitEvent(
		type: string,
		payload?: any,
		opts?: { key?: string | number; toAuthor?: boolean; global?: boolean; topic?: string }
	): string | undefined;
}

/**
 * The shared simulation step: runs verbatim on the client (prediction and
 * replay) and on the server (authority). Must be pure - treat `state` as
 * immutable and return the next state; returning the same reference means
 * "unchanged".
 */
export type SmoothApply<State = any, Command = any> = (
	state: State,
	command: Command,
	ctx: SmoothApplyContext
) => State;

// The SharedRandom contract and the createSharedRandom factory live in
// ./random.js (its own dependency-free subpath); the smooth server surface
// re-exports them so existing imports keep resolving.
export type { SharedRandom };
export { createSharedRandom } from './random.js';

export interface SmoothAuthorityOptions<State = any, Command = any> {
	/** The shared simulation step. */
	apply: SmoothApply<State, Command>;
	/**
	 * Per-tick continuation for an entity with no queued commands (a
	 * genuinely simulated entity keeps moving here). Runs only for an ACTIVE
	 * entity: activity starts with the entity's first command, an
	 * `ensure(..., { active: true })` spawn, or a server `set` - so a
	 * joined-but-idle client entity costs nothing here. Returning the same
	 * state reference (or undefined) signals rest; a resting entity stops
	 * costing ticks until it is next woken. Omitted = hold position.
	 */
	onMissing?: (state: State, lastCommand: Command | undefined) => State | undefined;
	/** Per-entity queue bound; oldest commands drop beyond it (default 1024). */
	queueCap?: number;
}

export interface SmoothAuthority<State = any, Command = any> {
	/**
	 * Bind (or re-bind) an entity to its owning connection, creating it with
	 * `initialState` on first sight. A new socket for an existing key starts
	 * a fresh command stream (queue dropped, ack watermark reset).
	 * `opts.active` creates the entity ACTIVE so `onMissing` drives it from
	 * its first tick without ever seeing a command - the server-entity
	 * (simulated / NPC) spawn path. Default false: a joined-but-idle client
	 * entity costs no onMissing calls until its first command.
	 */
	ensure(key: string, ws: any, initialState: State, opts?: { active?: boolean }): { state: State; lastAckedId: number };
	/** Queue commands for the next tick; true when anything was queued. */
	enqueue(key: string, commands: Array<{ id: number; cmd: Command }>): boolean;
	/**
	 * Apply a server-initiated command to an entity (e.g. a lag-compensated hit
	 * applying damage). Runs through the same `apply` on the next `drain()` but
	 * produces NO acknowledgement and a non-commanded update, so a victim that is
	 * not commanding still receives the change. True when queued (unknown key =>
	 * false). The injected command never bumps the entity's ack watermark.
	 */
	inject(key: string, cmd: Command): boolean;
	/**
	 * REPLACE an entity's authoritative state from server logic (a teleport, a
	 * respawn) - the discontinuous counterpart of `inject`, which routes through
	 * `apply`. Wakes the entity so `onMissing` continues from the new state. The
	 * caller owns broadcasting the change for the current tick (it is meant to
	 * run post-drain; the next drain's change-detection baseline is then the
	 * already-broadcast state). Never touches the queue, the ack watermark, or
	 * `lastCommand`. False for an unknown key.
	 *
	 * The replacement travels as an ordinary update on the ordinary cadence, so
	 * nothing on the wire marks it as discontinuous: rendering it as a jump
	 * rather than a slide across the map is the client channel's
	 * `snapSpeedPerSec`, which detects it from the entity's own motion by
	 * default. If a placement ever renders as a streak, that is the knob.
	 */
	set(key: string, state: State): boolean;
	/**
	 * Run one authoritative tick. The caller publishes `updates` (excluding
	 * each entity's owner when echo suppression is on) and sends each ack to
	 * its owner AFTER this returns - subscribers observe a tick atomically.
	 */
	drain(): {
		updates: Array<{ key: string; state: State; ws: any; commanded: boolean }>;
		acks: Array<{ key: string; ws: any; id: number; state: State }>;
		events: Array<{ type: string; key: string; data: any; id: number; opts: any; ws: any; commanded: boolean }>;
		idle: boolean;
	};
	/** Drop one entity. True when it existed. */
	remove(key: string): boolean;
	/** Drop every entity owned by a closing connection; returns their keys. */
	removeWs(ws: any): string[];
	/** Every entity's authoritative state, for a sync reply. */
	catalog(): Array<{ key: string; state: State }>;
	/** One entity's record, or undefined. */
	get(key: string): { state: State; ws: any; lastAckedId: number } | undefined;
	/** Number of live entities. */
	readonly size: number;
}

/**
 * Create the authoritative command processor for one smoothed topic: the
 * server-side half of the prediction/reconciliation contract. Pure with
 * respect to time and transport - the caller owns the tick cadence and
 * delivers the drain result.
 */
export function createSmoothAuthority<State = any, Command = any>(
	options: SmoothAuthorityOptions<State, Command>
): SmoothAuthority<State, Command>;

/**
 * Build the smooth binary wire codec (`smooth.protocol:1`). Hand it to
 * `platform.publishWire` / `platform.sendWire`; connections that advertised
 * the capability get the dictionaried binary wire, everyone else gets the
 * JSON envelope. `binary: false` returns null (JSON for everyone);
 * `timeSource` overrides the update-stamp clock (deterministic harnesses).
 */
export function createSmoothWireCodec(options?: {
	binary?: boolean;
	timeSource?: () => number;
}): {
	capability: string;
	schemaVersion: number;
	encode: (event: string, data: any, state?: any) => Uint8Array | null;
	state: { onAttach(ws: any): any; onDetach(ws: any, state: any): void };
} | null;

/** Negotiated capability token for the smooth binary wire. */
export const SMOOTH_CAPABILITY: string;

/** 1-byte in-frame schema version for the smooth wire. */
export const SMOOTH_SCHEMA_VERSION: number;

/** The internal topic-name prefix smoothed entity topics ride on (`__smooth:`). */
export const SMOOTH_TOPIC_PREFIX: string;

/**
 * Ingress kind for the client->server smooth COMMAND wire (the `0x03` ingress
 * frame). A consumer (svelte-realtime) registers a route for this kind and the
 * client binds its command channel under it. Independent of
 * `SMOOTH_CAPABILITY` (a different direction and codec).
 */
export const SMOOTH_COMMAND_CAPABILITY: string;

/** 1-byte in-frame schema version for the smooth command (ingress) wire. */
export const SMOOTH_COMMAND_SCHEMA_VERSION: number;

/**
 * Decode a smooth command ingress payload back into the `Array<{ id, cmd }>`
 * batch the JSON volatile-RPC path would deliver to `authority.enqueue`.
 * Returns `null` on an unknown schema version or a malformed / truncated frame.
 */
export function decodeSmoothCommandBatch(
	payload: Uint8Array,
	schemaVersion?: number
): Array<{ id: number; cmd: unknown }> | null;

/**
 * Register the server-side handler for a binary ingress `kind` (the core
 * client->server `0x03` transport seam, re-exported here for consumers that
 * already load this plugin). `decode` turns a frame payload into the routed
 * value (return `null`/`undefined` to drop the frame); `route` delivers it; the
 * optional `state` factory makes one per-binding decoder state.
 */
export function registerIngress(
	kind: string,
	handler: {
		decode: (payload: Uint8Array, schemaVersion: number, seq: number, state: unknown) => unknown;
		route: (ws: unknown, target: unknown, value: unknown, platform: unknown, seq: number) => void;
		state?: { onAttach?: (ws: unknown) => unknown };
	}
): void;

/**
 * Build the stateless cell-snapshot wire codec - the stateless twin of the smooth
 * codec used for spatial cell-topic interest. `shared: true` (no per-connection
 * state), so a cell topic fans out natively to its subscribers. Encodes an
 * interpolated entity snapshot with a full key string + absolute stamp so every
 * subscriber's frame is byte-identical. `binary: false` returns null.
 */
export function createCellWireCodec(options?: {
	binary?: boolean;
}): {
	capability: string;
	schemaVersion: number;
	encode: (event: string, data: { key: string; data?: any; t?: number }) => Uint8Array | null;
	shared: true;
} | null;

/**
 * Decode a cell-snapshot codec payload back into `{ event, data, t? }` - the same
 * shape the smooth codec decodes to, so the client ingests cell frames through the
 * same path. Stateless (no per-connection dictionary). Returns null on an unknown
 * opcode / schema version or a malformed frame.
 */
export function decodeCell(
	payload: Uint8Array,
	schemaVersion?: number
): { event: string; data: any; t?: number } | null;

/** Negotiated capability token for the stateless cell-snapshot wire. */
export const CELL_CAPABILITY: string;

/** 1-byte in-frame schema version for the cell-snapshot wire. */
export const CELL_SCHEMA_VERSION: number;

/** The internal topic-name prefix cell-snapshot topics ride on (`__smoothcell:`). */
export const CELL_TOPIC_PREFIX: string;
