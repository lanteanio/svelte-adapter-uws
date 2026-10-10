// Real disk indexing and actual HTTP delivery: names are created at runtime so
// a checkout filesystem cannot silently normalize the regression fixtures.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const composed = '\u00fcber';
const decomposed = 'u\u0308ber';

function request(port, target, method = 'GET') {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(method + ' ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
		});
		socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('HTTP response timed out')); });
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => {
			const data = Buffer.concat(chunks);
			const split = data.indexOf('\r\n\r\n');
			const lines = data.subarray(0, split).toString('latin1').split('\r\n');
			const headers = {};
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(':');
				headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
			}
			resolve({ status: Number(lines[0].split(' ')[1]), headers, body: data.subarray(split + 4).toString() });
		});
	});
}

describeUWS('encoded static and prerendered names on the built runtime', () => {
	let server;
	let tmp;
	let assets;
	let state;
	let prerendered;
	let sequence = 0;
	function index(prefix, files) {
		const dir = path.join(tmp, String(sequence++));
		fs.mkdirSync(dir);
		for (const [name, body] of Object.entries(files)) {
			const file = path.join(dir, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		}
		assets.cacheDir(dir, prefix, false);
	}
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
		assets = await import('./fixture/build/handler/static-assets.js');
		state = await import('./fixture/build/handler/state.js');
		({ prerendered } = await import('./fixture/build/manifest-bridge.js'));
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-clean-names-'));
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it.runIf(process.platform === 'win32')('serves indexed Unicode tilde names while refusing filesystem aliases', async () => {
		const name = '\u00dcbersicht~v2.pdf';
		index('/windows-index', { [name]: 'unicode-tilde-body', 'ascii~v2.txt': 'ascii-tilde-body', ['folder/' + name]: 'nested-body' });
		const canonical = '/windows-index/' + encodeURIComponent(name);
		for (const target of [canonical, canonical.replace('~', '%7E'), '/windows-index/ascii~v2.txt', '/windows-index/ascii%7Ev2.txt']) {
			const response = await request(server.port, target);
			expect(response.status, target).toBe(200);
			expect(response.body, target).toBe(target.includes('ascii') ? 'ascii-tilde-body' : 'unicode-tilde-body');
		}
		const head = await request(server.port, canonical, 'HEAD');
		expect(head.status).toBe(200);
		expect(head.body).toBe('');
		expect(head.headers['content-length']).toBe(String(Buffer.byteLength('unicode-tilde-body')));
		for (const target of [
			'/windows-index/' + name,
			'/windows-index/LONGFI~1.PDF',
			'/windows-index/LONGFI%7E1.PDF',
			canonical + ':private',
			canonical + '%3Aprivate',
			'/windows-index/folder%2F' + encodeURIComponent(name)
		]) expect((await request(server.port, target)).status, target).toBe(400);
		expect((await request(server.port, canonical, 'POST')).status).toBe(400);
	});

});
