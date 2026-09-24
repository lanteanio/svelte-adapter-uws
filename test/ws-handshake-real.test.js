// A WebSocket handshake no one could complete is refused before any capacity,
// origin or application decision, with the answers the native runtime gives:
// 400 for a malformed handshake, 426 naming version 13 for a version this
// server does not speak. A plain GET to the path is not a handshake and goes
// on to the application.
//
// The cases are the native runtime's own raw-socket set, driven over TCP
// against each surface, because the interesting ones - a repeated line, a key
// with its unused bits set - are exactly what an HTTP client library refuses
// to send.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { createServer } from 'node:http';
import { webSocketHandshakeRefusal, isWebSocketUpgradeAttempt, readRawHandshake } from '../src/runtime/utils/ws-handshake.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
/** @type {Array<[string, string]>} */
const NORMAL = [
	['Connection', 'keep-alive, UpGrAdE'],
	['Upgrade', 'WebSocket'],
	['Sec-WebSocket-Version', '13'],
	['Sec-WebSocket-Key', KEY]
];
const without = (name) => NORMAL.filter(([k]) => k !== name);
const replaced = (name, value) => NORMAL.map(([k, v]) => [k, k === name ? value : v]);
const repeated = (name) => [...NORMAL, NORMAL.find(([k]) => k === name)];

/** @type {Array<[string, Array<[string, string]>, number]>} */
const CASES = [
	['a complete handshake', NORMAL, 101],
	['no Upgrade', without('Upgrade'), 400],
	['no Connection', without('Connection'), 400],
	['no key', without('Sec-WebSocket-Key'), 400],
	['an Upgrade naming another protocol', replaced('Upgrade', 'not-websocket'), 400],
	['a Connection without upgrade', replaced('Connection', 'keep-alive'), 400],
	['a 24-character key that is not base64', replaced('Sec-WebSocket-Key', '!'.repeat(24)), 400],
	['a short key', replaced('Sec-WebSocket-Key', 'a'), 400],
	['a key with its unused bits set', replaced('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZR=='), 400],
	['Upgrade twice', repeated('Upgrade'), 400],
	['the key twice', repeated('Sec-WebSocket-Key'), 400],
	['the version twice', repeated('Sec-WebSocket-Version'), 400],
	['version 12', replaced('Sec-WebSocket-Version', '12'), 426],
	['a version that is not a number', replaced('Sec-WebSocket-Version', '13a'), 426],
	['upgrade listed on a second Connection line', [...without('Connection'), ['Connection', 'keep-alive'], ['Connection', 'Upgrade']], 101],
	['no version', without('Sec-WebSocket-Version'), 426],
	['a websocket Upgrade with no key', [['Connection', 'Upgrade'], ['Upgrade', 'websocket']], 400]
];

/**
 * Send one GET with exactly these header lines and read the status line and
 * headers of the answer.
 *
 * @param {number} port @param {Array<[string, string]>} headers
 * @returns {Promise<{ status: number, headers: Record<string, string> }>}
 */
