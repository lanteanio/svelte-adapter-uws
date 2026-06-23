// Type declarations for the deterministic simulation runner
// (svelte-adapter-uws/sim).

export interface SimFaults {
	/** Probability in [0,1] that a wire frame is dropped. */
	drop?: number;
	/** Probability in [0,1] that a wire frame is re-delivered. */
	duplicate?: number;
	/** Probability in [0,1] that a wire frame has one byte flipped. */
	corrupt?: number;
	/** Fixed delay (ms) or a [min,max] range sampled per frame. */
	delayMs?: number | [number, number];
	/** Probability in [0,1] that a frame gets independent jitter (reorder). */
	reorder?: number;
	/** Cap on the sampled jitter window (ms). */
	maxJitterMs?: number;
}

export interface SimClientFacade {
	readonly state: 'connecting' | 'open' | 'rejected' | 'closed';
	readonly rejection: { status: string; body: string } | null;
	readonly closeInfo: { code: number; reason: string } | null;
	readonly serverWs: any;
	frames(): Array<{ payload: string | Uint8Array; isBinary: boolean }>;
	texts(): string[];
	json(): any[];
	onMessage(cb: (frame: { payload: string | Uint8Array; isBinary: boolean }) => void): void;
	sendRaw(payload: string | Uint8Array, isBinary?: boolean): boolean;
	send(obj: unknown): boolean;
	subscribe(topic: string, ref?: number | string): boolean;
	unsubscribe(topic: string): boolean;
	/** Abort an in-flight upgrade; returns false if not still connecting. */
	abort(): boolean;
	close(code?: number, reason?: string): void;
}

export interface SimApi {
	rng: SeededRng;
	now(): number;
	server: any;
	app: InMemoryApp;
	connect(opts?: { headers?: Record<string, string>; query?: string }): SimClientFacade;
	publish(topic: string, event: string, data?: unknown, options?: unknown): boolean;
	publishBatched(messages: unknown[], options?: unknown): void;
	advance(rounds?: number): Promise<void>;
}

/** One worker's handle within a multi-worker scenario. */
export interface SimWorkerApi {
	connect(opts?: { headers?: Record<string, string>; query?: string }): SimClientFacade | null;
	clients(): SimClientFacade[];
	publish(topic: string, event: string, data?: unknown, options?: unknown): boolean;
	publishBatched(messages: unknown[], options?: unknown): void;
}

/** The api passed to a multi-worker scenario (runSim with `workers` > 1). */
export interface SimClusterApi {
	rng: SeededRng;
	now(): number;
	workersCount: number;
	worker(id: number): SimWorkerApi;
	/** Restart a worker (close its connections, then respawn under the budget). Pass
	 *  `{ recover: false }` to model a worker that crashes on every restart. */
	flapWorker(id: number, opts?: { recover?: boolean }): void;
	/** Stop a worker acking heartbeats so the supervisor terminates it after the timeout. */
	wedgeWorker(id: number): void;
	advance(rounds?: number): Promise<void>;
	/** Advance the virtual clock by `ms`, firing time-driven supervisor behaviour. */
	advanceTime(ms: number): Promise<void>;
}

export interface SimConfig {
	/** Seed string; the same seed reproduces the run bit-for-bit. */
	seed?: string;
	clients?: number;
	topics?: string[];
	/** Max scheduler rounds per drive call. */
	steps?: number;
	faults?: SimFaults;
	/** Number of workers to model. Omitted or 1 runs the single-worker path
	 *  (byte-identical to a non-cluster run); > 1 builds a cluster cohort. */
	workers?: number;
	/** Cluster topology when `workers` > 1. Defaults to 'reuseport'. */
	clusterMode?: 'reuseport' | 'acceptor';
	/** Fault spec applied to the cross-worker relay (IPC) channel, independent of
	 *  the per-worker `faults` (the client wire channel). Multi-worker only. */
	relayFaults?: SimFaults;
	/** The WS handler hooks under test (open/message/subscribe/etc.). */
	handler?: Record<string, any>;
	/** Scripts client actions; defaults to connect+subscribe+publish. A multi-worker
	 *  scenario receives the cluster api and a `workers` count. */
	scenario?: (api: SimApi & SimClusterApi, opts: { clients: number; topics: string[]; workers?: number }) => void | Promise<void>;
	tz?: string;
	startEpoch?: number;
	/** Pins the source for a cross-process reproducer; the CI/caller supplies it. */
	gitCommit?: string;
	allowSystemTopicSubscribe?: boolean;
	allowNonAsciiTopics?: boolean;
	/** Forwarded to createTestServer to make the upgrade-admission gate live. */
	upgradeAdmission?: Record<string, any>;
	protection?: 'normal' | 'auto' | 'elevated' | 'siege';
}

