import { monotonicNow } from '../runtime.js';
import { runMessageHook } from './hook-boundary.js';

const DEFAULT_WINDOW_MS = 1000;
const MESSAGE_ADMISSION_KEYS = new Set([
	'perConnectionRate', 'globalRate', 'rateWindowMs',
	'perConnectionConcurrent', 'globalConcurrent', 'maxQueue'
]);
const STATIC_OVERLOAD_FRAMES = Object.freeze({
	'concurrency_limit:connection': '{"type":"message-overloaded","reason":"concurrency_limit","scope":"connection"}',
	'concurrency_limit:global': '{"type":"message-overloaded","reason":"concurrency_limit","scope":"global"}',
	'queue_full:connection': '{"type":"message-overloaded","reason":"queue_full","scope":"connection"}',
	'queue_full:global': '{"type":"message-overloaded","reason":"queue_full","scope":"global"}'
});

function limit(value, name, { positive = false } = {}) {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
		throw new TypeError(`${name} must be ${positive ? 'a positive' : 'a non-negative'} safe integer.`);
	}
	return value;
}

/**
 * Validate and normalize the established-message admission options.
 *
 * Every limit is per worker. A zero limit is disabled. Rate permits use a
 * token bucket, while concurrency overflow may wait in one bounded FIFO.
 *
 * @param {unknown} input
 * @param {string} [prefix]
 */
