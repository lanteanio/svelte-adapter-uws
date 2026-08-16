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
			perConnectionBytesRate: 0,
			globalBytesRate: 0,
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
		// The byte rates take the same misshape judgment as the frame rates: a
		// value that cannot bound anything throws instead of silently disabling.
		expect(() => normalizeMessageAdmission({ perConnectionBytesRate: -1 })).toThrow('messageAdmission.perConnectionBytesRate');
		expect(() => normalizeMessageAdmission({ perConnectionBytesRate: 1.5 })).toThrow('messageAdmission.perConnectionBytesRate');
		expect(() => normalizeMessageAdmission({ globalBytesRate: '65536' })).toThrow('messageAdmission.globalBytesRate');
		expect(() => normalizeMessageAdmission({ globalBytesRate: Number.NaN })).toThrow('messageAdmission.globalBytesRate');
	});

	it('serializes the public option and reports nested typos', () => {
		const messageAdmission = {
			perConnectionRate: 25,
			globalRate: 1000,
			perConnectionBytesRate: 65536,
			globalBytesRate: 1048576,
			rateWindowMs: 500,
			perConnectionConcurrent: 2,
			globalConcurrent: 64,
			maxQueue: 128
		};
		expect(serializeWsOptions({ messageAdmission }, false).messageAdmission).toEqual(messageAdmission);
		expect(unknownWebsocketOptionKeys({ messageAdmission: { maxQueu: 5 } }))
			.toEqual(['messageAdmission.maxQueu']);
		expect(unknownWebsocketOptionKeys({ messageAdmission: { perConnectionBytesRate: 65536 } }))
			.toEqual([]);
		expect(() => serializeWsOptions({ messageAdmission: { globalRate: -1 } }, false))
			.toThrow('websocket.messageAdmission.globalRate');
		expect(() => serializeWsOptions({ messageAdmission: { perConnectionBytesRate: -1 } }, false))
			.toThrow('websocket.messageAdmission.perConnectionBytesRate');
	});

	it('charges the byte rates by frame length under an untouched frame rate', () => {
		let at = 0;
		const gate = createMessageAdmission({
			perConnectionRate: 100,
			perConnectionBytesRate: 1000,
			globalBytesRate: 1500,
			rateWindowMs: 1000
		}, () => at);
		const a = {};
		const b = {};
		// Well under the 100-frame rate, over the 1000-byte connection rate.
		const first = gate.enter(a, 600);
		expect(first.ok).toBe(true);
		first.release();
		expect(gate.enter(a, 600)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'connection', retryAfterMs: 200 });
		// The refused frame charged NOTHING: 400 tokens still stand.
		const fits = gate.enter(a, 400);
		expect(fits.ok).toBe(true);
		fits.release();
		// The global byte bucket saw 600 + 400; another connection's 600 tips it.
		expect(gate.enter(b, 600)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'global' });
		// Refill restores byte admission on the same clock the frame rates use.
		at = 1000;
		const recovered = gate.enter(b, 600);
		expect(recovered.ok).toBe(true);
		recovered.release();
	});

	it('a frame heavier than the whole window allowance is refused every time', () => {
		let at = 0;
		const gate = createMessageAdmission({ perConnectionBytesRate: 1000, rateWindowMs: 1000 }, () => at);
		const ws = {};
		expect(gate.enter(ws, 4096)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'connection' });
		at = 60_000;
		expect(gate.enter(ws, 4096)).toMatchObject({ ok: false, reason: 'rate_limit', scope: 'connection' });
		// A zero-byte entry (a caller without a frame) charges no weight.
		const free = gate.enter(ws);
		expect(free.ok).toBe(true);
		free.release();
	});

	it('runs the hook lane under the byte gate, charging the context payload', async () => {
		const gate = createMessageAdmission({ perConnectionBytesRate: 1000, rateWindowMs: 1000 }, () => 0);
		const ws = {};
		const overloads = [];
		const ran = [];
		const hook = (_ws, context) => { ran.push(context.data.byteLength); };
		await runAdmittedMessageHook(gate, hook, ws, { data: new Uint8Array(700).buffer }, (_w, rejection) => overloads.push(rejection));
		await runAdmittedMessageHook(gate, hook, ws, { data: new Uint8Array(700).buffer }, (_w, rejection) => overloads.push(rejection));
		expect(ran).toEqual([700]);
		expect(overloads).toEqual([
			expect.objectContaining({ reason: 'rate_limit', scope: 'connection' })
		]);
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
