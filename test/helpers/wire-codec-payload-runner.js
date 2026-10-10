import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { parseBinaryFrame } from '../../src/runtime/wire.js';
import { startRealRuntime } from './real-runtime.js';

const capability = 'test.codec-payload:1';
const entries = [{ data: { n: 1 } }, { data: { n: 2 } }];
const runtime = process.argv[2];
const requestedApi = process.argv[3];
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

async function connected(run, count = 1) {
	const topic = 'codec-payload-' + cases;
	const peers = [];
	try {
		for (let i = 0; i < count; i++) {
			const client = new WebSocket(server.wsUrl);
			const frames = [];
			client.on('message', (raw, binary) => frames.push(binary
				? { binary, value: parseBinaryFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) }
				: { binary, value: JSON.parse(raw.toString()) }));
			peers.push({ client, frames });
			await once(client, 'open');
			client.send(JSON.stringify({ type: 'hello', caps: [capability] }));
			client.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
			await waitFor(() => frames.some(f => f.value?.type === 'subscribed' && f.value.topic === topic), 'subscribe ack');
			frames.length = 0;
		}
		assert.equal(connections.size, count);
		const sockets = [...connections];
		const flushAll = async () => {
			for (const ws of sockets) platform.send(ws, topic, 'complete', null);
			await waitFor(() => peers.every(({ frames }) => frames.some(f => f.value?.event === 'complete')), 'delivery barrier');
			return peers.map(({ frames }) => frames.filter(f => f.value?.event !== 'complete'));
		};
		await run({ ws: sockets[0], sockets, topic, flushAll, flush: async () => (await flushAll())[0] });
		cases++;
	} finally {
		await Promise.all(peers.map(async ({ client }) => {
			const closed = client.readyState === WebSocket.CLOSED ? Promise.resolve() : once(client, 'close');
			client.terminate(); await closed;
		}));
		await waitFor(() => connections.size === 0, 'server close');
	}
}

const apis = [
	'sendWire-stateful', 'sendWire-stateless',
	'publishWire-stateful', 'publishWire-shared', 'publishWire-stateless',
	'publishWireBatch-batch', 'publishWireBatch-entry', 'publishWireBatch-stateless'
];
function codec(api, encode) {
	const wire = { capability, schemaVersion: 7, state: { onAttach: () => ({ schemaVersion: 7 }) },
		encode: (event, data, state) => api === 'publishWireBatch-entry' && event.endsWith('-batch') ? null : encode(event, data, state) };
	if (api.endsWith('-stateless')) delete wire.state;
	if (api.endsWith('-shared')) wire.state.onAttach = () => null;
	return wire;
}
function invoke(api, ws, topic, wire, dataEntries = entries) {
	if (api.startsWith('sendWire-')) return platform.sendWire(ws, topic, 'update', dataEntries[0].data, wire);
	if (api.startsWith('publishWire-')) return platform.publishWire(topic, 'update', dataEntries[0].data, wire, { seq: false, relay: false });
	return platform.publishWireBatch(topic, 'update', dataEntries, wire, { seq: false, relay: false });
}
function assertBinaryFrames(delivered, topic, expectedPayloads) {
	assert.equal(delivered.length, expectedPayloads.length + 1);
	assert.equal(delivered[0].binary, false);
	assert.equal(delivered[0].value.type, 'wire-id');
	assert.equal(delivered[0].value.topic, topic);
	for (const [index, payload] of expectedPayloads.entries()) {
		const frame = delivered[index + 1];
		assert.equal(frame.binary, true);
		assert.equal(frame.value.topicId, delivered[0].value.id);
		assert.equal(frame.value.schemaVersion, 7);
		assert.equal(frame.value.seq, 0);
		assert.deepEqual([...frame.value.payload], [...payload]);
	}
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
	assert(apis.includes(requestedApi), 'known API lane');
	for (const api of apis.filter(api => api === requestedApi)) {
		for (const [name, make] of invalid) {
			await connected(async ({ ws, topic, flush }) => {
				let calls = 0;
				const wire = codec(api, () => { calls++; return make(); });
				assert.throws(() => invoke(api, ws, topic, wire), {
					name: 'TypeError', message: 'wire.encode must return Uint8Array or null'
				}, api + ': ' + name);
				assert.equal(calls, 1, 'invalid result stops the remaining encode walk');
				assert.deepEqual(await flush(), [], 'invalid result must not announce or deliver a frame');
			});
		}
		for (const [name, make] of valid) {
			await connected(async ({ ws, topic, flush }) => {
				const payload = make();
				const result = invoke(api, ws, topic, codec(api, () => payload));
				assert.equal(result, api.startsWith('sendWire-') ? 1 : true, api + ': ' + name);
				const count = api === 'publishWireBatch-entry' || api === 'publishWireBatch-stateless' ? 2 : 1;
				assertBinaryFrames(await flush(), topic, Array(count).fill(payload));
			});
		}
		for (const declined of [null, undefined]) {
			await connected(async ({ ws, topic, flush }) => {
				assert.equal(invoke(api, ws, topic, codec(api, () => declined)), api.startsWith('sendWire-') ? 1 : true);
				const expected = api.startsWith('publishWireBatch-') ? entries : entries.slice(0, 1);
				assert.deepEqual(await flush(), expected.map(({ data }) => ({ binary: false, value: { topic, event: 'update', data } })));
			});
		}
		await connected(async ({ ws, topic, flush }) => {
			const failure = new Error('codec failed');
			assert.throws(() => invoke(api, ws, topic, codec(api, () => { throw failure; })), error => error === failure);
			assert.deepEqual(await flush(), []);
		});
	}
	for (const api of ['publishWireBatch-entry', 'publishWireBatch-stateless'].filter(api => api === requestedApi)) {
		await connected(async ({ ws, topic, flush }) => {
			const calls = [];
			const wire = codec(api, (_event, data) => {
				calls.push(data.n);
				return data.n === 1 ? new Uint8Array([1]) : {};
			});
			assert.throws(() => invoke(api, ws, topic, wire, [...entries, { data: { n: 3 } }]), TypeError);
			assert.deepEqual(calls, [1, 2]);
			assertBinaryFrames(await flush(), topic, [new Uint8Array([1])]);
		});
	}
	for (const api of ['publishWire-stateful', 'publishWireBatch-batch'].filter(api => api === requestedApi)) {
		await connected(async ({ ws, topic, flushAll }) => {
			const wire = codec(api, (_event, _data, state) => state.first ? new Uint8Array([1]) : {});
			wire.state.onAttach = socket => ({ schemaVersion: 7, first: socket === ws });
			assert.throws(() => invoke(api, ws, topic, wire), TypeError);
			const delivered = await flushAll();
			assertBinaryFrames(delivered[0], topic, [new Uint8Array([1])]);
			assert.deepEqual(delivered[1], [], 'a later subscriber receives no invalid admission');
		}, 2);
	}
	console.log('wire-codec-payload: ' + cases + ' cases passed');
} finally { await stop(); }
