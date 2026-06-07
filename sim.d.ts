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

export interface SimConfig {
	/** Seed string; the same seed reproduces the run bit-for-bit. */
	seed?: string;
	clients?: number;
	topics?: string[];
	/** Max scheduler rounds per drive call. */
	steps?: number;
	faults?: SimFaults;
	/** The WS handler hooks under test (open/message/subscribe/etc.). */
	handler?: Record<string, any>;
	/** Scripts client actions; defaults to connect+subscribe+publish. */
	scenario?: (api: SimApi, opts: { clients: number; topics: string[] }) => void | Promise<void>;
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

export interface SimResult {
	seed: string;
	gitCommit: string | null;
	config: { clients: number; topics: string[]; steps: number; faults: SimFaults; tz: string | null; startEpoch: number; allowSystemTopicSubscribe: boolean; allowNonAsciiTopics: boolean };
	steps: number;
	virtualTimeMs: number;
	invariantViolations: Array<{ category: string; context: any }>;
	fatals: Array<{ category: string; context: any }>;
	schedulerUncaught: string[];
	metrics: { clients: number; framesDelivered: number };
	clientFrames: any[][];
	finalState: {
		connections: Array<{ id: number; subscribed: string[]; bookkeeping: string[] | null }>;
		topicCounts: Record<string, number>;
		openConnections: number;
	};
	/** True only on a replaySim result whose violations + state matched the reproducer. */
	reproduced?: boolean;
}

export function runSim(config?: SimConfig): Promise<SimResult>;
export function runSimMany(spec: SimConfig[] | { seeds: string[]; base?: SimConfig }): Promise<SimResult[]>;
export function replaySim(reproducer: SimResult): Promise<SimResult>;

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

export const DEFAULT_SEED: string;
export const FIXED_EPOCH: number;
