import type { SmoothApply } from './server.js';

export { createSharedRandom, type SharedRandom } from './random.js';

export interface SmoothChannelTransport<Command = any> {
	/**
	 * Transmit a command batch. A lossy fire-and-forget send is the intended
	 * carrier: command loss is recovered by reconciliation, never by
	 * retransmission.
	 */
	sendCommand(batch: Array<{ id: number; cmd: Command }>): void;
	/**
	 * Transmit a shot: a fire-and-forget, non-predicted command resolved against
	 * the server's rewound world. Optional - a transport that predates the shoot
	 * path omits it, and `channel.shoot` is then inert. The `rt` stamp (the
	 * shooter's render-time on the synced server axis) is present only when the
	 * topic advertised lag compensation.
	 */
	sendShoot?(payload: { cmd: Command; rt?: number; ackT?: number }): void;
	/**
	 * Request the authoritative catalog: the resolved topic name, the server
	 * time stamp (the clock seed), the caller's own entity key, its ack
	 * watermark, and every entity's state. Runs on every connection 'open'
	 * and once per overflow recovery. `lc` advertises that the topic runs lag
	 * compensation (its `hitTest`), the cue for `shoot` to stamp its render-time.
	 */
	sync(): Promise<{
		topic?: string;
		t?: number;
		you?: string;
		ack?: number;
		states?: Array<{ key: string; state: any }>;
		lc?: 0 | 1;
	} | null | undefined>;
}

export interface SmoothChannelOptions<State = any, Command = any> {
	/** The shared simulation step (the same module the server applies). */
	apply: SmoothApply<State, Command>;
	/** The local entity's starting state. */
	initial: State;
	/** The injected transport (generated send paths, or a harness script). */
	transport: SmoothChannelTransport<Command>;
	/** Divergence measure for reconciliation corrections; defaults to the
	 * Euclidean distance between the states' `x`/`y`. */
	computeError?: (before: State, after: State) => number;
	/** Divergence at or below this snaps silently; above it the correction
	 * eases over `smoothTimeMs` (default 1). */
	errorThreshold?: number;
	/** Correction easing window in ms; 0 = always snap (default 100). */
	smoothTimeMs?: number;
	/** Un-acked command count bound; beyond it prediction is killed pending
	 * recovery (default 256). */
	windowCap?: number;
	/** Un-acked command age bound in ms (default 3000). */
	windowMaxAgeMs?: number;
	/** How far in the past remote entities render; `'auto'` (default) tracks
	 * twice the measured update interval. */
	interpolationMs?: 'auto' | number;
	/** Hard cap on dead-reckoning when the remote buffer runs dry (default 250). */
	extrapolateMs?: number;
	/** Remote sample gap treated as a discontinuity and snapped (default 500). */
	snapGapMs?: number;
	/** Maximum command flushes per second (default 60 - one per frame). */
	cmdRate?: number;
}

export interface SmoothChannelEvent<Data = any> {
	/** The event type passed to `ctx.emitEvent(type, ...)`. */
	type: string;
	/** The correlation key: `<commandId>:<ordinal>` by default, or an explicit
	 * `opts.key`. The optimistic and authoritative copies of one event share
	 * it, so a consumer that receives both can match them. */
	key: string;
	/** The payload passed to `ctx.emitEvent(type, data)`. */
	data: Data;
	/** The id of the command whose `apply` emitted the event. */
	id: number;
	/** `'local'` for the optimistic copy delivered when the command was issued;
	 * `'server'` for the authority's broadcast. */
	origin: 'local' | 'server';
}

