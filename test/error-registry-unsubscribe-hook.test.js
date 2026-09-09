// ADAPTER-ERR-UNSUBSCRIBE-HOOK, driven from the condition it claims.
//
// The `unsubscribe` hook is fire-and-forget: thirty call sites across the
// runtime, the test server and the dev plugin invoke it without awaiting.
// An app that passes an async function anyway hands the runtime a promise
// nobody owns, and its rejection was an unhandled rejection - which under
// Node's default policy ends the worker - while a synchronous throw took the
// message handler down with it. One helper now invokes the hook everywhere:
// it catches a throw, attaches a rejection handler to a returned thenable,
// reports either once, and the socket keeps going.
//
// Three layers, because each proves something the others cannot: the helper
// alone (every return shape, exactly one report), the test server (the
// harness must contain the same failures production does, or a deployment
// rehearsed against it learns the wrong thing), and the built runtime over a
// real socket with the fixture's hook selecting the failure by topic name.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { runUnsubscribeHook } from '../src/runtime/utils/unsubscribe-hook.js';

const describeUWS = hasUWS ? describe : describe.skip;
const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.UNSUBSCRIBE_HOOK);
const EVENT = 'unsubscribe.hook-failed';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('runUnsubscribeHook', () => {
	/** @type {any[]} */
	let events = [];
	/** @type {() => void} */
	let disposeSink;
	beforeAll(() => { disposeSink = setOperationalEventSink((record) => { events.push(record); }); });
	afterAll(() => { disposeSink?.(); });
	afterEach(() => { events = []; });

	const ws = { getUserData: () => ({ __adapter_uws_request_id__: 'req-42' }) };

	it('the registry entry exists and names its emitter', () => {
		expect(entry).toBeTruthy();
		expect(entry.event).toBe(EVENT);
		expect(entry.emission).toBe('direct');
		expect(entry.sources).toContain('src/runtime/utils/unsubscribe-hook.js');
	});

	it('contains a synchronous throw and reports it once, with the topic and request id', () => {
		expect(() => runUnsubscribeHook(() => { throw new Error('sync boom'); }, ws, 'room:1', { platform: null })).not.toThrow();
		expect(events.filter((r) => r.event === EVENT)).toHaveLength(1);
		const record = events[0];
		expect(record.message).toBe(entry.problemPrefix);
		expect(record.component).toBe('runtime.subscribe');
		expect(record.severity).toBe('error');
		expect(record.attributes.topic).toBe('room:1');
		expect(record.attributes.requestId).toBe('req-42');
		expect(record.attributes.error.message).toBe('sync boom');
	});

	it('contains a rejected promise and reports it once', async () => {
		runUnsubscribeHook(async () => { throw new Error('async boom'); }, ws, 'room:2', { platform: null });
		expect(events).toHaveLength(0);
		await tick();
		const mine = events.filter((r) => r.event === EVENT);
		expect(mine).toHaveLength(1);
		expect(mine[0].attributes.topic).toBe('room:2');
		expect(mine[0].attributes.error.message).toBe('async boom');
	});

	it('takes a thenable that is not a native promise', async () => {
		const thenable = { then(_ok, fail) { setTimeout(() => fail(new Error('thenable boom')), 0); } };
		runUnsubscribeHook(() => thenable, ws, 'room:3', { platform: null });
		await tick();
		expect(events.filter((r) => r.event === EVENT)).toHaveLength(1);
	});

	it('contains a thenable whose then throws synchronously', () => {
		// The one shape that could leave through the seam between the call and
		// the attach: attaching the handler is itself a call into app code.
		const hostile = { then() { throw new Error('then boom'); } };
		expect(() => runUnsubscribeHook(() => hostile, ws, 'room:6', { platform: null })).not.toThrow();
		expect(events.filter((r) => r.event === EVENT)).toHaveLength(1);
		expect(events[0].attributes.error.message).toBe('then boom');
	});

	it('takes a function that carries a then, like any other thenable', async () => {
		const fnThenable = Object.assign(() => {}, { then(_ok, fail) { setTimeout(() => fail(new Error('fn boom')), 0); } });
		runUnsubscribeHook(() => fnThenable, ws, 'room:7', { platform: null });
		await tick();
		expect(events.filter((r) => r.event === EVENT)).toHaveLength(1);
	});

	it('still reports when the platform refuses the request id read', () => {
		const platform = { get requestId() { throw new Error('hostile getter'); } };
		runUnsubscribeHook(() => { throw new Error('with hostile platform'); }, ws, 'room:8', { platform });
		expect(events).toHaveLength(1);
		expect(events[0].attributes.error.message).toBe('with hostile platform');
		expect(events[0].attributes.requestId).toBeUndefined();
	});

	it('reports nothing for a hook that returns, resolves, or is absent', async () => {
		runUnsubscribeHook(() => undefined, ws, 'a', { platform: null });
		runUnsubscribeHook(() => 42, ws, 'b', { platform: null });
		runUnsubscribeHook(async () => {}, ws, 'c', { platform: null });
		runUnsubscribeHook(undefined, ws, 'd', { platform: null });
		runUnsubscribeHook(null, ws, 'e', { platform: null });
		await tick();
		expect(events).toEqual([]);
	});

	it('still reports when the socket is already closed', () => {
		const closed = { getUserData() { throw new Error('Invalid access of closed uWS.WebSocket'); } };
		runUnsubscribeHook(() => { throw new Error('late'); }, closed, 'room:4', { platform: null });
		expect(events).toHaveLength(1);
		expect(events[0].attributes.requestId).toBeUndefined();
		expect(events[0].attributes.topic).toBe('room:4');
	});

	it('passes the hook exactly the production arguments', () => {
		/** @type {any[]} */
		let seen = [];
		const ctx = { platform: { marker: true } };
		runUnsubscribeHook((...args) => { seen = args; }, ws, 'room:5', ctx);
		expect(seen[0]).toBe(ws);
		expect(seen[1]).toBe('room:5');
		expect(seen[2]).toBe(ctx);
	});
});

