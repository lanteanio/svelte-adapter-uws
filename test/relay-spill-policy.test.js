import { describe, expect, it, vi } from 'vitest';
import { attributeRelayIncident, createRelaySpillQuarantine, relayEligible } from '../src/runtime/relay-spill-policy.js';

describe('relay fan-out eligibility', () => {
	it('excludes exactly the quarantined peers', () => {
		expect(relayEligible({ relayQuarantined: false })).toBe(true);
		expect(relayEligible({ relayQuarantined: true })).toBe(false);
	});
});

describe('relay incident attribution', () => {
	it('never reports through the involved worker and stops at the first survivor', () => {
		const involved = { postMessage: vi.fn() };
		const deadReporter = { postMessage: vi.fn(() => { throw new Error('gone'); }) };
		const reporter = { postMessage: vi.fn() };
		const late = { postMessage: vi.fn() };
		const notice = { type: 'relay-frame-oversized', declaredBytes: 9, maxFrameBytes: 4 };
		const delivered = attributeRelayIncident(
			new Map([[involved, {}], [deadReporter, {}], [reporter, {}], [late, {}]]),
			involved,
			notice
		);
		expect(delivered).toBe(true);
		expect(involved.postMessage).not.toHaveBeenCalled();
		expect(deadReporter.postMessage).toHaveBeenCalledTimes(1);
		expect(reporter.postMessage).toHaveBeenCalledWith(notice);
		expect(late.postMessage).not.toHaveBeenCalled();
	});

	it('never reports through a quarantined peer, whose registry dies with its requested exit', () => {
		const involved = { postMessage: vi.fn() };
		const quarantined = { postMessage: vi.fn() };
		const survivor = { postMessage: vi.fn() };
		const delivered = attributeRelayIncident(
			new Map([[involved, {}], [quarantined, { relayQuarantined: true }], [survivor, {}]]),
			involved,
			{ type: 'relay-frame-oversized' }
		);
		expect(delivered).toBe(true);
		expect(quarantined.postMessage).not.toHaveBeenCalled();
		expect(survivor.postMessage).toHaveBeenCalledTimes(1);
	});

	it('reports failure when no other worker survives, rather than reporting through the involved one', () => {
		const involved = { postMessage: vi.fn() };
		expect(attributeRelayIncident(new Map([[involved, {}]]), involved, { type: 'x' })).toBe(false);
		expect(involved.postMessage).not.toHaveBeenCalled();
	});
});

describe('relay spill quarantine policy', () => {
	it('quarantines once, reports once through another worker, and requests supervised exit', () => {
		const target = { postMessage: vi.fn() };
		const deadReporter = { postMessage: vi.fn(() => { throw new Error('gone'); }) };
		const reporter = { postMessage: vi.fn() };
		const meta = { threadId: 7, relayQuarantined: false };
		const requestWorkerExit = vi.fn();
		const log = vi.fn();
		const quarantine = createRelaySpillQuarantine({
			worker: target,
			meta,
			workers: new Map([[target, meta], [deadReporter, {}], [reporter, {}]]),
			requestWorkerExit,
			log
		});
		const event = { reason: 'bytes', droppedBytes: 4097, pendingAgeMs: 12 };

		expect(quarantine(event)).toBe(true);
		expect(quarantine(event)).toBe(false);
		expect(meta.relayQuarantined).toBe(true);
		expect(target.postMessage).not.toHaveBeenCalled();
		expect(deadReporter.postMessage).toHaveBeenCalledTimes(1);
		expect(reporter.postMessage).toHaveBeenCalledWith({
			type: 'relay-spill-overflow',
			reason: 'bytes',
			droppedBytes: 4097,
			pendingAgeMs: 12
		});
		expect(reporter.postMessage).toHaveBeenCalledTimes(1);
		expect(requestWorkerExit).toHaveBeenCalledTimes(1);
		expect(requestWorkerExit).toHaveBeenCalledWith(target, 1);
		expect(log).toHaveBeenCalledTimes(1);
	});
});
