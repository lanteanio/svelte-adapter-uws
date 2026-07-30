import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createTrustedProxyMatcher, createClientIpResolver } from '../src/runtime/utils/trusted-proxies.js';

// - createTrustedProxyMatcher -----------------------------------------------

describe('createTrustedProxyMatcher', () => {
	it('returns null for an empty spec', () => {
		expect(createTrustedProxyMatcher('')).toBeNull();
		expect(createTrustedProxyMatcher('  ,  ')).toBeNull();
		expect(createTrustedProxyMatcher(undefined)).toBeNull();
	});

	it('matches an exact IPv4 address', () => {
		const m = createTrustedProxyMatcher('10.1.2.3');
		expect(m.match('10.1.2.3')).toBe(true);
		expect(m.match('10.1.2.4')).toBe(false);
	});

	it('matches an IPv4 CIDR range', () => {
		const m = createTrustedProxyMatcher('10.0.0.0/8');
		expect(m.match('10.255.0.1')).toBe(true);
		expect(m.match('11.0.0.1')).toBe(false);
	});

	it('matches an IPv4 /32 and /0', () => {
		expect(createTrustedProxyMatcher('192.168.1.1/32').match('192.168.1.1')).toBe(true);
		expect(createTrustedProxyMatcher('192.168.1.1/32').match('192.168.1.2')).toBe(false);
		expect(createTrustedProxyMatcher('0.0.0.0/0').match('203.0.113.9')).toBe(true);
	});

	it('matches an exact IPv6 address including compressed forms', () => {
		const m = createTrustedProxyMatcher('2001:db8::1');
		expect(m.match('2001:db8::1')).toBe(true);
		expect(m.match('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
		expect(m.match('2001:db8::2')).toBe(false);
	});

	it('matches an IPv6 CIDR range', () => {
		const m = createTrustedProxyMatcher('2001:db8::/32');
		expect(m.match('2001:db8:ffff::1')).toBe(true);
		expect(m.match('2001:db9::1')).toBe(false);
	});

	it('matches loopback ::1', () => {
		const m = createTrustedProxyMatcher('::1');
		expect(m.match('::1')).toBe(true);
		expect(m.match('::2')).toBe(false);
	});

	it('unwraps IPv4-mapped IPv6 socket addresses to match IPv4 entries', () => {
		const m = createTrustedProxyMatcher('10.0.0.0/8');
		expect(m.match('::ffff:10.1.2.3')).toBe(true);
		expect(m.match('::ffff:11.1.2.3')).toBe(false);
	});

	it('strips a zone id and brackets before matching', () => {
		const m = createTrustedProxyMatcher('fe80::/10');
		expect(m.match('fe80::1%eth0')).toBe(true);
		expect(m.match('[fe80::1]')).toBe(true);
	});

	it('accepts a comma-separated mixed list', () => {
		const m = createTrustedProxyMatcher('127.0.0.1, 10.0.0.0/8, ::1, 2001:db8::/32');
		expect(m.match('127.0.0.1')).toBe(true);
		expect(m.match('10.9.9.9')).toBe(true);
		expect(m.match('::1')).toBe(true);
		expect(m.match('2001:db8::42')).toBe(true);
		expect(m.match('8.8.8.8')).toBe(false);
	});

	it('throws on a malformed entry', () => {
		expect(() => createTrustedProxyMatcher('not-an-ip')).toThrow(/not a valid IP/);
		expect(() => createTrustedProxyMatcher('10.0.0.999')).toThrow(/not a valid IP/);
		expect(() => createTrustedProxyMatcher('10.0.0.0/33')).toThrow(/prefix length/);
		expect(() => createTrustedProxyMatcher('2001:db8::/129')).toThrow(/prefix length/);
		expect(() => createTrustedProxyMatcher('10.0.0.0/x')).toThrow(/prefix length/);
	});

	it('never matches garbage input', () => {
		const m = createTrustedProxyMatcher('10.0.0.0/8');
		expect(m.match('')).toBe(false);
		expect(m.match('banana')).toBe(false);
		expect(m.match(undefined)).toBe(false);
	});
});

// - createClientIpResolver (trust gating) -----------------------------------

describe('createClientIpResolver with TRUSTED_PROXIES', () => {
	const HEADERS = { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' };

	it('keeps legacy behavior when no matcher is configured', () => {
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher: null });
		expect(resolve('10.0.0.1', HEADERS)).toBe('203.0.113.5');
	});

	it('honors the header when the direct peer is trusted', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const onUntrusted = vi.fn();
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher, onUntrusted });
		expect(resolve('10.0.0.1', HEADERS, '10.0.0.1')).toBe('203.0.113.5');
		expect(onUntrusted).not.toHaveBeenCalled();
	});

	it('ignores the header and reports when the direct peer is untrusted', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const onUntrusted = vi.fn();
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher, onUntrusted });
		expect(resolve('198.51.100.7', HEADERS, '198.51.100.7')).toBe('198.51.100.7');
		expect(onUntrusted).toHaveBeenCalledWith('198.51.100.7');
	});

	it('decides trust on the DIRECT peer, not the effective address', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-real-ip', xffDepth: 1, matcher });
		// effective (PP2-substituted) address is public, but the socket peer is trusted
		expect(resolve('203.0.113.9', { 'x-real-ip': '198.51.100.1' }, '10.0.0.1')).toBe('198.51.100.1');
		// socket peer untrusted: the claim is ignored even though effective looks internal
		expect(resolve('10.0.0.9', { 'x-real-ip': '198.51.100.1' }, '203.0.113.9')).toBe('10.0.0.9');
	});

	// A non-XFF address header had no length bound at all, so a client could
	// name itself with kilobytes and have that string become its rate-limit
	// identity - one map entry per distinct value, each retaining the whole
	// header because split()/trim() hand back a view onto the parent. The
	// address is the short thing; the memory was in what it kept alive.
	it('bounds an over-long address header by truncating it', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-real-ip', xffDepth: 1, matcher });
		const padded = '198.51.100.1' + 'x'.repeat(4096);
		const got = resolve('10.0.0.9', { 'x-real-ip': padded }, '10.0.0.1');
		expect(got.length).toBeLessThanOrEqual(128);
		expect(got.startsWith('198.51.100.1')).toBe(true);
		// The bound is generous enough for every real single-address spelling,
		// including an expanded IPv6 with brackets, port and zone id.
		const widest = '[0000:0000:0000:0000:0000:ffff:255.255.255.255%eth0]:65535';
		expect(resolve('10.0.0.9', { 'x-real-ip': widest }, '10.0.0.1')).toBe(widest);
	});

	// Falling back to the socket address for an over-long value merged every
	// client behind one proxy into a single rate-limit identity. Some non-XFF
	// headers legitimately CHAIN - `x-original-forwarded-for` (ingress-nginx,
	// the GCP external LB) and RFC 7239 `Forwarded` - so a few IPv6 hops cross
	// any sane bound, and merging distinct clients is the worse error of the
	// two by the limiter's own stated rule.
	it('keeps distinct clients distinct behind a long chaining header', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-original-forwarded-for', xffDepth: 1, matcher });
		const tail = ', ' + Array.from({ length: 14 }, (_, i) => `10.1.${i}.1`).join(', ');
		const seen = new Set();
		let sampleLength = 0;
		for (let i = 0; i < 30; i++) {
			const header = `203.0.113.${i}${tail}`;
			if (i === 0) sampleLength = header.length;
			seen.add(resolve('10.0.0.9', { 'x-original-forwarded-for': header }, '10.0.0.1'));
		}
		expect(sampleLength, 'the fixture must actually exceed the bound').toBeGreaterThan(128);
		expect(seen.size, 'thirty clients must not collapse into one bucket').toBe(30);
	});

	// An over-long X-Forwarded-For used to answer the SOCKET address, which merges
	// every client behind one proxy into a single rate-limit identity - the exact
	// outcome the non-XFF branch of this resolver documents as unacceptable, and one
	// a client can force at will by padding a header it controls the head of.
	//
	// Every hop APPENDS to X-Forwarded-For, so the padding lands on the left and
	// the addresses `xffDepth` counts are on the right. Cutting the head keeps them.
	describe('an over-long x-forwarded-for keeps distinct clients distinct', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher });
		// Well past the 8192-character bound, with the real chain at the tail.
		const padding = `${'203.0.113.1, '.repeat(900)}`;

		it('still reads the depth-selected address rather than the socket peer', () => {
			const header = `${padding}198.51.100.42`;
			expect(header.length).toBeGreaterThan(8192);
			expect(resolve('10.0.0.9', { 'x-forwarded-for': header }, '10.0.0.1')).toBe('198.51.100.42');
		});

		it('keeps two padded clients on DIFFERENT identities', () => {
			// The property that matters. Under the old fall-back both of these
			// answered '10.0.0.9' and shared one bucket.
			const a = resolve('10.0.0.9', { 'x-forwarded-for': `${padding}198.51.100.42` }, '10.0.0.1');
			const b = resolve('10.0.0.9', { 'x-forwarded-for': `${padding}198.51.100.77` }, '10.0.0.1');
			expect(a).not.toBe(b);
			expect(a).toBe('198.51.100.42');
			expect(b).toBe('198.51.100.77');
		});

		it('honours a deeper xffDepth against a padded header', () => {
			const deep = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
			const header = `${padding}198.51.100.42, 10.9.9.9`;
			expect(deep('10.0.0.9', { 'x-forwarded-for': header }, '10.0.0.1')).toBe('198.51.100.42');
		});

		it('does not return a partial address cut by the bound', () => {
			// A cut landing mid-address leaves a fragment as the first element; it is
			// not an address and must not be counted by the depth.
			for (let pad = 8180; pad < 8200; pad++) {
				const header = `${'9'.repeat(pad)}, 198.51.100.42`;
				const got = resolve('10.0.0.9', { 'x-forwarded-for': header }, '10.0.0.1');
				expect(got, `pad=${pad}`).toBe('198.51.100.42');
			}
		});

		// THE SWEEP ABOVE PASSES WITH THE FRAGMENT GUARD DELETED, which is worth
		// stating rather than discovering twice: at depth 1 the selected element is
		// the LAST one, so a fragment sitting at index 0 is never read either way,
		// and dropping it changes nothing the sweep can see. The guard decides
		// exactly one shape - a depth reaching PAST the complete addresses onto the
		// fragment - and without this case nothing covers it.
		it('refuses the socket peer rather than counting the fragment as an address', () => {
			const deep = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher });
			// Exactly one complete address survives the cut, so depth 2 reaches the
			// fragment. Counted, it would answer a client-controlled run of nines as
			// a rate-limit identity.
			const header = `${'9'.repeat(9000)}, 198.51.100.42`;
			const got = deep('10.0.0.9', { 'x-forwarded-for': header }, '10.0.0.1');
			expect(got).toBe('10.0.0.9');
			expect(got).not.toMatch(/^9+$/);
		});
	});

	it('returns the same address value after detaching it from the header', () => {
		// The detach must be invisible in the VALUE - it changes only what the
		// string retains, so every existing trust decision still reads the same.
		// NOTE this assertion alone proves nothing about the detach: it passes
		// unchanged if `detachFromHeader` is reduced to `return value`. The
		// retention test below is the one that covers it.
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher });
		const chain = `203.0.113.7, ${'10.9.9.9, '.repeat(200)}198.51.100.42`;
		expect(resolve('10.0.0.9', { 'x-forwarded-for': chain }, '10.0.0.1')).toBe('198.51.100.42');
	});

	// The property the detach exists for, and the only assertion that can see
	// it. `split()` / `trim()` hand back a V8 SlicedString that keeps its PARENT
	// alive, so a short client address derived from a multi-kilobyte header pins
	// that whole header for as long as the rate-limit entry lives. That is
	// invisible to any value-based assertion, which is why this one measures
	// retained heap in a child process with gc exposed.
	it('does not retain the header the address was cut from', () => {
		const moduleUrl = new URL('../src/runtime/utils/trusted-proxies.js', import.meta.url).href;
		const child = `
			import { createClientIpResolver } from ${JSON.stringify(moduleUrl)};
			const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher: null });
			const PAD = 'x'.repeat(4000);
			const gc3 = () => { for (let i = 0; i < 3; i++) global.gc(); };
			gc3();
			const before = process.memoryUsage().heapUsed;
			const keep = new Map();
			for (let i = 0; i < 5000; i++) {
				keep.set(i, resolve('10.0.0.9', { 'x-forwarded-for': PAD + ', 10.0.0.1, 203.0.113.' + (i % 256) }, '10.0.0.1'));
			}
			gc3();
			const after = process.memoryUsage().heapUsed;
			if (keep.size !== 5000) throw new Error('sanity');
			console.log(String((after - before) / 1048576));
		`;
		const out = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', child], {
			encoding: 'utf8'
		});
		const retainedMb = Number(out.trim());
		expect(Number.isFinite(retainedMb), `child reported ${out}`).toBe(true);
		// 5000 detached addresses are a few hundred KB. Retaining the 4 KB
		// parents instead is ~20 MB, so this bound is far from either value and
		// is not a flaky threshold.
		expect(retainedMb, 'the address must not pin its 4 KB source header').toBeLessThan(8);
	});

	it('does not consult the matcher when the header is absent', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const onUntrusted = vi.fn();
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher, onUntrusted });
		expect(resolve('198.51.100.7', {}, '198.51.100.7')).toBe('198.51.100.7');
		expect(onUntrusted).not.toHaveBeenCalled();
	});

	it('keeps the XFF depth guard after the trust gate', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 5, matcher });
		// Fewer hops than the configured depth is a deployment mismatch, and the
		// socket peer is the only defensible answer: there is no address at that
		// position to read.
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1' }, '10.0.0.1')).toBe('10.0.0.1');
	});

	it('no longer falls back to the socket peer on a long header', () => {
		// This used to answer the socket address, which merged every client behind
		// the proxy. The header is now truncated at the head instead, so the depth
		// still selects a real forwarded address. See the describe block above for
		// the property that makes this matter.
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 5, matcher });
		const long = '1.2.3.4, '.repeat(1000);
		expect(long.length).toBeGreaterThan(8192);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': long }, '10.0.0.1')).toBe('1.2.3.4');
	});
});

