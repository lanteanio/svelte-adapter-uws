// A request target is visible ASCII with no fragment (RFC 9112 3.2), and one
// that is not is refused with 400 on every route, where uWS decoded raw bytes
// into the path it served and kept a `#` in the path it routed on. node's
// parser refuses the raw bytes before any listener runs; the `#` it hands on.
// A target that RESOLVES onto one of the adapter's own exact paths, spelled
// some other way, is refused too, as one resolving into the admin prefix
// already is.
//
// Raw sockets, because every client library encodes or refuses exactly the
// bytes under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** @param {number} port @param {Buffer} request @returns {Promise<{ status: number, body: string }>} */
function answerOf(port, request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => socket.write(request));
		socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('no response within 10s')); });
		socket.on('data', (c) => chunks.push(c));
		socket.on('error', reject);
		socket.on('close', () => {
			const text = Buffer.concat(chunks).toString('latin1');
			resolve({ status: parseInt(text.split(' ')[1], 10), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
		});
	});
}

/** @param {number} port @param {Buffer} request @returns {Promise<number>} the status */
async function statusOf(port, request) {
	return (await answerOf(port, request)).status;
}

/** @param {Buffer | string} target */
function get(target) {
	return Buffer.concat([
		Buffer.from('GET '),
		Buffer.isBuffer(target) ? target : Buffer.from(target),
		Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
	]);
}

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))));
const E_ACUTE = [0xc3, 0xa9];

describeUWS('the request target on the built runtime', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'default' }); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it('refuses a raw non-ASCII byte in the path, on the prerendered lane', async () => {
		expect(await statusOf(server.port, get(bytes('/prerendered/caf', E_ACUTE, '/')))).toBe(400);
		expect(await statusOf(server.port, get('/prerendered/caf%C3%A9/')), 'the encoded spelling is served').toBe(308);
	});

	it('refuses a raw non-ASCII byte in the query, on the built-asset lane', async () => {
		expect(await statusOf(server.port, get(bytes('/test.txt?x=', E_ACUTE)))).toBe(400);
		expect(await statusOf(server.port, get('/test.txt?x=%C3%A9'))).toBe(200);
	});

	it('refuses a DEL byte and a fragment', async () => {
		expect(await statusOf(server.port, get(bytes('/test', [0x7f], '.txt')))).toBe(400);
		expect(await statusOf(server.port, get('/test.txt#part'))).toBe(400);
		expect(await statusOf(server.port, get('/healthz#frag')), 'the fragment no longer reaches the app by truncation').toBe(400);
	});

	it('refuses the query on an exact route as well', async () => {
		expect(await statusOf(server.port, get(bytes('/healthz?x=', E_ACUTE)))).toBe(400);
		expect(await statusOf(server.port, get('/healthz'))).toBe(200);
	});

	it('refuses a target that resolves onto one of the adapter\'s own paths', async () => {
		for (const target of ['/x/../healthz', '/x/../readyz', '/%68ealthz', '/x/%2E%2E/healthz']) {
			expect(await statusOf(server.port, get(target)), target).toBe(400);
		}
		expect(await statusOf(server.port, get('/x/../')), 'resolving onto an app page is not refused').toBe(200);
	});

	it('refuses a data or route-resolution request for one of the adapter\'s own paths', async () => {
		// SvelteKit answers `/p/__data.json` and `/p/__route.js` for `/p`, so
		// these would reach the app's router as the probe path. Judged by the
		// adapter's own body: SvelteKit answers a route-resolution request 400
		// itself when the app does not resolve routes on the server.
		for (const target of [
			'/healthz/__data.json',
			'/healthz/__data.json?x-sveltekit-invalidated=01',
			'/healthz/__data.json??x-sveltekit-trailing-slash=1',
			'/readyz/__route.js',
			'/x/../healthz/__data.json',
			'/%68ealthz/__data.json'
		]) {
			const answer = await answerOf(server.port, get(target));
			expect(answer.status, target).toBe(400);
			expect(answer.body, target).toBe('Bad Request');
		}
		expect(await statusOf(server.port, get('/__data.json')), 'an app page\'s data request is served').toBe(200);
	});

	it('leaves the page one trailing slash further on to the app, data included', async () => {
		// uWS does not route `/healthz/` to the probe, so it is the app's page
		// (its own router redirects it or serves it), and so is its data, which
		// SvelteKit asks for with the slash in a query parameter. The fixture has
		// no route there, so SvelteKit's own answers come back.
		for (const target of ['/healthz/', '/healthz/__data.json?x-sveltekit-trailing-slash=1', '/healthz//__data.json']) {
			expect((await answerOf(server.port, get(target))).status, target).toBe(404);
		}
		const resolution = await answerOf(server.port, get('/healthz//__route.js'));
		expect(resolution.status).toBe(400);
		expect(resolution.body, 'SvelteKit\'s refusal, not the adapter\'s').toContain('route resolution disabled');
	});

	it('leaves the WebSocket path to the app where its GETs are the app\'s', async () => {
		// Without an admission ceiling a plain GET to the path yields to the
		// application, so its data request and a spelling that resolves onto it
		// are the application's too.
		const direct = await statusOf(server.port, get('/ws'));
		expect(direct, 'the fixture has no ceiling, so the app answers the path').not.toBe(400);
		expect(await statusOf(server.port, get('/x/../ws'))).toBe(direct);
		expect(await statusOf(server.port, get('/ws/__data.json'))).not.toBe(400);
	});

	it('serves a static file whose name is not ASCII for its percent-encoded spelling', async () => {
		// `static/maß.txt`: browsers send the name encoded, and the raw bytes
		// that used to be the only spelling reaching it are refused as a target.
		const served = await answerOf(server.port, get('/ma%C3%9F.txt'));
		expect(served.status).toBe(200);
		expect(served.body).toContain('static-non-ascii-name');
		expect(await statusOf(server.port, get('/ma%c3%9f.txt')), 'lowercase escapes').toBe(200);
		expect(await statusOf(server.port, get(bytes('/ma', [0xc3, 0x9f], '.txt'))), 'the raw bytes').toBe(400);
	});

	it('does not read an encoded separator into a static directory', async () => {
		// Decoded as SvelteKit's Node adapter decodes before its file lookup,
		// which leaves `%2F` encoded.
		const direct = await answerOf(server.port, get('/.well-known/probe.txt'));
		expect(direct.status, 'the file is served on its own spelling').toBe(200);
		const encoded = await answerOf(server.port, get('/.well-known%2Fprobe.txt'));
		expect(encoded.body).not.toBe(direct.body);
		expect(encoded.status).not.toBe(200);
	});
});

