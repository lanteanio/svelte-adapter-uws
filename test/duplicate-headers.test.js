// Two lines of the same header, written as bytes at the REAL built runtime.
//
// WHY THIS EXISTS. Header collection used to keep the LAST line of a repeated
// header and drop every earlier one, at four separate entry points. The defect
// lives in the uWS `req.forEach` binding - it hands over one line at a time,
// repeats included - so a suite that builds a headers object by hand cannot see
// it: an object cannot hold the same key twice. Only bytes on a socket can put
// the second line there, which is what every case below does.
//
// WHAT THIS SUITE COVERS, AND WHAT IT DOES NOT. This one proves the collector is
// WIRED and that the merged VALUE is what the request is then answered from:
// the WebSocket upgrade, the auth preflight and the SSR path each merge or
// refuse a repeated line rather than silently keeping the last. The per-class
// policy itself - which headers join with ", ", which join with "; ", which keep
// the last line, which are refused - is pinned in `test/request-headers.test.js`,
// where every class can be driven directly.
//
// AN ASSERTION ON A STATUS ALONE PROVES LITTLE HERE. A repeated list header is
// SERVED either way, so `200` is true under last-wins too. Every case below
// therefore turns on a value: a cookie the upgrade hook compares, an encoding
// the response is compressed with, a forwarded chain the upgrade hook matches
// verbatim.
//
// The reserved admin route takes the same collector, but the fixture's WebSocket
// handler exports no `admin`, so that route is not mounted here and its call
// site is not reachable from this suite.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.
// The in-process mirror (`createTestServer`, src/testing.js) is a second SHIPPED
// surface rather than a second variant of the built one, and it carries its own
// copy of the collection sites, so it gets its own section at the bottom. The
// ADDRESS_HEADER section spawns the built server as a CHILD PROCESS instead of
// booting a second module, which is how it gets an eval-time environment of its
// own without a new fixture variant.

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade, freePort, EVAL_TIME_ENV } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * One `extraHeaders` entry that puts SEVERAL lines of the same header name on
 * the wire.
 *
 * The upgrade helper takes an object, and an object cannot hold one key twice -
 * which is the very confusion under test - so the repeat is written into the
 * VALUE: the helper joins its lines with CRLF, and this closes and reopens the
 * line exactly the same way.
 *
 * @param {string} name
 * @param {...string} values
 * @returns {Record<string, string>}
 */
function repeated(name, ...values) {
	return { [name]: values.join(`\r\n${name}: `) };
}

/**
 * Send a request built line by line and resolve with its status.
 *
 * The shared `rawUpgrade` helper writes a WebSocket handshake; the SSR and auth
 * preflight collectors need an ordinary request, so this writes those bytes in
 * the same shape. Resets rather than closing, for the TIME_WAIT reason the
 * helper documents.
 *
 * @param {number} port
 * @param {string[]} lines - request line and headers, no terminator
 * @returns {Promise<{ status: string, raw: string }>}
 */
function rawRequest(port, lines) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n') + '\r\n\r\n'));
		let buf = '';
		let settled = false;
		sock.on('data', (d) => {
			buf += d.toString('latin1');
			if (settled || buf.indexOf('\r\n\r\n') === -1) return;
			settled = true;
			const status = (buf.slice(0, buf.indexOf('\r\n')).match(/HTTP\/1\.1 (\d{3})/) || [, '???'])[1];
			if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy();
			else sock.destroy();
			resolve({ status, raw: buf });
		});
		sock.on('error', (error) => {
			if (settled) return;
			settled = true;
			sock.destroy();
			reject(error);
		});
		sock.setTimeout(15000, () => {
			if (settled) return;
			settled = true;
			sock.destroy();
			reject(new Error('no response line within 15s'));
		});
	});
}

