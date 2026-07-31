// The per-class duplicate policy of the shared request-header collector.
//
// WHY THIS EXISTS. Header collection used to be `headers[key] = value` written
// out by hand at four entry points, which keeps the LAST line of a repeated
// header and drops every earlier one. A proxy that emits one X-Forwarded-For
// LINE per hop (HAProxy's `option forwardfor` does exactly that) therefore
// arrived as a single address, the configured hop depth found fewer addresses
// than hops, and the client-IP resolver fell back to the socket peer - every
// client behind that proxy sharing one rate-limit identity, through ordinary
// infrastructure rather than an attack.
//
// WHAT THIS SUITE COVERS, AND WHAT IT DOES NOT. This one pins the POLICY: which
// class a repeated header belongs to and what happens to it. It drives the
// collector with a stand-in request, so it says nothing about whether the
// production entry points call it. That half is `test/duplicate-headers.test.js`,
// which writes two identical header lines at a booted server over a socket.
// Both are needed: a policy nothing calls is dead, and a call site with the
// wrong policy is a new bug.

import { describe, it, expect, afterEach } from 'vitest';
import { collectRequestHeaders, declareSingleValuedProxyHeaders } from '../src/runtime/utils/request-headers.js';
import { createClientIpResolver, createTrustedProxyMatcher } from '../src/runtime/utils/trusted-proxies.js';

// The declared names are process state (the runtime declares them once at boot),
// so a case that declares must put them back or it configures every later case
// in the file.
afterEach(() => { declareSingleValuedProxyHeaders([]); });

/**
 * A stand-in for the uWS request whose only job is to replay header LINES in
 * arrival order, repeats included - the one thing an ordinary headers object
 * cannot represent.
 *
 * @param {Array<[string, string]>} lines
 */
function reqOf(lines) {
	return {
		/** @param {(key: string, value: string) => void} cb */
		forEach(cb) {
			for (const [key, value] of lines) cb(key, value);
		}
	};
}

/** @param {Array<[string, string]>} lines */
function collect(lines) {
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(reqOf(lines), headers);
	return { headers, ambiguous };
}

