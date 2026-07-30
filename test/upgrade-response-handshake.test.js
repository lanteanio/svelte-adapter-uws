import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

/**
 * Raw-TCP WebSocket upgrade request, so nothing normalizes the bytes between
 * client and server. Resolves with the raw response as a latin1 string.
 * @param {number} port
 * @param {string} path
 * @returns {Promise<string>}
 */
function rawUpgrade(port, path) {
	return new Promise((resolve, reject) => {
		const key = Buffer.from('0123456789abcdef').toString('base64');
		const chunks = [];
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write(
				`GET ${path} HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${port}\r\n` +
				'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
				`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
			);
		});
		sock.on('data', (d) => chunks.push(d));
		sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
		sock.on('error', reject);
		sock.setTimeout(3000, () => { sock.destroy(); resolve(Buffer.concat(chunks).toString('latin1')); });
	});
}

describe('upgradeResponse header validation', () => {
	it('throws a TypeError when a header value contains CR or LF', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		expect(() => upgradeResponse({}, { 'x-evil': 'a\r\nInjected: yes' })).toThrow(TypeError);
		expect(() => upgradeResponse({}, { 'x-evil': 'a\r\nInjected: yes' })).toThrow(/CR, LF, or NUL/);
		expect(() => upgradeResponse({}, { 'x-evil': 'a\nb' })).toThrow(TypeError);
	});

	it('throws on a NUL byte in a value and on a non-token header name', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		expect(() => upgradeResponse({}, { 'x-evil': 'a\x00b' })).toThrow(TypeError);
		expect(() => upgradeResponse({}, { 'bad name': 'ok' })).toThrow(/RFC 7230 token/);
		expect(() => upgradeResponse({}, { 'bad\r\nname': 'ok' })).toThrow(TypeError);
	});

	it('refuses the control characters that do not split but still do not belong', async () => {
		// CR, LF and NUL are what actually split the response, but the accepted
		// class has to be the one Node enforces: a value this package accepts and
		// `cookies.set()` in the same package refuses is an inconsistency an app
		// will hit, and a value that survives here only to throw inside the first
		// Node-based proxy in front of it is worse than a clean refusal now.
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		for (const [name, ch] of [['VT', '\x0b'], ['FF', '\x0c'], ['DEL', '\x7f'], ['ESC', '\x1b']]) {
			expect(
				() => upgradeResponse({}, { 'x-ctl': `a${ch}b` }),
				`${name} must be refused`
			).toThrow(TypeError);
		}
	});

	it('matches the intended Node-compatible value class at every boundary', async () => {
		// The class must not overshoot: TAB is legal header whitespace, and uWS
		// writes bytes, so the Latin-1 high range is not a splitting risk.
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		for (const value of ['', '\t', ' ', '~', '\x80', 'caf\xe9', '\xff']) {
			expect(() => upgradeResponse({}, { 'x-boundary': value }), JSON.stringify(value)).not.toThrow();
		}
		for (const value of ['\x00', '\x08', '\x0a', '\x1f', '\x7f', '\u0100', '\u2028', '\ud800']) {
			expect(() => upgradeResponse({}, { 'x-boundary': value }), JSON.stringify(value)).toThrow(TypeError);
		}
	});

	it('matches the complete RFC token alphabet for names without Unicode folding', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		const token = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
		expect(() => upgradeResponse({}, { [token]: 'ok' })).not.toThrow();
		for (const name of ['', 'bad name', 'bad:name', 'bad\tname', 'bad\r\nname', 'bad\x00name', 'café', 'x\u212a']) {
			expect(() => upgradeResponse({}, { [name]: 'ok' }), JSON.stringify(name)).toThrow(TypeError);
		}
	});

	it('validates every element of an array header value', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		expect(() => upgradeResponse({}, { 'x-multi': ['fine', 'not\r\nfine'] })).toThrow(TypeError);
		expect(() => upgradeResponse({}, { 'x-multi': ['fine', 3] })).toThrow(/must be a string/);
	});

	it('rejects an object value without invoking hostile string coercion', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		let coerced = false;
		const value = {
			toString() { coerced = true; return 'a\r\nInjected: yes'; }
		};
		expect(() => upgradeResponse({}, { 'x-object': /** @type {any} */ (value) })).toThrow(/must be a string/);
		expect(coerced).toBe(false);
	});

	it('accepts normal header names and values unchanged', async () => {
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		expect(upgradeResponse({ userId: 7 }, { 'x-session-version': '2', 'set-cookie': ['a=1', 'b=2'] })).toEqual({
			__upgradeResponse: true,
			userData: { userId: 7 },
			headers: { 'x-session-version': '2', 'set-cookie': ['a=1', 'b=2'] }
		});
	});
});

describeUWS('upgradeResponse handshake', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('completes the WebSocket handshake and delivers a custom header from an upgrade hook', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		server = await createTestServer({
			handler: {
				upgrade() {
					return upgradeResponse({}, { 'x-custom-header': 'present' });
				}
			}
		});

		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);
		let upgradeHeaders = null;
		ws.on('upgrade', (res) => {
			upgradeHeaders = res.headers;
		});

		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			// The pre-fix bug surfaces exactly here: writing the custom header
			// before res.upgrade made uWS emit an implicit "200 OK", so the `ws`
			// client rejects with "Unexpected server response: 200" - no open,
			// no upgrade event.
			ws.on('error', reject);
			setTimeout(() => reject(new Error('handshake timed out')), 3000);
		});

		expect(upgradeHeaders).not.toBeNull();
		expect(upgradeHeaders['x-custom-header']).toBe('present');

		ws.close();
	});

	it('refuses the upgrade (500, no 101, no injected line) when a decoded header value contains CR/LF', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		// The injection chain: an app copies a (decoded) query parameter into a
		// Set-Cookie header on the 101 response. The double-encoded CRLF below
		// decodes to a raw CR LF inside the header value.
		server = await createTestServer({
			handler: {
				upgrade({ url }) {
					const u = new URL(url, 'http://placeholder');
					const reflect = u.searchParams.get('reflect') || '';
					return upgradeResponse({}, { 'set-cookie': 'refl=' + decodeURIComponent(reflect) });
				}
			}
		});

		const port = Number(new URL(server.url).port);
		const raw = await rawUpgrade(port, '/ws?reflect=x%250d%250aInjected%253A%2520crlf-worked');
		// The invalid header takes the hook-error path: 500 before any byte of
		// a 101 is written, and the injected header line never reaches the wire.
		expect(raw).toContain('500 Internal Server Error');
		expect(raw).not.toContain('101 Switching Protocols');
		expect(raw).not.toMatch(/\nInjected:/i);
	});

	it('still upgrades normally when the reflected value carries no control bytes', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		server = await createTestServer({
			handler: {
				upgrade({ url }) {
					const u = new URL(url, 'http://placeholder');
					const reflect = u.searchParams.get('reflect') || '';
					return upgradeResponse({}, { 'x-reflect': reflect });
				}
			}
		});

		const port = Number(new URL(server.url).port);
		const raw = await rawUpgrade(port, '/ws?reflect=plainvalue');
		expect(raw).toContain('101 Switching Protocols');
		expect(raw).toContain('x-reflect: plainvalue');
	});
});