describeUWS('a repeated request header line at the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime();
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	/** @param {string[]} extra */
	const get = (extra) => rawRequest(server.port, [
		'GET / HTTP/1.1',
		`Host: 127.0.0.1:${server.port}`,
		'Connection: close',
		...extra
	]);

	/** @param {string[]} extra */
	const preflight = (extra) => rawRequest(server.port, [
		'POST /__ws/auth HTTP/1.1',
		`Host: 127.0.0.1:${server.port}`,
		'Connection: close',
		'Content-Length: 0',
		...extra
	]);

	describe('on the WebSocket upgrade', () => {
		it('keeps the first Cookie line instead of dropping it', async () => {
			// The fixture's upgrade hook refuses a connection whose `token` cookie
			// reads `reject`. Sent as the FIRST of two Cookie lines, that cookie
			// only survives if the lines are merged - last-wins would hand the hook
			// the second line alone and the upgrade would complete.
			//
			// It also pins the SEPARATOR: joined with ", " instead of "; " the two
			// cookies become one cookie named `token` whose value is
			// "reject, probe=1", the hook's comparison fails, and the upgrade
			// completes just the same.
			const { status } = await rawUpgrade(server.port, repeated('Cookie', 'token=reject', 'probe=1'));
			expect(status, 'the first of two Cookie lines must survive collection').toBe('401');
		});

		it('completes the same upgrade when that cookie arrives on one line', async () => {
			// The control for the case above: 401 there has to come from the cookie
			// being seen, not from anything else about a two-line request.
			const single = await rawUpgrade(server.port, { Cookie: 'token=reject; probe=1' });
			expect(single.status).toBe('401');
			const other = await rawUpgrade(server.port, { Cookie: 'token=allow; probe=1' });
			expect(other.status).toBe('101');
		});

		it('refuses two Origin lines', async () => {
			// The fixture allows every origin, so both of these would be accepted
			// individually. Two of them is not an origin the CSRF check can decide
			// on: the proxy in front may have read the other one.
			const { status } = await rawUpgrade(server.port, repeated('Origin', 'http://a.test', 'http://b.test'));
			expect(status).toBe('400');
		});

		it('accepts one Origin line', async () => {
			const { status } = await rawUpgrade(server.port, { Origin: 'http://a.test' });
			expect(status).toBe('101');
		});
	});

	describe('on the auth preflight', () => {
		it('answers an ordinary preflight', async () => {
			// The fixture's `authenticate` hook sets no cookie and returns no body,
			// so an accepted preflight is a 204.
			const { status } = await preflight(['X-Requested-With: XMLHttpRequest']);
			expect(status).toBe('204');
		});

		it('refuses two Authorization lines', async () => {
			// Two credentials, one request: whichever this layer picked, the app's
			// credential check would be answering about the other one.
			const { status } = await preflight([
				'X-Requested-With: XMLHttpRequest',
				'Authorization: Bearer one',
				'Authorization: Bearer two'
			]);
			expect(status).toBe('400');
		});

		it('answers rather than hangs when no origin can be derived', async () => {
			// Not a duplicate-header case, but the same door: the origin builder
			// reads the collected headers and THROWS on a request it cannot
			// derive an origin from. Nothing wraps this route, so an unguarded
			// throw would escape the uWS callback as a synchronous exception - no
			// response written, the client waiting for its timeout, and the pooled
			// state object never handed back.
			//
			// This one pins the OUTCOME, not the guard: a Host-less request is
			// refused by uWS's own parser before the route runs - measured, the
			// status is 400 with the guard removed too, and the SSR path (which
			// answers 500 when the origin builder throws) says 400 here as well.
			// The reachable trigger is a client-supplied PROTOCOL_HEADER /
			// PORT_HEADER value, which needs a deployment configured for one; the
			// guard is here regardless, because the route must not be the one
			// place where a throw has nowhere to go.
			const { status } = await rawRequest(server.port, [
				'POST /__ws/auth HTTP/1.1',
				'Content-Length: 0'
			]);
			expect(status).toBe('400');
		});

	});

	describe('on the SSR path', () => {
		it('renders an ordinary request', async () => {
			const { status } = await get([]);
			expect(status).toBe('200');
		});

		it('refuses two Authorization lines', async () => {
			const { status } = await get([
				'Authorization: Bearer one',
				'Authorization: Bearer two'
			]);
			expect(status).toBe('400');
		});

		it('never answers a request carrying two Host lines', async () => {
			// Request smuggling in one header: the front proxy routes on one value
			// and the server would answer for the other. This one is refused by
			// uWS's own parser before collection runs - measured, the status is 400
			// with the collector reduced to last-wins too - so it pins the OUTCOME
			// rather than the collector. `host` is in the refused set regardless,
			// because the collector must not be the layer that lets it through.
			const { status } = await get(['Host: elsewhere.test']);
			expect(status).toBe('400');
		});

		it('serves a request whose list header arrived on several lines', async () => {
			// A repeated list header is merged, never refused: one line per hop is
			// how HAProxy's `option forwardfor` emits X-Forwarded-For, and that is
			// ordinary traffic rather than an anomaly. Status only - this fixture
			// renders no request header into its response, so what the merged
			// chain resolved TO is asserted on the mirror below and in
			// test/request-headers.test.js.
			const { status } = await get([
				'X-Forwarded-For: 203.0.113.7',
				'X-Forwarded-For: 10.0.0.9'
			]);
			expect(status).toBe('200');
		});

		it('does not refuse a repeated single-valued proxy header', async () => {
			// Two `x-forwarded-proto: https` lines are what an appending proxy in
			// front of another one produces. That class keeps the last line rather
			// than joining, because joined it reads "https, https" - not a
			// protocol - and the origin builder throws on it, turning every
			// request of a documented proxy configuration into a 500. Status only
			// on this variant: it configures no PROTOCOL_HEADER, so the runtime
			// does not read the header and cannot show which line won. The value
			// itself is pinned in test/request-headers.test.js and at the mirror
			// below.
			const { status } = await get([
				'X-Forwarded-Proto: https',
				'X-Forwarded-Proto: https'
			]);
			expect(status).toBe('200');
		});
	});
});