// - PROXY protocol v2 (live binary behavior) ---------------------------------
// Locks the two facts resolveTransportAddress depends on: uWS parses a PP2
// preamble natively (getProxiedRemoteAddressAsText returns the claimed source
// address), and returns an empty string when no preamble was sent.

describe('uWS PROXY protocol v2 parsing (live)', () => {
	it('reports the PP2 source address, and empty without a preamble', async () => {
		const uWS = (await import('uWebSockets.js')).default;
		const net = await import('node:net');
		const td = new TextDecoder();

		/** @type {{ direct: string, proxied: string }[]} */
		const seen = [];
		const app = uWS.App().get('/*', (res) => {
			seen.push({
				direct: td.decode(res.getRemoteAddressAsText()),
				proxied: td.decode(res.getProxiedRemoteAddressAsText())
			});
			res.end('ok');
		});

		const token = await new Promise((resolve) => app.listen('127.0.0.1', 0, resolve));
		expect(token).toBeTruthy();
		const port = uWS.us_socket_local_port(token);

		const pp2 = (() => {
			const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
			const meta = Buffer.from([0x21, 0x11, 0x00, 0x0c]); // v2 PROXY, AF_INET/STREAM, len 12
			const addrs = Buffer.alloc(12);
			'203.0.113.99'.split('.').forEach((o, i) => addrs.writeUInt8(Number(o), i));
			'127.0.0.1'.split('.').forEach((o, i) => addrs.writeUInt8(Number(o), 4 + i));
			addrs.writeUInt16BE(51234, 8);
			addrs.writeUInt16BE(port, 10);
			return Buffer.concat([sig, meta, addrs]);
		})();

		const request = (prefix) => new Promise((resolve, reject) => {
			const sock = net.connect(port, '127.0.0.1', () => {
				if (prefix) sock.write(prefix);
				sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
			});
			sock.on('data', () => {});
			sock.on('end', resolve);
			sock.on('error', reject);
			sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
		});

		try {
			await request(null);
			await request(pp2);
		} finally {
			uWS.us_listen_socket_close(token);
		}

		expect(seen).toHaveLength(2);
		expect(seen[0].proxied).toBe('');
		expect(seen[1].direct === '127.0.0.1' || seen[1].direct === '::ffff:127.0.0.1').toBe(true);
		expect(seen[1].proxied).toBe('203.0.113.99');
	});
});
