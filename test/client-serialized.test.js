import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import ts from 'typescript';
import * as client from '../src/client.js';

let connection;
let server;
let sockets;
let received;
let waiters;
const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

beforeEach(() => {
	sockets = [];
	received = [];
	waiters = [];
	delete globalThis.window;
	globalThis.WebSocket = class extends WebSocket {
		constructor(...args) {
			super(...args);
			sockets.push(this);
		}
	};
});

afterEach(async () => {
	vi.restoreAllMocks();
	connection?.close();
	connection = undefined;
	for (const socket of sockets) socket.terminate();
	if (server) {
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
		server = undefined;
	}
	if (originalWebSocket === undefined) delete globalThis.WebSocket;
	else globalThis.WebSocket = originalWebSocket;
	if (originalWindow === undefined) delete globalThis.window;
	else globalThis.window = originalWindow;
});

async function start() {
	server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	server.on('connection', (peer) => {
		peer.on('message', (data, binary) => {
			const frame = { bytes: Buffer.from(data), binary };
			received.push(frame);
			for (const waiter of [...waiters]) {
				if (!waiter.matches(frame)) continue;
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			}
		});
	});
	connection = client.connect({
		url: 'ws://127.0.0.1:' + server.address().port,
		reconnectInterval: 1,
		maxReconnectInterval: 1
	});
	return connection;
}

function receivedText(text) {
	const matches = (frame) => !frame.binary && frame.bytes.toString() === text;
	const existing = received.find(matches);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => waiters.push({ matches, resolve }));
}

async function barrier(text) {
	const delivered = receivedText(text);
	expect(connection.sendSerialized(text)).toBe(true);
	await delivered;
}

describe('client pre-serialized text sends', () => {
	it('delivers exact JSON text over a real socket without parsing or serializing again', async () => {
		await start();
		await client.ready();
		let serializations = 0;
		const args = JSON.stringify({ toJSON() { serializations++; return { label: 'Gr\u00fc\u00dfe', n: 4 }; } });
		const text = '{ "type": "custom", "args": ' + args + ', "value": 1e2 }';
		const delivered = receivedText(text);
		const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('unexpected parse'); });
		const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('unexpected serialization'); });
		let accepted;
		try { accepted = connection.sendSerialized(text); }
		finally { parse.mockRestore(); stringify.mockRestore(); }
		expect(accepted).toBe(true);
		expect((await delivered).bytes.equals(Buffer.from(text))).toBe(true);
		expect(serializations).toBe(1);
	});

	it('retains no connecting, closing or disconnected sends across the next open', async () => {
		await start();
		expect(sockets[0].readyState).toBe(WebSocket.CONNECTING);
		expect(connection.sendSerialized('{"phase":"connecting"}')).toBe(false);
		await client.ready();
		await barrier('{"phase":"first-open"}');
		const first = sockets[0];
		const closed = once(first, 'close');
		first.close();
		expect(first.readyState).toBe(WebSocket.CLOSING);
		let status;
		const unsubscribe = connection.status.subscribe((value) => { status = value; });
		expect(status).toBe('open');
		expect(connection.sendSerialized('{"phase":"closing"}')).toBe(false);
		await closed;
		expect(first.readyState).toBe(WebSocket.CLOSED);
		expect(connection.sendSerialized('{"phase":"disconnected"}')).toBe(false);
		connection.sendQueued({ phase: 'queued' });
		await client.ready();
		await barrier('{"phase":"second-open"}');
		unsubscribe();
		const application = received.filter((frame) => !frame.binary).map((frame) => JSON.parse(frame.bytes.toString())).filter((frame) => frame.phase);
		expect(application).toEqual([{ phase: 'first-open' }, { phase: 'queued' }, { phase: 'second-open' }]);
		expect(sockets).toHaveLength(2);
	});

	it('preserves send and sendQueued string and binary frames on the wire', async () => {
		await start();
		const pendingBinary = new Uint8Array([0, 19, 255]);
		connection.sendQueued('pending');
		connection.sendQueued(pendingBinary);
		await client.ready();
		connection.send('plain');
		connection.sendQueued('queued-open');
		connection.send(new Uint8Array([4, 5]).buffer);
		connection.sendQueued(new DataView(new Uint8Array([6, 7]).buffer));
		await barrier('{"phase":"complete"}');
		expect(received.filter((frame) => frame.binary).map((frame) => [...frame.bytes])).toEqual([[0, 19, 255], [4, 5], [6, 7]]);
		expect(received.filter((frame) => !frame.binary).map((frame) => frame.bytes.toString()).filter((text) => text.startsWith('"'))).toEqual(['"pending"', '"plain"', '"queued-open"']);
	});

	it('rejects non-string inputs without coercion while open', async () => {
		await start();
		await client.ready();
		const coercion = vi.fn(() => '{}');
		for (const value of [undefined, null, 42, {}, [], new String('{}'), new Uint8Array(1), { toString: coercion, toJSON: coercion }]) {
			expect(() => connection.sendSerialized(value)).toThrow(TypeError);
		}
		expect(coercion).not.toHaveBeenCalled();
		await barrier('{"phase":"after-invalid"}');
		expect(received.filter((frame) => JSON.parse(frame.bytes.toString()).type !== 'hello')).toHaveLength(1);
	});

	it('propagates transport errors and never requeues a failed send', async () => {
		await start();
		await client.ready();
		const socket = sockets[0];
		const failure = new Error('transport refused');
		const send = vi.spyOn(socket, 'send').mockImplementationOnce(() => { throw failure; });
		expect(() => connection.sendSerialized('{"phase":"failed"}')).toThrow(failure);
		send.mockRestore();
		const closed = once(socket, 'close');
		socket.close();
		await closed;
		await client.ready();
		await barrier('{"phase":"after-failure"}');
		expect(received.some((frame) => frame.bytes.toString() === '{"phase":"failed"}')).toBe(false);
	});

	it('returns false with no socket during SSR and after permanent close', async () => {
		delete globalThis.WebSocket;
		connection = client.connect();
		expect(connection.sendSerialized('{}')).toBe(false);
		expect(() => connection.sendSerialized({})).toThrow(TypeError);
		connection.close();
		expect(connection.sendSerialized('{}')).toBe(false);
	});

	it('declares a string-only boolean seam while retaining existing send input types', () => {
		const file = fileURLToPath(new URL('./client-serialized-consumer.mts', import.meta.url)).replaceAll('\\', '/');
		const source = [
			'import { connect } from "../src/client.js";',
			'const connection = connect();',
			'const accepted: boolean = connection.sendSerialized("{}");',
			'// @ts-expect-error a serialized message must be a primitive string',
			'connection.sendSerialized({ type: "custom" });',
			'// @ts-expect-error binary data belongs to send or sendQueued',
			'connection.sendSerialized(new Uint8Array(1));',
			'// @ts-expect-error acceptance is boolean, not a string or any',
			'const result: string = connection.sendSerialized("{}");',
			'connection.send("plain");',
			'connection.send(new ArrayBuffer(1));',
			'connection.sendQueued("plain");',
			'connection.sendQueued(new Uint8Array(1));'
		].join('\n');
		const options = { noEmit: true, strict: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
		const host = ts.createCompilerHost(options);
		const getSourceFile = host.getSourceFile.bind(host);
		host.getSourceFile = (name, ...rest) => name === file ? ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true) : getSourceFile(name, ...rest);
		const program = ts.createProgram([file], options, host);
		expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
	});
});
