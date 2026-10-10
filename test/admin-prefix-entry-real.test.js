// The reserved admin namespace is entered by RESOLUTION as well as by spelling.
//
// WHY THIS EXISTS. The mirror of the escape this repo already refuses. The
// admin route is mounted on the raw prefix and uWS matches the raw target, so a
// target whose raw spelling sits OUTSIDE `/__realtime` but which RESOLVES
// inside it never reaches the admin lane at all: it falls through to the static
// and SSR lanes, and building the Web `Request` there resolves the dot segments
// and hands the app's own router a pathname inside the reserved namespace.
//
//   GET /foo/../__realtime/introspect
//     raw target       /foo/../__realtime/introspect   -> misses the mount
//     Request pathname /__realtime/introspect          -> inside the prefix
//
// The adapter documents the prefix as reserved and mounted ahead of page
// routing, and an app is entitled to read that as "my routes never see it".
// Whether it held was decided by the caller's spelling.
//
// The lane a request is served by is chosen from the RAW target, so a target
// that resolves into a lane its raw form did not choose describes itself as one
// request and is routed as another. That is refused, not rerouted, for the same
// reason the escape is: rerouting picks one of the two readings on the caller's
// behalf, and picking the prefix would let any caller reach the admin lane by a
// spelling a fronting proxy's ACL never recognizes as admin.
//
// WHAT MAKES THE ASSERTION COUNT. The fixture app has a real route inside the
// prefix (`src/routes/__realtime/[...rest]`), and it reports that it ran. So a
// failure here is the APP answering a reserved path, not a status code standing
// in for one - and the direct spelling in the first case proves the app route
// is shadowed when the reservation does hold.
//
// RAW SOCKETS, NOT fetch(). Every HTTP client resolves the target before it
// goes out, so `fetch('/foo/../__realtime/introspect')` puts
// `/__realtime/introspect` on the wire, matches the mount, and never exercises
// this at all.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const BACKSLASH = String.fromCharCode(92);

/**
 * One request with the target written verbatim into the request line.
 * @param {number} port
 * @param {string} target
 * @param {string} [method]
 */
function rawRequest(port, target, method = 'GET') {
	return new Promise((resolve) => {
		let buf = '';
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
		});
		sock.setTimeout(5000, () => { sock.destroy(); resolve({ status: 0, body: '' }); });
		sock.on('data', (d) => { buf += d.toString(); });
		sock.on('close', () => {
			// The STATUS LINE first, then the code: uWS writes `HTTP/1.1 200`
			// with no reason phrase, so splitting the whole buffer on spaces
			// takes the first header line with it and yields NaN.
			const status = Number(buf.split('\r\n')[0].split(' ')[1] || 0);
			resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
		});
		sock.on('error', () => resolve({ status: 0, body: '' }));
	});
}

