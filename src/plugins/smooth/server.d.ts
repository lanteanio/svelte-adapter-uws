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
	 * genuinely simulated entity keeps moving here). Returning the same
	 * state reference (or undefined) signals rest; a resting entity stops
	 * costing ticks until its next command. Omitted = hold position.
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
	 */
	ensure(key: string, ws: any, initialState: State): { state: State; lastAckedId: number };
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
