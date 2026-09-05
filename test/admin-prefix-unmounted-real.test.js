// Without the admin mount there is no reservation, so nothing is refused.
//
// WHY THIS EXISTS. The main request edge refuses a target whose raw spelling is
// outside `/__realtime` and whose resolved form is inside it. What makes that
// refusal correct is the MOUNT: the admin route is what claims the prefix, and
// it is only registered when the app's WS handler exports `admin()`. An app
// without one owns the prefix like any other path - this fixture serves a real
// route there - and refusing the resolved spelling would take away a path the
// app is serving, for a lane that does not exist on this instance.
//
// Nothing else can fail if that condition is dropped: every suite that exercises
// the refusal boots a variant WITH an admin handler, so the check would still
// look right while quietly answering 400 for an app route. This is the case
// that fails instead.
//
// RAW SOCKETS, NOT fetch(). Every HTTP client resolves the target before it
// goes out, so the unresolved spelling never reaches the wire otherwise.
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
			const status = Number(buf.split('\r\n')[0].split(' ')[1] || 0);
			resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
		});
		sock.on('error', () => resolve({ status: 0, body: '' }));
	});
}

describeUWS('the admin prefix with no admin handler to mount', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		// The default fixture handler exports no `admin`, so handler.js never
		// registers the route and the prefix is the app's.
		server = await startRealRuntime({ variant: 'default' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('serves the app route inside the prefix, spelled directly', async () => {
		const direct = await rawRequest(server.port, '/__realtime/introspect');
		expect(direct.status).toBe(200);
		expect(JSON.parse(direct.body).appRouteReached).toBe(true);
	}, 60000);

	it('serves the prerendered page inside the prefix, by both spellings', async () => {
		// This is the half admin-prefix-entry-real.test.js cannot prove. Its
		// ordering case asserts that the ENCODED spelling of this page is
		// refused before the prerendered lookup can answer it - which says
		// nothing unless the page is really in the prerendered map. Here there
		// is no mount to shadow it, so both spellings reach the lookup and the
		// marker comes back: the page exists, the lookup decodes, and therefore
		// the refusal over there is the ordering and not an empty map.
		const direct = await rawRequest(server.port, '/__realtime/pinned');
		expect(direct.status).toBe(200);
		expect(direct.body, 'the page must be prerendered and served')
			.toContain('prerendered-inside-admin-prefix');

		const encoded = await rawRequest(server.port, '/%5f%5frealtime/pinned');
		expect(encoded.status, 'the prerendered lookup decodes the target').toBe(200);
		expect(encoded.body, 'so the encoded spelling reaches the same page')
			.toContain('prerendered-inside-admin-prefix');
	}, 60000);

	it('serves the same route through a target that resolves into the prefix', async () => {
		// The refusal is about a target reaching a lane its raw form did not
		// choose. Here both spellings choose the app, so there is no
		// disagreement to refuse - and the app is told the resolved path, the
		// same one the direct spelling gives it.
		const resolvedIn = await rawRequest(server.port, '/foo/../__realtime/introspect');
		expect(resolvedIn.status, 'no mount means nothing to refuse').toBe(200);
		const body = JSON.parse(resolvedIn.body);
		expect(body.appRouteReached).toBe(true);
		expect(body.path).toBe('/__realtime/introspect');
	}, 60000);
});
