import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { parseBinaryFrame } from '../../src/runtime/wire.js';
import { startRealRuntime } from './real-runtime.js';

const capability = 'test.batch-payload:1';
const entries = [{ data: { n: 1 } }, { data: { n: 2 } }];
const runtime = process.argv[2];
let server;
let platform;
let connections;
let stop;
let cases = 0;

if (runtime === 'built') {
	server = await startRealRuntime();
	({ platform } = await import('../fixture/build/handler/platform.js'));
	({ wsConnections: connections } = await import('../fixture/build/handler/state.js'));
	stop = () => server.stop();
} else if (runtime === 'testing') {
	const { createTestServer } = await import('../../src/testing.js');
	server = await createTestServer({});
	platform = server.platform;
	connections = server.wsConnections;
	stop = () => server.close();
} else {
	throw new Error('unknown runtime');
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert(Date.now() < deadline, label);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function connected(run) {
	const topic = 'batch-payload-' + cases;
	const client = new WebSocket(server.wsUrl);
	const frames = [];
	client.on('message', (raw, binary) => {
		frames.push(binary
			? { binary, value: parseBinaryFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) }
			: { binary, value: JSON.parse(raw.toString()) });
	});
	try {
		await once(client, 'open');
		client.send(JSON.stringify({ type: 'hello', caps: [capability] }));
		client.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
		await waitFor(() => frames.some((f) => f.value?.type === 'subscribed' && f.value.topic === topic), 'subscribe ack');
		assert.equal(connections.size, 1);
		const [ws] = connections;
		frames.length = 0;
		await run({ ws, topic, frames, async flush() {
			platform.send(ws, topic, 'complete', null);
			await waitFor(() => frames.some((f) => f.value?.event === 'complete'), 'delivery barrier');
			return frames.filter((f) => f.value?.event !== 'complete');
		} });
		cases++;
	} finally {
		const closed = client.readyState === WebSocket.CLOSED ? Promise.resolve() : once(client, 'close');
		client.terminate();
		await closed;
		await waitFor(() => connections.size === 0, 'server close');
	}
}

function codec(encode) {
	return { capability, schemaVersion: 7, state: { onAttach: () => ({ schemaVersion: 7 }) }, encode };
}

const invalid = [
	['object', () => ({})],
	['promise', () => Promise.resolve(new Uint8Array([1]))],
	['array-buffer', () => new ArrayBuffer(1)],
	['array', () => [1]],
	['string', () => 'x'],
	['empty-string', () => ''],
	['number', () => 1],
	['zero', () => 0],
	['boolean', () => true],
	['false', () => false],
	['data-view', () => new DataView(new ArrayBuffer(1))],
	['uint16-array', () => new Uint16Array([1])],
	['clamped-array', () => new Uint8ClampedArray([1])]
];
const valid = [
	['bytes', () => new Uint8Array([3, 5])],
	['empty', () => new Uint8Array(0)],
	['buffer', () => Buffer.from([3, 5])],
	['subarray', () => new Uint8Array([9, 3, 5, 9]).subarray(1, 3)],
	['other-realm', () => runInNewContext('new Uint8Array([3, 5])')]
];

try {
	for (const mode of ['batch', 'entry']) {
		for (const [name, make] of invalid) {
			await connected(async ({ ws, topic, flush }) => {
				const calls = [];
				const wire = codec((event) => {
					calls.push(event);
					return mode === 'entry' && event.endsWith('-batch') ? null : make();
				});
				assert.throws(() => platform.sendWireBatch(ws, topic, 'update', entries, wire), {
					name: 'TypeError', message: 'sendWireBatch: wire.encode must return Uint8Array or null'
				}, mode + ': ' + name);
				assert.deepEqual(calls, mode === 'entry' ? ['update-batch', 'update'] : ['update-batch']);
				assert.deepEqual(await flush(), [], 'invalid payload must not announce or deliver a frame');
			});
		}
		for (const [name, make] of valid) {
			await connected(async ({ ws, topic, flush }) => {
				const payload = make();
				const wire = codec((event) => mode === 'entry' && event.endsWith('-batch') ? null : payload);
				assert.equal(platform.sendWireBatch(ws, topic, 'update', entries, wire), 1, mode + ': ' + name);
				const delivered = await flush();
				assert.equal(delivered[0].value.type, 'wire-id');
				assert.equal(delivered[0].value.topic, topic);
				assert.equal(delivered.length, mode === 'batch' ? 2 : 3);
				for (const frame of delivered.slice(1)) {
					assert.equal(frame.binary, true);
					assert.equal(frame.value.topicId, delivered[0].value.id);
					assert.equal(frame.value.schemaVersion, 7);
					assert.equal(frame.value.seq, 0);
					assert.deepEqual([...frame.value.payload], [...payload]);
				}
			});
		}
		await connected(async ({ ws, topic, flush }) => {
			const failure = new Error('codec failed');
			const wire = codec((event) => {
				if (mode === 'entry' && event.endsWith('-batch')) return null;
				throw failure;
			});
			assert.throws(() => platform.sendWireBatch(ws, topic, 'update', entries, wire), (error) => error === failure);
			assert.deepEqual(await flush(), []);
		});
	}
	for (const declined of [null, undefined]) {
		await connected(async ({ ws, topic, flush }) => {
			assert.equal(platform.sendWireBatch(ws, topic, 'update', entries, codec(() => declined)), 1);
			assert.deepEqual(await flush(), entries.map(({ data }) => ({ binary: false, value: { topic, event: 'update', data } })));
		});
	}
	await connected(async ({ ws, topic, flush }) => {
		const calls = [];
		const wire = codec((event, data) => {
			if (event.endsWith('-batch')) return null;
			calls.push(data.n);
			return data.n === 1 ? new Uint8Array([1]) : {};
		});
		assert.throws(() => platform.sendWireBatch(ws, topic, 'update', [...entries, { data: { n: 3 } }], wire), TypeError);
		assert.deepEqual(calls, [1, 2]);
		const delivered = await flush();
		assert.equal(delivered.length, 2);
		assert.equal(delivered[0].value.type, 'wire-id');
		assert.equal(delivered[1].binary, true);
		assert.deepEqual([...delivered[1].value.payload], [1]);
	});
	console.log('send-wire-batch-payload: ' + cases + ' cases passed');
} finally {
	await stop();
}
