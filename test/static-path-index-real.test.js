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

function request(port, target, method = 'GET', host = '127.0.0.1') {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(method + ' ' + target + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
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

	it('leaves host canonicalization off by default', async () => {
		const response = await request(server.port, '/test.txt', 'GET', 'www.example.com');
		expect(response.status).toBe(200);
		expect(response.headers.location).toBeUndefined();
		expect(response.body.length).toBeGreaterThan(0);
	});

	for (const method of ['GET', 'HEAD']) {
		it('serves browser-encoded spaces and unreserved characters over ' + method, async () => {
			const body = 'space-paren-hyphen-body';
			index('/browser-names-' + method, { 'vtt_wct (34).png': body, 'a-b(c).txt': body, 'nested/file name.txt': body });
			for (const name of ['vtt_wct%20(34).png', 'vtt_wct%20%2834%29.png', 'a%2Db%28c%29.txt', 'a%2db(c).txt', 'nested/file%20name.txt']) {
				const target = '/browser-names-' + method + '/' + name + '?keep=%2F';
				const response = await request(server.port, target, method);
				expect(response.status, target).toBe(200);
				expect(response.body, target).toBe(method === 'HEAD' ? '' : body);
				expect(response.headers['content-length'], target).toBe(String(Buffer.byteLength(body)));
			}
		});
	}

	it('decodes an indexed name only once without traversing directories or matching encoded separators', async () => {
		index('/browser-guards', { 'file name.txt': 'indexed-space-body', 'nested/secret.txt': 'indexed-nested-body' });
		for (const target of [
			'/browser-guards/file%2520name.txt',
			'/browser-guards/nested%2Fsecret.txt',
			'/browser-guards/nested%2fsecret.txt',
			'/browser-guards/nested/../file%20name.txt',
			'/browser-guards/nested/%2e%2e/file%20name.txt',
			'/browser-guards/absent%20name.txt'
		]) {
			const response = await request(server.port, target);
			expect([400, 404], target).toContain(response.status);
			expect(response.body, target).not.toContain('indexed-space-body');
			expect(response.body, target).not.toContain('indexed-nested-body');
		}
		for (const target of ['/browser-guards/file%name.txt', '/browser-guards/file%FFname.txt']) {
			expect((await request(server.port, target)).status, target).toBe(400);
		}
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

	for (const directory of [false, true]) {
		it('serves the composed clean ' + (directory ? 'directory' : 'file') + ' path with its canonical slash policy', async () => {
			const prefix = directory ? '/clean-directory' : '/clean-file';
			const body = directory ? 'decomposed-directory-body' : 'decomposed-file-body';
			index(prefix, { [decomposed + (directory ? '/index.html' : '.html')]: body });
			const bare = prefix + '/' + composed;
			prerendered.add(bare);
			const canonical = encodeURI(bare + (directory ? '/' : ''));
			const response = await request(server.port, canonical);
			expect(response.status).toBe(200);
			expect(response.body).toBe(body);
			const head = await request(server.port, canonical, 'HEAD');
			expect(head.status).toBe(200);
			expect(head.body).toBe('');
			expect(head.headers['content-length']).toBe(String(Buffer.byteLength(body)));
			const alternate = encodeURI(bare + (directory ? '' : '/')) + '?keep=%2F';
			const redirect = await request(server.port, alternate);
			expect(redirect.status).toBe(308);
			expect(redirect.headers.location).toBe(canonical + '?keep=%2F');
			expect(state.staticCache.get(prefix + '/' + decomposed + (directory ? '/' : '')).buffer.toString()).toBe(body);
			expect(state.prerenderedDirStyle.has(bare)).toBe(directory);
		});
	}

	it('composes the clean path and slash marker of a nonempty base root', async () => {
		const rawBase = '/base-' + decomposed;
		const base = '/base-' + composed;
		index(rawBase, { 'index.html': 'base-root-body' });
		prerendered.add(base);
		const redirect = await request(server.port, encodeURI(base));
		expect(redirect.status).toBe(308);
		expect(redirect.headers.location).toBe(encodeURI(base + '/'));
		const response = await request(server.port, encodeURI(base + '/'));
		expect(response.status).toBe(200);
		expect(response.body).toBe('base-root-body');
		expect(state.staticCache.get(rawBase + '/').buffer.toString()).toBe('base-root-body');
	});

	for (const rawDirectory of [false, true]) {
		for (const aliasDirectory of [false, true]) {
			for (const aliasFirst of [false, true]) {
				it('keeps the real clean name over an NFC alias: raw directory=' + rawDirectory + ', alias directory=' + aliasDirectory + ', alias first=' + aliasFirst, async () => {
					const prefix = '/clean-collision-' + Number(rawDirectory) + Number(aliasDirectory) + Number(aliasFirst);
					const real = { [composed + (rawDirectory ? '/index.html' : '.html')]: 'real-composed-body' };
					const alias = { [decomposed + (aliasDirectory ? '/index.html' : '.html')]: 'alias-decomposed-body' };
					for (const files of aliasFirst ? [alias, real] : [real, alias]) index(prefix, files);
					const bare = prefix + '/' + composed;
					prerendered.add(bare);
					const canonical = encodeURI(bare + (rawDirectory ? '/' : ''));
					const response = await request(server.port, canonical);
					expect(response.status).toBe(200);
					expect(response.body).toBe('real-composed-body');
					const alternate = await request(server.port, encodeURI(bare + (rawDirectory ? '' : '/')));
					expect(alternate.status).toBe(308);
					expect(alternate.headers.location).toBe(canonical);
					expect(state.prerenderedDirStyle.has(bare)).toBe(rawDirectory);
					expect(state.staticCache.get(prefix + '/' + decomposed + (aliasDirectory ? '/' : '')).buffer.toString()).toBe('alias-decomposed-body');
				});
			}
		}
	}

	for (const aliasDirectory of [false, true]) {
		for (const aliasFirst of [false, true]) {
			it('keeps a literal extensionless file over a clean alias: alias directory=' + aliasDirectory + ', alias first=' + aliasFirst, async () => {
				const prefix = '/literal-collision-' + Number(aliasDirectory) + Number(aliasFirst);
				const literal = { [composed]: 'literal-file-body' };
				const alias = { [decomposed + (aliasDirectory ? '/index.html' : '.html')]: 'prerendered-alias-body' };
				for (const files of aliasFirst ? [alias, literal] : [literal, alias]) index(prefix, files);
				const bare = prefix + '/' + composed;
				prerendered.add(bare);
				const response = await request(server.port, encodeURI(bare));
				expect(response.status).toBe(200);
				expect(response.body).toBe('literal-file-body');
				expect(state.prerenderedDirStyle.has(bare)).toBe(false);
				const alternate = await request(server.port, encodeURI(bare + '/'));
				expect(alternate.status).toBe(308);
				expect(alternate.headers.location).toBe(encodeURI(bare));
			});
		}
	}

	it('adds neither a clean alias nor a slash marker when NFC becomes plain ASCII', async () => {
		index('/clean-kelvin-file', { '\u212aey.html': 'kelvin-file' });
		index('/clean-kelvin-dir', { '\u212aey/index.html': 'kelvin-directory' });
		for (const prefix of ['/clean-kelvin-file', '/clean-kelvin-dir']) {
			expect(state.staticCache.has(prefix + '/Key')).toBe(false);
			expect(state.staticCache.has(prefix + '/Key/')).toBe(false);
			expect(state.prerenderedDirStyle.has(prefix + '/Key')).toBe(false);
		}
		expect((await request(server.port, '/clean-kelvin-file/%E2%84%AAey')).body).toBe('kelvin-file');
		expect((await request(server.port, '/clean-kelvin-dir/%E2%84%AAey/')).body).toBe('kelvin-directory');
	});
});
