import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	provider: { startSpan: vi.fn() }
}));

vi.mock('../src/runtime/tracing-bridge.js', () => ({
	tracingProvider: mocks.provider
}));

const {
	activeTraceContext,
	extractTraceContext,
	injectTraceContext,
	normalizeTraceContext,
	runWithTraceContext,
	traceOperation,
	tracingEnabled
} = await import('../src/runtime/tracing.js');

const PARENT = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
	tracestate: 'vendor=value'
};

let spans;
let nextSpan;

beforeEach(() => {
	spans = [];
	nextSpan = 1;
	mocks.provider.startSpan.mockReset();
	mocks.provider.startSpan.mockImplementation((name, options) => {
		const entry = {
			name,
			options,
			ended: 0,
			errors: [],
			spanId: (nextSpan++).toString(16).padStart(16, '0')
		};
		spans.push(entry);
		return {
			spanContext: () => ({
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: entry.spanId,
				traceFlags: 1
			}),
			recordException(error) { entry.errors.push(error); },
			end() { entry.ended++; }
		};
	});
});

describe('W3C trace context', () => {
	it('accepts a valid parent and preserves a valid tracestate', () => {
		expect(normalizeTraceContext(PARENT)).toEqual(PARENT);
		expect(extractTraceContext(new Headers(PARENT))).toEqual(PARENT);
		expect(extractTraceContext({
			Traceparent: PARENT.traceparent,
			Tracestate: PARENT.tracestate
		})).toEqual(PARENT);
	});

	it.each([
		null,
		{},
		{ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
		{ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' },
		{ traceparent: '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01' },
		{ traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
		{ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
	])('rejects malformed or forbidden trace parents %#', (value) => {
		expect(normalizeTraceContext(value)).toBeNull();
	});

	it('drops malformed tracestate without discarding a valid parent', () => {
		expect(normalizeTraceContext({
			...PARENT,
			tracestate: 'vendor='
		})).toEqual({ traceparent: PARENT.traceparent });
		expect(normalizeTraceContext({
			...PARENT,
			tracestate: 'vendor=one,vendor=two'
		})).toEqual({ traceparent: PARENT.traceparent });
		expect(normalizeTraceContext({
			...PARENT,
			tracestate: 'tenant@1system=value'
		})).toEqual({ traceparent: PARENT.traceparent });
	});

	it('enforces the W3C 256-character tracestate member-value bound', () => {
		const atLimit = 'x'.repeat(256);
		expect(normalizeTraceContext({
			...PARENT,
			tracestate: 'vendor=' + atLimit
		})).toEqual({
			traceparent: PARENT.traceparent,
			tracestate: 'vendor=' + atLimit
		});
		expect(normalizeTraceContext({
			...PARENT,
			tracestate: 'vendor=' + atLimit + 'x'
		})).toEqual({ traceparent: PARENT.traceparent });
	});

	it('injects only validated context into plain and Headers carriers', () => {
		const plain = {};
		expect(injectTraceContext(plain, PARENT)).toBe(plain);
		expect(plain).toEqual(PARENT);

		const headers = new Headers();
		injectTraceContext(headers, PARENT);
		expect(headers.get('traceparent')).toBe(PARENT.traceparent);
		expect(headers.get('tracestate')).toBe(PARENT.tracestate);

		const untouched = {};
		injectTraceContext(untouched, { traceparent: 'bad' });
		expect(untouched).toEqual({});
	});

	it('can install an explicit context without starting a span', async () => {
		const seen = await runWithTraceContext(PARENT, async () => {
			await Promise.resolve();
			return activeTraceContext();
		});
		expect(seen).toEqual(PARENT);
		expect(spans).toHaveLength(0);
	});
});

describe('vendor-neutral tracing provider', () => {
	it('validates the provider module path at adapter configuration time', async () => {
		const { default: adapter } = await import('../src/index.js');
		expect(() => adapter({ tracing: {} })).toThrow('tracing must be a non-empty module path string');
		expect(() => adapter({ tracing: '   ' })).toThrow('tracing must be a non-empty module path string');
		expect(adapter({ tracing: './src/lib/server/tracing.js' }).name).toBe('adapter-uws');
		expect(adapter({ tracing: ' ./src/lib/server/tracing.js ' }).name).toBe('adapter-uws');
	});

	it('keeps an OpenTelemetry-shaped span context active through await', async () => {
		expect(tracingEnabled).toBe(true);
		const seen = await traceOperation('adapter.http.ssr', {
			kind: 'server',
			parent: PARENT,
			attributes: { 'http.request.method': 'GET' }
		}, async () => {
			const before = activeTraceContext();
			await Promise.resolve();
			return [before, activeTraceContext()];
		});

		expect(seen[0]).toEqual(seen[1]);
		expect(seen[0].traceparent).toBe(
			'00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000001-01'
		);
		expect(seen[0].tracestate).toBe(PARENT.tracestate);
		expect(spans[0].options.parent).toEqual(PARENT);
		expect(spans[0].ended).toBe(1);
	});

	it('isolates concurrent child operations on the same parent', async () => {
		let release;
		const barrier = new Promise((resolve) => { release = resolve; });
		const first = traceOperation('rpc.first', { parent: PARENT }, async () => {
			const before = activeTraceContext();
			await barrier;
			return [before, activeTraceContext()];
		});
		const second = traceOperation('rpc.second', { parent: PARENT }, async () => {
			const current = activeTraceContext();
			release();
			return current;
		});
		const [one, two] = await Promise.all([first, second]);
		expect(one[0]).toEqual(one[1]);
		expect(one[0].traceparent).not.toBe(two.traceparent);
	});

	it('records and rethrows provider-boundary failures exactly once', async () => {
		const failure = new Error('boom');
		await expect(traceOperation('rpc.failure', { parent: PARENT }, async () => {
			throw failure;
		})).rejects.toBe(failure);
		expect(spans[0].errors).toEqual([failure]);
		expect(spans[0].ended).toBe(1);
	});
});
