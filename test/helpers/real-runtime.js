// Boot the REAL built runtime and drive it over real sockets.
//
// WHY THIS EXISTS. src/testing.js and src/vite.js reimplement runtime
// behaviour by hand, so a suite that boots `createTestServer` proves nothing
// about src/runtime/**. That is not theoretical: security fixes have shipped
// with tests that looked end-to-end, passed, and stayed green when the fix was
// deleted, because the assertion never reached the code that was changed.
// Anything asserting a runtime security decision belongs here instead.
//
// WHAT MAKES AN ASSERTION COUNT. Assert on the frame the CLIENT receives, or on
// the bytes on the wire. A helper's return value, a source string, or a
// mock platform's recorded call can all stay true while the production wiring
// is dead.
//
// ONE VARIANT PER TEST FILE. The built handler is an ESM module imported into
// the vitest worker process, and it reads its env at module eval, so a second
// boot inside the same file gets the first module instance back. A file needing
// a different build-time config or a different env is a different file.

import net, { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './fixture-build.js';
import { variantOut } from '../fixture/variants.js';
// The PRODUCTION parsers, so the eval-time-env expectations below cannot drift
// from what the runtime actually computes from the same string.
import { parse_as_bytes, parse_origin } from '../../src/runtime/utils/parse.js';

const fixtureDir = fileURLToPath(new URL('../fixture', import.meta.url));

let uWS;
try {
	uWS = createRequire(import.meta.url)('uWebSockets.js');
} catch {
	uWS = null;
}
/**
 * uWS present? Suites gate with `hasUWS ? describe : describe.skip`.
 *
 * uWebSockets.js is an OPTIONAL native dependency, so a contributor without it
 * can still run the pure suites - that is why the gate exists and it stays.
 * What is not acceptable is the shape of the result: a skipped real-runtime
 * suite reports PASSED with zero assertions, which is indistinguishable from a
 * suite that ran and proved something. Every claim these suites make about
 * authorization, revocation and the handshake would be reported as verified by
 * a run that verified nothing.
 *
 * So where the result is a GATE rather than a convenience, absence is a hard
 * failure instead: `REQUIRE_UWS=1` demands it explicitly, and `CI` implies it.
 */
export const hasUWS = uWS !== null;

if (!hasUWS && (process.env.REQUIRE_UWS === '1' || process.env.CI === 'true')) {
	throw new Error(
		'uWebSockets.js is not installed, so every real-runtime suite would skip and report ' +
		'PASSED with zero assertions. Refusing to report that as a pass.\n' +
		'  install it:   npm install\n' +
		'  or run the pure suites deliberately, without REQUIRE_UWS / CI set.'
	);
}

/**
 * Every environment variable the built runtime reads at MODULE EVAL, and which
 * therefore cannot be changed after the import. Kept in sync with the `env(...)`
 * reads in `src/runtime/handler/config.js` - `test/real-runtime-env-scrub.test.js`
 * fails if that file grows one this list does not have.
 */
export const EVAL_TIME_ENV = [
	'ADDRESS_HEADER', 'BODY_SIZE_LIMIT', 'HOST_HEADER', 'ORIGIN', 'PORT_HEADER',
	'PROTOCOL_HEADER', 'PROXY_PROTOCOL', 'RECONNECT_DISPERSAL_MS', 'SSL_CERT',
	'SSL_KEY', 'SSL_RELOAD_DEBOUNCE_MS', 'SSL_SNI_HOSTS', 'SSL_WATCH',
	'TRUSTED_PROXIES', 'WS_DEBUG', 'XFF_DEPTH',
	// Read by `src/runtime/index.js`, the server BOOT entry - which this helper
	// does not import (it imports the built `handler.js`, and nothing in that
	// graph reads either name). So scrubbing these two is DEFENSIVE, not
	// load-bearing: it costs nothing and keeps a stray shell value from reaching
	// a suite that later grows a boot-level import. The earlier note here claimed
	// they were read at boot by the code under test, which is not true of this
	// path; `test/real-runtime-env-scrub.test.js` scans the actual import graph.
	'CLUSTER_WORKERS', 'CLUSTER_MODE'
];

/**
 * Eval-time knobs whose effect is READABLE BACK off the booted config module, so
 * a cached module evaluated under a different environment can be caught by
 * VALUE rather than merely by presence.
 *
 * Each entry brings its own comparison because the config value is parsed, not
 * stored raw: a header is lowercased, a byte size is a number, an SNI list is a
 * trimmed array. The expectation reuses the PRODUCTION parsers (`parse_as_bytes`,
 * `parse_origin`) rather than restating them, so this table cannot drift from
 * what the runtime actually computes - restating them is how the previous
 * version ended up comparing `String(got)` to a raw env string and having to
 * fall back to presence.
 *
 * `presenceOnly` marks a value that genuinely cannot be compared: the trusted
 * proxy matcher is a closure with no readable source. It is flagged here instead
 * of being silently lumped in with the rest, which is what hid the gap.
 *
 * `expect` receives the raw env value or `undefined`, and must answer what the
 * config carries in BOTH cases - an unset knob reads back as its documented
 * default, so an expectation that only handled the set case would report a
 * mismatch on every ordinary boot.
 *
 * @type {Array<{ env: string, read: (config: any) => unknown, expect?: (raw: string | undefined, config: any) => unknown, presenceOnly?: boolean }>}
 */
export const OBSERVABLE = [
	{ env: 'SSL_CERT', read: (c) => c.ssl_cert, expect: (raw) => raw },
	{ env: 'SSL_KEY', read: (c) => c.ssl_key, expect: (raw) => raw },
	{
		env: 'SSL_WATCH',
		read: (c) => c.ssl_watch,
		expect: (raw, c) => (c.is_tls ? raw !== '0' : false)
	},
	{
		env: 'SSL_RELOAD_DEBOUNCE_MS',
		read: (c) => c.ssl_reload_debounce_ms,
		expect: (raw) => {
			const n = parseInt(raw ?? '500', 10);
			return Number.isFinite(n) && n >= 0 ? n : 500;
		}
	},
	{
		env: 'SSL_SNI_HOSTS',
		read: (c) => c.ssl_sni_hosts,
		expect: (raw) => (raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
	},
	{ env: 'ORIGIN', read: (c) => c.origin, expect: (raw) => parse_origin(raw) },
	{ env: 'ADDRESS_HEADER', read: (c) => c.address_header, expect: (raw) => (raw ?? '').toLowerCase() },
	{ env: 'PROTOCOL_HEADER', read: (c) => c.protocol_header, expect: (raw) => (raw ?? '').toLowerCase() },
	{ env: 'HOST_HEADER', read: (c) => c.host_header, expect: (raw) => (raw ?? '').toLowerCase() },
	{ env: 'PORT_HEADER', read: (c) => c.port_header, expect: (raw) => (raw ?? '').toLowerCase() },
	{ env: 'BODY_SIZE_LIMIT', read: (c) => c.body_size_limit, expect: (raw) => parse_as_bytes(raw ?? '512K') },
	{ env: 'XFF_DEPTH', read: (c) => c.xff_depth, expect: (raw) => parseInt(raw ?? '1', 10) },
	{ env: 'PROXY_PROTOCOL', read: (c) => c.proxy_protocol, expect: (raw) => raw === '1' },
	{
		env: 'RECONNECT_DISPERSAL_MS',
		read: (c) => c.reconnect_dispersal_ms,
		expect: (raw) => {
			const n = parseInt(raw ?? '5000', 10);
			return Number.isFinite(n) && n >= 0 ? n : 5000;
		}
	},
	// Every fixture variant enables WebSockets - they exist to exercise the WS
	// runtime - so `WS_ENABLED` is true and `wsDebug` reduces to the env read. A
	// variant without WS would make this report a mismatch loudly, which is the
	// right direction: a noisy prompt to fix this table beats the silent pass
	// that presence-only comparison gave every key on this list.
	{ env: 'WS_DEBUG', read: (c) => c.wsDebug, expect: (raw) => raw === '1' },
	{ env: 'TRUSTED_PROXIES', read: (c) => c.trusted_proxies, presenceOnly: true }
];

/**
 * Eval-time knobs with NO readable config export, so a stale module carrying a
 * different value for one cannot be detected here at all.
 *
 * Named rather than omitted: `test/real-runtime-env-scrub.test.js` asserts that
 * every entry in EVAL_TIME_ENV is either observable or listed here, so a knob
 * added later forces the choice instead of quietly landing in a blind spot.
 */
export const UNOBSERVABLE_EVAL_TIME_ENV = ['CLUSTER_WORKERS', 'CLUSTER_MODE'];

/**
 * Reduce a config value to something comparable: absent for empty, a joined
 * string for a list, the value itself for a scalar.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeConfigValue(value) {
	if (value === undefined || value === null || value === '') return undefined;
	if (Array.isArray(value)) return value.length === 0 ? undefined : value.join(',');
	if (typeof value === 'function') return undefined;
	return value;
}

/**
 * Which eval-time knobs the booted config DISAGREES with `env` about.
 *
 * Exported and pure so the comparison itself can be driven directly. It is the
 * whole decision this guard makes, and the previous version of it looked correct
 * while being unable to detect the failure it was written for - so it is worth
 * testing against a config object rather than only through a boot, where the
 * only reachable assertion is "no suite happened to trip it".
 *
 * COMPARES VALUES, not presence. Presence alone was the original signal, and two
 * suites that both set a key to DIFFERENT values agreed on presence and passed:
 * boot 1 with `ADDRESS_HEADER=x-forwarded-for`, boot 2 asking for `x-real-ip`,
 * module still carrying the first, guard silent.
 *
 * @param {any} config - the booted `handler/config.js` module
 * @param {Record<string, string|undefined>} env
 * @returns {string[]} one human-readable line per disagreement
 */
export function evalTimeEnvMismatches(config, env) {
	const mismatched = [];
	for (const entry of OBSERVABLE) {
		const wanted = env[entry.env];
		const got = entry.read(config);
		const gotNorm = normalizeConfigValue(got);
		if (entry.presenceOnly) {
			// No comparable value exists - only whether the knob was set at all. A
			// closure reads back as a function whether or not it matched anything,
			// so it cannot even carry presence; say so rather than guess.
			const wantedSet = wanted !== undefined && wanted !== '';
			const gotSet = got !== undefined && got !== null;
			if (wantedSet === gotSet || typeof got === 'function') continue;
			mismatched.push(
				`${entry.env}: asked for ${wantedSet ? 'set' : '(unset)'}, module has ${gotSet ? 'set' : '(unset)'} (presence only)`
			);
			continue;
		}
		// An UNSET knob reads back as its documented default, not as absent, so the
		// expectation covers both cases - which is what lets this catch the original
		// bug too: a suite naming no SSL_CERT against a cached module that booted
		// TLS is `undefined` against a cert, and that is a mismatch.
		let wantedNorm;
		try {
			wantedNorm = normalizeConfigValue(entry.expect(wanted === '' ? undefined : wanted, config));
		} catch (error) {
			// A knob the runtime itself would have rejected at eval. Report it rather
			// than letting the comparison throw from inside a guard.
			mismatched.push(`${entry.env}: ${String(wanted)} is not a value the runtime accepts (${error.message})`);
			continue;
		}
		if (wantedNorm === undefined && gotNorm === undefined) continue;
		if (wantedNorm === gotNorm) continue;
		mismatched.push(
			`${entry.env}: asked for ${String(wantedNorm)}, module has ${gotNorm === undefined ? '(unset)' : String(gotNorm)}`
		);
	}
	return mismatched;
}

/** @returns {Promise<number>} an unused loopback port */
export function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

/**
 * Build (once per source state) and boot a fixture variant's real runtime.
 *
 * Env must be applied BEFORE the built handler is imported - the runtime reads
 * it at module eval - which is why this helper sets it rather than the caller.
 *
 * @param {{ variant?: string, env?: Record<string, string|undefined> }} [opts]
 * @returns {Promise<{ port: number, wsUrl: string, httpUrl: string, handler: any, stop: () => Promise<void> }>}
 */
export async function startRealRuntime({ variant = 'default', env = {} } = {}) {
	const built = buildFixtureOnce(variant);
	if (!built) throw new Error(`fixture variant "${variant}" failed to build`);

	// NORMALIZE FIRST, then apply what the caller asked for.
	//
	// The runtime reads all of these at MODULE EVAL, and `process.env` is shared
	// by every test file in a vitest worker (globals and module registries are
	// not; env is). Applying only the caller's keys therefore let a suite inherit
	// whatever the previous one left set, or whatever the developer happened to
	// export in their shell - and a suite that inherits `ADDRESS_HEADER` is
	// silently testing a different server than the one it describes. Two suites
	// were made to fail that way, and the reverse order passed while testing the
	// wrong thing, which is worse.
	//
	// So: every eval-time knob starts absent unless this call names it. A suite
	// that needs one passes it; a suite that does not gets the documented
	// default regardless of what ran before it.
	// Snapshot before touching anything, so `stop()` can put the process back the
	// way it found it. The scrub deletes 18 variables process-wide and nothing
	// depended on them persisting, which made this latent rather than broken - but
	// a helper that permanently edits the environment of every later suite in the
	// worker is a trap waiting for the first suite that reads one outside a boot.
	/** @type {Array<[string, string | undefined]>} */
	const envBefore = EVAL_TIME_ENV.concat(Object.keys(env))
		.map((key) => /** @type {[string, string | undefined]} */ ([key, process.env[key]]));

	for (const key of EVAL_TIME_ENV) {
		if (!(key in env)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	const builtHandler = path.join(fixtureDir, variantOut(variant), 'handler.js');
	const handler = await import(pathToFileURL(builtHandler).href);

	// The import above is a CACHE READ when another suite in this worker already
	// loaded this variant. That only happens when file parallelism is off (at
	// `--maxWorkers=1` / `--no-file-parallelism` vitest reuses one module
	// registry); with parallelism on, each file re-evaluates. Either way the
	// scrub above means the eval saw a known env - so if the module still comes
	// back TLS, it is a genuinely stale cached one from a suite that booted TLS
	// in-process, and every caller here dials `ws://`. Left unnamed that
	// surfaces as a bare `socket hang up` with nothing pointing at the cause.
	const config = await import(pathToFileURL(path.join(fixtureDir, variantOut(variant), 'handler', 'config.js')).href);

	// COMPARE what the module actually booted with against what this call asked
	// for. The scrub above only reaches module EVAL, and the import is a cache
	// hit whenever another suite in this worker already loaded the variant (which
	// is every time file parallelism is off). In that case the returned runtime
	// is configured however the FIRST suite left it, and the previous version of
	// this guard - which only looked at is_tls - let that pass silently: two
	// suites were caught testing a server with an `ADDRESS_HEADER` they never
	// asked for, and the order that passed was testing the wrong thing.
	//
	// A mismatch is not recoverable here (re-importing cannot re-evaluate a
	// cached module graph), so the answer is to be LOUD about it. The cure is a
	// dedicated fixture variant, which is what gives a suite its own module.
	const mismatched = evalTimeEnvMismatches(config, process.env);
	if (mismatched.length > 0) {
		throw new Error(
			`real-runtime: variant "${variant}" was already evaluated in this worker under a different ` +
			`environment, so this suite would test a server it did not configure - ${mismatched.join('; ')}. ` +
			'The runtime reads these at module eval and Node cannot re-evaluate a cached module, so two ' +
			'suites needing different eval-time env cannot share a variant: give this one its own entry in ' +
			'test/fixture/variants.js. (Most often seen with file parallelism off, where one worker runs ' +
			'every file.)'
		);
	}

	const port = await freePort();
	await handler.start('127.0.0.1', port);

	return {
		port,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		httpUrl: `http://127.0.0.1:${port}`,
		handler,
		async stop() {
			try { await handler.shutdown(); } catch { /* already down */ }
			try { handler.forceCloseApp(); } catch { /* already closed */ }
			// RESTORE, rather than delete what this call set. Deleting only the
			// caller's keys left the other scrubbed variables gone for the rest of
			// the process, so the helper's cleanup was itself a source of
			// cross-suite env drift - the thing the scrub exists to prevent.
			for (const [key, value] of envBefore) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
}

/**
 * A real `ws` client that records every frame it receives.
 *
 * close() TERMINATES rather than closing gracefully: the side that closes
 * gracefully holds its ephemeral port in TIME_WAIT for ~2 minutes, and on
 * Windows the default dynamic range is 16384 ports, so socket-heavy suites that
 * close politely exhaust the pool and make unrelated tests fail with connect
 * errors indistinguishable from a real regression.
 *
 * @param {string} wsUrl
 * @param {{ headers?: Record<string,string> }} [opts]
 */
export async function connectRealClient(wsUrl, { headers } = {}) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);
	/** @type {string[]} */
	const frames = [];
	ws.on('message', (data) => { frames.push(data.toString()); });
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});

	return {
		ws,
		frames,
		/** @param {unknown} msg */
		send(msg) { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
		/**
		 * Resolve with the first received frame matching `predicate`, or null on
		 * timeout. Returning null rather than throwing lets a test assert that
		 * something was NOT delivered, which is the shape most access-control
		 * assertions need.
		 *
		 * SCANS THE WHOLE FRAME HISTORY, deliberately (the negative-assertion
		 * shape above needs it). The cost: two waits with the same predicate on
		 * one connection BOTH resolve with the first matching frame - a probe
		 * repeated to observe a change reads its own earlier answer back and the
		 * assertion goes vacuous. Any request/response probe a test issues more
		 * than once per connection must carry a correlator the server echoes (a
		 * nonce) and match on it.
		 * @param {(parsed: any, raw: string) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 500) {
			const deadline = Date.now() + ms;
			for (;;) {
				for (const raw of frames) {
					let parsed = null;
					try { parsed = JSON.parse(raw); } catch { /* non-JSON frame */ }
					if (predicate(parsed, raw)) return { parsed, raw };
				}
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() {
			try { ws.terminate(); } catch { /* already gone */ }
		}
	};
}

/**
 * How many times {@link rawUpgrade} re-issues a request whose socket died before
 * the server said anything. Small on purpose: this covers a listen backlog
 * shedding a connection during a burst, not a server that is actually down.
 */
const RAW_UPGRADE_ATTEMPTS = 6;

/**
 * One attempt at a raw upgrade.
 *
 * Resolves `{ status, raw }` once a response line arrived, or `{ error, raw }`
 * when the socket ended first. `raw` is what separates the two failure kinds:
 * bytes already received mean the server DID answer, so whatever happened next
 * is a result rather than a request that never happened.
 *
 * @param {number} port
 * @param {Record<string,string>} extraHeaders
 * @returns {Promise<{ status?: string, error?: any, raw: string, timedOut?: boolean }>}
 */
function attemptRawUpgrade(port, extraHeaders) {
	return new Promise((resolve) => {
		const lines = [
			'GET /ws HTTP/1.1',
			`Host: 127.0.0.1:${port}`,
			'Connection: Upgrade',
			'Upgrade: websocket',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version: 13'
		];
		for (const [name, value] of Object.entries(extraHeaders)) lines.push(`${name}: ${value}`);
		lines.push('', '');

		const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n')));
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
			// The reset above makes the socket emit too; that one is ours.
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve({ error, raw: buf });
		});
		sock.setTimeout(15000, () => {
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve({ error: new Error('no response line within 15s'), raw: buf, timedOut: true });
		});
	});
}

