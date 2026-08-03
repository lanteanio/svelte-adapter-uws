import { describe, expect, it, vi } from 'vitest';
import { createRelaySpillQuarantine } from '../src/runtime/relay-spill-policy.js';

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
