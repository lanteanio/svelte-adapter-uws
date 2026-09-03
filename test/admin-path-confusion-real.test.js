// The path the router MATCHED and the path the admin handler is TOLD it
// received have to be the same path.
//
// WHY THIS EXISTS. The admin route is registered on the raw prefix
// (`/__realtime/*`) and uWS matches the raw request target, but building a Web
// `Request` NORMALIZES dot segments. So `GET /__realtime/../reflect` matched
// the admin route, reached `handleAdminRequest`, and handed the app's
// `admin(request)` a request whose pathname was `/reflect` - a path outside the
// prefix that was routed, and outside the namespace the handler's own dispatch
// and authorization are written against. Every decision such a handler makes
// reads that pathname, so it was deciding about a different path than the one
// the router had claimed. Two segments up (`/__realtime/a/../../escape`)
// reached it as `/escape`.
//
// The refusal is a 400 rather than a normalization, because a request whose
// route and whose self-description disagree is ambiguous: rewriting it would
// serve something other than what was asked for, and silently picking the
// prefix would let a caller aim the admin lane at an arbitrary path.
//
// RAW SOCKETS, NOT fetch(). Every HTTP client here normalizes the path before
// it goes out - `fetch('/__realtime/../reflect')` puts `/reflect` on the wire
// and never reaches the admin route at all, so a case written with it passes
// against the defect while testing nothing. The request line is written by
// hand for that reason.
//
// The fixture's `admin` echoes the pathname it was handed, so the assertion is
// what the APP SAW, not merely a status code.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * One request with the target written verbatim into the request line.
 * @param {number} port
 * @param {string} target
 */
function rawRequest(port, target) {
	return new Promise((resolve) => {
		let buf = '';
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
		});
		sock.setTimeout(5000, () => { sock.destroy(); resolve({ status: 0, body: '' }); });
		sock.on('data', (d) => { buf += d.toString(); });
		sock.on('close', () => {
			// The STATUS LINE first, then the code. uWS writes `HTTP/1.1 200`
			// with no reason phrase, so splitting the whole buffer on spaces
			// takes the first header line with it and yields NaN.
			const status = Number(buf.split('\r\n')[0].split(' ')[1] || 0);
			resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
		});
		sock.on('error', () => resolve({ status: 0, body: '' }));
	});
}

describeUWS('the admin route refuses a target that normalizes out of its prefix', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('hands the app the path that was routed, or refuses the request', async () => {
		// Vacuity guard: an ordinary admin target reaches the handler and the
		// handler reports the pathname it received. Without this the refusals
		// below could be a route that stopped working.
		const ok = await rawRequest(server.port, '/__realtime/introspect');
		expect(ok.status, 'an ordinary admin target must be served').toBe(200);
		expect(JSON.parse(ok.body).path, 'the handler must see the routed path')
			.toBe('/__realtime/introspect');

		// One segment up, and two. Both used to reach `admin()` describing
		// themselves as a path the router never matched.
		for (const target of ['/__realtime/../reflect', '/__realtime/a/../../escape', '/__realtime/./../escape']) {
			const refused = await rawRequest(server.port, target);
			expect(refused.status, `${target} must be refused`).toBe(400);
			expect(refused.body, `${target} must not reach the app handler`).not.toContain('"ok":true');
		}
	}, 60000);

	it('leaves a percent-encoded dot segment alone, because it is not one', async () => {
		// `..%2f` is a single opaque segment, not `..` plus a separator, so it
		// normalizes to nothing and keeps the prefix. Refusing it would break a
		// legitimate target for looking dangerous - the check is about where the
		// path ENDS UP, not about which characters it contains.
		const kept = await rawRequest(server.port, '/__realtime/..%2freflect');
		expect(kept.status).toBe(200);
		expect(JSON.parse(kept.body).path).toBe('/__realtime/..%2freflect');

		// A `..` inside a segment name is likewise not a dot segment.
		const inner = await rawRequest(server.port, '/__realtime/a..b');
		expect(inner.status).toBe(200);
		expect(JSON.parse(inner.body).path).toBe('/__realtime/a..b');
	}, 60000);

	it('keeps serving a target that normalizes but stays inside the prefix', async () => {
		// Normalization is not itself the fault. `/__realtime/a/../introspect`
		// resolves to `/__realtime/introspect`, which is still the routed
		// namespace, so it is served - and the handler is told the resolved
		// path, which is the one it should dispatch on.
		const inside = await rawRequest(server.port, '/__realtime/a/../introspect');
		expect(inside.status, 'normalizing within the prefix must still serve').toBe(200);
		expect(JSON.parse(inside.body).path).toBe('/__realtime/introspect');
	}, 60000);
});
