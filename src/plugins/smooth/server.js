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

/** Per-entity command queue bound: drop-oldest beyond it. A client that
 * floods faster than the tick drains loses its oldest samples and recovers
 * through ordinary reconciliation (the next ack rebases it). */
const DEFAULT_QUEUE_CAP = 1024;

/**
 * Create the authoritative command processor for one smoothed topic.
 *
 * @param {{
 *   apply: (state: any, command: any, ctx: { firstTime: boolean, rng: any }) => any,
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
	const ctx = { firstTime: true, rng };

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
		 * watermark resets.
		 * @param {string} key @param {any} ws @param {any} initialState
		 * @returns {{ state: any, lastAckedId: number }}
		 */
		ensure(key, ws, initialState) {
			let e = entities.get(key);
			if (e === undefined) {
				e = { state: initialState, ws, queue: [], lastAckedId: 0, lastCommand: undefined, active: false };
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
					acks.push({ key, ws: e.ws, id: e.lastAckedId, state: s });
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
				if (e.state !== before) updates.push({ key, state: e.state, ws: e.ws, commanded });
				if (e.active || e.queue.length > 0) idle = false;
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