/** A single-server structural snapshot (the single-worker finalState). */
export interface SimSnapshot {
	connections: Array<{ id: number; subscribed: string[]; bookkeeping: string[] | null }>;
	topicCounts: Record<string, number>;
	openConnections: number;
}

/** The multi-worker finalState aggregate (one snapshot per worker, sorted by id). */
export interface SimClusterFinalState {
	workers: Array<{ id: number } & SimSnapshot>;
	framesDelivered: Array<{ worker: number; frames: number }>;
}

/** A reproducible supervisor outcome (e.g. a worker that died after N restarts). */
export interface SimFatal {
	worker: number;
	reason: string;
	attempts: number;
	schedule: number[];
}

export interface SimResult {
	seed: string;
	gitCommit: string | null;
	/** Multi-worker runs additionally carry `workers`, `clusterMode`, `relayFaults`. */
	config: { clients: number; topics: string[]; steps: number; faults: SimFaults; tz: string | null; startEpoch: number; allowSystemTopicSubscribe: boolean; allowNonAsciiTopics: boolean; workers?: number; clusterMode?: 'reuseport' | 'acceptor'; relayFaults?: SimFaults };
	steps: number;
	virtualTimeMs: number;
	invariantViolations: Array<{ category: string; context: any }>;
	fatals: SimFatal[];
	schedulerUncaught: string[];
	/** Multi-worker runs extend metrics with workers/relay/restarts/flaps/wedges/workersLive/listenPaused. */
	metrics: { clients: number; framesDelivered: number; workers?: number; relay?: { forwarded: number; delivered: number; dropped: number }; restarts?: number; flaps?: number; wedges?: number; workersLive?: number; listenPaused?: boolean };
	clientFrames: any[][];
	/** Per-worker client frames (multi-worker only), sorted by worker id. */
	clusterFrames?: Array<{ worker: number; clients: any[][] }>;
	finalState: SimSnapshot | SimClusterFinalState;
	/** True only on a replaySim result whose violations + state + fatals + cluster frames matched the reproducer. */
	reproduced?: boolean;
}

export function runSim(config?: SimConfig): Promise<SimResult>;
export function runSimMany(spec: SimConfig[] | { seeds: string[]; base?: SimConfig }): Promise<SimResult[]>;
export function replaySim(reproducer: SimResult): Promise<SimResult>;

/** One run's compact outcome within a swarm. The heavy SimResult is discarded;
 *  the seed reproduces it on demand via runSim. */
export interface SimSwarmRun {
	seed: string;
	/** Clean: no invariant/fatal/uncaught failure, and (if re-checked) it reproduced. */
	ok: boolean;
	/** Whether this run had the fault profile enabled (see buggify). */
	buggified: boolean;
	/** 8-hex-char structural fingerprint (the "unseed" determinism canary). */
	fingerprint: string;
	violations: number;
	fatals: number;
	uncaught: number;
	violationCategories: string[];
	/** null when this run was not selected for the determinism re-check. */
	reproduced: boolean | null;
}

export interface SimSwarmSummary {
	total: number;
	/** Runs that were fully clean (ok === true). */
	passed: number;
	/** Runs with at least one invariant violation, fatal, or uncaught error. */
	failed: number;
	/** The first failing seed - the entire local reproduce command - or null. */
	firstFailingSeed: string | null;
	failingSeeds: string[];
	buggify: 'off' | 'on' | 'random';
	/** How many runs had the fault profile enabled. */
	buggified: number;
	/** How many runs were re-checked for determinism (the checkRatio sample). */
	determinismChecks: number;
	/** Re-checked runs that failed to reproduce (a determinism regression). */
	determinismFailures: number;
	determinismFailingSeeds: string[];
	gitCommit: string | null;
	/** True iff no invariant failures and no determinism regressions. */
	ok: boolean;
}