export function normalizeMessageAdmission(input, prefix = 'messageAdmission') {
	if (input === undefined) {
		return Object.freeze({
			perConnectionRate: 0,
			globalRate: 0,
			rateWindowMs: DEFAULT_WINDOW_MS,
			perConnectionConcurrent: 0,
			globalConcurrent: 0,
			maxQueue: 0
		});
	}
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`${prefix} must be an object.`);
	}
	const value = /** @type {Record<string, unknown>} */ (input);
	const unknown = Object.keys(value).filter((key) => !MESSAGE_ADMISSION_KEYS.has(key));
	if (unknown.length > 0) {
		throw new TypeError(`${prefix} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
	}
	const perConnectionRate = limit(value.perConnectionRate, `${prefix}.perConnectionRate`);
	const globalRate = limit(value.globalRate, `${prefix}.globalRate`);
	const rateWindowMs = value.rateWindowMs === undefined
		? DEFAULT_WINDOW_MS
		: limit(value.rateWindowMs, `${prefix}.rateWindowMs`, { positive: true });
	const normalized = {
		perConnectionRate,
		globalRate,
		rateWindowMs,
		perConnectionConcurrent: limit(value.perConnectionConcurrent, `${prefix}.perConnectionConcurrent`),
		globalConcurrent: limit(value.globalConcurrent, `${prefix}.globalConcurrent`),
		maxQueue: limit(value.maxQueue, `${prefix}.maxQueue`)
	};
	if (normalized.maxQueue > 0 && normalized.perConnectionConcurrent === 0 && normalized.globalConcurrent === 0) {
		throw new TypeError(`${prefix}.maxQueue requires perConnectionConcurrent or globalConcurrent.`);
	}
	return Object.freeze(normalized);
}

function refill(bucket, capacity, windowMs, at) {
	if (bucket === null) return { tokens: capacity, updatedAt: at };
	const elapsed = Math.max(0, at - bucket.updatedAt);
	return {
		tokens: Math.min(capacity, bucket.tokens + elapsed * capacity / windowMs),
		updatedAt: at
	};
}

function rateRejection(scope, bucket, capacity, windowMs) {
	return {
		ok: false,
		reason: 'rate_limit',
		scope,
		retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) * windowMs / capacity))
	};
}

/**
 * Create a worker-local gate for application WebSocket messages.
 *
 * `enter()` never retains the native message buffer. It returns synchronously
 * so the caller can copy only frames that actually have to wait in the queue.
 *
 * @param {unknown} input
 * @param {() => number} [clock]
 */
export function createMessageAdmission(input, clock = monotonicNow) {
	const config = normalizeMessageAdmission(input);
	const enabled = config.perConnectionRate > 0 || config.globalRate > 0 ||
		config.perConnectionConcurrent > 0 || config.globalConcurrent > 0;
	/** @type {WeakMap<object, { active: number, queued: number, rate: { tokens: number, updatedAt: number } | null, closed: boolean }>} */
	const connections = new WeakMap();
	/** @type {Array<{ ws: object, state: any, resolve: (value: any) => void }>} */
	const queue = [];
	let active = 0;
	/** @type {{ tokens: number, updatedAt: number } | null} */
	let globalBucket = null;

	const stateFor = (ws) => {
		let state = connections.get(ws);
		if (state === undefined) {
			state = { active: 0, queued: 0, rate: null, closed: false };
			connections.set(ws, state);
		}
		return state;
	};
	const canStart = (state) =>
		(config.globalConcurrent === 0 || active < config.globalConcurrent) &&
		(config.perConnectionConcurrent === 0 || state.active < config.perConnectionConcurrent);
	const permit = (state) => {
		active++;
		state.active++;
		let released = false;
		return {
			ok: true,
			release() {
				if (released) return;
				released = true;
				active--;
				state.active--;
				drain();
			}
		};
	};
	const blockedScope = (state) =>
		config.perConnectionConcurrent > 0 && state.active >= config.perConnectionConcurrent
			? 'connection'
			: 'global';
	const drain = () => {
		for (;;) {
			let index = -1;
			for (let i = 0; i < queue.length; i++) {
				if (!queue[i].state.closed && canStart(queue[i].state)) {
					index = i;
					break;
				}
			}
			if (index === -1) return;
			const [entry] = queue.splice(index, 1);
			entry.state.queued--;
			entry.resolve(permit(entry.state));
		}
	};

	return Object.freeze({
		enabled,
		config,
		get active() { return active; },
		get queued() { return queue.length; },
		/** @param {object} ws */
		enter(ws) {
			if (!enabled) return permit(stateFor(ws));
			const state = stateFor(ws);
			if (state.closed) return { ok: false, reason: 'connection_closed', scope: 'connection' };

			const at = clock();
			let nextConnectionBucket = null;
			let nextGlobalBucket = null;
			if (config.perConnectionRate > 0) {
				nextConnectionBucket = refill(state.rate, config.perConnectionRate, config.rateWindowMs, at);
				if (nextConnectionBucket.tokens < 1) {
					state.rate = nextConnectionBucket;
					return rateRejection('connection', nextConnectionBucket, config.perConnectionRate, config.rateWindowMs);
				}
			}
			if (config.globalRate > 0) {
				nextGlobalBucket = refill(globalBucket, config.globalRate, config.rateWindowMs, at);
				if (nextGlobalBucket.tokens < 1) {
					globalBucket = nextGlobalBucket;
					return rateRejection('global', nextGlobalBucket, config.globalRate, config.rateWindowMs);
				}
			}
			if (nextConnectionBucket !== null) {
				nextConnectionBucket.tokens--;
				state.rate = nextConnectionBucket;
			}
			if (nextGlobalBucket !== null) {
				nextGlobalBucket.tokens--;
				globalBucket = nextGlobalBucket;
			}

			if (canStart(state)) return permit(state);
			const scope = blockedScope(state);
			if (config.maxQueue === 0) return { ok: false, reason: 'concurrency_limit', scope };
			if (queue.length >= config.maxQueue || state.queued >= config.maxQueue) {
				return { ok: false, reason: 'queue_full', scope: queue.length >= config.maxQueue ? 'global' : 'connection' };
			}
			state.queued++;
			let resolve;
			const wait = new Promise((settle) => { resolve = settle; });
			queue.push({ ws, state, resolve });
			return { ok: null, queued: true, wait };
		},
		/** Cancel queued work when its connection closes. Active work releases normally. @param {object} ws */
		close(ws) {
			const state = connections.get(ws);
			if (state === undefined) return;
			state.closed = true;
			for (let i = queue.length - 1; i >= 0; i--) {
				const entry = queue[i];
				if (entry.ws !== ws) continue;
				queue.splice(i, 1);
				state.queued--;
				entry.resolve({ ok: false, reason: 'connection_closed', scope: 'connection' });
			}
			drain();
		}
	});
}

/** @param {{ reason: string, scope: string, retryAfterMs?: number }} rejection */
export function messageOverloadedFrame(rejection) {
	const cached = STATIC_OVERLOAD_FRAMES[`${rejection.reason}:${rejection.scope}`];
	if (cached !== undefined && rejection.retryAfterMs === undefined) return cached;
	const frame = {
		type: 'message-overloaded',
		reason: rejection.reason,
		scope: rejection.scope
	};
	if (rejection.retryAfterMs !== undefined) frame.retryAfterMs = rejection.retryAfterMs;
	return JSON.stringify(frame);
}

function retainedContext(context) {
	const data = context?.data;
	let retained = data;
	if (data instanceof ArrayBuffer) retained = data.slice(0);
	else if (ArrayBuffer.isView(data)) retained = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	return { ...context, data: retained };
}

/**
 * Run one application-work lane through the established-message gate.
 * Protocol-control frames deliberately stay outside this boundary so clients
 * can still unsubscribe, request a fresh lease, or recover while application
 * work is saturated.
 *
 * `work` receives the socket and context separately so callers can pass a
 * stable function rather than allocating a closure for every hot-path frame.
 *
 * @param {ReturnType<typeof createMessageAdmission>} admission
 * @param {object} ws
 * @param {any} context
 * @param {(ws: object, context: any) => unknown | Promise<unknown>} work
 * @param {(ws: object, rejection: { reason: string, scope: string, retryAfterMs?: number }) => void} onOverload
 */
export async function runAdmittedMessageWork(admission, ws, context, work, onOverload) {
	if (!admission.enabled) return work(ws, context);
	const decision = admission.enter(ws);
	const queuedContext = decision.ok === null ? retainedContext(context) : context;
	const result = decision.ok === null ? await decision.wait : decision;
	if (!result.ok) {
		if (result.reason !== 'connection_closed') {
			try { onOverload(ws, result); } catch {}
		}
		return;
	}
	try {
		return await work(ws, queuedContext);
	} finally {
		result.release();
	}
}

/**
 * Run an application message hook through the gate.
 *
 * @param {ReturnType<typeof createMessageAdmission>} admission
 * @param {unknown} hook
 * @param {object} ws
 * @param {any} context
 * @param {(ws: object, rejection: { reason: string, scope: string, retryAfterMs?: number }) => void} onOverload
 */
export async function runAdmittedMessageHook(admission, hook, ws, context, onOverload) {
	if (typeof hook !== 'function') return;
	if (!admission.enabled) return runMessageHook(hook, ws, context);
	const decision = admission.enter(ws);
	const queuedContext = decision.ok === null ? retainedContext(context) : context;
	const result = decision.ok === null ? await decision.wait : decision;
	if (!result.ok) {
		if (result.reason !== 'connection_closed') {
			try { onOverload(ws, result); } catch {}
		}
		return;
	}
	try {
		await runMessageHook(hook, ws, queuedContext);
	} finally {
		result.release();
	}
}
