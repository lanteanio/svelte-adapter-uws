import { describe, it, expect, vi } from 'vitest';
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

	it('does not consult the matcher when the header is absent', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const onUntrusted = vi.fn();
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher, onUntrusted });
		expect(resolve('198.51.100.7', {}, '198.51.100.7')).toBe('198.51.100.7');
		expect(onUntrusted).not.toHaveBeenCalled();
	});

	it('keeps the XFF depth/length guards after the trust gate', () => {
		const matcher = createTrustedProxyMatcher('10.0.0.0/8');
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 5, matcher });
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1' }, '10.0.0.1')).toBe('10.0.0.1');
		const long = '1.2.3.4, '.repeat(1000);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': long }, '10.0.0.1')).toBe('10.0.0.1');
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
