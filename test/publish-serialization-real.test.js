import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

for (const surface of ['production', 'testing']) {
	describeUWS(`${surface} publish serialization`, () => {
		let runtime;
		let platform;
		let seen;
		let ws;
		const frames = [];

		beforeAll(async () => {
			if (surface === 'production') {
				runtime = await startRealRuntime();
				({ platform } = await import('./fixture/build/handler/platform.js'));
				({ maxSeenSeq: seen } = await import('./fixture/build/handler/state.js'));
			} else {
				const { createTestServer } = await import('../src/testing.js');
				runtime = await createTestServer();
				platform = runtime.platform;
			}
			ws = new WebSocket(runtime.wsUrl);
			ws.on('message', data => {
				const frame = JSON.parse(data.toString());
				if (frame.type === 'batch') frames.push(...frame.events);
				else frames.push(frame);
			});
			await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
			ws.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
		}, 400000);

		afterAll(async () => {
			ws?.terminate();
			if (surface === 'production') await runtime?.stop();
			else await runtime?.close();
		});

		async function waitFor(predicate) {
			await expect.poll(() => frames.find(predicate), { timeout: 3000 }).toBeTruthy();
			return frames.find(predicate);
		}

		async function subscribe(topic) {
			ws.send(JSON.stringify({ type: 'subscribe', topic, ref: topic }));
			await waitFor(frame => frame.type === 'subscribed' && frame.ref === topic);
		}

		for (const [kind, bad] of [
			['bigint', () => 1n],
			['function', () => () => 1],
			['symbol', () => Symbol('value')],
			['cycle', () => { const value = {}; value.self = value; return value; }],
			['undefined-toJSON', () => ({ toJSON() {} })],
			['throwing-toJSON', () => ({ toJSON() { throw new TypeError('cannot serialize'); } })]
		]) {
			it(`does not stamp a refused ${kind} publication`, async () => {
				const topic = `serialization:${surface}:${kind}`;
				await subscribe(topic);
				platform.publish(topic, 'value', 'before');
				expect(() => platform.publish(topic, 'refused', bad())).toThrow(TypeError);
				platform.publish(topic, 'value', 'after');
				await waitFor(frame => frame.topic === topic && frame.data === 'after');
				expect(frames.filter(frame => frame.topic === topic && frame.event === 'value').map(frame => frame.seq)).toEqual([1, 2]);
				expect(frames.some(frame => frame.topic === topic && frame.event === 'refused')).toBe(false);
			});
		}

		it('serializes once and stamps reentrant publications in their delivery order', async () => {
			const topic = `serialization:${surface}:reentrant`;
			await subscribe(topic);
			let calls = 0;
			platform.publish(topic, 'value', {
				toJSON() {
					calls++;
					platform.publish(topic, 'value', 'nested');
					return 'outer';
				}
			});
			await waitFor(frame => frame.topic === topic && frame.data === 'outer');
			expect(calls).toBe(1);
			expect(frames.filter(frame => frame.topic === topic && frame.event === 'value').map(frame => [frame.data, frame.seq])).toEqual([['nested', 1], ['outer', 2]]);
		});

		it('does not stamp any entry of a batch whose later value is refused', async () => {
			const topic = `serialization:${surface}:batch`;
			await subscribe(topic);
			platform.publish(topic, 'value', 'before');
			expect(() => platform.publishBatched([
				{ topic, event: 'refused', data: 'first' },
				{ topic, event: 'refused', data: 1n }
			])).toThrow(TypeError);
			platform.publishBatched([
				{ topic, event: 'value', data: 'second' },
				{ topic, event: 'value', data: 'third' }
			]);
			await waitFor(frame => frame.topic === topic && frame.data === 'third');
			expect(frames.filter(frame => frame.topic === topic && frame.event === 'value').map(frame => frame.seq)).toEqual([1, 2, 3]);
			expect(frames.some(frame => frame.topic === topic && frame.event === 'refused')).toBe(false);
		});

		if (surface === 'production') {
			it('leaves every authoritative batch watermark unchanged when a later entry fails', async () => {
				const topic = 'serialization:authoritative-batch';
				await subscribe(topic);
				platform.publish(topic, 'value', 'before', { seq: 4, relay: false });
				expect(() => platform.publishBatched([
					{ topic, event: 'refused', data: 'first', options: { seq: 5, relay: false } },
					{ topic, event: 'refused', data: 1n, options: { seq: 6, relay: false } }
				])).toThrow(TypeError);
				expect(seen.get(topic)).toBe(4);
			});

			it('leaves the recovery watermark unchanged when an authoritative publish fails', async () => {
				const topic = 'serialization:authoritative';
				await subscribe(topic);
				platform.publish(topic, 'value', 'before', { seq: 4, relay: false });
				expect(() => platform.publish(topic, 'refused', 1n, { seq: 5, relay: false })).toThrow(TypeError);
				expect(seen.get(topic)).toBe(4);
				platform.publish(topic, 'value', 'after', { seq: 5, relay: false });
				await waitFor(frame => frame.topic === topic && frame.data === 'after');
				expect(seen.get(topic)).toBe(5);
			});
		}
	});
}
