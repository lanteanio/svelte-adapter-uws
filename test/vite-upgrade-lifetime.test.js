import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { bootViteDev } from './helpers/vite-dev.js';
import { findOpenssl, loopbackCertificate } from './helpers/openssl.js';

function deferred() {
	/** @type {() => void} */
	let resolve;
	const promise = new Promise((done) => { resolve = () => done(undefined); });
	return { promise, resolve };
}

/** @param {number} port @param {string} target */
function upgradeRequest(port, target) {
	return `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
}

/** @param {number} port @param {string} target @param {string} [ca] */
function refusedUpgrade(port, target, ca) {
	return new Promise((resolve, reject) => {
		const socket = ca === undefined
			? connect({ host: '127.0.0.1', port })
			: connectTls({ host: '127.0.0.1', port, ca });
		let response = '';
		socket.setEncoding('utf8');
		socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade response timed out')));
		socket.once('error', reject);
		socket.on('data', (chunk) => { response += chunk; });
		socket.once('end', () => resolve(response));
		socket.once(ca === undefined ? 'connect' : 'secureConnect', () => {
			socket.write(upgradeRequest(port, target));
		});
	});
}

/** @param {number} port @param {string} [ca] */
function healthyUpgrade(port, ca) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${ca === undefined ? 'ws' : 'wss'}://127.0.0.1:${port}/ws`, ca === undefined ? { handshakeTimeout: 2000 } : { ca, handshakeTimeout: 2000 });
		ws.once('error', reject);
		ws.once('open', () => { ws.terminate(); resolve(101); });
		ws.once('unexpected-response', (_req, res) => {
			res.resume();
			reject(new Error('Unexpected upgrade status ' + res.statusCode));
		});
	});
}

const openssl = findOpenssl();
for (const secure of [false, true]) {
	(openssl === null && secure && process.env.CI !== 'true' ? describe.skip : describe)(`Vite upgrade lifetime over ${secure ? 'TLS' : 'cleartext'}`, () => {
		/** @type {Awaited<ReturnType<typeof bootViteDev>> | undefined} */
		let server;
		/** @type {string | undefined} */
		let directory;
		/** @type {string | undefined} */
		let ca;
		afterAll(async () => {
			await server?.close();
			if (directory !== undefined) {
				if (dirname(directory) !== tmpdir()) throw new Error('Unexpected certificate directory');
				rmSync(directory, { recursive: true, force: true });
			}
		});

		it('refuses malformed targets and raw path aliases without ending the server', async () => {
			/** @type {{ key: string, cert: string } | undefined} */
			let tls;
			if (secure) {
				if (openssl === null) throw new Error('TLS upgrade tests require openssl');
				directory = mkdtempSync(join(tmpdir(), 'uws-vite-upgrade-'));
				tls = loopbackCertificate(openssl, directory);
				ca = tls.cert;
			}
			server = await bootViteDev({ handler: { upgrade() { return {}; } }, tls });
			for (const target of ['//', 'http://[', '/x/../ws', '/ws#fragment']) {
				const response = await refusedUpgrade(server.port, target, ca);
				expect(response, target).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
				expect(response, target).toContain('\r\n\r\nBad Request');
				expect(await healthyUpgrade(server.port, ca), target).toBe(101);
			}
		}, 120_000);
	});
}

describe('Vite upgrade lifetime while waiting', () => {
	it('survives a TCP reset while the handler module is still loading', async () => {
		const ready = deferred();
		let calls = 0;
		const server = await bootViteDev({
			ready: ready.promise,
			handler: { upgrade() { calls++; return {}; } }
		});
		const socket = connect({ host: '127.0.0.1', port: server.port });
		socket.on('error', () => {});
		try {
			const entered = once(server.httpServer, 'upgrade');
			await once(socket, 'connect');
			socket.write(upgradeRequest(server.port, '/ws'));
			const [, accepted] = await entered;
			const closed = new Promise((resolve) => accepted.once('close', resolve));
			socket.resetAndDestroy();
			await closed;
			ready.resolve();
			expect(await healthyUpgrade(server.port)).toBe(101);
			expect(calls).toBe(1);
		} finally {
			ready.resolve();
			socket.destroy();
			await server.close();
		}
	});

	it('survives a TCP reset during an asynchronous upgrade hook', async () => {
		const entered = deferred();
		const release = deferred();
		let calls = 0;
		const server = await bootViteDev({
			handler: {
				async upgrade() {
					if (++calls === 1) { entered.resolve(); await release.promise; }
					return {};
				}
			}
		});
		const socket = connect({ host: '127.0.0.1', port: server.port });
		socket.on('error', () => {});
		try {
			const acceptedUpgrade = once(server.httpServer, 'upgrade');
			await once(socket, 'connect');
			socket.write(upgradeRequest(server.port, '/ws'));
			const [, accepted] = await acceptedUpgrade;
			await entered.promise;
			const closed = new Promise((resolve) => accepted.once('close', resolve));
			socket.resetAndDestroy();
			await closed;
			release.resolve();
			expect(await healthyUpgrade(server.port)).toBe(101);
			expect(calls).toBe(2);
		} finally {
			release.resolve();
			socket.destroy();
			await server.close();
		}
	});
});
