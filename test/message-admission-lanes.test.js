import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIngress } from '../src/runtime/handler/ingress.js';
import { buildBinaryFrame } from '../src/runtime/wire.js';

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

function captureMetrics() {
	const series = new Map();
	return {
		series,
		metrics: {
			counter(name) {
				return {
					inc(labels) {
						const key = `${name}:${JSON.stringify(labels ?? {})}`;
						series.set(key, (series.get(key) ?? 0) + 1);
					}
				};
			},
			gauge() { return { set() {} }; }
		}
	};
}

function metricKey(reason, scope) {
	return `ws_message_admission_rejected_total:${JSON.stringify({ reason, scope })}`;
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
	vi.restoreAllMocks();
});

describeUWS('established-message application lanes', () => {
	it('sheds saturated binary ingress through the typed and metered boundary', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { metrics, series } = captureMetrics();
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const seen = [];
		registerIngress('rt259.admission:1', {
			decode(payload) { return payload[0]; },
			async route(_ws, _target, value) {
				seen.push(value);
				if (value === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
			}
		});
		server = await createTestServer({
			metrics,
			messageAdmission: {
				perConnectionConcurrent: 1,
				globalConcurrent: 1,
				maxQueue: 1
			},
			handler: { message() {} }
		});
		client = await connect(server.wsUrl);
		client.ws.send(JSON.stringify({ type: 'hello', caps: ['wire.ingress:1'] }));
		await client.waitFor((frame) => frame.type === 'ingress-ok');
		client.ws.send(JSON.stringify({ type: 'ingress-bind', id: 7, kind: 'rt259.admission:1' }));
		await client.waitFor((frame) => frame.type === 'ingress-bound' && frame.id === 7);

		client.ws.send(Buffer.from(buildBinaryFrame(1, 7, 1, new Uint8Array([1]))));
		await firstStarted.promise;
		client.ws.send(Buffer.from(buildBinaryFrame(1, 7, 2, new Uint8Array([2]))));
		client.ws.send(Buffer.from(buildBinaryFrame(1, 7, 3, new Uint8Array([3]))));

		await expect(client.waitFor((frame) => frame.type === 'message-overloaded')).resolves.toEqual({
			type: 'message-overloaded',
			reason: 'queue_full',
			scope: 'global'
		});
		expect(client.ws.readyState).toBe(client.ws.OPEN);
		releaseFirst.resolve();
		await expect.poll(() => seen).toEqual([1, 2]);
		expect(series.get(metricKey('queue_full', 'global'))).toBe(1);
	});

	it('rate-sheds the game publish lane before fan-out and keeps the socket open', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { metrics, series } = captureMetrics();
		server = await createTestServer({
			metrics,
			messageAdmission: { perConnectionRate: 1, rateWindowMs: 60_000 },
			handler: {
				open(ws, { platform }) { platform.grantPublish(ws, 'room'); }
			}
		});
		const publishGame = vi.spyOn(server.platform, 'publishGame');
		client = await connect(server.wsUrl);
		client.ws.send(JSON.stringify({ type: 'game', event: 'move', data: { x: 1 }, id: 1 }));
		client.ws.send(JSON.stringify({ type: 'game', event: 'move', data: { x: 2 }, id: 2 }));

		await expect(client.waitFor((frame) => frame.type === 'message-overloaded')).resolves.toMatchObject({
			type: 'message-overloaded',
			reason: 'rate_limit',
			scope: 'connection'
		});
		expect(client.ws.readyState).toBe(client.ws.OPEN);
		expect(publishGame).toHaveBeenCalledTimes(1);
		expect(publishGame).toHaveBeenCalledWith(expect.anything(), 'room', 'move', { x: 1 }, 1);
		expect(series.get(metricKey('rate_limit', 'connection'))).toBe(1);
	});
});

const surfaces = [
	{
		file: new URL('../src/runtime/handler.js', import.meta.url),
		ingressWork: 'runIngressApplicationWork',
		gameWork: 'runGameApplicationWork',
		hookBoundaries: 2
	},
	{
		file: new URL('../src/testing.js', import.meta.url),
		ingressWork: 'runIngressApplicationWorkT',
		gameWork: 'runGameApplicationWorkT',
		hookBoundaries: 1
	},
	{
		file: new URL('../src/vite.js', import.meta.url),
		ingressWork: 'runIngressApplicationWorkV',
		gameWork: 'runGameApplicationWorkV',
		hookBoundaries: 1
	}
];

function occurrences(source, pattern) {
	return [...source.matchAll(pattern)].length;
}

describe('application-message admission containment', () => {
	it.each(surfaces)('enumerates every application dispatch sink in $file', ({ file, ingressWork, gameWork, hookBoundaries }) => {
		const source = readFileSync(file, 'utf8');
		const ingressStart = source.indexOf(`const ${ingressWork}`);
		const ingressDefinition = source.slice(ingressStart, source.indexOf(';', ingressStart) + 1);
		const gameStart = source.indexOf(`const ${gameWork}`);
		const gameDefinition = source.slice(gameStart, source.indexOf('\n\t};', gameStart) + 4);

		// Sink inventory: binary ingress, typed game fan-out, and the generic app
		// hook. Exactly one ingress/game sink per surface prevents a new bypass
		// from being added without extending this explicit manifest.
		expect(occurrences(source, /\bdispatchIngressFrame\(/g)).toBe(1);
		expect(occurrences(source, /\.publishGame\(/g)).toBe(1);
		expect(occurrences(source, /await runAdmittedMessageHook\(/g)).toBe(hookBoundaries);
		expect(ingressDefinition).toContain('dispatchIngressFrame(');
		expect(gameDefinition).toContain('.publishGame(');

		// Both named sinks must be passed through the common boundary exactly
		// once. Replacing either call with a direct dispatch is a failing mutation.
		expect(occurrences(source, new RegExp(`await runAdmittedMessageWork\\(messageAdmission, [^\\n]+${ingressWork},`, 'g'))).toBe(1);
		expect(occurrences(source, new RegExp(`await runAdmittedMessageWork\\(messageAdmission, [^\\n]+${gameWork},`, 'g'))).toBe(1);
	});
});
