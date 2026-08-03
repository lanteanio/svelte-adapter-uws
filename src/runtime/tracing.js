import { AsyncLocalStorage } from 'node:async_hooks';
import { tracingProvider } from './tracing-bridge.js';
import {
	normalizeTraceContext,
	extractTraceContext,
	injectTraceContext
} from '../trace-context.js';

const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';
const active = new AsyncLocalStorage();

const provider = tracingProvider && typeof tracingProvider.startSpan === 'function'
	? tracingProvider
	: null;

export const tracingEnabled = provider !== null;

export { normalizeTraceContext, extractTraceContext, injectTraceContext };

/** @returns {{ traceparent: string, tracestate?: string } | null} */
export function activeTraceContext() {
	return active.getStore() ?? null;
}

/**
 * Run work with a validated W3C context as the active context.
 * @template T
 * @param {unknown} context
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTraceContext(context, fn) {
	const normalized = normalizeTraceContext(context);
	return normalized === null ? fn() : active.run(normalized, fn);
}

function contextFromSpan(span, parent) {
	let candidate = null;
	try {
		candidate = span?.traceContext ?? span?.context ?? null;
		if (typeof candidate === 'function') candidate = candidate.call(span);
	} catch {}
	const normalized = normalizeTraceContext(candidate);
	if (normalized !== null) return normalized;
	let otel = null;
	try { if (typeof span?.spanContext === 'function') otel = span.spanContext(); } catch {}
	if (otel && /^[0-9a-f]{32}$/.test(otel.traceId) && otel.traceId !== ZERO_TRACE_ID &&
		/^[0-9a-f]{16}$/.test(otel.spanId) && otel.spanId !== ZERO_SPAN_ID) {
		const flags = Number.isInteger(otel.traceFlags) ? (otel.traceFlags & 0xff) : 0;
		return {
			traceparent: '00-' + otel.traceId + '-' + otel.spanId + '-' + flags.toString(16).padStart(2, '0'),
			...(parent?.tracestate === undefined ? {} : { tracestate: parent.tracestate })
		};
	}
	return parent;
}

function finishSpan(span, error) {
	if (error !== undefined) {
		try { span?.recordException?.(error); } catch {}
		try { span?.setAttribute?.('error.type', error?.name ?? typeof error); } catch {}
	}
	try { span?.end?.(); } catch {}
}

/**
 * Start one optional vendor-neutral span and keep its W3C context active across
 * synchronous and asynchronous work. A provider receives only plain data and
 * may adapt it to OpenTelemetry, another tracer, or a test recorder.
 *
 * @template T
 * @param {string} name
 * @param {{ kind?: 'server' | 'consumer' | 'producer' | 'internal', parent?: unknown, attributes?: Record<string, string | number | boolean> }} options
 * @param {(span: unknown) => T} fn
 * @returns {T}
 */
export function traceOperation(name, options, fn) {
	if (provider === null) return fn(null);
	const parent = normalizeTraceContext(options?.parent) ?? activeTraceContext();
	let span = null;
	try {
		span = provider.startSpan(name, {
			kind: options?.kind ?? 'internal',
			parent,
			attributes: options?.attributes ?? {}
		});
	} catch {
		return parent === null ? fn(null) : active.run(parent, () => fn(null));
	}
	const context = contextFromSpan(span, parent);
	const execute = () => {
		let result;
		try { result = fn(span); }
		catch (error) { finishSpan(span, error); throw error; }
		if (result && typeof result.then === 'function') {
			return result.then(
				(value) => { finishSpan(span); return value; },
				(error) => { finishSpan(span, error); throw error; }
			);
		}
		finishSpan(span);
		return result;
	};
	return context === null ? execute() : active.run(context, execute);
}

export const trace = Object.freeze({
	get enabled() { return tracingEnabled; },
	current: activeTraceContext,
	extract: extractTraceContext,
	inject(carrier, context = activeTraceContext()) { return injectTraceContext(carrier, context); },
	run: traceOperation,
	withContext: runWithTraceContext
});
