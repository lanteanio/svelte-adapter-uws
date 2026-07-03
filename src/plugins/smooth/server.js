/**
 * Server-side pieces of the smoothing primitive: the authoritative command
 * processor and the smooth wire codec factory.
 *
 * The authority owns the invariant the whole primitive rests on: a client
 * can only ever send COMMANDS, never push state. Each entity (one per owning
 * connection per topic) holds the authoritative state, a bounded queue of
 * commands awaiting the next tick, and the id of the last command applied.
 * A tick drains every queued command in arrival order through the SAME
 * `apply(state, command, ctx)` the clients predict with, then reports which
 * entities changed (for the broadcast) and which owners need an
 * acknowledgement (always carrying the authoritative state - the ack IS the
 * owner's copy of truth, which is what lets the broadcast skip echoing the
 * owner's own entity back to it).
 *
 * Commands are drained whole per tick rather than paced one-per-tick:
 * commands are frame-coalesced input samples arriving on a reliable in-order
 * transport, so pacing would add queue latency without fairness gain. A tick
 * with an EMPTY queue holds the entity unchanged unless an `onMissing(state,
 * lastCommand)` hook is supplied (a genuinely simulated entity continues its
 * motion there); `onMissing` returning the same state reference (or
 * undefined) signals rest, and a resting entity stops costing ticks until
 * its next command.
 *
 * `ctx.rng` is reseeded from each command's id before it is applied - the
 * same id-seeded draw the client makes on prediction and replay, so
 * randomness inside `apply` cannot diverge (see ./random.js). `ctx.firstTime`
 * is always true here: the authority applies a command exactly once.
 * `ctx.key` names the entity whose command is being applied - the handle an
 * authoritative side effect attributes to (who fired the shot, whose action
 * to log). It is the same key the predicting client sees for its own entity,
 * so an `apply` that reads it stays deterministic across both sides.
 *
 * Re-binding an entity to a new connection (the same identity reconnecting)
 * resets its acknowledgement watermark: command ids belong to the CLIENT
 * stream, and a fresh socket means a fresh stream whose ids the authority
 * simply echoes. The queue is dropped with the old socket - un-acked
 * commands from a dead connection are gone by definition, and the client
 * rebases through its sync request rather than blind-replaying onto a basis
 * it no longer shares.
 *
 * The authority is pure with respect to time and transport: no clocks, no
 * timers, no publishes - the caller owns the tick cadence and delivers the
 * drain result. That is also the ordering contract the broadcast needs:
 * `apply` is pure state -> state, so nothing can publish mid-drain, and the
 * caller publishes updates and acknowledgements only after the drain
 * returns - subscribers always observe a tick's effects atomically.
 *
 * @module svelte-adapter-uws/plugins/smooth/server
 */

import { createSharedRandom } from './random.js';
import { SMOOTH_CAPABILITY, SMOOTH_SCHEMA_VERSION, SMOOTH_TOPIC_PREFIX, SmoothEncodeDict, encodeSmooth } from './codec.js';
import { WS_CAPS } from '../../runtime/utils.js';
import { wallEpoch } from '../../runtime/runtime.js';

// Re-exported so a server-side consumer reaches the whole smooth server
// surface through one subpath (the topic prefix names the wire topics, the
// generator serves command-id-seeded draws outside `apply`).
export { createSharedRandom } from './random.js';
export { SMOOTH_CAPABILITY, SMOOTH_SCHEMA_VERSION, SMOOTH_TOPIC_PREFIX } from './codec.js';
// Stateless cell-snapshot wire (spatial cell-topic interest). The stateless twin
// of the smooth codec: `shared: true`, so a cell topic fans out natively to its
// subscribers. Consumed by the realtime smooth server (per-cell publish) and the
// smooth client (decode). See ./cell-codec.js.
export { createCellWireCodec, decodeCell, CELL_CAPABILITY, CELL_SCHEMA_VERSION, CELL_TOPIC_PREFIX } from './cell-codec.js';

/** Per-entity command queue bound: drop-oldest beyond it. A client that
 * floods faster than the tick drains loses its oldest samples and recovers
 * through ordinary reconciliation (the next ack rebases it). */
const DEFAULT_QUEUE_CAP = 1024;

/**
 * Create the authoritative command processor for one smoothed topic.
 *
 * @param {{
 *   apply: (state: any, command: any, ctx: { firstTime: boolean, rng: any, key: string | null }) => any,
 *   onMissing?: (state: any, lastCommand: any) => any,
 *   queueCap?: number
 * }} options resolved options - validation belongs to the caller's public
 *   surface.
 */
