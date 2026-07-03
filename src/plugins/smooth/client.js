/**
 * Client-side channel for one smoothed entity topic: prediction for the
 * local entity, render-in-the-past interpolation for remote entities, and
 * the wire glue between them.
 *
 * A channel composes the pure cores - the predictor (./predict.js), the
 * smoother/clock (./interpolate.js, ./clock.js), and the binary codec
 * (./codec.js) - over the singleton connection, with the TRANSPORT injected:
 * the caller supplies `sendCommand(batch)` (a lossy fire-and-forget send;
 * command loss is recovered by reconciliation, never retransmission) and
 * `sync()` (an awaited request returning the authoritative catalog, the
 * caller's own entity key, its ack watermark, and a server time stamp).
 * Injection keeps this module free of any framework above the adapter, and
 * makes the channel drivable by a deterministic harness with a scripted
 * transport.
 *
 * Lifecycle and recovery:
 *
 *   - On every connection 'open' (first connect and every reconnect) the
 *     channel resyncs: the sync round trip seeds the clock estimator with an
 *     upper bound, rebases the predictor on the server's state and ack
 *     watermark, and rebuilds the remote rings from the catalog at the
 *     reply's server time. Un-acked commands from the old connection are
 *     dropped, never blind-replayed onto a basis the server no longer
 *     shares.
 *   - Every acknowledgement is a clock sample: the predictor remembers when
 *     the acked command was sent, so `ack.t` plus that send time is a full
 *     round-trip bound - the steady-state source that keeps the estimate
 *     honest on the main connection.
 *   - When the un-acked window overflows (the server stopped
 *     acknowledging), prediction is killed and the channel resyncs once per
 *     episode; the overflow state is surfaced through `onOverflow` so the
 *     app's health surface can reflect it.
 *
 * The frame loop runs only while a frame consumer is attached and goes
 * near-free when idle: the gate stays closed unless something is dirty, a
 * ring still holds un-played motion, or a correction is still decaying.
 *
 * Frames sent to `onFrame` carry fresh objects (the reactive layer above
 * needs new identities to notice changes); the channel's own bookkeeping is
 * allocation-free per frame apart from that view.
 *
 * @module svelte-adapter-uws/plugins/smooth/client
 */

import { on, status, registerWireCodec } from '../../client.js';
import { monotonicNow, now, setTimer, clearTimer } from '../../client-runtime.js';
import { createPredictor } from './predict.js';
import { createSmoother, SAMPLE_EMPTY } from './interpolate.js';
import { SMOOTH_CAPABILITY, SMOOTH_TOPIC_PREFIX, SmoothDecodeDict, decodeSmooth } from './codec.js';
import { CELL_CAPABILITY, CELL_TOPIC_PREFIX, decodeCell } from './cell-codec.js';

// The deterministic generator the predictor seeds per command, re-exported so
// an app can draw the same reproducible randomness outside `apply` (world
// generation, spawns, tests) without reaching into the plugin internals. Pure
// and side-effect-free; for the RNG alone, prefer the lighter
// `svelte-adapter-uws/plugins/smooth/random` subpath, which pulls in no client.
export { createSharedRandom } from './random.js';

// Opt this connection into binary smooth frames: registered at module load so
// the first `hello` already carries the capability (a lazily-added capability
// would not reach a server whose codec state had already attached - the
// attach-once contract). Fully transparent: the decoder yields the identical
// { event, data } envelopes the JSON path produces.
registerWireCodec(SMOOTH_TOPIC_PREFIX, {
	capability: SMOOTH_CAPABILITY,
	state: { onAttach: () => new SmoothDecodeDict() },
	decode: decodeSmooth
});