describeUWS('a target that resolves into the reserved admin prefix', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('shadows the app route when the prefix is spelled directly', async () => {
		// The reservation working. Both this and the refusals below would be
		// satisfied by a broken admin mount, so this case is what tells them
		// apart: the admin handler answers and the app route, which exists and
		// would answer 200 with a body of its own, does not run.
		const direct = await rawRequest(server.port, '/__realtime/introspect');
		expect(direct.status).toBe(200);
		const body = JSON.parse(direct.body);
		expect(body.ok, 'the admin lane must answer the reserved prefix').toBe(true);
		expect(body.appRouteReached, 'the app route inside the prefix must be shadowed').toBeUndefined();
	}, 60000);

	it('refuses a target whose raw form is outside the prefix and whose resolved form is inside', async () => {
		// One segment up; two; the dot-only spelling; the percent-encoded dots
		// (`%2e` IS a dot segment to the URL parser, so it resolves the same
		// way and has to be refused the same way); the backslash spelling (a
		// backslash is a path separator for a special scheme, so `..\` drops a
		// segment exactly as `../` does); and a raw path that starts with the
		// prefix TEXT without being inside the namespace, which the mount does
		// not match and which resolves inside it.
		for (const target of [
			'/foo/../__realtime/introspect',
			'/a/b/../../__realtime/introspect',
			'/foo/./../__realtime/introspect',
			'/foo/%2e%2e/__realtime/introspect',
			'/foo/%2E%2E/__realtime/introspect',
			`/foo/..${BACKSLASH}__realtime/introspect`,
			`/foo${BACKSLASH}..${BACKSLASH}__realtime/introspect`,
			'/__realtimex/../__realtime/introspect'
		]) {
			const refused = await rawRequest(server.port, target);
			expect(refused.status, `${target} must be refused`).toBe(400);
			expect(refused.body, `${target} must not reach the app's router`)
				.not.toContain('appRouteReached');
			expect(refused.body, `${target} must not reach the admin handler`)
				.not.toContain('"ok":true');
		}
	}, 60000);

	it('refuses a target that spells the prefix percent-encoded', async () => {
		// The OTHER way in, and it needs no dot segment at all. The URL parser
		// never decodes percent-escapes, but both lanes below it do before they
		// match: the prerendered lookup decodes, and SvelteKit's router decodes.
		// So `%5f` is an underscore to everything that routes this path and to
		// nothing that inspects it, which is exactly the disagreement the check
		// exists to refuse. `%72` covers a letter rather than the punctuation,
		// so a check written against the underscores alone fails here.
		//
		// A fronting proxy's ACL on the literal prefix does not see any of these
		// either, which is why the adapter refusing them is what makes the
		// reservation something an operator can build on.
		for (const target of [
			'/%5f%5frealtime/introspect',
			'/%5F%5Frealtime/introspect',
			'/_%5frealtime/introspect',
			'/__%72ealtime/introspect',
			'/%5f%5f%72%65%61%6c%74%69%6d%65/introspect',
			'/foo/../%5F%5Frealtime/introspect',
			'/__realtime%2Fintrospect'
		]) {
			const refused = await rawRequest(server.port, target);
			expect(refused.status, `${target} must be refused`).toBe(400);
			expect(refused.body, `${target} must not reach the app's router`)
				.not.toContain('appRouteReached');
		}
	}, 60000);

	it('refuses a resolved entry whose escape does not decode', async () => {
		// The path reaches the prefix by resolution or by its escapes and ends in
		// an escape no UTF-8 decoder accepts. The prefix answer cannot wait on
		// that decode: SvelteKit answers such a path 400 itself, but only after
		// the app's `handle` hook has run on it, so a 400 alone does not show
		// that the reservation held. The adapter's own refusal is the plain
		// `Bad Request` body. POST, because a GET is refused by the prerendered
		// lookup's own decode before SvelteKit is asked.
		for (const method of ['GET', 'POST']) {
			for (const target of ['/foo/../__realtime/introspect%', '/foo/../__realtime/%zz', '/%5F%5Frealtime/introspect%', '/__%72ealtime/%E0%A4%A']) {
				const refused = await rawRequest(server.port, target, method);
				expect(refused.status, `${method} ${target} must be refused`).toBe(400);
				expect(refused.body, `${method} ${target} must be refused before the app sees it`).toBe('Bad Request');
			}
		}
	}, 60000);

	it('refuses a raw byte or a fragment in a target the admin lane routes', async () => {
		// The admin mount is a wildcard, so these match it on their raw spelling
		// and meet the route wrapper's target check rather than the catch-all's.
		const E_ACUTE = String.fromCharCode(0xe9);
		for (const target of [`/__realtime/intro${E_ACUTE}`, '/__realtime/introspect#x', `/__realtime/introspect?x=${E_ACUTE}`]) {
			const refused = await rawRequest(server.port, target);
			expect(refused.status, `${target} must be refused`).toBe(400);
			expect(refused.body, `${target} must not reach the admin handler`).toBe('Bad Request');
		}
	}, 60000);

	it('refuses the encoded spelling ahead of the prerendered lookup', async () => {
		// The prerendered map is a SECOND lane into the namespace and it is
		// consulted before SSR, so a check that sat after it would be bypassed
		// by anything prerendered inside the prefix. The fixture prerenders
		// `/__realtime/pinned` for exactly this: with the check ahead of the
		// lookup the encoded spelling is refused, and with it behind, the page
		// is served.
		// THE PAGE HAS TO EXIST for this to mean anything: against a fixture
		// that never built it, the refusal below is just the ordinary encoded
		// refusal and the ordering goes untested. It cannot be proved from
		// HERE - the mount shadows every spelling that reaches it - so
		// admin-prefix-unmounted-real.test.js proves it instead, on the variant
		// with no mount, by fetching the page and reading its marker back. The
		// pair is the assertion; neither half is one alone.
		const refused = await rawRequest(server.port, '/%5f%5frealtime/pinned');
		expect(refused.status, 'the prerendered lane must not answer first').toBe(400);
		expect(refused.body).not.toContain('prerendered-inside-admin-prefix');
	}, 60000);

	it('leaves a target that resolves outside the prefix alone', async () => {
		// The check is about where a path ENDS UP, not about which characters
		// it contains. A dot segment that resolves somewhere ordinary is an
		// ordinary request, and a path that merely begins with the prefix TEXT
		// is a different path - refusing either would break working targets for
		// looking dangerous.
		//
		// The prefix-text cases carry a dot segment DELIBERATELY. Without one
		// the character scan short-circuits and the target never reaches the
		// prefix comparison at all, so a bare `/__realtime-docs/nope` would pass
		// whatever that comparison said - it would pin the scan, not the
		// boundary between `/__realtime/` and a longer name starting the same
		// way, which is the thing worth pinning.
		for (const target of [
			'/foo/../nope',
			'/foo/../__realtime-docs/nope',
			'/foo/../__realtimex',
			'/__realtime-docs/nope',
			'/nope.txt'
		]) {
			const served = await rawRequest(server.port, target);
			expect(served.status, `${target} must not be refused`).not.toBe(400);
			expect(served.body, `${target} must not reach the reserved namespace`)
				.not.toContain('appRouteReached');
		}
	}, 60000);

	it('serves the app the path it asked for when a dot segment resolves to a real route', async () => {
		// Vacuity guard for the case above: a dot segment on a target that
		// resolves to a route the app HAS is still served by that route, so the
		// refusals are the prefix rule firing and not dot segments dying at the
		// edge.
		const served = await rawRequest(server.port, '/anything/../ssr-echo');
		// `ssr-echo` answers POST only, so GET gets SvelteKit's 405 - which is
		// the app's ROUTER speaking, and that is the part being proved.
		expect(served.status, 'a resolved target must reach the app router').toBe(405);
	}, 60000);
	it.runIf(process.platform === 'win32')('refuses an encoded reserved prefix before an indexed Unicode tilde asset', async () => {
		const { cacheDir } = await import('./fixture/build-hook-crash/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build-hook-crash/handler/state.js');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-admin-tilde-'));
		const name = '\u00dcbersicht~v2.pdf';
		try {
			fs.writeFileSync(path.join(dir, name), 'indexed-inside-admin-prefix');
			cacheDir(dir, '/__realtime', false);
			expect(staticCache.get('/__realtime/' + name).buffer.toString()).toBe('indexed-inside-admin-prefix');
			const refused = await rawRequest(server.port, '/%5f%5frealtime/' + encodeURIComponent(name));
			expect(refused.status).toBe(400);
			expect(refused.body).toBe('Bad Request');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

});