describeUWS('a repeated line of the header named as ADDRESS_HEADER, at the built runtime', () => {
	// The one configuration where the collector's class decision IS the security
	// decision, and the one the class list could not express by name.
	// ADDRESS_HEADER is operator-chosen: ingress-nginx and the GCP external load
	// balancer emit `x-original-forwarded-for`, RFC 7239 defines `Forwarded`, and
	// an operator reaches either by reading their own proxy's documentation. Both
	// are comma-separated chains, but `createClientIpResolver` counts hops in the
	// literal `x-forwarded-for` and nothing else - every other configured name
	// goes to its single-address branch, which truncates KEEPING THE LEADING
	// bytes. Joining the repeats of a chain-named ADDRESS_HEADER handed that
	// branch a value whose leading bytes are the CLIENT'S, so a client behind an
	// appending proxy chose its own rate-limit identity by padding the header.
	//
	// A CHILD PROCESS rather than a second in-process boot. ADDRESS_HEADER is
	// read at module eval, the suites above need it ABSENT, and a cached module
	// cannot be re-evaluated - which is the one-variant-per-file rule in
	// helpers/real-runtime.js. A spawned server evaluates the built runtime fresh
	// under its own environment, the same escape the TLS watch suite takes, and
	// it needs no new fixture variant.
	//
	// THE ORACLE IS THE LIMITER, because nothing in the fixture echoes a resolved
	// address back to the client. The built variant caps upgrades at 100 per
	// address per window: repeats that collapse to the proxy's line share ONE
	// bucket, so a burst past the cap is refused; repeats that join keep the
	// client's rotating padding, so every request lands in its own bucket and
	// nothing is refused at all. That gap is the defect, read off status codes.

	const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
	// The variant the suites above already build, reused rather than rebuilt: the
	// difference under test is environment, not build-time options.
	const builtEntry = path.join(fixtureDir, 'build', 'index.js');
	const LIMIT = 100;
	// Enough past the cap for the refusal to be unambiguous, few enough that the
	// burst finishes well inside the 10s window the variant is built with.
	const BURST = LIMIT + 30;
	// Longer than an address and constant across the burst, so the padding is the
	// only thing that could make two requests look like different clients.
	const PAD = 'x'.repeat(120);

	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	/** @type {number} */
	let port = 0;
	let output = '';

	beforeAll(async () => {
		port = await freePort();
		// Every eval-time knob starts absent, for the reason startRealRuntime
		// scrubs them: an inherited ADDRESS_HEADER or TRUSTED_PROXIES from a
		// developer's shell would silently test a different server. TRUSTED_PROXIES
		// stays unset on purpose - the header is then honored verbatim, which is
		// what puts the resolved value entirely in the collector's hands.
		const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ADDRESS_HEADER: 'x-original-forwarded-for' };
		for (const key of EVAL_TIME_ENV) {
			if (key !== 'ADDRESS_HEADER') delete env[key];
		}
		const listening = await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'], env });
			const scan = (buf) => {
				output += buf.toString();
				if (output.includes('Listening on http://')) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 20000);
		});
		expect(listening, `the configured server never reached listening.\n--- server output ---\n${output}`).toBe(true);
	}, 400000);

	afterAll(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	/**
	 * One upgrade carrying two lines of the configured address header: the
	 * client's line first, then the line an appending proxy adds.
	 *
	 * @param {string} clientLine
	 * @param {string} proxyLine
	 */
	const twoLines = (clientLine, proxyLine) =>
		rawUpgrade(port, repeated('X-Original-Forwarded-For', clientLine, proxyLine));

	it('keeps distinct proxy lines in distinct limiter buckets', async () => {
		// The control, and it runs FIRST so the burst below meets an empty
		// bucket. It also pins that the refusals below are bucket SHARING rather
		// than a global cap: these carry the same rotating padding and differ only
		// in the proxy's line, and none of them is refused.
		let refused = 0;
		for (let i = 0; i < 20; i++) {
			const { status } = await twoLines(`${PAD}${i}`, `203.0.113.${i}`);
			if (status === '429') refused++;
		}
		expect(refused, 'requests the proxy attributed to different clients must not share a bucket').toBe(0);
	});

	it('collapses a padded client line onto the proxy line the appending hop added', async () => {
		// The attack, verbatim, through the header name the operator configured.
		// Joined, each of these resolves to its own 128-character prefix of the
		// client's padding - the whole burst is admitted, and a client can rotate
		// the padding to stay under the per-address cap forever or pin it to a
		// victim's value to spend that victim's budget. Collapsed to the proxy's
		// line, the burst shares one bucket and is refused past the cap.
		let refused = 0;
		const started = Date.now();
		for (let i = 0; i < BURST; i++) {
			const { status } = await twoLines(`${PAD}${i}`, '198.51.100.7');
			if (status === '429') refused++;
		}
		expect(
			refused,
			`a client's own padding must not become its rate-limit identity ` +
			`(burst of ${BURST} took ${Date.now() - started}ms against a 10s window)`
		).toBeGreaterThan(0);
	});
});