// Spatial cell-topic interest (cells mode). A cells-mode topic delivers remote
// entities on many dynamic `__smoothcell:<name>#<cx>,<cy>` topics the server
// subscribes this socket to; a SINK codec receives every such frame (with its
// resolved topic) through one registration, so a channel never taps a cell topic
// itself. The sink parses the topic's `<name>` and routes the decoded frame to the
// channel registered for it, tagged with the cell key so a stale cross-cell remove
// resolves correctly. Registered at module load so `hello` advertises the
// capability (the attach-once contract). Stateless (no per-connection dictionary).
/** @type {Map<string, (decoded: { event: string, data: any, t?: number }, cellKey: string) => void>} */
const _cellChannels = new Map();
registerWireCodec(CELL_TOPIC_PREFIX, {
	capability: CELL_CAPABILITY,
	sink: true,
	decode(payload, _state, schemaVersion, _seq, topic) {
		const decoded = decodeCell(payload, schemaVersion);
		if (!decoded || typeof topic !== 'string') return;
		// topic = `<CELL_TOPIC_PREFIX><name>#<cellKey>`; split on the LAST '#' so a
		// name containing '#' (unusual but legal) still resolves.
		const rest = topic.slice(CELL_TOPIC_PREFIX.length);
		const hash = rest.lastIndexOf('#');
		if (hash < 0) return;
		const sink = _cellChannels.get(rest.slice(0, hash));
		if (sink) sink(decoded, rest.slice(hash + 1));
	}
});

// Resolve `requestAnimationFrame` at call time so a polyfill installed after
// this module imports (or a test harness substitution) is honored.
function scheduleFrame(cb) {
	if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
	return setTimer(cb, 16);
}

function cancelFrame(handle) {
	if (handle == null) return;
	if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(handle);
	else clearTimer(handle);
}

/**
 * Validate one numeric knob: undefined adopts the default, anything else
 * must be a finite number within the stated bound.
 * @param {any} v @param {string} label @param {number} min
 */
function checkKnob(v, label, min) {
	if (v === undefined) return;
	if (!(typeof v === 'number' && Number.isFinite(v) && v >= min)) {
		throw new Error('smooth: ' + label + ' must be a number >= ' + min);
	}
}

/**
 * Validate one wire codec pair: undefined means "off" (null), anything else
 * must carry pack and unpack functions.
 * @param {any} pair @param {string} label
 */
function checkWirePair(pair, label) {
	if (pair === undefined) return null;
	if (pair === null || typeof pair !== 'object' || typeof pair.pack !== 'function' || typeof pair.unpack !== 'function') {
		throw new Error('smooth: ' + label + ' must be { pack(value), unpack(packed) }');
	}
	return pair;
}

/**
 * Create the channel for one smoothed topic.
 *
 * The wire topic is announced by the first sync reply (the topic resolves
 * server-side), so the inbound tap binds on the first successful sync;
 * commands are path-routed and flow regardless.
 *
 * @param {{
 *   apply: (state: any, command: any, ctx: { firstTime: boolean, rng: any, key: string | null }) => any,
 *   initial: any,
 *   transport: {
 *     sendCommand: (batch: Array<{ id: number, cmd: any }>) => void,
 *     sync: () => Promise<{ topic?: string, t?: number, you?: string, ack?: number, states?: Array<{ key: string, state: any }> } | null | undefined>
 *   },
 *   computeError?: (before: any, after: any) => number,
 *   errorThreshold?: number,
 *   smoothTimeMs?: number,
 *   windowCap?: number,
 *   windowMaxAgeMs?: number,
 *   interpolationMs?: 'auto' | number,
 *   extrapolateMs?: number,
 *   snapGapMs?: number,
 *   cmdRate?: number,
 *   wire?: {
 *     state?: { pack: (state: any) => any, unpack: (packed: any) => any },
 *     command?: { pack: (cmd: any) => any, unpack: (packed: any) => any }
 *   }
 * }} options
 *
 * `wire` declares the topic's wire views - app-owned codec pairs applied at
 * the wire boundary and nowhere else. `wire.state` packs every state the
 * server sends (updates, acknowledgements, the sync roster) into a compact
 * JSON-serializable form and unpacks it back before the predictor and the
 * interpolation consume it; `wire.command` packs each outgoing command (and
 * shot) and the server unpacks it before applying. The prediction always
 * replays the ORIGINAL command objects - packing touches only the transmit
 * copy. Both pairs must be the same functions the server topic declares
 * (share the module, like `apply`); with neither, the wire is byte-identical
 * to before. A state frame whose unpack throws is dropped as malformed; a
 * command whose pack throws surfaces the error at the `command()` call.
 */