/**
 * A raw ws client over the test server, collecting parsed frames.
 * @param {string} url
 */
async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const socket = new WebSocket(url);
	/** @type {any[]} */
	const frames = [];
	socket.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch { frames.push(data); } });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	return {
		socket,
		frames,
		send(msg) { socket.send(JSON.stringify(msg)); },
		async waitFor(predicate, ms = 1000) {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				await tick();
			}
			return null;
		},
		close() { socket.close(); }
	};
}

describeUWS('ADAPTER-ERR-UNSUBSCRIBE-HOOK on the test server', () => {
	let server;
	let client;
	/** @type {any[]} */
	const events = [];
	/** @type {() => void} */
	let disposeSink;
	let hookCalls = 0;
	/** The request id the hook's own ctx carried, to compare with the record. */
	let ctxRequestId;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				unsubscribe(_ws, topic, { platform }) {
					hookCalls++;
					ctxRequestId = platform?.requestId;
					if (topic.startsWith('unsub-throw:')) throw new Error('harness unsubscribe throw');
					if (topic.startsWith('unsub-reject:')) return Promise.reject(new Error('harness unsubscribe rejection'));
				},
				message(ws, { data, platform }) {
					const msg = JSON.parse(Buffer.from(data).toString());
					if (msg.type === 'revoke') {
						platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed: platform.unsubscribe(ws, msg.topic) });
					}
				}
			}
		});
		disposeSink = setOperationalEventSink((record) => { events.push(record); });
		client = await connectClient(server.wsUrl);
	});

	afterAll(async () => {
		client?.close();
		disposeSink?.();
		await server?.close();
	});

	it('survives a throwing and a rejecting hook, reporting each once', async () => {
		for (const [topic, ref] of [['unsub-throw:a', 1], ['unsub-reject:b', 2]]) {
			client.send({ type: 'subscribe', topic, ref });
			expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === ref), topic + ' subscribed').toBeTruthy();
		}
		const before = events.length;
		const callsBefore = hookCalls;
		client.send({ type: 'unsubscribe', topic: 'unsub-throw:a' });
		client.send({ type: 'unsubscribe', topic: 'unsub-reject:b' });
		// The connection is alive if it still answers a subscribe with an ack.
		client.send({ type: 'subscribe', topic: 'after:ok', ref: 3 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 3), 'the connection must survive').toBeTruthy();
		await tick();
		expect(hookCalls - callsBefore).toBe(2);
		const mine = events.slice(before).filter((r) => r.event === EVENT);
		expect(mine.map((r) => r.attributes.topic).sort()).toEqual(['unsub-reject:b', 'unsub-throw:a']);
		expect(mine.every((r) => r.message === entry.problemPrefix)).toBe(true);
		// The record names the connection the way the hook's own ctx does.
		expect(mine.every((r) => r.attributes.requestId === ctxRequestId)).toBe(true);
		// The memberships really went: subscribing again is a fresh grant.
		client.send({ type: 'subscribe', topic: 'unsub-throw:a', ref: 4 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 4)).toBeTruthy();
	});

	it('platform.unsubscribe runs the same contained hook', async () => {
		client.send({ type: 'subscribe', topic: 'unsub-reject:server', ref: 5 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 5)).toBeTruthy();
		const before = events.length;
		client.send({ type: 'revoke', topic: 'unsub-reject:server' });
		const revoked = await client.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'unsub-reject:server');
		expect(revoked, 'the revoke probe must answer').toBeTruthy();
		expect(revoked.data.removed, 'the server-side revoke must find the membership').toBe(true);
		await tick();
		expect(events.slice(before).filter((r) => r.event === EVENT)).toHaveLength(1);
		client.send({ type: 'subscribe', topic: 'after:server', ref: 6 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 6)).toBeTruthy();
	});
});