export interface SmoothChannel<State = any, Command = any> {
	/** Submit one command: predicted locally this frame, transmitted on the
	 * next flush, reconciled when its acknowledgement returns. */
	command(cmd: Command): number;
	/** Fire a shot: a fire-and-forget, non-predicted command the server resolves
	 * against the rewound world (lag compensation). Stamps the shooter's
	 * render-time (synced clock minus interpolation delay) when the topic
	 * advertised its `hitTest`; the outcome arrives as an authoritative event, not
	 * a reconciliation. Inert if the transport predates the shoot path. */
	shoot(cmd: Command): void;
	/** Attach the per-frame consumer and start the render loop. `local` is
	 * the rendered local state (prediction plus any decaying correction);
	 * `remote` maps entity keys to interpolated states. */
	onFrame(cb: (local: State, remote: Map<string, State>) => void): void;
	/** Observe prediction-killed transitions (overflow and recovery). */
	onOverflow(cb: (overflowed: boolean) => void): void;
	/** Attach the discrete-event consumer for `ctx.emitEvent` fires. `command`
	 * delivers the events its `apply` emitted with `origin:'local'` (the
	 * optimistic copy, drawn the frame it was issued); the authority's
	 * broadcast - other authors' events, and an opt-in `toAuthor` event's own
	 * confirmation - arrives `origin:'server'`, sharing the correlation key so
	 * both copies of one event can be matched. One consumer per channel. */
	onEvent(cb: (event: SmoothChannelEvent) => void): void;
	/** Re-request the authoritative catalog (also runs on every 'open'). */
	resync(): void;
	/** The estimated server wall-clock time - the stamp source for commands
	 * and compensated actions. */
	now(): number;
	/** The caller's own entity key, once the sync reply announced it. */
	readonly self: string | null;
	/** The current prediction (simulation truth, no easing offset). */
	readonly predicted: State;
	/** Commands awaiting acknowledgement. */
	readonly windowSize: number;
	/** True while prediction is killed pending recovery. */
	readonly overflowed: boolean;
	/** The applied interpolation delay (ms) - diagnostics. */
	readonly delay: number;
	/** The applied clock offset (ms), or null - diagnostics. */
	readonly clockOffset: number | null;
	/** The resolved wire topic, or null before the first sync reply. */
	readonly topic: string | null;
	/**
	 * A one-shot telemetry snapshot of the prediction + interpolation state, for
	 * a devtools / per-stream inspector. Pull-based (read on a panel refresh tick),
	 * so it costs nothing when nothing reads it. `monoNow` defaults to the current
	 * monotonic clock.
	 */
	stats(monoNow?: number): SmoothChannelStats;
	destroy(): void;
}

/** The shape returned by {@link SmoothChannel.stats}. */
export interface SmoothChannelStats {
	/** The caller's own entity key, or null before the sync reply announced it. */
	self: string | null;
	/** The resolved wire topic, or null before the first sync reply. */
	topic: string | null;
	/** True while prediction is killed pending recovery (window overflow). */
	overflowed: boolean;
	/** Commands awaiting acknowledgement (the reconciliation window depth). */
	unacked: number;
	/** The window cap; `unacked` nearing it predicts an overflow kill. */
	windowCap: number;
	/** The most recent reconciliation error magnitude (0 until the first reconcile). */
	lastDivergence: number;
	/** True while a reconciliation correction is still easing in. */
	correcting: boolean;
	/** The applied remote render-behind interpolation delay (ms). */
	interpDelayMs: number;
	/** Whether the server-clock estimate has a sample yet. */
	clockSynced: boolean;
	/** Number of remote entities currently merged. */
	remoteCount: number;
}

/**
 * Create the client-side channel for one smoothed topic: prediction for the
 * local entity, render-in-the-past interpolation for remote entities, and
 * the wire glue between them. Importing this module opts the connection into
 * binary smooth frames (`smooth.protocol:1` rides the first hello). Options
 * are validated eagerly; the wire topic is announced by the first sync reply
 * (the topic resolves server-side), so the inbound tap binds on the first
 * successful sync while commands flow immediately.
 */
export function createSmoothChannel<State = any, Command = any>(
	options: SmoothChannelOptions<State, Command>
): SmoothChannel<State, Command>;