describeUWS('a repeated request header line at the in-process mirror', () => {
	// src/testing.js is a SHIPPED surface: apps verify their handshake against
	// `createTestServer` before deploying. It carries its own copies of the
	// collection sites, so a policy that only reached the built runtime would let
	// an app pass locally and be refused in production.
	//
	// This section also covers what the fixture cannot: the upgrade hook here is
	// written by the test, so it can compare the MERGED X-Forwarded-For value
	// byte for byte - the headline behaviour, decided on real bytes rather than
	// on a headers object a test built itself.

	/** @type {any} */
	let mirror = null;

	afterEach(async () => {
		await mirror?.close();
		mirror = null;
	});

	/**
	 * A registry shaped like the `metrics` option, recording label sets so a
	 * counter series can be read back by reason.
	 */
	function recordingRegistry() {
		const counters = new Map();
		return {
			counter(name) {
				let c = counters.get(name);
				if (!c) {
					c = {
						series: new Map(),
						inc(labels) {
							const key = labels ? JSON.stringify(labels) : '';
							c.series.set(key, (c.series.get(key) || 0) + 1);
						}
					};
					counters.set(name, c);
				}
				return c;
			},
			gauge() { return { set() {} }; },
			/** @param {string} name @param {string} reason */
			reason(name, reason) {
				return counters.get(name)?.series.get(JSON.stringify({ reason })) || 0;
			}
		};
	}

	it('hands the upgrade hook every X-Forwarded-For line, joined in arrival order', async () => {
		// The hook is the only reader that can see the collected value, and it
		// compares the WHOLE string: last-wins gives it "10.0.0.9", first-wins
		// "203.0.113.7", and either one is refused here. Only the merge opens the
		// connection.
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({
			handler: {
				upgrade: ({ headers }) => headers['x-forwarded-for'] === '203.0.113.7, 10.0.0.9' && {}
			}
		});
		const merged = await rawUpgrade(mirror.port, repeated('X-Forwarded-For', '203.0.113.7', '10.0.0.9'));
		expect(merged.status, 'the two lines must arrive as one comma-joined chain').toBe('101');

		const single = await rawUpgrade(mirror.port, { 'X-Forwarded-For': '203.0.113.7, 10.0.0.9' });
		expect(single.status, 'the control: one line carrying the same chain').toBe('101');

		const lastOnly = await rawUpgrade(mirror.port, { 'X-Forwarded-For': '10.0.0.9' });
		expect(lastOnly.status, 'and the hook really does refuse anything else').toBe('401');
	});

	it('keeps the last line of a repeated single-valued proxy header', async () => {
		// The other class the runtime itself parses: joined, this value is not an
		// address at all, and the resolver's length bound would truncate it back
		// to the client's own bytes.
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({
			handler: {
				upgrade: ({ headers }) => headers['x-real-ip'] === '203.0.113.5' && {}
			}
		});
		const { status } = await rawUpgrade(mirror.port, repeated('X-Real-IP', '9.9.9.9', '203.0.113.5'));
		expect(status).toBe('101');
	});

	it('refuses a repeated Authorization line and counts it under its own reason', async () => {
		// The refused class, plus the counter an operator's dashboard buckets it
		// in. Nothing else asserts that label, so dropping the `inc()` in a later
		// refactor is otherwise silent.
		const { createTestServer } = await import('../src/testing.js');
		const metrics = recordingRegistry();
		mirror = await createTestServer({ metrics, handler: { upgrade: () => ({}) } });

		const { status } = await rawUpgrade(mirror.port, repeated('Authorization', 'Bearer one', 'Bearer two'));
		expect(status).toBe('400');
		expect(metrics.reason('upgrade_rejected_total', 'duplicate_header')).toBe(1);
		expect(metrics.reason('upgrade_rejected_total', 'auth_rejected')).toBe(0);

		const clean = await rawUpgrade(mirror.port, { Authorization: 'Bearer one' });
		expect(clean.status).toBe('101');
		expect(metrics.reason('upgrade_rejected_total', 'duplicate_header')).toBe(1);
	});
});