export function createSmoothChannel(options) {
	if (options === null || typeof options !== 'object') {
		throw new Error('smooth: an options object with apply and initial is required');
	}
	if (typeof options.apply !== 'function') {
		throw new Error('smooth: apply must be the shared (state, command, ctx) => state function');
	}
	if (options.initial === undefined) {
		throw new Error('smooth: initial state is required');
	}
	const transport = options.transport;
	if (!transport || typeof transport.sendCommand !== 'function' || typeof transport.sync !== 'function') {
		throw new Error('smooth: transport with sendCommand and sync is required');
	}
	if (options.computeError !== undefined && typeof options.computeError !== 'function') {
		throw new Error('smooth: computeError must be a function (before, after) => number');
	}
	checkKnob(options.errorThreshold, 'errorThreshold', 0);
	checkKnob(options.smoothTimeMs, 'smoothTimeMs', 0);
	checkKnob(options.windowCap, 'windowCap', 1);
	checkKnob(options.windowMaxAgeMs, 'windowMaxAgeMs', 1);
	if (options.interpolationMs !== undefined && options.interpolationMs !== 'auto') {
		checkKnob(options.interpolationMs, 'interpolationMs', 0);
	}
	checkKnob(options.extrapolateMs, 'extrapolateMs', 0);
	checkKnob(options.snapGapMs, 'snapGapMs', 1);
	checkKnob(options.cmdRate, 'cmdRate', 0);
	let wireState = null;
	let wireCommand = null;
	if (options.wire !== undefined) {
		if (options.wire === null || typeof options.wire !== 'object') {
			throw new Error('smooth: wire must be an object with optional state and command codec pairs');
		}
		wireState = checkWirePair(options.wire.state, 'wire.state');
		wireCommand = checkWirePair(options.wire.command, 'wire.command');
	}

	const cmdRate = options.cmdRate === undefined ? 60 : options.cmdRate;
	const minFlushMs = cmdRate > 0 ? 1000 / cmdRate : 0;

	// The caller's own entity key, learned from the sync reply. Read live by
	// the predictor's `self` accessor, so `ctx.key` starts reporting it on the
	// first application after the reply lands.
	let selfKey = null;

	const predictor = createPredictor({
		apply: options.apply,
		initial: options.initial,
		self: () => selfKey,
		computeError: options.computeError,
		errorThreshold: options.errorThreshold,
		smoothTimeMs: options.smoothTimeMs,
		windowCap: options.windowCap,
		windowMaxAgeMs: options.windowMaxAgeMs
	});
	const smoother = createSmoother({
		delayMs: options.interpolationMs === undefined ? 'auto' : options.interpolationMs,
		extrapolateMs: options.extrapolateMs === undefined ? 250 : options.extrapolateMs,
		snapGapMs: options.snapGapMs === undefined ? 500 : options.snapGapMs
	});

	/** Latest merged remote states (positions interpolate, other fields are
	 * latest-value). The local entity never lives here. */
	const merged = new Map();
	// Cells mode (interest.cells): remote entities arrive on cell topics via the
	// module sink, not the base wire tap. `cellOf` tracks each remote entity's
	// current cell so a transition's stale remove-to-old-cell only drops an entity
	// still in that cell. `smoothName` is the sink registry key (the sync reply's
	// topic name), set when the topic runs cells mode.
	const cellOf = new Map();
	let smoothName = null;
	let destroyed = false;
	let dirty = true;
	let wasOverflowed = false;
	/** The resolved wire topic, learned from the first sync reply. */
	let wireTopic = null;
	/** @type {(() => void) | null} */
	let tapUnsub = null;
	// The inbound tap's subscribe synchronously replays the topic store's
	// current value; a discrete event that landed before the tap bound would
	// otherwise fire stale on bind, so server-event delivery is gated until the
	// tap is live (continuous update/ack/remove frames tolerate the replay).
	let tapLive = false;

	/** @type {Array<{ id: number, cmd: any }>} */
	let outQueue = [];
	let lastFlushMono = -Infinity;

	/** @type {((local: any, remote: Map<string, any>) => void) | null} */
	let frameCb = null;
	/** @type {((overflowed: boolean) => void) | null} */
	let overflowCb = null;
	/** @type {((event: { type: string, key: string, data: any, id: number, origin: 'local' | 'server' }) => void) | null} */
	let eventCb = null;
	let raf = null;

	const localPoint = { x: 0, y: 0 };
	const samplePoint = { x: 0, y: 0 };

	function ingest(ev) {
		if (ev === null || typeof ev !== 'object') return;
		const recvMono = monotonicNow();
		if (ev.event === 'ack') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.id !== 'number') return;
			let ackState = d.state;
			if (wireState !== null) {
				try {
					ackState = wireState.unpack(ackState);
				} catch {
					return; // malformed packed state: drop the frame
				}
			}
			const res = predictor.ack(d.id, ackState, recvMono);
			if (res !== null) {
				if (typeof d.t === 'number' && Number.isFinite(d.t)) {
					if (typeof res.sentMono === 'number') smoother.clock.seed(d.t, res.sentMono, recvMono);
					else smoother.clock.sample(d.t, recvMono);
					smoother.noteServerStamp(d.t);
				}
				if (wasOverflowed && !predictor.overflowed) notifyOverflow(false);
				dirty = true;
			}
			return;
		}
		if (ev.event === 'update') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			let s = d.data;
			if (wireState !== null) {
				try {
					s = wireState.unpack(s);
				} catch {
					return; // malformed packed state: drop the frame
				}
			}
			// An own-key update never enters the remote set (no ghost twin).
			// While commands are in flight the acknowledgement is the
			// reconciliation carrier and the frame is dropped; with nothing
			// pending it is adopted as authoritative continuation - the
			// server moves command-less entities (onMissing) and those
			// updates are the owner's only feedback.
			if (selfKey !== null && d.key === selfKey) {
				if (predictor.rebase(s)) dirty = true;
				return;
			}
			merged.set(d.key, s);
			// The smoother reads the envelope's data.data; hand it the unpacked
			// state (a fresh envelope only when a codec is on - the raw path
			// stays allocation-identical).
			smoother.ingest(wireState === null ? ev : { event: 'update', data: { key: d.key, data: s }, t: ev.t }, recvMono);
			dirty = true;
			return;
		}
		if (ev.event === 'remove') {
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			merged.delete(d.key);
			smoother.ingest(ev, recvMono);
			dirty = true;
			return;
		}
		if (ev.event === 'event') {
			// A discrete event the topic store replays at subscribe time (a
			// one-shot that landed before the tap bound) is stale: the tap is not
			// yet live, so it is dropped rather than fired out of its moment.
			if (!tapLive) return;
			// The authority's broadcast of a discrete one-shot event. The owner's
			// own events are author-excluded server-side (their optimistic copy
			// was delivered locally when the command was issued), so a frame
			// arriving here is another author's - or, for an opt-in `toAuthor`
			// event, the owner's authoritative confirmation, carrying the same
			// `<commandId>:<ordinal>` key the local copy did so the consumer can
			// correlate the two. Discrete events never enter the smoother or the
			// remote set; they are delivered once and not replayed.
			const d = ev.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string' || typeof d.type !== 'string' || typeof d.id !== 'number') return;
			if (eventCb) eventCb({ type: d.type, key: d.key, data: d.data, id: d.id, origin: 'server' });
			return;
		}
		// Any other event (the sync-time 'time' seed rides the sync reply
		// instead; additive future events) feeds the clock path only.
		smoother.ingest(ev, recvMono);
	}

	// Cells-mode inbound: a decoded cell frame (update / remove) tagged with the
	// cell it arrived on. Both feed the SAME merged/smoother path as the base tap's
	// `ingest`; a remove is cell-scoped so a transition's stale remove-to-old-cell
	// cannot drop an entity already re-placed in a new cell (its update re-pointed
	// cellOf first). A self-key update still routes through `ingest` (rebase, no
	// ghost twin), so the owner's own cell echo never double-renders.
	function ingestCell(decoded, cellKey) {
		if (decoded.event === 'update') {
			const d = decoded.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			cellOf.set(d.key, cellKey);
			ingest(decoded);
			return;
		}
		if (decoded.event === 'remove') {
			const d = decoded.data;
			if (d === null || typeof d !== 'object' || typeof d.key !== 'string') return;
			if (cellOf.get(d.key) !== cellKey) return;
			cellOf.delete(d.key);
			ingest(decoded);
		}
	}

	function notifyOverflow(state) {
		wasOverflowed = state;
		if (overflowCb) overflowCb(state);
	}

	let syncInFlight = false;
	let lastSyncAttemptMono = -Infinity;
	// Whether the topic advertised lag compensation on its sync reply. Gates the
	// renderTime stamp on `shoot` so a non-hit-testing topic sends a byte-identical,
	// stampless shot frame (and so a stale flag never survives a reconnect onto a
	// topic that has it off - it is re-read from every sync reply).
	let lcEnabled = false;
	function resync() {
		if (destroyed || syncInFlight) return;
		syncInFlight = true;
		lastSyncAttemptMono = monotonicNow();
		const sendMono = lastSyncAttemptMono;
		Promise.resolve()
			.then(() => transport.sync())
			.then((reply) => {
				syncInFlight = false;
				if (destroyed || reply === null || typeof reply !== 'object') return;
				const recvMono = monotonicNow();
				if (tapUnsub === null && typeof reply.topic === 'string') {
					// First successful sync names the wire topic; the tap binds
					// once and survives reconnects (topic stores are name-keyed).
					// The subscribe replays the store's current value synchronously
					// while `tapLive` is still false, so any event buffered before
					// the bind is dropped; it goes live for every later frame.
					wireTopic = SMOOTH_TOPIC_PREFIX + reply.topic;
					tapUnsub = on(wireTopic).subscribe(ingest);
					tapLive = true;
				}
				if (typeof reply.you === 'string') selfKey = reply.you;
				lcEnabled = reply.lc === 1 || reply.lc === true;
				// Cells mode: register this channel's cell-frame sink under its topic
				// name so the module-level sink routes `__smoothcell:<name>#` frames
				// here. Idempotent across reconnects (name-keyed).
				if ((reply.cells === 1 || reply.cells === true) && typeof reply.topic === 'string') {
					smoothName = reply.topic;
					cellsEnabled = true;
					_cellChannels.set(smoothName, ingestCell);
				}
				merged.clear();
				cellOf.clear();
				// Reset BEFORE seeding: a resync may follow a reconnect onto a
				// different machine, so the old offset estimate and ring axis
				// must not survive into the new seed.
				smoother.reset();
				if (typeof reply.t === 'number' && Number.isFinite(reply.t)) {
					smoother.clock.seed(reply.t, sendMono, recvMono);
				}
				let own;
				const states = Array.isArray(reply.states) ? reply.states : [];
				const bulk = [];
				for (let i = 0; i < states.length; i++) {
					const s = states[i];
					if (!s || typeof s.key !== 'string') continue;
					let st = s.state;
					if (wireState !== null) {
						try {
							st = wireState.unpack(st);
						} catch {
							continue; // malformed packed state: skip this entry
						}
					}
					if (selfKey !== null && s.key === selfKey) {
						own = st;
						continue;
					}
					merged.set(s.key, st);
					bulk.push({ key: s.key, data: st });
				}
				if (bulk.length > 0) {
					smoother.ingest({ event: 'bulk', data: bulk, t: typeof reply.t === 'number' ? reply.t : undefined }, recvMono);
				}
				predictor.sync(own === undefined ? options.initial : own, typeof reply.ack === 'number' ? reply.ack : 0);
				if (wasOverflowed) notifyOverflow(false);
				dirty = true;
			})
			.catch(() => {
				// A failed sync (offline, server restarting) leaves the channel
				// on its current basis; the next 'open' or overflow retries.
				syncInFlight = false;
			});
	}

	function flush(monoNow) {
		if (outQueue.length === 0) return;
		if (monoNow - lastFlushMono < minFlushMs) return;
		lastFlushMono = monoNow;
		const batch = outQueue;
		outQueue = [];
		transport.sendCommand(batch);
	}

	// A channel without a frame consumer (headless commanding) still flushes:
	// the render loop is the flush pump only while it runs.
	let flushTimer = null;
	function scheduleFlush() {
		if (raf !== null || flushTimer !== null || destroyed) return;
		flushTimer = setTimer(() => {
			flushTimer = null;
			const mono = monotonicNow();
			flush(mono);
			if (outQueue.length > 0) scheduleFlush();
		}, Math.max(minFlushMs, 16));
	}

	function loop() {
		if (destroyed) return;
		raf = scheduleFrame(loop);
		const mono = monotonicNow();
		flush(mono);
		if (predictor.checkOverflow(mono)) {
			// The server went silent past the window bound: surface it and
			// run a recovery sync - retried at a modest cadence while the
			// episode persists, so a sync that failed during the same stall
			// does not strand the channel on a healthy connection.
			if (!wasOverflowed) {
				notifyOverflow(true);
				resync();
			} else if (!syncInFlight && mono - lastSyncAttemptMono > 1000) {
				resync();
			}
		}
		const renderTime = smoother.beginFrame(mono);
		const localMotion = predictor.renderInto(localPoint, mono);
		if (!dirty && !smoother.motionPending && !localMotion) return;
		dirty = false;
		if (frameCb === null) return;

		const predicted = predictor.predicted;
		let local = predicted;
		if (predicted !== null && typeof predicted === 'object' && typeof predicted.x === 'number') {
			local = { ...predicted, x: localPoint.x, y: localPoint.y };
		}
		const remote = new Map();
		for (const [key, state] of merged) {
			if (state !== null && typeof state === 'object' && typeof state.x === 'number') {
				const s = smoother.sampleInto(key, renderTime, samplePoint);
				remote.set(key, s === SAMPLE_EMPTY ? state : { ...state, x: samplePoint.x, y: samplePoint.y });
			} else {
				remote.set(key, state);
			}
		}
		frameCb(local, remote);
	}

	// The status store delivers the current value on subscribe, so a channel
	// constructed on an already-open connection syncs immediately.
	const statusUnsub = status.subscribe((s) => {
		if (s === 'open') resync();
	});

	return {
		/**
		 * Submit one command: predicted locally this frame, transmitted on
		 * the next flush, reconciled when its acknowledgement returns.
		 * @param {any} cmd
		 * @returns {number} the command id
		 */
		command(cmd) {
			const mono = monotonicNow();
			const id = predictor.command(cmd, mono);
			if (predictor.overflowed && !wasOverflowed) {
				notifyOverflow(true);
				resync();
			}
			// Queue and schedule the transmit BEFORE delivering local events. A
			// command issued from inside an onEvent handler then enqueues strictly
			// after this one, so the transport batch stays in id order - the order
			// the predictor (and the authority) apply commands in; queuing after
			// the callback would reverse them and force a reconciliation snap.
			// The wire view packs only the transmit copy - the predictor replays
			// the original object.
			outQueue.push({ id, cmd: wireCommand === null ? cmd : wireCommand.pack(cmd) });
			scheduleFlush();
			dirty = true;
			// Deliver the discrete events `apply` emitted on this optimistic
			// application (`origin:'local'`) the same frame the command was
			// issued. The drain runs unconditionally so the predictor's event
			// sink starts the next command empty; a killed or overflowed command
			// runs no apply and drains nothing. The drained array is snapshotted
			// before any callback fires, and the transmit is already queued, so a
			// consumer that issues a command from its handler is fully safe.
			const events = predictor.drainEvents();
			if (eventCb !== null) {
				for (let i = 0; i < events.length; i++) {
					const e = events[i];
					eventCb({ type: e.type, key: e.key, data: e.data, id: e.id, origin: 'local' });
				}
			}
			return id;
		},

		/**
		 * Fire a shot: a fire-and-forget, non-predicted command the server resolves
		 * against the rewound world (lag compensation). Unlike `command`, it never
		 * enters the prediction ring - a shot owns no entity state to predict, and its
		 * outcome (a hit) arrives as an authoritative event, not a reconciliation. It
		 * stamps the render-time the shooter saw the world at - the synced server clock
		 * minus the interpolation delay, the same instant remote entities are rendered
		 * at - so the server rewinds directly to it. The stamp is appended only when
		 * the topic advertised lag compensation (its `hitTest`), so a topic without it
		 * sends a byte-identical, stampless frame. Inert if the transport predates the
		 * shoot path.
		 * @param {any} cmd
		 */
		shoot(cmd) {
			if (typeof transport.sendShoot !== 'function') return;
			// A shot is a command on the wire: the same wire view packs it.
			const wcmd = wireCommand === null ? cmd : wireCommand.pack(cmd);
			if (!lcEnabled) {
				transport.sendShoot({ cmd: wcmd });
				return;
			}
			// Cold start: until the server clock has a sample, a render-time built from
			// the raw local wall clock would be arbitrarily skewed (an un-synced laptop
			// can be seconds off). Suppress the stamp and let the server resolve at
			// present - an honest miss on a moving target, never a wrong-position hit.
			const est = smoother.clock.estServerNow(monotonicNow());
			if (est === null) {
				transport.sendShoot({ cmd: wcmd });
				return;
			}
			// Echo the latest absolute server stamp so the server measures the round
			// trip against its OWN send time (both ends server-authored) - the client
			// cannot fake a lower latency, only inflate it (bounded + detectable).
			const ackT = smoother.lastServerT;
			const rt = est - smoother.delay;
			if (ackT >= 0) transport.sendShoot({ cmd: wcmd, rt, ackT });
			else transport.sendShoot({ cmd: wcmd, rt });
		},

		/**
		 * Attach the per-frame consumer and start the render loop. One
		 * consumer per channel; the reactive wrapper above owns fan-out.
		 * @param {(local: any, remote: Map<string, any>) => void} cb
		 */
		onFrame(cb) {
			frameCb = cb;
			dirty = true;
			if (raf === null && !destroyed) raf = scheduleFrame(loop);
		},

		/**
		 * Observe prediction-killed transitions (window overflow and its
		 * recovery) - the app health surface's input.
		 * @param {(overflowed: boolean) => void} cb
		 */
		onOverflow(cb) {
			overflowCb = cb;
		},

		/**
		 * Attach the discrete-event consumer for `ctx.emitEvent` fires. Each
		 * `command` delivers the events its `apply` emitted with `origin:'local'`
		 * (the optimistic copy, drawn the frame the command was issued); the
		 * authority's broadcast - other authors' events, and an opt-in
		 * `toAuthor` event's own authoritative confirmation - arrives with
		 * `origin:'server'`. The optimistic and authoritative copies of one
		 * event share a `<commandId>:<ordinal>` key, so a consumer that receives
		 * both can correlate them. One consumer per channel; the reactive
		 * wrapper above owns fan-out. Events are not buffered - fires before the
		 * consumer attaches (and server events before the first sync binds the
		 * tap) are dropped, so attach it before the first command, like onFrame.
		 * @param {(event: { type: string, key: string, data: any, id: number, origin: 'local' | 'server' }) => void} cb
		 */
		onEvent(cb) {
			eventCb = cb;
		},

		/** Re-request the authoritative catalog (also runs on every 'open'). */
		resync,

		/**
		 * The estimated server wall-clock time, for stamping commands and
		 * compensated actions with the same clock the smoothing runs on.
		 * Falls back to the local wall clock before the first sample. Safe
		 * alongside the render loop: every estimator reading here and in the
		 * loop is a fresh monotonic sample, so the slew limiter only ever
		 * advances.
		 * @returns {number}
		 */
		now() {
			const est = smoother.clock.estServerNow(monotonicNow());
			return est === null ? now() : est;
		},

		/** The caller's own entity key, once the sync reply announced it. */
		get self() {
			return selfKey;
		},

		/** The current prediction (simulation truth, no easing offset). */
		get predicted() {
			return predictor.predicted;
		},

		/** Commands awaiting acknowledgement. */
		get windowSize() {
			return predictor.windowSize;
		},

		/** True while prediction is killed pending recovery. */
		get overflowed() {
			return predictor.overflowed;
		},

		/** The applied interpolation delay (ms) - diagnostics. */
		get delay() {
			return smoother.delay;
		},

		/** The applied clock offset (ms), or null - diagnostics. */
		get clockOffset() {
			return smoother.clock.offset();
		},

		/**
		 * A one-shot telemetry snapshot of the channel's prediction + interpolation
		 * state, for a devtools / per-stream inspector. Pull-based, so it costs
		 * nothing when nothing reads it - read it on a panel's refresh tick.
		 * `unacked`/`windowCap` are the reconciliation window (unacked nearing the
		 * cap predicts an overflow kill); `lastDivergence` is the most recent
		 * reconciliation error magnitude and `correcting` whether a correction is
		 * still easing in; `interpDelayMs` is the applied remote render-behind;
		 * `clockSynced` is whether the server-clock estimate has a sample yet.
		 * @param {number} [monoNow]
		 * @returns {{ self: string | null, topic: string | null, overflowed: boolean, unacked: number, windowCap: number, lastDivergence: number, correcting: boolean, interpDelayMs: number, clockSynced: boolean, remoteCount: number }}
		 */
		stats(monoNow) {
			const mono = typeof monoNow === 'number' ? monoNow : monotonicNow();
			return {
				self: selfKey,
				topic: wireTopic,
				overflowed: predictor.overflowed,
				unacked: predictor.windowSize,
				windowCap: predictor.windowCap,
				lastDivergence: predictor.lastDivergence,
				correcting: predictor.correcting,
				interpDelayMs: smoother.delay,
				clockSynced: smoother.clock.estServerNow(mono) !== null,
				remoteCount: merged.size
			};
		},

		/** The resolved wire topic, or null before the first sync reply. */
		get topic() {
			return wireTopic;
		},

		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (smoothName !== null && _cellChannels.get(smoothName) === ingestCell) _cellChannels.delete(smoothName);
			cellOf.clear();
			if (tapUnsub !== null) tapUnsub();
			statusUnsub();
			cancelFrame(raf);
			raf = null;
			if (flushTimer !== null) {
				clearTimer(flushTimer);
				flushTimer = null;
			}
			frameCb = null;
			overflowCb = null;
			eventCb = null;
			outQueue = [];
			merged.clear();
			smoother.reset();
			predictor.reset();
		}
	};
}
