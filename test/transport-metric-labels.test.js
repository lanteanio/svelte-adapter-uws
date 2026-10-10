// Drive the instrumented terminal paths and validate their emitted labels
// against the public manifest; declaration tables alone cannot pin emit sites.
import { describe, it, expect } from 'vitest';
import { createTransportMetricHooks } from '../src/runtime/transport-metrics.js';
import { computePressureReason, applyCapacityReason } from '../src/runtime/utils/pressure.js';
import { emitPressureMetricTelemetry } from '../src/runtime/utils/os-pressure.js';
import { SIGNALS_BY_NAME } from '../src/runtime/observability-manifest.js';

function instrument(name, recorded) {
	const calls = [];
	recorded.set(name, calls);
	const record = (labels) => calls.push({ ...labels });
	return { inc: record, observe: record };
}

function assertManifestCoverage(recorded) {
	for (const [name, calls] of recorded) {
		const signal = SIGNALS_BY_NAME.get(name);
		expect(signal, name).toBeTruthy();
		expect(calls.length, name).toBeGreaterThan(0);
		for (const labels of calls) {
			expect(Object.keys(labels).sort(), name).toEqual([...signal.labels].sort());
			for (const [key, value] of Object.entries(labels)) {
				expect(signal.labelDomains[key].values, `${name}.${key}`).toContain(value);
			}
		}
		for (const key of signal.labels) {
			expect([...new Set(calls.map(labels => labels[key]))].sort(), `${name}.${key} coverage`)
				.toEqual([...signal.labelDomains[key].values].sort());
		}
	}
}

function response() {
	return {
		writeStatus() { return this; }, end() {}, endWithoutBody() {},
		close() {}, upgrade() {}, onAborted(callback) { this.abort = callback; }
	};
}

const terminal = {
	body: reply => reply.writeStatus('200 OK').end(),
	bodyless: reply => reply.writeStatus('204 No Content').endWithoutBody(),
	clientError: reply => reply.writeStatus('404 Not Found').end(),
	serverError: reply => reply.writeStatus('503 Unavailable').end(),
	closed: reply => reply.close(),
	aborted: reply => { reply.onAborted(() => {}); reply.abort(); },
	thrown: () => { throw new Error('handler failed'); }
};

describe('transport metric labels from instrumented handlers', () => {
	it('covers HTTP methods and every terminal outcome, plus all WebSocket instruments', async () => {
		const recorded = new Map();
		let tick = 0;
		const hooks = createTransportMetricHooks({
			httpRequests: instrument('http_requests_total', recorded),
			httpDuration: instrument('http_request_duration_seconds', recorded),
			upgradeDuration: instrument('upgrade_duration_seconds', recorded),
			wsMessages: instrument('ws_messages_total', recorded),
			wsMessageDuration: instrument('ws_message_duration_seconds', recorded),
			wsConnectionDuration: instrument('ws_connection_duration_seconds', recorded),
			publishOutcomes: instrument('ws_publish_outcomes_total', recorded)
		}, () => ++tick);
		for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'BREW']) {
			for (const [name, action] of Object.entries(terminal)) {
				const handler = hooks.instrumentHttp(action, 'any');
				if (name === 'thrown') expect(() => handler(response(), { getMethod: () => method })).toThrow('handler failed');
				else handler(response(), { getMethod: () => method });
			}
		}
		expect(recorded.get('http_requests_total')).toHaveLength(56);
		expect(recorded.get('http_request_duration_seconds')).toHaveLength(56);
		for (const action of [reply => reply.upgrade(), reply => reply.end(), terminal.closed, terminal.aborted]) {
			hooks.instrumentWebSocket({ upgrade: action }).upgrade(response());
		}
		expect(() => hooks.instrumentWebSocket({ upgrade: terminal.thrown }).upgrade(response())).toThrow('handler failed');
		expect(recorded.get('upgrade_duration_seconds')).toHaveLength(5);
		for (const binary of [false, true]) {
			await hooks.instrumentWebSocket({ message: async () => {} }).message({}, '', binary);
			await expect(hooks.instrumentWebSocket({ message: async () => { throw new Error('message failed'); } })
				.message({}, '', binary)).rejects.toThrow('message failed');
		}
		const behavior = hooks.instrumentWebSocket({ open() {}, close() {} });
		for (const code of [1000, 1001, 1006]) {
			const socket = {};
			behavior.open(socket);
			behavior.close(socket, code);
		}
		hooks.publishOutcome(true);
		hooks.publishOutcome(false);
		expect(recorded.get('ws_messages_total')).toHaveLength(4);
		expect(recorded.get('ws_message_duration_seconds')).toHaveLength(4);
		expect(recorded.get('ws_connection_duration_seconds')).toHaveLength(3);
		expect(recorded.get('ws_publish_outcomes_total')).toHaveLength(2);
		assertManifestCoverage(recorded);
	});
});

describe('pressure transition labels from pressure decisions', () => {
	it('emits actual reason outputs, including the capacity overlay, within the manifest domains', () => {
		const thresholds = {
			memoryHeapUsedRatio: 0.85, publishRatePerSec: 100, subscriberRatio: 10,
			cpuThrottledRatio: 0.25, psiCpuSome: 60, psiMemoryFull: 15, psiIoFull: 50
		};
		const normal = { heapUsedRatio: 0, publishRate: 0, subscriberRatio: 0 };
		const samples = [normal, { heapUsedRatio: 1 }, { publishRate: 100 }, { subscriberRatio: 10 },
			{ cpuThrottledRatio: 0.25 }, { psiCpuSome10: 60 }, { psiMemoryFull10: 15 }, { psiIoFull10: 50 }];
		const reasons = new Set();
		for (const sample of samples) {
			const reason = computePressureReason({ ...normal, ...sample }, thresholds);
			for (const posture of ['normal', 'elevated', 'siege']) reasons.add(applyCapacityReason(reason, posture));
		}
		const recorded = new Map();
		const instruments = { reasonTransitions: instrument('pressure_reason_transitions_total', recorded) };
		for (const from of reasons) for (const to of reasons) {
			emitPressureMetricTelemetry({ transition: { from, to }, os: { psi: null, cpuThrottle: null } }, instruments);
		}
		expect(recorded.get('pressure_reason_transitions_total')).toHaveLength(49);
		assertManifestCoverage(recorded);
	});
});