describe('collectRequestHeaders keeps every line of a repeated list header', () => {
	it('leaves a header that arrives once exactly as it came', () => {
		const { headers, ambiguous } = collect([
			['host', 'example.test'],
			['x-forwarded-for', '203.0.113.7'],
			['user-agent', 'probe/1']
		]);
		expect(ambiguous).toBe(null);
		expect(headers).toEqual({
			host: 'example.test',
			'x-forwarded-for': '203.0.113.7',
			'user-agent': 'probe/1'
		});
	});

	it('joins repeated x-forwarded-for lines in ARRIVAL order', () => {
		// Order is the whole point: the depth counts hops from the right, so a
		// reversed join would name the wrong hop as the client.
		const { headers, ambiguous } = collect([
			['x-forwarded-for', '203.0.113.7'],
			['x-forwarded-for', '10.0.0.9']
		]);
		expect(ambiguous).toBe(null);
		expect(headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.9');
	});

	it('joins three lines without losing the middle one', () => {
		const { headers } = collect([
			['x-forwarded-for', '203.0.113.7'],
			['x-forwarded-for', '10.0.0.9'],
			['x-forwarded-for', '10.0.0.10']
		]);
		expect(headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.9, 10.0.0.10');
	});

	it('treats an unenumerated vendor chain the same way', () => {
		// The list-header universe cannot be listed, so joining is the DEFAULT.
		// A chain nobody here has heard of must not lose hops either.
		for (const name of ['forwarded', 'via', 'accept-encoding', 'x-original-forwarded-for', 'x-vendor-hop-chain']) {
			const { headers, ambiguous } = collect([[name, 'first'], [name, 'second']]);
			expect(ambiguous, name).toBe(null);
			expect(headers[name], name).toBe('first, second');
		}
	});

	it('stores and joins a header whose name exists on Object.prototype', () => {
		// `constructor` reads back as an inherited function rather than
		// undefined, so a first sighting would look like a repeat without the
		// own-property check - and the value would be dropped or joined onto a
		// function.
		for (const name of ['constructor', 'valueOf', 'toString', 'hasownproperty']) {
			const once = collect([[name, 'only']]);
			expect(once.headers[name], name).toBe('only');
			const twice = collect([[name, 'a'], [name, 'b']]);
			expect(twice.headers[name], name).toBe('a, b');
			expect(twice.ambiguous, name).toBe(null);
		}
	});
});

describe('collectRequestHeaders applies the cookie rules', () => {
	it('joins repeated Cookie lines with "; ", never with a comma', () => {
		// Several Cookie lines are what an HTTP/2 to HTTP/1.1 downgrade at an
		// edge proxy produces. A comma join folds every later cookie into the
		// last one's VALUE, so the app sees one cookie with a corrupt value
		// instead of three cookies.
		const { headers, ambiguous } = collect([
			['cookie', 'session=abc'],
			['cookie', 'theme=dark'],
			['cookie', 'token=xyz']
		]);
		expect(ambiguous).toBe(null);
		expect(headers.cookie).toBe('session=abc; theme=dark; token=xyz');
		expect(headers.cookie).not.toContain(',');
	});

	it('keeps the first set-cookie line and never joins them', () => {
		// Not a list header - a comma is legal inside an Expires date - so a
		// join corrupts rather than concatenates. It means nothing on a request,
		// so the request is still served.
		const { headers, ambiguous } = collect([
			['set-cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
			['set-cookie', 'b=2']
		]);
		expect(ambiguous).toBe(null);
		expect(headers['set-cookie']).toBe('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
	});
});

describe('collectRequestHeaders refuses an ambiguous single-valued header', () => {
	// Framing, body parsing, identity, origin: whichever value this layer picked,
	// the proxy in front may have picked the other, and the two would then
	// disagree about where the request ends, how it parses, who sent it, or which
	// origin it claims. Merging is meaningless and picking is a security decision
	// made silently, so the request dies at the door.
	const REFUSED = [
		'host',
		'content-length',
		'transfer-encoding',
		'content-type',
		'authorization',
		'proxy-authorization',
		'origin'
	];

	for (const name of REFUSED) {
		it(`reports a repeated ${name}`, () => {
			const { ambiguous } = collect([[name, 'first'], [name, 'second']]);
			expect(ambiguous).toBe(name);
		});
	}

	it('accepts every one of them when it arrives once', () => {
		const { ambiguous } = collect(REFUSED.map((name) => /** @type {[string, string]} */ ([name, 'only'])));
		expect(ambiguous).toBe(null);
	});

	it('names the first offender and still finishes the walk', () => {
		// uWS offers no way to stop the iteration, so the caller must get a
		// complete object rather than a half-filled one - a caller that ignores
		// the finding must not also get truncated headers.
		const { headers, ambiguous } = collect([
			['host', 'a.test'],
			['host', 'b.test'],
			['content-length', '1'],
			['content-length', '2'],
			['accept', 'text/html']
		]);
		expect(ambiguous).toBe('host');
		expect(headers.accept).toBe('text/html');
		expect(headers.host).toBe('a.test');
	});

	it('keeps merging every other class after an offender is seen', () => {
		// The refusal is a FINDING about one header, not a mode switch. Stopping
		// the merge at the first offender would silently make every later
		// repeated header first-wins - a third policy nothing documents, and one
		// that reaches production the moment a caller treats the finding as
		// advisory rather than fatal.
		const { headers, ambiguous } = collect([
			['host', 'a.test'],
			['host', 'b.test'],
			['x-forwarded-for', '203.0.113.7'],
			['x-forwarded-for', '10.0.0.9'],
			['cookie', 'session=abc'],
			['cookie', 'theme=dark']
		]);
		expect(ambiguous).toBe('host');
		expect(headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.9');
		expect(headers.cookie).toBe('session=abc; theme=dark');
	});
});

describe('collectRequestHeaders keeps the last line of a single-valued proxy header', () => {
	// A joined value here is not a longer version of the same thing, it is the
	// wrong SHAPE: one scheme, one external host, one external port, one client
	// address are what these carry and what the runtime parses back out. The
	// last line is the proxy's, because the hop in front appends.

	it('answers one scheme for two x-forwarded-proto lines', () => {
		// Two `https` lines joined read "https, https", which the origin builder
		// rejects as not a protocol - it throws, and every request of a
		// deployment configured exactly as documented is answered 500 (SSR) or
		// hangs (auth preflight, before its guard).
		const { headers, ambiguous } = collect([
			['x-forwarded-proto', 'https'],
			['x-forwarded-proto', 'https']
		]);
		expect(ambiguous).toBe(null);
		expect(headers['x-forwarded-proto']).toBe('https');
	});

	it('answers one host and one port for repeated forwarding lines', () => {
		// "a.test, a.test" builds a request URL the WHATWG parser refuses
		// outright, and "443, 443" is not a number.
		const { headers } = collect([
			['x-forwarded-host', 'a.test'],
			['x-forwarded-host', 'a.test'],
			['x-forwarded-port', '443'],
			['x-forwarded-port', '443']
		]);
		expect(headers['x-forwarded-host']).toBe('a.test');
		expect(headers['x-forwarded-port']).toBe('443');
	});

	it('keeps the proxy line of a repeated single-address header', () => {
		// The client's line comes first because the proxy APPENDS, so last-wins
		// is what makes the proxy's claim the surviving one.
		for (const name of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'fly-client-ip']) {
			const { headers, ambiguous } = collect([[name, '9.9.9.9'], [name, '203.0.113.5']]);
			expect(ambiguous, name).toBe(null);
			expect(headers[name], name).toBe('203.0.113.5');
		}
	});

	it('applies the same rule to a header name only this deployment knows', () => {
		// PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER / ADDRESS_HEADER are
		// operator-chosen, so the class cannot be read off the name. The runtime
		// declares them at boot.
		declareSingleValuedProxyHeaders(['x-scheme', 'x-vhost', undefined, '']);
		const { headers } = collect([
			['x-scheme', 'https'],
			['x-scheme', 'https'],
			['x-vhost', 'a.test'],
			['x-vhost', 'a.test']
		]);
		expect(headers['x-scheme']).toBe('https');
		expect(headers['x-vhost']).toBe('a.test');
	});

	it('still joins x-forwarded-for when it is the declared name', () => {
		// `ADDRESS_HEADER=x-forwarded-for` is the documented configuration and
		// the whole reason the join exists: putting it into the last-line class
		// would delete the fix for exactly the deployment that needs it. It is
		// the ONE name a declaration cannot move, because it is the one name the
		// resolver has a chain branch for.
		declareSingleValuedProxyHeaders(['x-forwarded-for']);
		const { headers } = collect([['x-forwarded-for', 'first'], ['x-forwarded-for', 'second']]);
		expect(headers['x-forwarded-for']).toBe('first, second');
	});

	it('claims a declared vendor CHAIN too, because the resolver reads it as one address', () => {
		// The header's own grammar does not decide the class - what parses the
		// value does. `x-original-forwarded-for`, `forwarded` and `via` chain,
		// but the resolver routes only the literal `x-forwarded-for` to its
		// depth branch, so a deployment naming one of these as ADDRESS_HEADER
		// hands a JOINED value to the single-address branch, which truncates
		// keeping the LEADING - client-authored - bytes.
		for (const name of ['forwarded', 'x-original-forwarded-for', 'via']) {
			declareSingleValuedProxyHeaders([name]);
			const { headers } = collect([[name, 'first'], [name, 'second']]);
			expect(headers[name], name).toBe('second');
		}
	});

	it('leaves a vendor chain joined when it is NOT the declared name', () => {
		// The rule costs those names nothing anywhere else: an app reading a
		// vendor chain off the header bag still sees every hop, and declaring
		// one name never reclassifies another.
		declareSingleValuedProxyHeaders(['x-forwarded-for']);
		for (const name of ['forwarded', 'x-original-forwarded-for', 'via']) {
			const { headers } = collect([[name, 'first'], [name, 'second']]);
			expect(headers[name], name).toBe('first, second');
		}
	});

	it('forgets a declaration when a later one replaces it', () => {
		declareSingleValuedProxyHeaders(['x-scheme']);
		declareSingleValuedProxyHeaders(['x-vhost']);
		expect(collect([['x-scheme', 'a'], ['x-scheme', 'b']]).headers['x-scheme']).toBe('a, b');
		expect(collect([['x-vhost', 'a'], ['x-vhost', 'b']]).headers['x-vhost']).toBe('b');
		// The well-known spellings are not a declaration and survive every one.
		expect(collect([['x-real-ip', 'a'], ['x-real-ip', 'b']]).headers['x-real-ip']).toBe('b');
	});

	it('does not let a declaration override the refused class', () => {
		declareSingleValuedProxyHeaders(['host', 'authorization']);
		expect(collect([['host', 'a.test'], ['host', 'b.test']]).ambiguous).toBe('host');
		expect(collect([['authorization', 'a'], ['authorization', 'b']]).ambiguous).toBe('authorization');
	});
});

describe('the collected chain is what the client-IP resolver counts hops in', () => {
	// The live consequence the collector exists for. A two-hop path behind a
	// proxy that emits one line per hop must resolve to the client, not to the
	// socket peer that every client behind that proxy shares.
	const matcher = createTrustedProxyMatcher('10.0.0.0/8');

	it('finds both hops of a two-line X-Forwarded-For at depth 2', () => {
		const { headers } = collect([
			['x-forwarded-for', '203.0.113.7'],
			['x-forwarded-for', '10.0.0.9']
		]);
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
		expect(resolve('10.0.0.1', headers, '10.0.0.1')).toBe('203.0.113.7');
	});

	it('keeps distinct clients distinct across one-line-per-hop proxies', () => {
		// Last-wins collection answered the socket peer for all of these, which
		// is one rate-limit identity for every client behind the proxy.
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
		const seen = new Set();
		for (let i = 0; i < 20; i++) {
			const { headers } = collect([
				['x-forwarded-for', `203.0.113.${i}`],
				['x-forwarded-for', '10.0.0.9']
			]);
			seen.add(resolve('10.0.0.1', headers, '10.0.0.1'));
		}
		expect(seen.size).toBe(20);
	});

	it('resolves a repeated single-address header to the proxy line, not the client one', () => {
		// The other half of the resolver, and the one a policy that joined
		// EVERYTHING would break. `x-real-ip` reaches the non-chain branch,
		// which takes the value verbatim and - over its 128-character bound -
		// truncates keeping the LEADING bytes, deliberately, because for a
		// single-address header the leading bytes are the proxy's. Join the
		// lines and the leading bytes become the CLIENT'S: padding the header
		// past the bound then decides the rate-limit key and
		// `getClientAddress()` outright, rotating it to defeat the per-address
		// limiter or pinning it to spend a victim's budget.
		const padded = 'x'.repeat(130);
		const { headers } = collect([['x-real-ip', padded], ['x-real-ip', '203.0.113.5']]);
		const resolve = createClientIpResolver({ addressHeader: 'x-real-ip', xffDepth: 1, matcher });
		expect(headers['x-real-ip']).toBe('203.0.113.5');
		expect(resolve('10.0.0.1', headers, '10.0.0.1')).toBe('203.0.113.5');
	});

	it('resolves a repeated declared address header the same way', () => {
		// Same defect through an operator-chosen ADDRESS_HEADER name, which no
		// well-known list can contain.
		declareSingleValuedProxyHeaders(['x-house-client-ip']);
		const { headers } = collect([
			['x-house-client-ip', 'y'.repeat(130)],
			['x-house-client-ip', '203.0.113.6']
		]);
		const resolve = createClientIpResolver({ addressHeader: 'x-house-client-ip', xffDepth: 1, matcher });
		expect(resolve('10.0.0.1', headers, '10.0.0.1')).toBe('203.0.113.6');
	});

	it('resolves a declared vendor CHAIN to the proxy line, padding and all', () => {
		// The same identity attack through a chain-named ADDRESS_HEADER. These
		// three names read as chains, so a policy that classified on grammar
		// kept joining them - but `createClientIpResolver` compares the
		// configured name against the literal 'x-forwarded-for' and sends
		// everything else to the single-address branch, which truncates keeping
		// the LEADING bytes. Joined, those bytes are the client's padding, so
		// the resolved address, the per-address upgrade limiter's key and
		// `getClientAddress()` all became a string the client chose - rotatable
		// to defeat the limiter, or pinnable to spend a victim's budget.
		// ingress-nginx and the GCP external LB emit `x-original-forwarded-for`
		// and RFC 7239 defines `Forwarded`, so this is a configuration an
		// operator reaches by reading their own proxy's documentation.
		for (const name of ['x-original-forwarded-for', 'forwarded', 'via']) {
			declareSingleValuedProxyHeaders([name]);
			const { headers } = collect([[name, 'x'.repeat(130)], [name, '203.0.113.5']]);
			const resolve = createClientIpResolver({ addressHeader: name, xffDepth: 1, matcher });
			expect(headers[name], name).toBe('203.0.113.5');
			expect(resolve('10.0.0.1', headers, '10.0.0.1'), name).toBe('203.0.113.5');
		}
	});

	it('resolves an unpadded declared vendor chain to an address, not to a list', () => {
		// The half of the same defect that needs no attacker: joined, the
		// resolver answered the literal string '9.9.9.9, 203.0.113.5', which is
		// not an address and is what `getClientAddress()` handed the app.
		for (const name of ['x-original-forwarded-for', 'forwarded', 'via']) {
			declareSingleValuedProxyHeaders([name]);
			const { headers } = collect([[name, '9.9.9.9'], [name, '203.0.113.5']]);
			const resolve = createClientIpResolver({ addressHeader: name, xffDepth: 1, matcher });
			expect(resolve('10.0.0.1', headers, '10.0.0.1'), name).toBe('203.0.113.5');
		}
	});

	it('keeps counting hops in a declared x-forwarded-for', () => {
		// The exception the last-line class makes for the one name the resolver
		// understands, driven through the configuration that names it.
		declareSingleValuedProxyHeaders(['x-forwarded-for']);
		const { headers } = collect([
			['x-forwarded-for', '203.0.113.7'],
			['x-forwarded-for', '10.0.0.9']
		]);
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
		expect(resolve('10.0.0.1', headers, '10.0.0.1')).toBe('203.0.113.7');
	});

	it('still answers the socket peer when the chain is shorter than the depth', () => {
		// Correct collection removes the infrastructure route into this branch;
		// what remains is a request that did not traverse the configured chain
		// (where the socket peer IS the client) or a depth naming more hops than
		// exist. The leftmost address is client-authored by construction, so
		// taking it would let any client name its own rate-limit identity.
		const { headers } = collect([['x-forwarded-for', '203.0.113.7']]);
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
		expect(resolve('10.0.0.1', headers, '10.0.0.1')).toBe('10.0.0.1');
	});
});