/**
 * One raw WebSocket upgrade request, for assertions about the handshake itself
 * (status line and response headers) rather than about WS frames.
 *
 * Resets instead of closing, for the TIME_WAIT reason above.
 *
 * RETRIES A CONNECT-LEVEL FAILURE INSTEAD OF REPORTING IT. A socket that dies
 * before a single response byte arrived never reached the server's decision, so
 * handing the caller a sentinel status for it mixes kernel weather into a
 * protocol tally. A suite opening thousands of connections overflows the listen
 * backlog now and then, the odd RST used to be counted alongside the real 101s
 * and 429s, and a strict count then failed roughly one run in three for reasons
 * that had nothing to do with the code under test. Re-issuing the request is the
 * only honest reading of "this one never happened".
 *
 * What is NOT retried, because both are real results: a failure once the server
 * has started answering - those bytes are evidence - and a request that keeps
 * failing past the attempt budget. Both THROW, carrying the transport error, so
 * a genuine regression cannot be absorbed as a status a caller might tally or
 * skip past.
 *
 * @param {number} port
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Promise<{ status: string, raw: string }>}
 */
export async function rawUpgrade(port, extraHeaders = {}) {
	/** @type {{ status?: string, error?: any, raw: string, timedOut?: boolean }} */
	let last = { raw: '' };
	for (let attempt = 1; attempt <= RAW_UPGRADE_ATTEMPTS; attempt++) {
		last = await attemptRawUpgrade(port, extraHeaders);
		if (last.status !== undefined) return { status: last.status, raw: last.raw };
		if (last.raw.length > 0 || last.timedOut) break;
		// Linear backoff. The backlog drains in milliseconds, and a longer wait
		// would turn a suite that opens ten thousand connections into a slow one.
		await new Promise((r) => setTimeout(r, 10 * attempt));
	}

	const why = last.raw.length > 0
		? `the server had already sent ${last.raw.length} byte(s), so this is an answer cut short`
		: last.timedOut
			? 'the connection opened and nothing was ever answered on it'
			: `no response byte arrived across ${RAW_UPGRADE_ATTEMPTS} attempts`;
	throw new Error(
		`raw upgrade to 127.0.0.1:${port} produced no status line (${last.error?.code ?? last.error?.message}) - ${why}. ` +
		'A failure with nothing received is retried and never reported, so reaching this means either a real ' +
		'regression or a machine out of ephemeral ports: check `Get-NetTCPConnection -State TimeWait`, which ' +
		'stays full for ~120s after a socket-heavy run and makes every suite here fail the same way.'
	);
}