describeUWS('ADAPTER-ERR-UNSUBSCRIBE-HOOK on the built runtime', () => {
	let server;
	let client;
	/** @type {any[]} */
	const events = [];
	/** @type {() => void} */
	let disposeSink;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'subhook' });
		disposeSink = setOperationalEventSink((record) => { events.push(record); });
		client = await connectRealClient(server.wsUrl);
	}, 400000);

	afterAll(async () => {
		client?.close();
		disposeSink?.();
		await server?.stop();
	});

	it('survives a throwing and a rejecting hook over a real socket, reporting each once', async () => {
		for (const [topic, ref] of [['unsub-throw:a', 11], ['unsub-reject:b', 12]]) {
			client.send({ type: 'subscribe', topic, ref });
			expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === ref), topic + ' subscribed').not.toBeNull();
		}
		const before = events.length;
		client.send({ type: 'unsubscribe', topic: 'unsub-throw:a' });
		client.send({ type: 'unsubscribe', topic: 'unsub-reject:b' });
		// Membership as the server sees it, and proof the connection answers.
		client.send({ type: 'count', topic: 'unsub-throw:a' });
		const count = await client.waitFor((f) => f?.event === 'count' && f.data?.topic === 'unsub-throw:a');
		expect(count, 'the count probe must answer').not.toBeNull();
		expect(count.parsed.data.count).toBe(0);
		await tick();
		const mine = events.slice(before).filter((r) => r.event === EVENT);
		expect(mine.map((r) => r.attributes.topic).sort()).toEqual(['unsub-reject:b', 'unsub-throw:a']);
		for (const record of mine) {
			expect(record.message).toBe(entry.problemPrefix);
			expect(record.component).toBe('runtime.subscribe');
			expect(record.severity).toBe('error');
			// The connection's own id, as its platform reports it to the app.
			expect(record.attributes.requestId ?? null).toBe(count.parsed.data.requestId);
			expect(record.attributes.error.message).toMatch(/unsubscribe hook probe/);
		}
		expect(entry.nextAction).toMatch(/attached error/i);
		client.send({ type: 'subscribe', topic: 'after:ok', ref: 13 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 13)).not.toBeNull();
	});

	it('platform.unsubscribe runs the same contained hook', async () => {
		client.send({ type: 'subscribe', topic: 'unsub-reject:server', ref: 14 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 14)).not.toBeNull();
		const before = events.length;
		client.send({ type: 'revoke', topic: 'unsub-reject:server' });
		const revoked = await client.waitFor((f) => f?.event === 'revoked' && f.data?.topic === 'unsub-reject:server');
		expect(revoked, 'the revoke probe must answer').not.toBeNull();
		expect(revoked.parsed.data.removed).toBe(true);
		await tick();
		expect(events.slice(before).filter((r) => r.event === EVENT)).toHaveLength(1);
		client.send({ type: 'subscribe', topic: 'after:server', ref: 15 });
		expect(await client.waitFor((f) => f?.type === 'subscribed' && f.ref === 15)).not.toBeNull();
	});
});