function exchange(port, headers, path = '/ws') {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		let buf = '';
		const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer to ${JSON.stringify(headers)}`)); }, 3000);
		socket.on('data', (d) => {
			buf += d.toString('latin1');
			const end = buf.indexOf('\r\n\r\n');
			if (end < 0) return;
			clearTimeout(timer);
			socket.destroy();
			const [statusLine, ...lines] = buf.slice(0, end).split('\r\n');
			/** @type {Record<string, string>} */
			const parsed = {};
			for (const line of lines) {
				const at = line.indexOf(':');
				parsed[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
			}
			resolve({ status: Number(statusLine.split(' ')[1]), headers: parsed });
		});
		socket.on('error', (err) => { clearTimeout(timer); reject(err); });
		socket.on('connect', () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
		});
	});
}

describe('the handshake rule', () => {
	/** Read header lines the way Node hands them over, so the unit cases share the surfaces' reader. */
	const read = (lines) => readRawHandshake(lines.flat());

	it('counts repeated lines instead of reading them joined', () => {
		expect(webSocketHandshakeRefusal(read(NORMAL))).toBeNull();
		expect(webSocketHandshakeRefusal(read(repeated('Upgrade')))).toBe(400);
		expect(webSocketHandshakeRefusal(read(repeated('Sec-WebSocket-Key')))).toBe(400);
		expect(webSocketHandshakeRefusal(read(repeated('Sec-WebSocket-Version'))), 'two version lines, even equal ones').toBe(400);
		expect(webSocketHandshakeRefusal(read([...without('Connection'), ['Connection', 'keep-alive'], ['Connection', 'Upgrade']])), 'upgrade on a second Connection line').toBeNull();
		expect(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive, upgraded')))).toBe(400);
	});

	it('accepts only the canonical encoding of 16 octets as a key', () => {
		for (const last of 'AQgw') {
			expect(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(21) + last + '=='))), last).toBeNull();
		}
		for (const last of 'BRhx') {
			expect(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(21) + last + '=='))), last).toBe(400);
		}
		expect(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(24))))).toBe(400);
	});

	it('answers 426 for any single version but 13, and only for an otherwise complete handshake', () => {
		for (const version of ['8', '12', '13a', 'thirteen', '']) {
			expect(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Version', version))), version).toBe(426);
		}
		expect(webSocketHandshakeRefusal(read(without('Sec-WebSocket-Version')))).toBe(426);
		expect(webSocketHandshakeRefusal(read([...without('Upgrade').filter(([k]) => k !== 'Sec-WebSocket-Version'), ['Sec-WebSocket-Version', '8']])),
			'a missing Upgrade answers first').toBe(400);
	});

	it('folds case and trims in ASCII only', () => {
		expect(webSocketHandshakeRefusal(read(replaced('Upgrade', 'WEBSOCKET')))).toBeNull();
		expect(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive,\tUPGRADE ')))).toBeNull();
		// A Kelvin sign lowers to `k` under Unicode case mapping, and a vertical
		// tab is whitespace to String#trim; neither is to the native runtime.
		expect(webSocketHandshakeRefusal(read(replaced('Upgrade', 'websoc\u212At')))).toBe(400);
		expect(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive,\u000bupgrade')))).toBe(400);
	});

	it('counts a websocket Upgrade or any key as an attempt, and nothing else', () => {
		expect(isWebSocketUpgradeAttempt(read([['Upgrade', 'WebSocket']]))).toBe(true);
		expect(isWebSocketUpgradeAttempt(read([['Sec-WebSocket-Key', '']]))).toBe(true);
		expect(isWebSocketUpgradeAttempt(read([['Connection', 'Upgrade'], ['Upgrade', 'h2c']]))).toBe(false);
		expect(isWebSocketUpgradeAttempt(read([]))).toBe(false);
	});
});

/** @type {Array<() => Promise<void>>} */
const teardown = [];
afterAll(async () => { for (const stop of teardown.splice(0)) await stop(); });

/** One production runtime for the file: the built module is started once. */
let production = null;
function bootProduction() {
	production ??= startRealRuntime({ variant: 'default' }).then((server) => {
		teardown.push(() => server.stop());
		return server.port;
	});
	return production;
}

async function bootTesting() {
	const { createTestServer } = await import('../src/testing.js');
	const server = await createTestServer({});
	teardown.push(() => server.close());
	return server.port;
}

/**
 * The dev plugin on a bare http server, with a minimal middleware chain so a
 * request that is not an upgrade reaches the plugin's middleware and then a
 * final 404 standing in for the application.
 */
async function bootDev() {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
	/** @type {Array<{ path: string, fn: Function }>} */
	const chain = [];
	const httpServer = createServer((req, res) => {
		let i = 0;
		const next = () => {
			const layer = chain[i++];
			if (!layer) { res.statusCode = 404; res.end('Not Found'); return; }
			if (layer.path && !(req.url || '').startsWith(layer.path)) { next(); return; }
			layer.fn(req, res, next);
		};
		next();
	});
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	teardown.push(() => new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(() => r(undefined)); }));
	await plugin.configureServer({
		httpServer,
		middlewares: { use(path, fn) { chain.push(typeof path === 'function' ? { path: '', fn: path } : { path, fn }); } },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return {}; }
	});
	return httpServer.address().port;
}

const SURFACES = [
	...(hasUWS ? [{ label: 'production', boot: bootProduction }] : []),
	...(hasUWS ? [{ label: 'createTestServer', boot: bootTesting }] : []),
	{ label: 'vite dev', boot: bootDev }
];

for (const surface of SURFACES) {
	describe(`handshakes on ${surface.label}`, () => {
		/** @type {number} */
		let port;
		// Booted once for the block: the harness stops a runtime a single test
		// started when that test ends.
		beforeAll(async () => { port = await surface.boot(); }, 400000);

		for (const [name, headers, expected] of CASES) {
			it(`answers ${expected} to ${name}`, async () => {
				const { status, headers: got } = await exchange(port, headers);
				expect(status).toBe(expected);
				if (expected === 426) expect(got['sec-websocket-version']).toBe('13');
			});
		}
	});
}

describeUWS('a GET to the WebSocket path that is not a handshake', () => {
	it('reaches the application on production, and an upgrade to another protocol does too', async () => {
		const port = await bootProduction();
		// The fixture has no page at /ws, so the application answers it as it
		// answers any path it does not route.
		const unrouted = await exchange(port, [], '/__no_such_page__');
		const plain = await exchange(port, []);
		const h2c = await exchange(port, [['Connection', 'Upgrade'], ['Upgrade', 'h2c']]);
		expect(plain.status).toBe(unrouted.status);
		expect(h2c.status).toBe(unrouted.status);
	}, 400000);

	// A yielded GET passes through two routes, and each registration is wrapped
	// by the request metrics. uWS hands each route a response object of its
	// own, so the first wrapper never sees the answer; this pins that the
	// request is still counted exactly once.
	it('is counted once by the request metrics although it passes through two routes', async () => {
		const server = await startRealRuntime({ variant: 'metrics' });
		teardown.push(() => server.stop());
		const total = async (name) => {
			const text = await (await fetch(server.httpUrl + '/metrics')).text();
			const line = text.split('\n').find((l) => l.startsWith(name + ' '));
			return line ? Number(line.split(' ')[1]) : 0;
		};
		// The scrape is itself a request, counted when it completes; reading
		// twice around each probe keeps it out of the delta.
		const before = await total('http_requests_total');
		const after0 = await total('http_requests_total');
		const scrapeCost = after0 - before;
		await exchange(server.port, []);
		const after = await total('http_requests_total');
		expect(after - after0 - scrapeCost, 'one GET, one count').toBe(1);

		const rejected0 = await total('upgrade_rejected_total');
		await exchange(server.port, [['Connection', 'Upgrade'], ['Upgrade', 'websocket']]);
		expect(await total('upgrade_rejected_total')).toBe(rejected0 + 1);
	}, 400000);
});

describeUWS('the handshake is judged before capacity', () => {
	/** A registry that keeps each counter's labels apart. */
	function recordingRegistry() {
		const counters = new Map();
		return {
			counter(name) {
				let c = counters.get(name);
				if (!c) {
					c = { series: new Map(), inc(labels) { const k = JSON.stringify(labels ?? {}); c.series.set(k, (c.series.get(k) || 0) + 1); } };
					counters.set(name, c);
				}
				return c;
			},
			gauge() { return { set() {} }; },
			reason(name, reason) { return counters.get(name)?.series.get(JSON.stringify({ reason })) || 0; }
		};
	}

	it('answers a malformed handshake 400 under siege, where a complete one is shed 503', async () => {
		// The native runtime validates first, so a junk handshake is never
		// answered as load, and never counted toward keeping the posture raised.
		const { createTestServer } = await import('../src/testing.js');
		const metrics = recordingRegistry();
		const server = await createTestServer({ protection: 'siege', metrics });
		try {
			expect((await exchange(server.port, NORMAL)).status).toBe(503);
			expect((await exchange(server.port, replaced('Sec-WebSocket-Key', '!'.repeat(24)))).status).toBe(400);
			expect((await exchange(server.port, replaced('Sec-WebSocket-Version', '8'))).status).toBe(426);
			expect(metrics.reason('upgrade_rejected_total', 'malformed_handshake')).toBe(2);
			expect(metrics.reason('upgrade_rejected_total', 'siege')).toBe(1);
		} finally {
			await server.close();
		}
	});

	it('answers an attempted upgrade 400 on the GET route when a ceiling is set', async () => {
		// The GET route registered for a ceiling answers a navigation 426 or a
		// capacity page; an attempted upgrade it sees is refused before either.
		const { createTestServer } = await import('../src/testing.js');
		const metrics = recordingRegistry();
		const server = await createTestServer({ upgradeAdmission: { maxConnections: 5 }, metrics });
		try {
			expect((await exchange(server.port, [])).status, 'a navigation is told to upgrade').toBe(426);
			expect((await exchange(server.port, [['Connection', 'Upgrade'], ['Upgrade', 'websocket']])).status).toBe(400);
			expect(metrics.reason('upgrade_rejected_total', 'malformed_handshake')).toBe(1);
		} finally {
			await server.close();
		}
	});
});

describe('the dev middleware matches the WebSocket path exactly', () => {
	it('leaves a longer path that starts with it to the application', async () => {
		const port = await bootDev();
		const attempt = [['Upgrade', 'websocket']];
		expect((await exchange(port, attempt, '/ws')).status).toBe(400);
		expect((await exchange(port, attempt, '/wsfoo')).status).toBe(404);
		expect((await exchange(port, attempt, '/ws?x=1')).status).toBe(400);
	});
});
