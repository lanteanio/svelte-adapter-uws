import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;
const SIZE = 32 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
	const socket = net.createServer();
	await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
	const port = socket.address().port;
	await new Promise((resolve) => socket.close(resolve));
	return port;
}
function response(port, method = 'GET', headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: '/large-static/media.bin', headers }, (res) => {
			const hash = createHash('sha256');
			let length = 0;
			res.on('data', (chunk) => { length += chunk.length; hash.update(chunk); });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, length, hash: hash.digest('hex') }));
			res.on('error', reject);
		});
		req.setTimeout(15000, () => req.destroy(new Error('static response timed out')));
		req.on('error', reject);
		req.end();
	});
}
function hold(port, coding = 'identity', range = 'bytes=0-') {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port, highWaterMark: 1024 }, () => {
			socket.write('GET /large-static/media.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept-Encoding: ' + coding + '\r\nRange: ' + range + '\r\n\r\n');
		});
		const hash = createHash('sha256');
		let length = 0;
		let headerBytes = Buffer.alloc(0);
		let metadata;
		let finish;
		let fail;
		const done = new Promise((a, b) => { finish = a; fail = b; });
		done.catch(() => {});
		socket.setTimeout(15000, () => socket.destroy(new Error('held response timed out')));
		socket.on('error', (error) => { reject(error); fail(error); });
		socket.on('data', (chunk) => {
			if (!metadata) {
				headerBytes = Buffer.concat([headerBytes, chunk]);
				const end = headerBytes.indexOf('\r\n\r\n');
				if (end < 0) return;
				const lines = headerBytes.subarray(0, end).toString('latin1').split('\r\n');
				const headers = {};
				for (const line of lines.slice(1)) {
					const colon = line.indexOf(':');
					headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
				}
				metadata = { status: Number(lines[0].split(' ')[1]), headers };
				chunk = headerBytes.subarray(end + 4);
				socket.pause();
				resolve({ socket, ...metadata, resume: () => { socket.resume(); return done; } });
				headerBytes = null;
			}
			length += chunk.length;
			hash.update(chunk);
		});
		socket.on('end', () => finish({ ...metadata, length, hash: hash.digest('hex') }));
	});
}

describeUWS('large static response backpressure', () => {
	let dir;
	let child;
	let port;
	let childErrors = '';
	let serial = 0;
	const pending = new Map();
	const sockets = new Set();
	const bodies = {};
	beforeAll(async () => {
		expect(buildFixtureOnce()).toBe(true);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-large-static-'));
		bodies.identity = Buffer.alloc(SIZE);
		randomBytes(8 * 1024 * 1024).copy(bodies.identity);
		bodies.br = zlib.brotliCompressSync(bodies.identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
		bodies.gzip = zlib.gzipSync(bodies.identity, { level: 1 });
		for (const [coding, bytes] of Object.entries(bodies)) {
			expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
			fs.writeFileSync(path.join(dir, 'media.bin' + (coding === 'identity' ? '' : coding === 'br' ? '.br' : '.gz')), bytes);
		}
		port = await freePort();
		child = fork(fileURLToPath(new URL('./helpers/static-backpressure-child.js', import.meta.url)), [dir, String(port)], {
			execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			env: { ...process.env, ORIGIN: 'http://127.0.0.1:' + port }
		});
		child.stderr.on('data', (chunk) => { childErrors += chunk; });
		child.on('message', (message) => pending.get(message.id)?.(message));
		await new Promise((resolve, reject) => {
			child.once('message', resolve);
			child.once('exit', (code) => reject(new Error('static server exited ' + code + ': ' + childErrors)));
		});
	}, 400000);
	afterAll(async () => {
		for (const socket of sockets) socket.destroy();
		if (child && child.exitCode === null) {
			const stopped = new Promise((resolve) => child.once('exit', resolve));
			child.send({ op: 'stop' });
			await stopped;
		}
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	async function memory() {
		const id = ++serial;
		const result = await new Promise((resolve) => { pending.set(id, resolve); child.send({ id, op: 'memory' }); });
		pending.delete(id);
		return result.rss;
	}
	it('keeps resident memory bounded while eight clients stop reading an open-ended range', async () => {
		await response(port, 'HEAD');
		const before = await memory();
		const held = [];
		for (let i = 0; i < 8; i++) {
			const peer = await hold(port);
			sockets.add(peer.socket);
			held.push(peer);
			expect(peer.status).toBe(206);
			expect(peer.headers['content-range']).toBe('bytes 0-' + (SIZE - 1) + '/' + SIZE);
			expect(peer.headers['content-length']).toBe(String(SIZE));
		}
		await delay(150);
		const delta = (await memory()) - before;
		expect(delta, 'eight paused readers must not each pin a native copy of a 32 MiB file').toBeLessThan(SIZE * 3);
		for (const peer of held) { peer.socket.destroy(); sockets.delete(peer.socket); }
		await delay(50);
		const healthy = await response(port, 'GET', { Range: 'bytes=17-1030' });
		expect(healthy.status).toBe(206);
		expect(healthy.hash).toBe(digest(bodies.identity.subarray(17, 1031)));
	}, 30000);
	it.each(['identity', 'br', 'gzip'])('resumes paused %s bytes without loss or duplication', async (coding) => {
		const peer = await hold(port, coding, 'bytes=113-');
		sockets.add(peer.socket);
		expect(peer.status).toBe(206);
		await delay(50);
		const received = await peer.resume();
		sockets.delete(peer.socket);
		const expected = bodies[coding].subarray(113);
		expect(received.length).toBe(expected.length);
		expect(received.hash).toBe(digest(expected));
		expect(received.headers['content-encoding']).toBe(coding === 'identity' ? undefined : coding);
		expect(received.headers['content-range']).toBe('bytes 113-' + (bodies[coding].length - 1) + '/' + bodies[coding].length);
	}, 30000);
	it.each(['identity', 'br', 'gzip'])('serves complete %s bodies and HEAD metadata', async (coding) => {
		const headers = { 'Accept-Encoding': coding };
		const full = await response(port, 'GET', headers);
		expect(full.status).toBe(200);
		expect(full.length).toBe(bodies[coding].length);
		expect(full.hash).toBe(digest(bodies[coding]));
		const head = await response(port, 'HEAD', headers);
		expect(head.status).toBe(200);
		expect(head.length).toBe(0);
		expect(head.headers['content-length']).toBe(String(bodies[coding].length));
	}, 30000);
});
