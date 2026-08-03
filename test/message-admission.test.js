import { describe, expect, it, vi } from 'vitest';
import {
	createMessageAdmission,
	messageOverloadedFrame,
	normalizeMessageAdmission,
	runAdmittedMessageHook
} from '../src/runtime/utils/message-admission.js';
import { serializeWsOptions, unknownWebsocketOptionKeys } from '../src/index.js';

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

describe('established-message admission', () => {
	it('validates every resource limit and preserves the disabled default', () => {
		expect(normalizeMessageAdmission(undefined)).toEqual({
			perConnectionRate: 0,
			globalRate: 0,
			rateWindowMs: 1000,
			perConnectionConcurrent: 0,
			globalConcurrent: 0,
			maxQueue: 0
		});
		expect(() => normalizeMessageAdmission({ globalConcurrent: -1 })).toThrow('messageAdmission.globalConcurrent');
		expect(() => normalizeMessageAdmission({ rateWindowMs: 0 })).toThrow('messageAdmission.rateWindowMs');
		expect(() => normalizeMessageAdmission([])).toThrow('messageAdmission must be an object');
		expect(() => normalizeMessageAdmission({ maxQueu: 1 })).toThrow('unsupported field: maxQueu');
		expect(() => normalizeMessageAdmission({ maxQueue: 1 })).toThrow('maxQueue requires');
	});

	it('serializes the public option and reports nested typos', () => {
		const messageAdmission = {
			perConnectionRate: 25,
			globalRate: 1000,
			rateWindowMs: 500,
			perConnectionConcurrent: 2,
			globalConcurrent: 64,
			maxQueue: 128
		};
		expect(serializeWsOptions({ messageAdmission }, false).messageAdmission).toEqual(messageAdmission);
		expect(unknownWebsocketOptionKeys({ messageAdmission: { maxQueu: 5 } }))
			.toEqual(['messageAdmission.maxQueu']);
		expect(() => serializeWsOptions({ messageAdmission: { globalRate: -1 } }, false))
			.toThrow('websocket.messageAdmission.globalRate');
	});

	it('enforces connection and global token buckets with a concrete retry delay', () => {
		let at = 0;
		const gate = createMessageAdmission({
			perConnectionRate: 2,
			globalRate: 3,
			rateWindowMs: 1000
		}, () => at);
		const a = {};
		const b = {};
		const a1 = gate.enter(a);
		const a2 = gate.enter(a);
		expect(a1.ok).toBe(true);
		expect(a2.ok).toBe(true);
		a1.release();
		a2.release();
		expect(gate.enter(a)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'connection', retryAfterMs: 500 });
		const b1 = gate.enter(b);
		expect(b1.ok).toBe(true);
		b1.release();
		expect(gate.enter(b)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'global' });
		at = 500;
		const recovered = gate.enter(a);
		expect(recovered.ok).toBe(true);
		recovered.release();
	});

	it('bounds queued concurrency and drains the connection FIFO', async () => {
		const gate = createMessageAdmission({
			perConnectionConcurrent: 1,
			globalConcurrent: 2,
			maxQueue: 2
		});
		const a = {};
		const b = {};
		const firstA = gate.enter(a);
		const firstB = gate.enter(b);
		const secondA = gate.enter(a);
		const thirdA = gate.enter(a);
		expect(secondA).toMatchObject({ ok: null, queued: true });
		expect(thirdA).toMatchObject({ ok: null, queued: true });
		expect(gate.enter(b)).toMatchObject({ ok: false, reason: 'queue_full', scope: 'global' });

		firstB.release();
		let secondSettled = false;
		secondA.wait.then(() => { secondSettled = true; });
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		firstA.release();
		const admittedSecond = await secondA.wait;
		expect(admittedSecond.ok).toBe(true);
		admittedSecond.release();
		const admittedThird = await thirdA.wait;
		expect(admittedThird.ok).toBe(true);
		admittedThird.release();
		expect(gate.active).toBe(0);
		expect(gate.queued).toBe(0);
	});

	it('cancels queued work when the connection closes', async () => {
		const gate = createMessageAdmission({ perConnectionConcurrent: 1, maxQueue: 1 });
		const ws = {};
		const active = gate.enter(ws);
		const queued = gate.enter(ws);
		gate.close(ws);
		expect(await queued.wait).toEqual({ ok: false, reason: 'connection_closed', scope: 'connection' });
		active.release();
		expect(gate.queued).toBe(0);
	});

	it('copies only queued native payloads and emits a typed overload frame', async () => {
		const gate = createMessageAdmission({ globalConcurrent: 1, maxQueue: 1 });
		const hold = deferred();
		const firstStarted = deferred();
		const seen = [];
		const hook = async (_ws, context) => {
			seen.push(new Uint8Array(context.data)[0]);
			if (seen.length === 1) {
				firstStarted.resolve();
				await hold.promise;
			}
		};
		const firstBytes = new Uint8Array([1]);
		const secondBytes = new Uint8Array([2]);
		const first = runAdmittedMessageHook(gate, hook, {}, { data: firstBytes.buffer }, vi.fn());
		await firstStarted.promise;
		const second = runAdmittedMessageHook(gate, hook, {}, { data: secondBytes.buffer }, vi.fn());
		secondBytes[0] = 9;
		hold.resolve();
		await Promise.all([first, second]);
		expect(seen).toEqual([1, 2]);
		expect(JSON.parse(messageOverloadedFrame({
			reason: 'rate_limit',
			scope: 'connection',
			retryAfterMs: 25
		}))).toEqual({
			type: 'message-overloaded',
			reason: 'rate_limit',
			scope: 'connection',
			retryAfterMs: 25
		});
		expect(messageOverloadedFrame({ reason: 'queue_full', scope: 'global' }))
			.toBe('{"type":"message-overloaded","reason":"queue_full","scope":"global"}');
	});
});