export interface SimSwarmConfig {
	/** Explicit seed list; takes precedence over count/startSeed. */
	seeds?: Array<string | number>;
	/** Number of consecutive integer seeds to run (default 50). */
	count?: number;
	/** First integer seed when using `count` (default 1). */
	startSeed?: number;
	/** Base SimConfig applied to every run (its `seed`/`faults` are overridden per run). */
	base?: SimConfig;
	/** Fault-enablement knob. 'off' (default), 'on' (always layer faultProfile), or
	 *  'random' (a per-seed seeded coin at buggifyProbability). */
	buggify?: 'off' | 'on' | 'random';
	/** The fault profile layered on when a run is buggified. */
	faultProfile?: SimFaults;
	/** Probability a run is buggified under buggify:'random' (default 0.25). */
	buggifyProbability?: number;
	/** Fraction in [0,1] of runs also replayed to assert determinism (default 0). */
	checkRatio?: number;
	gitCommit?: string;
	/** Called as each run completes; a runner streams progress through it. */
	onResult?: (run: SimSwarmRun, index: number) => void;
}

export interface SimSwarmResult {
	summary: SimSwarmSummary;
	runs: SimSwarmRun[];
}

export function runSimSwarm(config?: SimSwarmConfig): Promise<SimSwarmResult>;

// - Building blocks (re-exported for advanced harnesses) ---------------------

export interface SeededRng {
	float(): number;
	u32(): number;
	bytes(n: number): Uint8Array;
	uuid(): string;
	int(n: number): number;
}

export interface InMemoryApp {
	ws(path: string, behavior: Record<string, any>): InMemoryApp;
	get(path: string, handler: Function): InMemoryApp;
	publish(topic: string, message: string | Uint8Array, isBinary?: boolean, compress?: boolean): boolean;
	numSubscribers(topic: string): number;
	listen(...args: any[]): InMemoryApp;
	connect(opts?: { headers?: Record<string, string>; query?: string }): SimClientFacade;
}

export function createSeededRng(seed: string | number): SeededRng;
export function createScheduler(opts?: { startEpoch?: number; tz?: string }): any;
export function createFaultEngine(opts: { rng: SeededRng; faults?: SimFaults }): { plan(payload: string | Uint8Array): Array<{ delayMs: number; payload: string | Uint8Array }>; active: boolean };
export function createInMemoryApp(opts: { scheduler: any; faultEngine: any; port?: number }): InMemoryApp;

/** The runtime-seam env that `createScheduler(...).buildEnv(rng)` produces. */
export interface RuntimeEnv {
	clock: { now(): number; monotonic(): number; wallEpoch(): number };
	rng: { float(): number; u32(): number; uuid(): string; bytes(n: number): Uint8Array };
	timers: {
		set(cb: Function, ms?: number, ...args: any[]): any;
		setInterval(cb: Function, ms?: number, ...args: any[]): any;
		setImmediate(cb: Function, ...args: any[]): any;
		clear(handle: any): void;
		clearInterval(handle: any): void;
		queueMicrotask(cb: Function): void;
	};
	tz?: string;
}

/** The uWS helper bundle createTestServer needs alongside the in-memory app. */
export interface InMemoryUwsHelpers {
	App(): InMemoryApp;
	SSLApp(): InMemoryApp;
	us_socket_local_port(): number;
	us_listen_socket_close(): void;
	SHARED_COMPRESSOR: number;
	DISABLED: number;
}

// Composition primitives: install/teardown the runtime seam, re-latch the
// per-process epoch, and build the uWS helper bundle - so a downstream package
// can drive createTestServer over the in-memory app on the same virtual clock.
export function setRuntimeEnv(env: Partial<RuntimeEnv>, opts?: { force?: boolean }): void;
export function resetRuntimeEnv(): void;
export function resetProcessEpoch(): void;
export function createInMemoryUwsHelpers(app: InMemoryApp): InMemoryUwsHelpers;

export const DEFAULT_SEED: string;
export const FIXED_EPOCH: number;
