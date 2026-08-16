import { afterEach, describe, expect, it } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server = null;
let client = null;

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function connect(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (data) => {
		const value = JSON.parse(data.toString());
		frames.push(value);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (!waiters[i].predicate(value)) continue;
			const [waiter] = waiters.splice(i, 1);
			waiter.resolve(value);
		}
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	return {
		ws,
		frames,
		waitFor(predicate) {
			const found = frames.find(predicate);
			if (found) return Promise.resolve(found);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), 1500);
				waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolve(value); } });
			});
		}
	};
}

afterEach(async () => {
	try { client?.ws.terminate(); } catch {}
	client = null;
	await server?.close();
	server = null;
});

describeUWS('established-message admission wiring', () => {
	it('bounds in-flight app work and returns a typed overload without closing the socket', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const series = new Map();
		const metrics = {
			counter(name) {
				return {
					inc(labels) {
						const key = `${name}:${JSON.stringify(labels ?? {})}`;
						series.set(key, (series.get(key) ?? 0) + 1);
					}
				};
			},
			gauge() { return { set() {} }; }
		};
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const seen = [];
		server = await createTestServer({
			metrics,
			messageAdmission: {
				perConnectionConcurrent: 1,
				globalConcurrent: 1,
				maxQueue: 1
			},
			handler: {
				async message(_ws, { data }) {
					const value = Buffer.from(data).toString();
					seen.push(value);
					if (value === 'one') {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
				}
			}
		});
		client = await connect(server.wsUrl);
		client.ws.send('one');
		await firstStarted.promise;
		client.ws.send('two');
		client.ws.send('three');

		await expect(client.waitFor((frame) => frame.type === 'message-overloaded')).resolves.toEqual({
			type: 'message-overloaded',
			reason: 'queue_full',
			scope: 'global'
		});
		expect(client.ws.readyState).toBe(client.ws.OPEN);
		releaseFirst.resolve();
		await expect.poll(() => seen).toEqual(['one', 'two']);
		expect(series.get(
			'ws_message_admission_rejected_total:{"reason":"queue_full","scope":"global"}'
		)).toBe(1);
	});

	it('refuses by byte weight under an untouched frame rate, with the typed rate_limit frame', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const seen = [];
		server = await createTestServer({
			messageAdmission: {
				perConnectionRate: 1000,
				perConnectionBytesRate: 4096,
				rateWindowMs: 60_000
			},
			handler: {
				message(_ws, { data }) {
					seen.push(data.byteLength);
				}
			}
		});
		client = await connect(server.wsUrl);
		// Two frames, far under the 1000-frame rate: 3 KiB passes, then a
		// second 3 KiB frame exceeds the 4 KiB byte window and is refused
		// without closing the socket.
		client.ws.send(Buffer.alloc(3072, 0x61));
		client.ws.send(Buffer.alloc(3072, 0x62));
		const refusal = await client.waitFor((frame) => frame.type === 'message-overloaded');
		expect(refusal).toMatchObject({ reason: 'rate_limit', scope: 'connection' });
		expect(refusal.retryAfterMs).toBeGreaterThan(0);
		expect(client.ws.readyState).toBe(client.ws.OPEN);
		await expect.poll(() => seen).toEqual([3072]);
	});

	it('charges the game lane by byte weight like every other application-work lane', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			messageAdmission: {
				perConnectionRate: 1000,
				perConnectionBytesRate: 4096,
				rateWindowMs: 60_000
			},
			handler: {
				open(ws, { platform }) { platform.grantPublish(ws, 'room:1'); }
			}
		});
		client = await connect(server.wsUrl);
		// Both frames are granted game publishes far under the frame rate,
		// ~3 KiB each: the first passes, the second crosses the 4 KiB byte
		// window and must be refused. A publish-granted client streaming
		// large game frames must not be a byte-rate bypass.
		const pad = 'x'.repeat(3000);
		client.ws.send(JSON.stringify({ type: 'game', event: 'move', data: pad }));
		client.ws.send(JSON.stringify({ type: 'game', event: 'move', data: pad }));
		const refusal = await client.waitFor((frame) => frame.type === 'message-overloaded');
		expect(refusal).toMatchObject({ reason: 'rate_limit', scope: 'connection' });
		expect(client.ws.readyState).toBe(client.ws.OPEN);
	});
});