export function createSmoothAuthority(options) {
	const apply = options.apply;
	const onMissing = options.onMissing;
	// Defensive clamp: the queue bound is a flood defense, so a malformed cap
	// (NaN from a missing env var, zero, a negative) must never disable it.
	const queueCap =
		Number.isInteger(options.queueCap) && options.queueCap >= 1 ? options.queueCap : DEFAULT_QUEUE_CAP;

	/**
	 * @type {Map<string, {
	 *   state: any,
	 *   ws: any,
	 *   queue: Array<{ id: number, cmd: any }>,
	 *   lastAckedId: number,
	 *   lastCommand: any,
	 *   active: boolean
	 * }>}
	 */
	const entities = new Map();

	const rng = createSharedRandom();
	const ctx = { firstTime: true, rng, key: null };

	// Discrete-event channel. The developer's `apply` may call
	// `ctx.emitEvent(type, payload, opts?)` to fire a one-shot action (a shot, a
	// hit) that is NOT part of the reconciled continuous state. The authority
	// applies each command exactly once (firstTime is always true here), so it
	// emits unconditionally; the predicting client gates the same call on
	// `firstTime` so a reconciliation replay never re-fires it. Events accumulate
	// in this per-tick sink during `apply` and `drain()` moves them into the tick
	// result tagged with the owning `ws`, then clears it - nothing publishes
	// mid-drain. The default correlation key is `<commandId>:<ordinal>`, computed
	// from the SAME command id and per-command emit ordinal on both sides, so the
	// client's optimistic event and this authoritative copy share a key with zero
	// coordination (an explicit `opts.key` overrides it).
	let eventSink = [];
	let currentId = 0;
	let eventOrdinal = 0;
	// Server-initiated commands (ctx.applyTo, e.g. a lag-compensated hit applying
	// damage) use a descending id space so their rng reseed and default event keys
	// never collide with a client's ascending command ids.
	let serverId = 0;
	ctx.emitEvent = (type, data, opts) => {
		const key = opts && opts.key != null ? String(opts.key) : currentId + ':' + eventOrdinal;
		eventOrdinal++;
		eventSink.push({ type: String(type), key, data, id: currentId, opts: opts || null });
		return key;
	};

	return {
		/**
		 * Bind (or re-bind) an entity to its owning connection, creating it
		 * with `initialState` on first sight. A new socket for an existing
		 * key starts a fresh command stream: the queue drops and the ack
		 * watermark resets. `opts.active` creates the entity ACTIVE, so
		 * `onMissing` drives it from its first tick without ever seeing a
		 * command - the server-entity (simulated / NPC) spawn path; the
		 * default stays false so a joined-but-idle client entity costs no
		 * onMissing calls until its first command.
		 * @param {string} key @param {any} ws @param {any} initialState
		 * @param {{ active?: boolean }} [opts]
		 * @returns {{ state: any, lastAckedId: number }}
		 */
		ensure(key, ws, initialState, opts) {
			let e = entities.get(key);
			if (e === undefined) {
				e = { state: initialState, ws, queue: [], lastAckedId: 0, lastCommand: undefined, active: opts !== undefined && opts.active === true };
				entities.set(key, e);
			} else if (e.ws !== ws) {
				e.ws = ws;
				e.queue.length = 0;
				e.lastAckedId = 0;
			}
			return { state: e.state, lastAckedId: e.lastAckedId };
		},

		/**
		 * Queue commands for the next tick. Unknown keys are ignored (the
		 * sync request creates the entity before its first command). Returns
		 * true when anything was queued - the caller's cue to arm its tick.
		 * @param {string} key
		 * @param {Array<{ id: number, cmd: any }>} commands
		 * @returns {boolean}
		 */
		enqueue(key, commands) {
			const e = entities.get(key);
			if (e === undefined || !Array.isArray(commands) || commands.length === 0) return false;
			// Only the newest `queueCap` entries of an oversized batch can
			// survive, so older entries are never even examined, and eviction
			// of existing entries happens in ONE bulk drop - the per-call cost
			// is bounded by the cap, never by the (client-controlled) batch
			// length times the cap.
			const start = commands.length > queueCap ? commands.length - queueCap : 0;
			let queued = false;
			let incoming = 0;
			for (let i = start; i < commands.length; i++) {
				const c = commands[i];
				if (!c || typeof c.id !== 'number' || !Number.isInteger(c.id) || c.id < 0) continue;
				incoming++;
			}
			if (incoming === 0) return false;
			const overflow = e.queue.length + incoming - queueCap;
			if (overflow > 0) e.queue.splice(0, overflow);
			for (let i = start; i < commands.length; i++) {
				const c = commands[i];
				if (!c || typeof c.id !== 'number' || !Number.isInteger(c.id) || c.id < 0) continue;
				e.queue.push(c);
				queued = true;
			}
			return queued;
		},

		/**
		 * Apply a SERVER-INITIATED command to an entity (e.g. a lag-compensated
		 * hit applying damage to a victim the shooter never commanded). It runs
		 * through the same pure `apply` on the next `drain()` but - unlike a
		 * client command - produces NO acknowledgement and a NON-COMMANDED update,
		 * so the victim (who may not be commanding at all) still receives the
		 * change. This is the `onMissing` delivery polarity: a server-side mutation
		 * the owner did not initiate must reach the owner's broadcast. Unknown keys
		 * are ignored (the victim may have left). Returns true when queued - the
		 * caller's cue to arm the tick. The injected command gets a descending
		 * server id so its rng reseed and default event keys never collide with the
		 * victim's own ascending command ids, and it never bumps `lastAckedId`.
		 * @param {string} key @param {any} cmd
		 * @returns {boolean}
		 */
		inject(key, cmd) {
			const e = entities.get(key);
			if (e === undefined) return false;
			if (e.serverQueue === undefined) e.serverQueue = [];
			// Same drop-oldest flood bound as the command queue.
			if (e.serverQueue.length >= queueCap) e.serverQueue.shift();
			serverId -= 1;
			e.serverQueue.push({ id: serverId, cmd });
			return true;
		},

		/**
		 * REPLACE an entity's authoritative state from server logic (a teleport,
		 * a respawn, a scripted placement) - the discontinuous counterpart of
		 * `inject`, which routes through `apply`. The entity wakes (`active`), so
		 * `onMissing` continues from the new state (a resting entity that stays
		 * at rest re-rests in one tick). The caller owns broadcasting the change
		 * for THIS tick (it runs post-drain, so the next drain's change-detection
		 * baseline is the already-broadcast state - no duplicate update). Never
		 * touches the queue, the ack watermark, or `lastCommand`. Unknown keys
		 * are ignored (false).
		 * @param {string} key @param {any} state
		 * @returns {boolean}
		 */
		set(key, state) {
			const e = entities.get(key);
			if (e === undefined) return false;
			e.state = state;
			e.active = true;
			return true;
		},

		/**
		 * Run one authoritative tick: drain every entity's queue in order
		 * through `apply`, advance command-less active entities through
		 * `onMissing`, and report what changed.
		 *
		 * Each update carries `commanded`: true when the change came from the
		 * owner's own commands (the acknowledgement is the owner's copy, so a
		 * broadcast may exclude the owner), false when it came from
		 * `onMissing` (server-side motion the owner did NOT initiate - it
		 * produces no acknowledgement, so the owner must receive the
		 * broadcast or render a frozen entity everyone else sees gliding).
		 *
		 * @returns {{
		 *   updates: Array<{ key: string, state: any, ws: any, commanded: boolean }>,
		 *   acks: Array<{ key: string, ws: any, id: number, state: any }>,
		 *   events: Array<{ type: string, key: string, data: any, id: number, opts: any, ws: any, commanded: boolean }>,
		 *   idle: boolean
		 * }} `idle` is true when no entity has queued commands or live
		 *   `onMissing` motion left - the caller's cue to stop ticking. `events`
		 *   are the discrete one-shot actions emitted via `ctx.emitEvent` this
		 *   tick, each tagged with its owning `ws` so the broadcast can exclude
		 *   the author's already-predicted copy.
		 */
		drain() {
			const updates = [];
			const acks = [];
			const events = [];
			let idle = true;
			for (const [key, e] of entities) {
				// Attribution for this entity's applications (client-commanded and
				// server-injected alike): `apply` reads it as `ctx.key`.
				ctx.key = key;
				const before = e.state;
				let commanded = false;
				if (e.queue.length > 0) {
					let s = e.state;
					for (let i = 0; i < e.queue.length; i++) {
						const c = e.queue[i];
						rng.reseed(c.id);
						currentId = c.id;
						eventOrdinal = 0;
						s = apply(s, c.cmd, ctx);
						e.lastAckedId = c.id;
						e.lastCommand = c.cmd;
						for (let j = 0; j < eventSink.length; j++) {
							const ev = eventSink[j];
							events.push({ type: ev.type, key: ev.key, data: ev.data, id: ev.id, opts: ev.opts, ws: e.ws, commanded: true });
						}
						eventSink.length = 0;
					}
					e.queue.length = 0;
					e.state = s;
					e.active = true;
					commanded = true;
				} else if (e.active && onMissing) {
					const s = onMissing(e.state, e.lastCommand);
					if (s === undefined || s === e.state) {
						e.active = false;
					} else {
						e.state = s;
					}
				} else {
					e.active = false;
				}
				// Server-initiated commands (ctx.applyTo) apply after the owner's own
				// commands so the acknowledgement below carries the final state (no
				// reconciliation flicker when a victim moves and is hit on the same
				// tick). They emit events to the owner too (commanded:false) and never
				// acknowledge: a still victim has no ack, so its update must reach it.
				let injected = false;
				if (e.serverQueue !== undefined && e.serverQueue.length > 0) {
					let s = e.state;
					for (let i = 0; i < e.serverQueue.length; i++) {
						const c = e.serverQueue[i];
						rng.reseed(c.id);
						currentId = c.id;
						eventOrdinal = 0;
						s = apply(s, c.cmd, ctx);
						for (let j = 0; j < eventSink.length; j++) {
							const ev = eventSink[j];
							events.push({ type: ev.type, key: ev.key, data: ev.data, id: ev.id, opts: ev.opts, ws: e.ws, commanded: false });
						}
						eventSink.length = 0;
					}
					e.serverQueue.length = 0;
					e.state = s;
					injected = true;
				}
				// The ack carries the FINAL state (including any injection), so the
				// owner reconciles to the truth in one step. The update is commanded
				// (owner-excluded) only when the owner commanded AND was not injected
				// into - an injected, non-commanding victim is delivered its update.
				if (commanded) acks.push({ key, ws: e.ws, id: e.lastAckedId, state: e.state });
				if (e.state !== before) updates.push({ key, state: e.state, ws: e.ws, commanded: commanded && !injected });
				if (e.active || e.queue.length > 0 || injected) idle = false;
			}
			return { updates, acks, events, idle };
		},

		/**
		 * Drop one entity (its owner left). Returns true when it existed.
		 * @param {string} key
		 */
		remove(key) {
			return entities.delete(key);
		},

		/**
		 * Drop every entity owned by a closing connection.
		 * @param {any} ws
		 * @returns {string[]} the removed keys, for departure broadcasts
		 */
		removeWs(ws) {
			const removed = [];
			for (const [key, e] of entities) {
				if (e.ws === ws) {
					entities.delete(key);
					removed.push(key);
				}
			}
			return removed;
		},

		/**
		 * The catalog for a sync reply: every entity's authoritative state.
		 * @returns {Array<{ key: string, state: any }>}
		 */
		catalog() {
			const out = [];
			for (const [key, e] of entities) out.push({ key, state: e.state });
			return out;
		},

		/** One entity's record, or undefined. */
		get(key) {
			return entities.get(key);
		},

		/** Number of live entities. */
		get size() {
			return entities.size;
		}
	};
}

