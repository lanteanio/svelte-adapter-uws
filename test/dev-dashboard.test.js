// The dev dashboard against the real dev plugin: real HTTP requests through
// the plugin's own middleware, a real ws client whose subscription shows up
// in the streamed snapshot, and the loopback gate probed with the forged
// headers a hostile page would send. The pure pieces (the access gate, the
// escaper, the accept guard) are additionally pinned as units, and the accept
// guard's unit is the SAME function the page embeds - the render asserts the
// source travels into the document.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import uws from '../src/vite.js';
import {
	renderAppShell,
	createDashboardSnapshots,
	checkDashboardAccess,
	inlineJsonForHtml,
	acceptSnapshot,
	registerDashboardContributor,
	dashboardContributors
} from '../src/dev-dashboard.js';

const servers = [];
const sockets = [];
const requests = [];
const unsubscribers = [];

afterEach(async () => {
	for (const undo of unsubscribers.splice(0)) undo();
	for (const ws of sockets.splice(0)) {
		try { ws.terminate(); } catch { /* already closed */ }
	}
	// An open SSE request is an ACTIVE connection: server.close() never reaps
	// it, so a test that fails before its own destroy would hang teardown into
	// a hook timeout. Destroy every tracked request here first.
	for (const req of requests.splice(0)) {
		try { req.destroy(); } catch { /* already gone */ }
	}
	for (const server of servers.splice(0).reverse()) {
		if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
});

async function bootDev(pluginOptions = {}) {
	const middleware = [];
	const httpServer = createServer((req, res) => {
		// Replay Connect's prefix mount: the longest matching mount wins and
		// the handler sees the sub-path, exactly as the plugin's own comment
		// on `server.middlewares.use` relies on.
		const url = new URL(req.url || '/', 'http://localhost');
		const hit = middleware
			.filter((entry) => url.pathname === entry.path || url.pathname.startsWith(entry.path + '/'))
			.sort((a, b) => b.path.length - a.path.length)[0];
		if (!hit) { res.statusCode = 404; res.end('Not Found'); return; }
		req.url = (url.pathname.slice(hit.path.length) || '/') + url.search;
		hit.fn(req, res, () => { res.statusCode = 404; res.end('Not Found'); });
	});
	servers.push(httpServer);

	const plugin = uws({ allowedOrigins: '*', handler: '/virtual-dashboard-handler', ...pluginOptions });
	await plugin.configureServer({
		httpServer,
		middlewares: {
			use(path, fn) { middleware.push({ path, fn }); }
		},
		config: {
			root: process.cwd(),
			server: {},
			logger: { warn() {}, info() {}, error() {} }
		},
		async ssrLoadModule() {
			return { default: {}, open() {} };
		}
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const port = httpServer.address().port;
	return { port, middleware };
}

/**
 * One dashboard request with controllable Host/Origin, resolving to status,
 * headers, and the full body.
 */
function fetchDash(port, subPath, { host = `localhost:${port}`, origin, method = 'GET', body } = {}) {
	return new Promise((resolve, reject) => {
		const headers = { host };
		if (origin !== undefined) headers.origin = origin;
		if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: '/__uws/dashboard' + subPath,
			method,
			headers
		}, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { data += chunk; });
			res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.once('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** The embedded snapshot JSON, extracted and parsed from a rendered page. */
function embeddedSnapshot(html) {
	const match = html.match(/<script type="application\/json" id="uws-dash-snapshot">([\s\S]*?)<\/script>/);
	expect(match, 'the page must embed its snapshot').toBeTruthy();
	return { raw: match[1], snapshot: JSON.parse(match[1]) };
}

describe('the dev dashboard units', () => {
	it('accepts only strictly newer sequence numbers, and ships that exact guard to the page', () => {
		expect(acceptSnapshot(2, 3)).toBe(true);
		expect(acceptSnapshot(3, 3)).toBe(false);
		expect(acceptSnapshot(3, 2)).toBe(false);
		expect(acceptSnapshot(-Infinity, 1)).toBe(true);
		expect(acceptSnapshot(3, '4')).toBe(false);
		expect(acceptSnapshot(3, NaN)).toBe(false);
		// The page runs THIS function, not a re-spelling of it: the render
		// embeds its source, so the unit above is the browser's behavior.
		const html = renderAppShell({ seq: 1 }, { live: true, basePath: '/__uws/dashboard' });
		expect(html).toContain(acceptSnapshot.toString());
	});

	it('escapes the three characters that can break out of an inline JSON block', () => {
		const out = inlineJsonForHtml({ a: '</script><script>alert(1)</script>', b: '\u2028\u2029' });
		expect(out).not.toContain('</script');
		expect(out).toContain('\\u003c/script>');
		expect(out).not.toMatch(/[\u2028\u2029]/);
		expect(out).toContain('\\u2028');
		expect(out).toContain('\\u2029');
		expect(JSON.parse(out)).toEqual({ a: '</script><script>alert(1)</script>', b: '\u2028\u2029' });
	});

	it('gates on socket, Host, and Origin, with the bracket and mapped spellings handled', () => {
		const ok = (input) => expect(checkDashboardAccess(input).allowed, JSON.stringify(input)).toBe(true);
		const no = (input) => expect(checkDashboardAccess(input).allowed, JSON.stringify(input)).toBe(false);

		ok({ remoteAddress: '127.0.0.1', host: 'localhost:5173' });
		ok({ remoteAddress: '::1', host: '[::1]:5173' });
		ok({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:5173' });
		ok({ remoteAddress: '127.0.0.1', host: 'localhost' });
		ok({ remoteAddress: '127.0.0.1', host: 'localhost:5173', origin: 'http://localhost:5173' });
		ok({ remoteAddress: '127.0.0.1', host: 'localhost:5173', origin: 'http://[::1]:5173' });

		// The DNS-rebinding shape: a genuine loopback socket carrying the
		// attacker's Host or Origin.
		no({ remoteAddress: '127.0.0.1', host: 'attacker.example:5173' });
		no({ remoteAddress: '127.0.0.1', host: 'localhost:5173', origin: 'http://attacker.example' });
		// The rebinding names an attacker registers UNDER a 127-prefixed label:
		// a substring host check would pass these, and their address is the
		// attacker's to rebind. A complete-IPv4 parse refuses them.
		no({ remoteAddress: '127.0.0.1', host: '127.evil.com:5173' });
		no({ remoteAddress: '127.0.0.1', host: '127.0.0.1.attacker.example:5173' });
		no({ remoteAddress: '127.0.0.1', host: 'localhost:5173', origin: 'http://127.evil.com:5173' });
		no({ remoteAddress: '127.0.0.1', host: '127.0.0.256' });
		no({ remoteAddress: '127.0.0.1', host: '127.0.0' });
		// A full IPv4 anywhere in 127.0.0.0/8 is genuine loopback.
		ok({ remoteAddress: '127.0.0.1', host: '127.9.9.9:5173' });
		// A non-loopback socket never passes, whatever the headers claim.
		no({ remoteAddress: '192.168.1.50', host: 'localhost:5173' });
		no({ remoteAddress: undefined, host: 'localhost:5173' });
		// Malformed Host spellings fail closed.
		no({ remoteAddress: '127.0.0.1', host: '' });
		no({ remoteAddress: '127.0.0.1', host: '::1:5173' });
		no({ remoteAddress: '127.0.0.1', host: '[::1' });
		no({ remoteAddress: '127.0.0.1', host: 'localhost:5173:extra' });
		no({ remoteAddress: '127.0.0.1', host: 'localhost:5173', origin: 'not a url' });
	});

	it('stamps strictly increasing sequence numbers across every snapshot path', () => {
		const next = createDashboardSnapshots({
			now: () => 42,
			introspect: () => ({ connections: 0 }),
			topicCounts: () => new Map()
		});
		const a = next();
		const b = next();
		expect(b.seq).toBeGreaterThan(a.seq);
		expect(acceptSnapshot(a.seq, b.seq)).toBe(true);
		expect(acceptSnapshot(b.seq, a.seq)).toBe(false);
	});
});

describe('the dev dashboard endpoint against the real plugin', () => {
	it('serves the live page with the embedded snapshot to a loopback client', async () => {
		const { port } = await bootDev();
		const res = await fetchDash(port, '/');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.headers['cache-control']).toBe('no-store');
		const { snapshot } = embeddedSnapshot(res.body);
		expect(snapshot.seq).toBeGreaterThanOrEqual(1);
		expect(snapshot.mode).toBe('dev');
		expect(snapshot.workers).toEqual({ expected: 1, reporting: 1 });
		expect(typeof snapshot.versions.adapter).toBe('string');
		expect(snapshot.introspect.connections).toBe(0);
		expect(res.body).toContain('"live":true');
	});

	it('refuses a forged Host, a foreign Origin, and a non-loopback story, draining the body first', async () => {
		const { port } = await bootDev();
		// The DNS-rebinding request: loopback socket, hostile Host - and a
		// request body, which must be drained or this 403 never arrives.
		const rebound = await fetchDash(port, '/', {
			host: 'attacker.example',
			method: 'POST',
			body: 'x'.repeat(256 * 1024)
		});
		expect(rebound.status).toBe(403);
		expect(rebound.body).toContain('loopback');

		const crossOrigin = await fetchDash(port, '/', { origin: 'http://attacker.example' });
		expect(crossOrigin.status).toBe(403);

		const wrongMethod = await fetchDash(port, '/', { method: 'POST', body: '' });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.allow).toBe('GET');

		const unknown = await fetchDash(port, '/nope');
		expect(unknown.status).toBe(404);
	});

	it('serves the static report as an attachment rendered by the same path, live disabled', async () => {
		const { port } = await bootDev();
		const res = await fetchDash(port, '/report');
		expect(res.status).toBe(200);
		expect(res.headers['content-disposition']).toContain('attachment');
		expect(res.headers['content-disposition']).toContain('uws-diagnostic-report.html');
		const { snapshot } = embeddedSnapshot(res.body);
		expect(snapshot.seq).toBeGreaterThanOrEqual(1);
		expect(res.body).toContain('"live":false');
		// Self-contained: no external stylesheet, script src, or image URL.
		expect(res.body).not.toMatch(/<link|src=/);
	});

	it('answers snapshot fetches with strictly increasing sequences', async () => {
		const { port } = await bootDev();
		const first = JSON.parse((await fetchDash(port, '/snapshot')).body);
		const second = JSON.parse((await fetchDash(port, '/snapshot')).body);
		expect(second.seq).toBeGreaterThan(first.seq);
		expect(acceptSnapshot(second.seq, first.seq)).toBe(false);
	});

	it('shares one monotonic counter across the page, the report, and the fetch', async () => {
		const { port } = await bootDev();
		// Three DIFFERENT routes in order; a per-route counter would let a
		// later route hand back a number the earlier one already issued.
		const pageSeq = embeddedSnapshot((await fetchDash(port, '/')).body).snapshot.seq;
		const reportSeq = embeddedSnapshot((await fetchDash(port, '/report')).body).snapshot.seq;
		const fetchSeq = JSON.parse((await fetchDash(port, '/snapshot')).body).seq;
		expect(reportSeq).toBeGreaterThan(pageSeq);
		expect(fetchSeq).toBeGreaterThan(reportSeq);
		// Seeded from the clock, not zero, so a restart resumes above any
		// number an earlier session issued rather than colliding from zero.
		expect(pageSeq).toBeGreaterThan(1000);
	});

	it('streams a real client subscription into the SSE frames', async () => {
		const { port } = await bootDev();

		// Open the stream first, as the browser would.
		/** @type {string[]} */
		const frames = [];
		let buffered = '';
		const stream = await new Promise((resolve, reject) => {
			const req = httpRequest({
				host: '127.0.0.1',
				port,
				path: '/__uws/dashboard/events',
				method: 'GET',
				headers: { host: `localhost:${port}`, accept: 'text/event-stream' }
			}, (res) => {
				expect(res.statusCode).toBe(200);
				expect(res.headers['content-type']).toBe('text/event-stream');
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					buffered += chunk;
					let cut;
					while ((cut = buffered.indexOf('\n\n')) !== -1) {
						const block = buffered.slice(0, cut);
						buffered = buffered.slice(cut + 2);
						const data = block.split('\n').filter((l) => l.startsWith('data: '))
							.map((l) => l.slice(6)).join('');
						if (data) frames.push(data);
					}
				});
				resolve(req);
			});
			requests.push(req);
			req.once('error', reject);
			req.end();
		});

		const waitForFrame = async (predicate, ms = 5000) => {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.map((f) => JSON.parse(f)).find(predicate);
				if (hit) return hit;
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 25));
			}
		};

		const initial = await waitForFrame((s) => s.seq >= 1);
		expect(initial, 'the stream must open with a snapshot frame').toBeTruthy();
		expect(initial.topics).toEqual([]);

		// A REAL ws client subscribes through the plugin's real socket path;
		// the next streamed snapshot must show the topic with its subscriber.
		const wsMod = await import('ws');
		const WebSocket = wsMod.WebSocket ?? wsMod.default;
		const client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
		sockets.push(client);
		await new Promise((resolve, reject) => { client.on('open', resolve); client.on('error', reject); });
		client.send(JSON.stringify({ type: 'subscribe', topic: 'dashboard-feed' }));

		const withTopic = await waitForFrame((s) =>
			(s.topics || []).some((t) => t.topic === 'dashboard-feed' && t.subscribers === 1)
		);
		expect(withTopic, 'the subscription must appear in a streamed snapshot').toBeTruthy();
		expect(withTopic.introspect.connections).toBe(1);
		// Streamed frames carry the same monotonic counter as the fetch path.
		expect(withTopic.seq).toBeGreaterThan(initial.seq);

		stream.destroy();
	});

	it('renders contributor sections through the registry, hostile content escaped', async () => {
		const undo = registerDashboardContributor('cluster-health', () => ({
			nodes: 3,
			note: '</script><script>alert(1)</script>\u2028'
		}));
		unsubscribers.push(undo);

		const { port } = await bootDev();
		const json = JSON.parse((await fetchDash(port, '/snapshot')).body);
		expect(json.sections['cluster-health'].nodes).toBe(3);

		const page = await fetchDash(port, '/');
		const { raw, snapshot } = embeddedSnapshot(page.body);
		// The hostile payload survives as DATA and never as markup: the raw
		// block carries only the escaped spelling, and parsing it restores
		// the original string byte for byte.
		expect(raw).not.toContain('</script');
		expect(raw).toContain('\\u003c/script>');
		expect(raw).not.toMatch(/[\u2028\u2029]/);
		expect(snapshot.sections['cluster-health'].note).toBe('</script><script>alert(1)</script>\u2028');

		undo();
		expect(dashboardContributors().has('cluster-health')).toBe(false);
		const after = JSON.parse((await fetchDash(port, '/snapshot')).body);
		expect(after.sections['cluster-health']).toBeUndefined();
	});

	it('a broken contributor loses its section, never the dashboard', async () => {
		unsubscribers.push(registerDashboardContributor('broken', () => {
			throw new Error('contributor exploded');
		}));
		const { port } = await bootDev();
		const res = await fetchDash(port, '/snapshot');
		expect(res.status).toBe(200);
		const json = JSON.parse(res.body);
		expect(json.sections.broken.error).toContain('contributor exploded');
	});

	it('a contributor returning unserializable data loses its section, never the process', async () => {
		// A returned (not thrown) BigInt and a returned cycle both make
		// JSON.stringify throw. Without a serialization guard at build time,
		// the /snapshot and SSE-frame stringify - the latter in a timer
		// callback - would crash rather than the section absorbing it.
		unsubscribers.push(registerDashboardContributor('bigint', () => ({ n: 10n })));
		const cyclic = {};
		cyclic.self = cyclic;
		unsubscribers.push(registerDashboardContributor('cyclic', () => cyclic));

		const { port } = await bootDev();
		const res = await fetchDash(port, '/snapshot');
		expect(res.status).toBe(200);
		const json = JSON.parse(res.body);
		expect(json.sections.bigint.error).toBeTruthy();
		expect(json.sections.cyclic.error).toBeTruthy();
		// A healthy contributor alongside them is unaffected.
		const before = json.seq;
		const again = JSON.parse((await fetchDash(port, '/snapshot')).body);
		expect(again.seq).toBeGreaterThan(before);
	});

	it('honors dashboard: false and a custom mount path', async () => {
		const disabled = await bootDev({ dashboard: false });
		expect(disabled.middleware.some((m) => m.path.startsWith('/__uws/dashboard'))).toBe(false);

		const custom = await bootDev({ dashboard: { path: '/__diag' } });
		expect(custom.middleware.some((m) => m.path === '/__diag')).toBe(true);

		expect(() => uws({ handler: '/x', dashboard: 'yes' })).toThrow(/dashboard/);
		expect(() => uws({ handler: '/x', dashboard: { path: 'no-slash' } })).toThrow(/dashboard\.path/);
		// A protocol-relative `//host` is a URL, not a local path: the page
		// derives its stream and fetch URLs from it, so it must be refused.
		expect(() => uws({ handler: '/x', dashboard: { path: '//evil.example/x' } })).toThrow(/dashboard\.path/);
	});
});
