import { describe, expect, it, vi } from 'vitest';
import {
	createTransportMetricHooks,
	HTTP_DURATION_BUCKETS,
	UPGRADE_DURATION_BUCKETS,
	WS_MESSAGE_DURATION_BUCKETS,
	WS_CONNECTION_DURATION_BUCKETS
} from '../src/runtime/transport-metrics.js';

function recorder() {
	const calls = [];
	return {
		calls,
		counter: { inc(labels, value) { calls.push({ method: 'inc', labels, value }); } },
		histogram: { observe(labels, value) { calls.push({ method: 'observe', labels, value }); } }
	};
}

function tickingClock(step = 5) {
	let value = 0;
	return () => (value += step);
}

function response() {
	return {
		status: null,
		ended: false,
		closed: false,
		upgraded: false,
		abortHandler: null,
		writeStatus(value) { this.status = value; return this; },
		end() { this.ended = true; return this; },
		endWithoutBody() { this.ended = true; return this; },
		close() { this.closed = true; return this; },
		upgrade() { this.upgraded = true; return this; },
		onAborted(callback) { this.abortHandler = callback; return this; }
	};
}

function expectStrictlyIncreasing(values) {
	expect(values.length).toBeGreaterThan(2);
	for (let i = 0; i < values.length; i++) {
		expect(Number.isFinite(values[i])).toBe(true);
		expect(values[i]).toBeGreaterThan(0);
		if (i > 0) expect(values[i]).toBeGreaterThan(values[i - 1]);
	}
}