/**
 * Build the smooth binary wire codec. Exported as a factory (the cursor
 * codec precedent) so every server-side consumer - and a future
 * cluster-backed variant - builds the IDENTICAL codec from one definition.
 * The per-connection dictionary state lives in the framework: publishWire /
 * sendWire run the per-subscriber encode against it and dispose it at close.
 *
 * Connections that advertised `smooth.protocol:1` get the dictionaried
 * binary wire; everyone else gets the JSON envelope (`onAttach` returning
 * null means no binary form exists for that connection - the smooth wire is
 * dictionary-only by design, so there is no stateless shared-encode tier).
 *
 * @param {{ binary?: boolean, timeSource?: () => number }} [options]
 *   `binary: false` -> null (JSON for everyone). `timeSource` overrides the
 *   update-stamp clock (the deterministic harness injects here); defaults to
 *   the runtime's exact wall clock - NOT the 1s-cached `now()`, which would
 *   quantize every client's reconstructed time axis.
 */
export function createSmoothWireCodec(options = {}) {
	if (options.binary === false) return null;
	const timeSource = options.timeSource === undefined ? wallEpoch : options.timeSource;
	return {
		capability: SMOOTH_CAPABILITY,
		schemaVersion: SMOOTH_SCHEMA_VERSION,
		encode: encodeSmooth,
		state: {
			onAttach(ws) {
				let caps;
				try {
					caps = ws.getUserData()[WS_CAPS];
				} catch {
					return null;
				}
				if (!caps || !caps.has(SMOOTH_CAPABILITY)) return null;
				return new SmoothEncodeDict(timeSource);
			},
			onDetach(ws, state) {
				if (state && state.byKey) state.byKey.clear();
			}
		}
	};
}