describe('a static file whose name a browser encodes', () => {
	// The BUILT index and lookup, over a directory of names the fixture cannot
	// carry portably: one with a space, and one written decomposed.
	let tmp = '';
	/** @type {(pathname: string) => any} */
	let encodedStaticEntry;
	/** @type {any} */
	let mod;
	/** @type {Map<string, any>} */
	let staticCache;
	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this test').toBe(true);
		mod = await import('./fixture/build/handler/static-assets.js');
		({ staticCache } = await import('./fixture/build/handler/state.js'));
		encodedStaticEntry = mod.encodedStaticEntry;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-encoded-name-'));
		fs.writeFileSync(path.join(tmp, 'My Report.txt'), 'spaced');
		fs.mkdirSync(path.join(tmp, 'My'));
		fs.writeFileSync(path.join(tmp, 'My', 'Report.txt'), 'nested');
		fs.writeFileSync(path.join(tmp, 'U' + String.fromCharCode(0x308) + 'bersicht.txt'), 'decomposed');
		mod.cacheDir(tmp, '/encoded-probe', false);
	}, 400000);
	afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

	it('is found for its encoded spelling, in either Unicode form', () => {
		expect(encodedStaticEntry('/encoded-probe/My%20Report.txt')).toBeTruthy();
		expect(encodedStaticEntry('/encoded-probe/%C3%9Cbersicht.txt'), 'the composed spelling a browser sends').toBeTruthy();
		expect(encodedStaticEntry('/encoded-probe/U%CC%88bersicht.txt'), 'the name as written').toBeTruthy();
	});

	it('does not read an encoded separator into a directory that holds the name', () => {
		expect(encodedStaticEntry('/encoded-probe/My%2FReport.txt')).toBeUndefined();
		expect(encodedStaticEntry('/encoded-probe/My/Report%2Etxt'), 'the directory is there to be found').toBeTruthy();
	});

	it('never lets a composed alias shadow a file of that name, in either walk order', () => {
		// One directory per form: some file systems cannot hold both in one.
		const composed = String.fromCharCode(0xdc) + 'ber.txt';
		const decomposed = 'U' + String.fromCharCode(0x308) + 'ber.txt';
		for (const [prefix, order] of [['/alias-first', [decomposed, composed]], ['/alias-second', [composed, decomposed]]]) {
			for (const name of order) {
				const dir = fs.mkdtempSync(path.join(tmp, 'walk-'));
				fs.writeFileSync(path.join(dir, name), name === composed ? 'composed' : 'decomposed');
				mod.cacheDir(dir, prefix, false);
			}
			expect(staticCache.get(`${prefix}/${composed}`).buffer.toString(), prefix).toBe('composed');
			expect(staticCache.get(`${prefix}/${decomposed}`).buffer.toString(), prefix).toBe('decomposed');
		}
	});

	it('registers no alias that composes to plain ASCII', () => {
		// A Kelvin sign composes to `K`: the file is reached by its own encoded
		// name, never by a target that is not its name.
		const dir = fs.mkdtempSync(path.join(tmp, 'kelvin-'));
		fs.writeFileSync(path.join(dir, String.fromCharCode(0x212a) + 'ey.txt'), 'kelvin');
		mod.cacheDir(dir, '/kelvin-probe', false);
		expect(staticCache.get('/kelvin-probe/Key.txt')).toBeUndefined();
		expect(encodedStaticEntry('/kelvin-probe/%E2%84%AAey.txt')).toBeTruthy();
	});
});

describeUWS('the request target on createTestServer', () => {
	it('refuses a raw non-ASCII byte on the routes it mirrors', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({});
		try {
			expect(await statusOf(server.port, get(bytes('/healthz?x=', E_ACUTE)))).toBe(400);
			expect(await statusOf(server.port, get('/healthz'))).toBe(200);
		} finally {
			await server.close();
		}
	});
});