describe('transport RED instrumentation', () => {
	it('returns null when every instrument is absent, preserving the disabled handler path', () => {
		expect(createTransportMetricHooks({}, vi.fn())).toBeNull();
	});

	it('classifies HTTP status/method with pre-bounded labels and observes seconds', () => {
		const rate = recorder();
		const duration = recorder();
		const hooks = createTransportMetricHooks({
			httpRequests: rate.counter,
			httpDuration: duration.histogram
		}, tickingClock());
		const res = response();
		const handler = hooks.instrumentHttp((reply) => {
			reply.writeStatus('404 Not Found').end();
		}, 'any');
		handler(res, { getMethod: () => 'GET' });
		expect(rate.calls).toEqual([{
			method: 'inc',
			labels: { method: 'get', outcome: 'client_error' },
			value: undefined
		}]);
		expect(duration.calls).toEqual([{
			method: 'observe',
			labels: { method: 'get', outcome: 'client_error' },
			value: 0.005
		}]);
	});

	it('counts responses completed without a body exactly like bodied ones', () => {
		// Redirects, 204s, HEADs, and empty admin replies all terminate via
		// endWithoutBody; leaving it unpatched made that whole class of
		// ordinary traffic invisible while the transport read healthy.
		const rate = recorder();
		const hooks = createTransportMetricHooks({ httpRequests: rate.counter }, tickingClock());
		const res = response();
		const handler = hooks.instrumentHttp((reply) => {
			reply.writeStatus('302 Found').endWithoutBody(0);
		}, 'any');
		handler(res, { getMethod: () => 'HEAD' });
		expect(rate.calls).toEqual([{
			method: 'inc',
			labels: { method: 'head', outcome: 'ok' },
			value: undefined
		}]);
		// A later abort callback must not double-count the finished response.
		res.abortHandler?.();
		expect(rate.calls).toHaveLength(1);
	});

	it('records aborts and synchronous HTTP exceptions exactly once', () => {
		const rate = recorder();
		const hooks = createTransportMetricHooks({ httpRequests: rate.counter }, tickingClock());
		const aborted = response();
		const onAbort = vi.fn();
		hooks.instrumentHttp((reply) => reply.onAborted(onAbort), 'post')(
			aborted,
			{ getMethod: () => 'POST' }
		);
		aborted.abortHandler();
		aborted.close();
		expect(onAbort).toHaveBeenCalledOnce();
		expect(rate.calls.map((call) => call.labels.outcome)).toEqual(['aborted']);

		const throwing = hooks.instrumentHttp(() => { throw new Error('boom'); }, 'any');
		expect(() => throwing(response(), { getMethod: () => 'BREW' })).toThrow('boom');
		expect(rate.calls.at(-1).labels).toEqual({ method: 'other', outcome: 'server_error' });
	});

	it('measures asynchronous upgrade admission/rejection/abort at the terminal response method', async () => {
		const duration = recorder();
		const hooks = createTransportMetricHooks(
			{ upgradeDuration: duration.histogram },
			tickingClock(10)
		);
		const admitted = response();
		const behavior = hooks.instrumentWebSocket({
			upgrade: async (reply) => { await Promise.resolve(); reply.upgrade(); }
		});
		await behavior.upgrade(admitted);
		expect(duration.calls[0]).toMatchObject({
			labels: { outcome: 'admitted' },
			value: 0.01
		});

		const rejected = response();
		hooks.instrumentWebSocket({ upgrade: (reply) => reply.end() }).upgrade(rejected);
		const aborted = response();
		hooks.instrumentWebSocket({
			upgrade: (reply) => reply.onAborted(() => {})
		}).upgrade(aborted);
		aborted.abortHandler();
		expect(duration.calls.map((call) => call.labels.outcome)).toEqual([
			'admitted', 'rejected', 'aborted'
		]);
	});

	it('covers awaited message failures and clean/abnormal connection lifetimes', async () => {
		const messages = recorder();
		const messageDuration = recorder();
		const connectionDuration = recorder();
		const hooks = createTransportMetricHooks({
			wsMessages: messages.counter,
			wsMessageDuration: messageDuration.histogram,
			wsConnectionDuration: connectionDuration.histogram
		}, tickingClock(2));
		const behavior = hooks.instrumentWebSocket({
			open() {},
			message: async (_ws, _data, isBinary) => {
				await Promise.resolve();
				if (isBinary) throw new Error('handler failed');
			},
			close() {}
		});
		const clean = {};
		behavior.open(clean);
		await behavior.message(clean, new Uint8Array(), false);
		await expect(behavior.message(clean, new Uint8Array(), true)).rejects.toThrow('handler failed');
		behavior.close(clean, 1000);
		const abnormal = {};
		behavior.open(abnormal);
		behavior.close(abnormal, 1006);
		expect(messages.calls.map((call) => call.labels)).toEqual([
			{ kind: 'text', outcome: 'ok' },
			{ kind: 'binary', outcome: 'error' }
		]);
		expect(connectionDuration.calls.map((call) => call.labels.outcome)).toEqual([
			'clean', 'abnormal'
		]);
	});

	it('classifies native publish booleans without per-call label allocation', () => {
		const outcomes = recorder();
		const hooks = createTransportMetricHooks(
			{ publishOutcomes: outcomes.counter },
			vi.fn()
		);
		hooks.publishOutcome(true);
		hooks.publishOutcome(false);
		hooks.publishOutcome(true);
		expect(outcomes.calls.map((call) => call.labels.outcome)).toEqual([
			'delivered', 'no_subscribers', 'delivered'
		]);
		expect(outcomes.calls[0].labels).toBe(outcomes.calls[2].labels);
	});

	it('ships explicit finite increasing second buckets for every duration lane', () => {
		for (const buckets of [
			HTTP_DURATION_BUCKETS,
			UPGRADE_DURATION_BUCKETS,
			WS_MESSAGE_DURATION_BUCKETS,
			WS_CONNECTION_DURATION_BUCKETS
		]) expectStrictlyIncreasing(buckets);
		expect(HTTP_DURATION_BUCKETS[0]).toBeLessThan(1);
		expect(WS_MESSAGE_DURATION_BUCKETS[0]).toBeLessThan(0.001);
		expect(WS_CONNECTION_DURATION_BUCKETS.at(-1)).toBe(86400);
	});
});
