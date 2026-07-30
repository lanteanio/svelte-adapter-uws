import { describe, it, expect } from 'vitest';
import { isSafeUrl, checkUrl, checkUrlResolved, classifyAddress, isAddressSafe } from '../src/safe-url.js';

describe('safe-url: blocked ranges (strict mode, the zero-config default)', () => {
	it('blocks IPv4 loopback 127.0.0.0/8 and allows the just-outside member', () => {
		expect(checkUrl('http://127.0.0.1/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://127.255.255.254/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://128.0.0.1/')).toEqual({ safe: true });
	});

	it('blocks the unspecified 0.0.0.0/8 range', () => {
		expect(checkUrl('http://0.0.0.0/')).toEqual({ safe: false, reason: 'unspecified' });
		expect(checkUrl('http://0.1.2.3/')).toEqual({ safe: false, reason: 'unspecified' });
	});

	it('blocks IPv4 link-local 169.254.0.0/16 and allows the just-outside member', () => {
		expect(checkUrl('http://169.254.0.1/')).toEqual({ safe: false, reason: 'link-local' });
		expect(checkUrl('http://169.255.0.1/')).toEqual({ safe: true });
	});

	it('blocks the cloud-metadata IP 169.254.169.254 with a distinct reason', () => {
		expect(checkUrl('http://169.254.169.254/')).toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/'))
			.toEqual({ safe: false, reason: 'metadata' });
	});

	it('blocks RFC1918 10.0.0.0/8', () => {
		expect(checkUrl('http://10.0.0.1/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://10.255.255.255/')).toEqual({ safe: false, reason: 'rfc1918' });
	});

	it('blocks RFC1918 172.16.0.0/12 across its full extent and allows just outside', () => {
		expect(checkUrl('http://172.16.0.1/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://172.31.255.255/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://172.15.0.1/')).toEqual({ safe: true });
		expect(checkUrl('http://172.32.0.1/')).toEqual({ safe: true });
	});

	it('blocks RFC1918 192.168.0.0/16 and allows just outside', () => {
		expect(checkUrl('http://192.168.1.1/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://192.169.0.1/')).toEqual({ safe: true });
	});

	it('blocks RFC 6598 CGNAT 100.64.0.0/10 across its full extent and allows just outside', () => {
		// Alibaba Cloud's instance metadata lives inside this range.
		expect(checkUrl('http://100.100.100.200/latest/meta-data/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://100.64.0.0/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://100.64.0.1/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://100.127.255.254/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://100.127.255.255/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://100.63.255.255/')).toEqual({ safe: true });
		expect(checkUrl('http://100.128.0.0/')).toEqual({ safe: true });
	});

	it('blocks the special-purpose 198.18.0.0/15, 224.0.0.0/4 and 240.0.0.0/4 ranges', () => {
		expect(checkUrl('http://198.18.0.1/')).toEqual({ safe: false, reason: 'benchmark' });
		expect(checkUrl('http://198.19.255.255/')).toEqual({ safe: false, reason: 'benchmark' });
		expect(checkUrl('http://198.17.0.1/')).toEqual({ safe: true });
		expect(checkUrl('http://198.20.0.1/')).toEqual({ safe: true });
		expect(checkUrl('http://224.0.0.1/')).toEqual({ safe: false, reason: 'multicast' });
		expect(checkUrl('http://239.255.255.255/')).toEqual({ safe: false, reason: 'multicast' });
		expect(checkUrl('http://240.0.0.1/')).toEqual({ safe: false, reason: 'reserved' });
		expect(checkUrl('http://255.255.255.255/')).toEqual({ safe: false, reason: 'reserved' });
	});

	it('blocks the CGNAT range through IPv4-mapped IPv6 and obfuscated IPv4 forms', () => {
		expect(checkUrl('http://[::ffff:100.100.100.200]/')).toEqual({ safe: false, reason: 'cgnat' });
		expect(checkUrl('http://[::ffff:6464:64c8]/')).toEqual({ safe: false, reason: 'cgnat' });
		// 100.100.100.200 as a bare decimal integer.
		expect(checkUrl('http://1684301000/')).toEqual({ safe: false, reason: 'cgnat' });
	});

	it('blocks the localhost hostname (and the trailing-dot / cased forms)', () => {
		expect(checkUrl('http://localhost/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://LOCALHOST/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://localhost./')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://LocalHost.:8080/admin')).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks the GCP metadata hostname', () => {
		expect(checkUrl('http://metadata.google.internal/computeMetadata/v1/'))
			.toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://METADATA.GOOGLE.INTERNAL/'))
			.toEqual({ safe: false, reason: 'metadata' });
	});
});

describe('safe-url: blocked IPv6 ranges', () => {
	it('blocks IPv6 loopback ::1 (in any spelling)', () => {
		expect(checkUrl('http://[::1]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[0:0:0:0:0:0:0:1]/')).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks the IPv6 unspecified address ::', () => {
		expect(checkUrl('http://[::]/')).toEqual({ safe: false, reason: 'unspecified' });
	});

	it('blocks IPv6 ULA fc00::/7 (both fc00::/8 and fd00::/8) and allows just outside', () => {
		expect(checkUrl('http://[fc00::1]/')).toEqual({ safe: false, reason: 'ula' });
		expect(checkUrl('http://[fd00::1]/')).toEqual({ safe: false, reason: 'ula' });
		expect(checkUrl('http://[fdff:ffff::1]/')).toEqual({ safe: false, reason: 'ula' });
		expect(checkUrl('http://[fe00::1]/')).toEqual({ safe: true });
	});

	it('blocks IPv6 link-local fe80::/10', () => {
		expect(checkUrl('http://[fe80::1]/')).toEqual({ safe: false, reason: 'link-local' });
		expect(checkUrl('http://[febf:ffff::1]/')).toEqual({ safe: false, reason: 'link-local' });
		// fec0::/10 is outside link-local, but it is deprecated site-local
		// (RFC 3879) - still routed on plenty of internal networks and never a
		// public destination, so it is blocked under its own reason rather
		// than being treated as an ordinary global address.
		expect(checkUrl('http://[fec0::1]/')).toEqual({ safe: false, reason: 'ula' });
		expect(checkUrl('http://[2606:4700:4700::1111]/')).toEqual({ safe: true });
	});

	it('blocks the IPv6 cloud-metadata form fd00:ec2::254 with a distinct reason', () => {
		expect(checkUrl('http://[fd00:ec2::254]/')).toEqual({ safe: false, reason: 'metadata' });
	});

	it('allows a public IPv6 literal', () => {
		expect(checkUrl('http://[2001:db8::1]/')).toEqual({ safe: true });
		expect(checkUrl('http://[2606:4700:4700::1111]/')).toEqual({ safe: true });
	});

	it('returns parse-error for a malformed bracketed literal', () => {
		expect(checkUrl('http://[not:valid:ipv6:::::]/').safe).toBe(false);
	});
});

describe('safe-url: IPv4-embedding transition mechanisms (NAT64 / 6to4 / Teredo)', () => {
	it('blocks NAT64 64:ff9b::/96 (RFC 6052) wrapping a private / metadata / loopback IPv4', () => {
		expect(checkUrl('http://[64:ff9b::a9fe:a9fe]/')).toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://[64:ff9b::169.254.169.254]/')).toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://[64:ff9b::7f00:1]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[64:ff9b::127.0.0.1]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[64:ff9b::a00:1]/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://[64:ff9b::c0a8:101]/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://[64:ff9b::6464:64c8]/')).toEqual({ safe: false, reason: 'cgnat' });
	});

	it('allows a NAT64-wrapped genuinely public IPv4 (64:ff9b::0808:0808 = 8.8.8.8)', () => {
		expect(checkUrl('http://[64:ff9b::0808:0808]/')).toEqual({ safe: true });
		expect(checkUrl('http://[64:ff9b::8.8.8.8]/')).toEqual({ safe: true });
	});

	it('blocks the NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215, RFC 6052 /48 layout)', () => {
		// For the /48 layout the IPv4 address is split around the reserved
		// u-octet: high 16 bits in group 3, u-octet in the high byte of group
		// 4, low 16 bits in the low byte of group 4 plus the high byte of
		// group 5. See nat64LocalUse48() below for the encoder these follow.
		// 64:ff9b:1:7f00:0:100:: embeds 127.0.0.1.
		expect(checkUrl('http://[64:ff9b:1:7f00:0:100::]/')).toEqual({ safe: false, reason: 'loopback' });
		// 64:ff9b:1:a9fe:a9:fe00:: embeds 169.254.169.254.
		expect(checkUrl('http://[64:ff9b:1:a9fe:a9:fe00::]/')).toEqual({ safe: false, reason: 'metadata' });
		// 64:ff9b:1:a00:0:100:: embeds 10.0.0.1.
		expect(checkUrl('http://[64:ff9b:1:a00:0:100::]/')).toEqual({ safe: false, reason: 'rfc1918' });
		// 64:ff9b:1:c0a8:0:100:: embeds 192.168.0.1 - the vector a contiguous
		// 32-bit read let through as public.
		expect(checkUrl('http://[64:ff9b:1:c0a8:0:100::]/')).toEqual({ safe: false, reason: 'rfc1918' });
		// 64:ff9b:1::7f00:1 has an all-zero /48 field with address bits after it, so
		// its /48 reading is 0.0.0.0 and is skipped as padding; its /96 reading is
		// 127.0.0.1, which is what the address means.
		expect(checkUrl('http://[64:ff9b:1::7f00:1]/')).toEqual({ safe: false, reason: 'loopback' });
		// 64:ff9b:1:808:8:800:: embeds the public 8.8.8.8 - allowed.
		expect(checkUrl('http://[64:ff9b:1:808:8:800::]/')).toEqual({ safe: true });
	});

	it('blocks 6to4 2002::/16 wrapping a private IPv4 (embedded in groups 1-2)', () => {
		expect(checkUrl('http://[2002:7f00:1::]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[2002:a9fe:a9fe::]/')).toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://[2002:a00:1::]/')).toEqual({ safe: false, reason: 'rfc1918' });
		// 2002:808:808:: embeds the public 8.8.8.8 - allowed.
		expect(checkUrl('http://[2002:808:808::]/')).toEqual({ safe: true });
	});

	it('blocks Teredo 2001::/32 outright as reserved (XOR-obfuscated embedded IPv4)', () => {
		expect(checkUrl('http://[2001:0::7f00:1]/')).toEqual({ safe: false, reason: 'reserved' });
		expect(checkUrl('http://[2001::]/')).toEqual({ safe: false, reason: 'reserved' });
		// 2001:db8::/32 (documentation) is NOT Teredo and stays public.
		expect(checkUrl('http://[2001:db8::1]/')).toEqual({ safe: true });
	});
});

describe('safe-url: IP-obfuscation evasions normalise to the same block', () => {
	it('blocks the decimal-integer encoding of 127.0.0.1', () => {
		expect(checkUrl('http://2130706433/')).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks the hex encodings of 127.0.0.1', () => {
		expect(checkUrl('http://0x7f000001/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://0x7f.0.0.1/')).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks the octal encoding of 127.0.0.1', () => {
		expect(checkUrl('http://0177.0.0.1/')).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks short-form IPv4 (127.1 -> 127.0.0.1)', () => {
		expect(checkUrl('http://127.1/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://10.1/')).toEqual({ safe: false, reason: 'rfc1918' });
	});

	it('blocks IPv4-mapped IPv6 forms - the metadata IP cannot be smuggled', () => {
		expect(checkUrl('http://[::ffff:169.254.169.254]/')).toEqual({ safe: false, reason: 'metadata' });
		expect(checkUrl('http://[::ffff:127.0.0.1]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[::ffff:192.168.1.1]/')).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl('http://[::ffff:a9fe:a9fe]/')).toEqual({ safe: false, reason: 'metadata' });
	});

	it('blocks IPv4-compatible IPv6 forms (::a.b.c.d)', () => {
		expect(checkUrl('http://[::127.0.0.1]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://[::169.254.169.254]/')).toEqual({ safe: false, reason: 'metadata' });
	});

	it('defeats userinfo smuggling (host is the real authority, not the userinfo)', () => {
		expect(checkUrl('http://expected.com@127.0.0.1/')).toEqual({ safe: false, reason: 'loopback' });
		expect(checkUrl('http://user:pass@10.0.0.5/')).toEqual({ safe: false, reason: 'rfc1918' });
	});

	it('normalises the trailing dot on a numeric host', () => {
		expect(checkUrl('http://127.0.0.1./')).toEqual({ safe: false, reason: 'loopback' });
	});
});

describe('safe-url: scheme gate', () => {
	it('rejects non-http(s) schemes with reason bad-scheme', () => {
		expect(checkUrl('file:///etc/passwd')).toEqual({ safe: false, reason: 'bad-scheme' });
		expect(checkUrl('gopher://example.com/')).toEqual({ safe: false, reason: 'bad-scheme' });
		expect(checkUrl('ftp://example.com/')).toEqual({ safe: false, reason: 'bad-scheme' });
		expect(checkUrl('data:text/plain,hi')).toEqual({ safe: false, reason: 'bad-scheme' });
		expect(checkUrl('redis://example.com:6379')).toEqual({ safe: false, reason: 'bad-scheme' });
	});

	it('admits http: and https: to the host checks', () => {
		expect(checkUrl('http://example.com/')).toEqual({ safe: true });
		expect(checkUrl('https://example.com/')).toEqual({ safe: true });
	});
});

describe('safe-url: parse handling never throws', () => {
	it('returns { safe: false, reason: parse-error } for an unparseable URL', () => {
		expect(checkUrl('not a url')).toEqual({ safe: false, reason: 'parse-error' });
		expect(isSafeUrl('not a url')).toBe(false);
		expect(isSafeUrl('')).toBe(false);
	});

	it('isSafeUrl mirrors checkUrl().safe', () => {
		expect(isSafeUrl('http://127.0.0.1/')).toBe(false);
		expect(isSafeUrl('http://example.com/')).toBe(true);
	});
});

describe('safe-url: public passthrough', () => {
	it('allows ordinary public hosts and IPs', () => {
		expect(checkUrl('https://example.com/webhook')).toEqual({ safe: true });
		expect(checkUrl('http://8.8.8.8/')).toEqual({ safe: true });
		expect(checkUrl('https://hooks.partner.com/abc')).toEqual({ safe: true });
	});
});

describe('safe-url: mode = allowlist', () => {
	it('passes only allowlisted hosts and blocks other public hosts', () => {
		const opts = { mode: 'allowlist', allow: ['ok.com', 'api.acme.io'] };
		expect(checkUrl('https://ok.com/hook', opts)).toEqual({ safe: true });
		expect(checkUrl('https://api.acme.io/hook', opts)).toEqual({ safe: true });
		expect(checkUrl('https://other.com/hook', opts)).toEqual({ safe: false, reason: 'not-allowlisted' });
	});

	it('matches allow entries case-insensitively and ignores a trailing dot', () => {
		const opts = { mode: 'allowlist', allow: ['OK.com.'] };
		expect(checkUrl('https://ok.com/hook', opts)).toEqual({ safe: true });
	});

	it('does NOT let an allowlist re-open a private range (SSRF ranges win)', () => {
		const opts = { mode: 'allowlist', allow: ['localhost'] };
		expect(checkUrl('http://localhost/', opts)).toEqual({ safe: false, reason: 'loopback' });
		const opts2 = { mode: 'allowlist', allow: ['10.0.0.5'] };
		expect(checkUrl('http://10.0.0.5/', opts2)).toEqual({ safe: false, reason: 'rfc1918' });
	});
});

describe('safe-url: mode = off', () => {
	it('returns true for any parseable http(s) URL, including a private IP', () => {
		expect(checkUrl('http://127.0.0.1/', { mode: 'off' })).toEqual({ safe: true });
		expect(checkUrl('http://169.254.169.254/', { mode: 'off' })).toEqual({ safe: true });
		expect(isSafeUrl('http://10.0.0.1/', { mode: 'off' })).toBe(true);
	});

	it('still enforces the http(s) scheme gate (off relaxes ranges, not the scheme)', () => {
		expect(checkUrl('file:///etc/passwd', { mode: 'off' })).toEqual({ safe: false, reason: 'bad-scheme' });
	});

	it('does NOT block a DNS name resolving to a private IP - matching the literal-IP behaviour', async () => {
		let called = false;
		const r = await checkUrlResolved('http://rebind.test/', {
			mode: 'off',
			resolve: async () => { called = true; return '127.0.0.1'; }
		});
		expect(r).toEqual({ safe: true });
		expect(called).toBe(false);
	});
});

describe('safe-url: checkUrlResolved (DNS-rebinding closer)', () => {
	it('blocks a public-looking name that resolves to a private address', async () => {
		const r = await checkUrlResolved('http://rebind.test/', { resolve: async () => '127.0.0.1' });
		expect(r).toEqual({ safe: false, reason: 'loopback' });
	});

	it('blocks when the name resolves to the metadata IP', async () => {
		const r = await checkUrlResolved('http://innocent.example/', {
			resolve: async () => ['203.0.113.10', '169.254.169.254']
		});
		expect(r).toEqual({ safe: false, reason: 'metadata' });
	});

	it('blocks when the name resolves into CGNAT or Alibaba metadata space', async () => {
		const r = await checkUrlResolved('http://innocent.example/', {
			resolve: async () => ['203.0.113.10', '100.100.100.200']
		});
		expect(r).toEqual({ safe: false, reason: 'cgnat' });
	});

	it('allows a name that resolves only to public addresses', async () => {
		const r = await checkUrlResolved('http://good.example/', {
			resolve: async () => ['93.184.216.34', '2606:4700:4700::1111']
		});
		expect(r).toEqual({ safe: true });
	});

	it('returns unresolved-host when the resolver throws', async () => {
		const r = await checkUrlResolved('http://nope.example/', {
			resolve: async () => { throw new Error('ENOTFOUND'); }
		});
		expect(r).toEqual({ safe: false, reason: 'unresolved-host' });
	});

	it('short-circuits on the literal check without ever calling the resolver', async () => {
		let called = false;
		const r = await checkUrlResolved('http://127.0.0.1/', {
			resolve: async () => { called = true; return '8.8.8.8'; }
		});
		expect(r).toEqual({ safe: false, reason: 'loopback' });
		expect(called).toBe(false);
	});

	it('is identical to checkUrl when no resolver is supplied (literal-only)', async () => {
		const r = await checkUrlResolved('http://example.com/');
		expect(r).toEqual({ safe: true });
	});

	it('does not resolve an IP literal (already classified) even with a resolver', async () => {
		let called = false;
		const r = await checkUrlResolved('http://8.8.8.8/', {
			resolve: async () => { called = true; return '127.0.0.1'; }
		});
		expect(r).toEqual({ safe: true });
		expect(called).toBe(false);
	});

	it('treats a non-address resolver return as unresolved-host', async () => {
		const r = await checkUrlResolved('http://weird.example/', {
			resolve: async () => 'still-a-name.example'
		});
		expect(r).toEqual({ safe: false, reason: 'unresolved-host' });
	});
});

describe('safe-url: classifyAddress / isAddressSafe (bare-IP companion)', () => {
	it('classifies bare IPv4 in every obfuscated encoding', () => {
		expect(classifyAddress('127.0.0.1')).toBe('loopback'); // dotted-decimal
		expect(classifyAddress('2130706433')).toBe('loopback'); // bare integer
		expect(classifyAddress('0x7f000001')).toBe('loopback'); // whole hex
		expect(classifyAddress('0x7f.0.0.1')).toBe('loopback'); // dotted hex
		expect(classifyAddress('0177.0.0.1')).toBe('loopback'); // octal
		expect(classifyAddress('127.1')).toBe('loopback'); // short form
		expect(classifyAddress('10.1')).toBe('rfc1918'); // short form, rfc1918
	});

	it('classifies bare and bracketed IPv6', () => {
		expect(classifyAddress('::1')).toBe('loopback');
		expect(classifyAddress('[::1]')).toBe('loopback');
		expect(classifyAddress('0:0:0:0:0:0:0:1')).toBe('loopback');
		expect(classifyAddress('::')).toBe('unspecified');
		expect(classifyAddress('fd00::1')).toBe('ula');
		expect(classifyAddress('[fc00::1]')).toBe('ula');
		expect(classifyAddress('fe80::1')).toBe('link-local');
		expect(classifyAddress('[febf:ffff::1]')).toBe('link-local');
		expect(classifyAddress('[fd00:ec2::254]')).toBe('metadata');
	});

	it('unwraps IPv4-mapped / IPv4-compatible IPv6 and re-checks the embedded IPv4', () => {
		expect(classifyAddress('::ffff:169.254.169.254')).toBe('metadata');
		expect(classifyAddress('[::ffff:127.0.0.1]')).toBe('loopback');
		expect(classifyAddress('::ffff:192.168.1.1')).toBe('rfc1918');
		expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('::169.254.169.254')).toBe('metadata');
	});

	it('unwraps NAT64 / 6to4 and blocks Teredo at the address level too', () => {
		expect(classifyAddress('64:ff9b::a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('[64:ff9b::7f00:1]')).toBe('loopback');
		expect(classifyAddress('64:ff9b:1:a9fe:a9:fe00::')).toBe('metadata');
		expect(classifyAddress('2002:7f00:1::')).toBe('loopback');
		expect(classifyAddress('2001::1')).toBe('reserved');
		expect(classifyAddress('64:ff9b::808:808')).toBeNull(); // public 8.8.8.8
		expect(isAddressSafe('2002:a9fe:a9fe::')).toBe(false);
		expect(isAddressSafe('64:ff9b::808:808')).toBe(true);
	});

	it('reports metadata / ULA / link-local / loopback with a non-null reason', () => {
		expect(classifyAddress('169.254.169.254')).toBe('metadata');
		expect(classifyAddress('169.254.0.1')).toBe('link-local');
		expect(classifyAddress('10.0.0.1')).toBe('rfc1918');
		expect(classifyAddress('0.0.0.0')).toBe('unspecified');
		// The two name-based blocks still report their range, never null.
		expect(classifyAddress('localhost')).toBe('loopback');
		expect(classifyAddress('metadata.google.internal')).toBe('metadata');
	});

	it('blocks the CGNAT / special-purpose ranges at the fire-time address path too', () => {
		expect(classifyAddress('100.100.100.200')).toBe('cgnat');
		expect(classifyAddress('100.64.0.1')).toBe('cgnat');
		expect(classifyAddress('100.127.255.254')).toBe('cgnat');
		expect(classifyAddress('100.63.255.255')).toBe(null);
		expect(classifyAddress('100.128.0.1')).toBe(null);
		expect(classifyAddress('198.18.0.1')).toBe('benchmark');
		expect(classifyAddress('224.0.0.1')).toBe('multicast');
		expect(classifyAddress('240.0.0.1')).toBe('reserved');
		expect(classifyAddress('::ffff:100.100.100.200')).toBe('cgnat');
	});

	it('returns null (and isAddressSafe true) for a genuinely public IP', () => {
		expect(classifyAddress('8.8.8.8')).toBeNull();
		expect(classifyAddress('128.0.0.1')).toBeNull();
		expect(classifyAddress('[2001:db8::1]')).toBeNull();
		expect(classifyAddress('2606:4700:4700::1111')).toBeNull(); // bare public IPv6
		expect(isAddressSafe('8.8.8.8')).toBe(true);
		expect(isAddressSafe('2606:4700:4700::1111')).toBe(true);
		expect(isAddressSafe('8.8.8.8', {})).toBe(true); // options accepted for symmetry
	});

	it('SECURITY: a DNS-name string is never null - it maps to a non-null reason', () => {
		// The whole point: `null` must mean "a real public IP literal", so a
		// hostname handed to the address classifier can never pass as safe.
		expect(classifyAddress('example.com')).toBe('not-an-ip');
		expect(classifyAddress('hooks.partner.com')).toBe('not-an-ip');
		expect(isAddressSafe('example.com')).toBe(false);
		expect(isAddressSafe('hooks.partner.com')).toBe(false);
	});

	it('SECURITY: an empty / degenerate input is never null (an empty forwarded-for hop is not safe)', () => {
		// classifyHost normalises '' and '.' to an empty host and returns null;
		// without a guard classifyAddress would report those as "a real public IP"
		// (null), letting an absent / malformed X-Forwarded-For hop read as safe.
		expect(classifyAddress('')).toBe('not-an-ip');
		expect(classifyAddress('.')).toBe('not-an-ip');
		expect(isAddressSafe('')).toBe(false);
		expect(isAddressSafe('.')).toBe(false);
		expect(isAddressSafe('   ')).toBe(false);
		// A non-string input is also never null.
		expect(classifyAddress(/** @type {any} */ (undefined))).toBe('not-an-ip');
	});

	it('reports a malformed literal as parse-error (also non-null / unsafe)', () => {
		expect(classifyAddress('[not:valid:ipv6:::::]')).toBe('parse-error');
		expect(classifyAddress('foo:bar')).toBe('parse-error'); // bracket-wrapped, fails IPv6 parse
		expect(isAddressSafe('[not:valid:ipv6:::::]')).toBe(false);
	});

	it('isAddressSafe mirrors classifyAddress() === null', () => {
		expect(isAddressSafe('127.0.0.1')).toBe(false);
		expect(isAddressSafe('169.254.169.254')).toBe(false);
		expect(isAddressSafe('fd00::1')).toBe(false);
		expect(isAddressSafe('9.9.9.9')).toBe(true);
	});

	it('is drift-free vs the checkUrl URL wrapper for real IP literals', () => {
		// Bracket a bare IPv6 exactly as classifyAddress and resolveAndPin do.
		const wrap = (ip) => (ip.indexOf(':') !== -1 && ip[0] !== '[' ? '[' + ip + ']' : ip);
		const ips = [
			'127.0.0.1', '10.0.0.1', '169.254.169.254', '169.254.0.1', '0.0.0.0',
			'8.8.8.8', '128.0.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.1',
			'[::1]', '::1', '[fc00::1]', 'fe80::1', '[fd00:ec2::254]',
			'[2001:db8::1]', '2606:4700:4700::1111',
			'::ffff:169.254.169.254', '[::ffff:127.0.0.1]'
		];
		for (const ip of ips) {
			const result = checkUrl('http://' + wrap(ip) + '/');
			const expected = result.safe ? null : result.reason;
			expect(classifyAddress(ip)).toBe(expected);
		}
	});
});

/**
 * Encode an IPv4 address into a NAT64 prefix at any of the six RFC 6052
 * section 2.2 prefix lengths.
 *
 * Every layout except `/96` splits the address AROUND the reserved u-octet at
 * bits 64-71, so the octets do not sit in one contiguous 32-bit field. That is
 * what makes these easy to get wrong, and hand-computing the offsets has
 * already produced two wrong vectors in this file whose comments claimed an
 * address they did not encode. Vectors are generated here instead.
 *
 * @param {number} len - prefix length: 32, 40, 48, 56, 64 or 96
 * @param {string} v4 - dotted quad
 * @param {{ g2?: number, u?: number }} [opts] - `g2` sets group 2, which the
 *   /48 and longer layouts leave to the prefix (the RFC 8215 local-use prefix
 *   `64:ff9b:1::/48` is `g2 = 1`); it does not apply at /32 and /40, where
 *   group 2 carries address octets. `u` sets the reserved octet, which RFC 6052
 *   says is zero but a hostile sender is free to set.
 * @returns {string} the full eight-group IPv6 text
 */
function nat64Embed(len, v4, opts = {}) {
	const { g2 = 0, u = 0 } = opts;
	const [a, b, c, d] = v4.split('.').map(Number);
	const g = [0x0064, 0xff9b, g2, 0, 0, 0, 0, 0];
	if (len === 32) {
		g[2] = (a << 8) | b;
		g[3] = (c << 8) | d;
	} else if (len === 40) {
		g[2] = a;
		g[3] = (b << 8) | c;
		g[4] = (u << 8) | d;
	} else if (len === 48) {
		g[3] = (a << 8) | b;
		g[4] = (u << 8) | c;
		g[5] = d << 8;
	} else if (len === 56) {
		g[3] = a;
		g[4] = (u << 8) | b;
		g[5] = (c << 8) | d;
	} else if (len === 64) {
		g[4] = (u << 8) | a;
		g[5] = (b << 8) | c;
		g[6] = d << 8;
	} else if (len === 96) {
		g[6] = (a << 8) | b;
		g[7] = (c << 8) | d;
	} else {
		throw new Error('unsupported NAT64 prefix length: ' + len);
	}
	return g.map((x) => x.toString(16)).join(':');
}

/**
 * The RFC 8215 local-use prefix `64:ff9b:1::/48` at the /48 layout - the shape
 * most of the cases below are written against.
 *
 * @param {string} v4 - dotted quad
 * @param {number} [u] - the reserved octet
 */
function nat64LocalUse48(v4, u = 0) {
	return nat64Embed(48, v4, { g2: 1, u });
}

describe('IPv4-embedding transition prefixes', () => {
	// These assert the exact REASON, not merely that something was blocked.
	// The distinction is load-bearing: an earlier version of the /48 unwrap
	// read a contiguous 32 bits (consuming the u-octet), which still reported
	// *a* blocked reason for three of the four obvious vectors purely by
	// accident - 10.0.0.1 came back 'unspecified', 127.0.0.1 'unspecified',
	// 169.254.169.254 'reserved' - while letting 192.168.0.1 through as
	// public. A blocked-ness-only assertion passes against that bug.

	it('unwraps the RFC 8215 /48 local-use prefix to the right IPv4', () => {
		expect(classifyAddress(nat64LocalUse48('192.168.0.1'))).toBe('rfc1918');
		expect(classifyAddress(nat64LocalUse48('10.0.0.1'))).toBe('rfc1918');
		expect(classifyAddress(nat64LocalUse48('172.16.0.1'))).toBe('rfc1918');
		expect(classifyAddress(nat64LocalUse48('127.0.0.1'))).toBe('loopback');
		expect(classifyAddress(nat64LocalUse48('169.254.169.254'))).toBe('metadata');
		expect(classifyAddress(nat64LocalUse48('169.254.0.1'))).toBe('link-local');
		expect(classifyAddress(nat64LocalUse48('100.100.100.200'))).toBe('cgnat');
		expect(classifyAddress(nat64LocalUse48('0.0.0.0'))).toBe('unspecified');
	});

	it('blocks an RFC-correct /48 encoding that a misaligned read calls public', () => {
		// The layout splits the address around the reserved u-octet, so a
		// contiguous 32-bit read decodes one octet late and turns a private
		// address into a public-looking one.
		expect(checkUrl('http://[64:ff9b:1:c0a8:1:100::]/')).toEqual({ safe: false, reason: 'rfc1918' });
		// KNOWN RESIDUAL, asserted so a change to it is deliberate rather than
		// accidental. Under the /48 layout this embeds 0.1.0.0, but its /40 and
		// /56 readings turn the same prefix bits into 1.0.1.0 and 1.0.0.0, which
		// look like ordinary public addresses and vouch for the zero readings. The
		// prefix length is not recoverable from the address text, so one of the
		// two has to win, and every rule that blocks this one also refuses real
		// destinations for whole deployment shapes.
		//
		// What BOUNDS the residual is that a skipped reading can only ever be one
		// classifyIpv4 calls 'unspecified'. The skip tests for a zero top octet,
		// which is exactly that reason's condition and no other's, so the rule is
		// structurally incapable of hiding a loopback, RFC1918, metadata or any
		// other range - the entire class it can suppress is 0.0.0.0/8.
		//
		// That class IS reachable, and calling it harmless would be wrong: Linux
		// substitutes the loopback route inside __ip_route_output_key_hash, the
		// generic output-route lookup every in-kernel caller reaches, so a
		// translator routing its own translated packet through it (Jool does,
		// without validating the destination) lands on the translator's loopback.
		// The floor is blind SSRF against the translator appliance; what the bound
		// above guarantees is that it cannot reach the CALLING host's metadata or
		// RFC1918. Declaring nat64Prefix removes it entirely.
		expect(checkUrl('http://[64:ff9b:1:1::]/')).toEqual({ safe: true });
		// The bare-prefix case below is NOT a general "0.0.0.0 always blocks" rule
		// and must not be described as one: it requires groups 3-7 to be entirely
		// zero, so junk in any group the /48 reading does not use switches it off.
		// This reads 0.0.0.0 at /48, has a clean u-octet, and is allowed.
		expect(checkUrl('http://[64:ff9b:1:0:0:0:8:8]/')).toEqual({ safe: true });
		// The same shape with a DIRTY u-octet is refused, but by the conformance
		// rule rather than by anything about the embedded address: bits 64-71 are
		// reserved MUST-zero in every layout, so this is not a legal encoding at
		// any length. That rule is what keeps the residual to clean-u-octet shapes.
		expect(classifyAddress('64:ff9b:1:0:100::')).toBe('reserved');
		expect(checkUrl('http://[64:ff9b:1::]/')).toEqual({ safe: false, reason: 'unspecified' });
		expect(classifyAddress('64:ff9b:1:0:0:0:0:0')).toBe('unspecified');
	});

	it('still allows a public IPv4 through the /48 prefix', () => {
		// The prefix is how a NAT64 network reaches the public IPv4 internet,
		// so blocking the whole range would break every legitimate outbound
		// webhook on such a network. Only the embedded address decides.
		expect(classifyAddress(nat64LocalUse48('8.8.8.8'))).toBeNull();
		expect(classifyAddress(nat64LocalUse48('93.184.216.34'))).toBeNull();
	});

	it('unwraps the /48 prefix even when the reserved u-octet is non-zero', () => {
		// RFC 6052 says the u-octet is zero. A sender that sets it anyway must
		// not shift the guard off the real address or escape it entirely.
		expect(classifyAddress(nat64LocalUse48('169.254.169.254', 0xff))).toBe('metadata');
		expect(classifyAddress(nat64LocalUse48('10.0.0.1', 0x7f))).toBe('rfc1918');
	});

	it('treats a /96-shaped address inside the /48 prefix as its real value', () => {
		// `64:ff9b:1::7f00:1` is a /96-shaped address, not a /48 one: its /48 field
		// is entirely zero while address bits follow it, which RFC 6052 padding
		// forbids. Its /48 reading is therefore 0.0.0.0, skipped as padding, and
		// the address means what its /96 reading says - 127.0.0.1.
		//
		// It therefore cannot demonstrate a /48 unwrap in either direction, and
		// must not be used to argue one is correct.
		expect(classifyAddress('64:ff9b:1::7f00:1')).toBe('loopback');
	});

	it('unwraps the RFC 6052 /96 well-known prefix', () => {
		expect(classifyAddress('64:ff9b::169.254.169.254')).toBe('metadata');
		expect(classifyAddress('64:ff9b::a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('64:ff9b::127.0.0.1')).toBe('loopback');
		expect(classifyAddress('64:ff9b::10.0.0.1')).toBe('rfc1918');
		expect(classifyAddress('64:ff9b::100.100.100.200')).toBe('cgnat');
		expect(classifyAddress('64:ff9b::8.8.8.8')).toBeNull();
	});

	it('unwraps the 6to4 prefix from groups 1-2', () => {
		expect(classifyAddress('2002:c0a8:1::1')).toBe('rfc1918');
		expect(classifyAddress('2002:7f00:1::1')).toBe('loopback');
		expect(classifyAddress('2002:a9fe:a9fe::1')).toBe('metadata');
		expect(classifyAddress('2002:6464:64c8::1')).toBe('cgnat');
		expect(classifyAddress('2002:808:808::1')).toBeNull();
	});

	it('blocks an address that is public under a short reading but private under a longer one', () => {
		// Why every length has to be read rather than picking one: the /48 reading
		// here is the public 8.8.8.8, while the /96 reading is 169.254.169.254.
		// Under a deployment whose NSP is /96 sourced from the 8215 /48, stopping
		// at the shorter reading reaches the metadata endpoint.
		expect(classifyAddress('64:ff9b:1:808:8:800:a9fe:a9fe')).toBe('metadata');
		// Same idea at a different length. The /64 layout takes the low byte of
		// group 4 as the first octet, group 5 as the middle two, and the high byte
		// of group 6 as the last: 0x7f | 0x0000 | 0x01 is 127.0.0.1. The /48
		// reading of the same address is 8.8.127.0, which is public.
		expect(classifyAddress('64:ff9b:1:808:7f:0:100:0')).toBe('loopback');
	});

	it('decodes the /32 and /40 layouts, not only the longer ones', () => {
		// Reading the two shortest layouts is a fail-closed choice over space IANA
		// never assigned, NOT a spec requirement: RFC 6052 section 2.2 permits the
		// well-known prefix only at /96, and IANA lists only 64:ff9b::/96 and
		// 64:ff9b:1::/48 inside the /32. These vectors carry the embedded address
		// with everything after it zeroed, and the readings are consulted
		// shortest-first, so each reports its own layout.
		expect(classifyAddress('64:ff9b:c0a8:101::')).toBe('rfc1918');       // /32 192.168.1.1
		expect(classifyAddress('64:ff9b:6464:64c8::')).toBe('cgnat');        // /32 100.100.100.200
		expect(classifyAddress('64:ff9b:c0:a801:1::')).toBe('rfc1918');      // /40 192.168.1.1
		expect(classifyAddress('64:ff9b:ac:1000:1::')).toBe('rfc1918');      // /40 172.16.0.1
		expect(classifyAddress('64:ff9b:c6:1200:1::')).toBe('benchmark');    // /40 198.18.0.1
	});

	it('allows a public destination reached through a /96 NSP inside the /48', () => {
		// Every address under a /96 NSP sourced from the RFC 8215 /48 has all-zero
		// /48 bits BY CONSTRUCTION. Letting the /48 reading decide would therefore
		// refuse every public destination for that entire deployment shape - not an
		// edge case, 100% of it. The zero /48 reading is skipped as padding here
		// precisely because the /96 reading carries a real address.
		expect(classifyAddress('64:ff9b:1::808:808')).toBeNull();     // 8.8.8.8
		expect(classifyAddress('64:ff9b:1::101:101')).toBeNull();     // 1.1.1.1
		expect(classifyAddress('64:ff9b:1::5db8:d822')).toBeNull();   // 93.184.216.34
		// ... while a private one through the same NSP is still refused.
		expect(classifyAddress('64:ff9b:1::a9fe:a9fe')).toBe('metadata');
	});

	it('still unwraps when the reserved u-octet is hostile rather than skipping the reading', () => {
		// This is about the POLARITY of the u-octet rule, not its existence. The
		// module does refuse a non-zero u-octet outright (see the conformance
		// cases), but it must never DISQUALIFY A READING on that basis: the octet
		// is not part of any embedding, so gating a reading on it would hand an
		// attacker an off switch - set it, and the reading that sees the private
		// address is discarded while a public-looking one at another length
		// decides. Here the /64 reading is 127.0.0.1 and the /96 reading is the
		// public 1.0.0.0, so a reading-gate would allow it. Refusal is checked
		// after the readings, so the private address still reports its own range.
		expect(classifyAddress('64:ff9b:1:0:ff7f:0:100:0')).toBe('loopback');
		expect(classifyAddress(nat64LocalUse48('169.254.169.254', 0xff))).toBe('metadata');
	});

	it('unwraps ISATAP interface identifiers under any routing prefix', () => {
		// ISATAP carries the IPv4 in the low 32 bits behind a 0000:5efe or
		// 0200:5efe interface identifier, and it works under ANY unicast prefix -
		// so unlike 6to4 and NAT64 the address cannot be recognised by its prefix.
		// On a host with an ISATAP tunnel on that /64 these reach the embedded
		// address, so the guard has to look at the identifier instead.
		expect(classifyAddress('2001:db8::5efe:a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('2001:db8::5efe:c0a8:1')).toBe('rfc1918');
		expect(classifyAddress('2001:db8::200:5efe:7f00:1')).toBe('loopback');
		expect(classifyAddress('2a01:4f8:1:2::5efe:a9fe:a9fe')).toBe('metadata');
		// A public embedded address stays allowed - the identifier is not itself
		// grounds for blocking.
		expect(classifyAddress('2001:db8::5efe:808:808')).toBeNull();
		// The link-local spelling was already covered by fe80::/10.
		expect(classifyAddress('fe80::5efe:a9fe:a9fe')).toBe('link-local');
	});

	it('sees an ISATAP identifier inside a 6to4 address (the classic pairing)', () => {
		// 6to4 and ISATAP coexist on the same host in the standard Windows
		// configuration, so a 6to4 address whose embedded IPv4 is public can still
		// carry a private one in its interface identifier. Returning on the public
		// 6to4 reading would hide it.
		expect(classifyAddress('2002:808:808::5efe:a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('2002:808:808::5efe:7f00:1')).toBe('loopback');
		expect(classifyAddress('2002:808:808:0:200:5efe:c0a8:1')).toBe('rfc1918');
		// A 6to4 address with a public IPv4 and no ISATAP identifier stays allowed.
		expect(classifyAddress('2002:808:808::1')).toBeNull();
	});

	it('applies the NAT64 embeddings across the whole 64:ff9b::/32 prefix', () => {
		// RFC 6052 nominates the well-known prefix at /96, but nothing stops a
		// deployment sourcing a longer prefix from inside 64:ff9b::/32. An address
		// matching neither the exact /96 shape nor the RFC 8215 /48 used to match
		// no branch at all and read as a public destination.
		expect(checkUrl('http://[64:ff9b:0:7f00:0:100::]/')).toEqual({ safe: false, reason: 'loopback' });
		expect(classifyAddress('64:ff9b:2:c0a8:0:100::')).toBe('rfc1918');
		// 169.254.169.254 laid out per RFC 6052 section 2.2: high 16 bits in group
		// 3, third octet in the LOW byte of group 4 (the u-octet occupies the high
		// byte), fourth octet in the high byte of group 5.
		expect(classifyAddress('64:ff9b:5:a9fe:a9:fe00::')).toBe('metadata');
		// A public embedded address through such a prefix is still allowed.
		expect(classifyAddress('64:ff9b:2:808:8:800::')).toBeNull();
	});

	it('blocks Teredo outright (its embedded IPv4 is XOR-obfuscated)', () => {
		expect(classifyAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('reserved');
		expect(classifyAddress('2001::1')).toBe('reserved');
		// 2001:db8::/32 is documentation space, not Teredo - must not be caught.
		expect(classifyAddress('2001:db8::1')).toBeNull();
	});
});

describe('NAT64 reading coverage', () => {
	// Each case here was written against a deliberately broken copy of
	// src/safe-url.js and confirmed to fail on it. They exist because the
	// classifier had three behaviours that could be removed outright with the
	// rest of this file still fully green: the /56 reading could be deleted, the
	// zero-reading skip could be made unconditional, and the six readings could
	// be reordered. A reading with no case that fails when it is gone is not
	// covered, however many addresses happen to pass through it.

	it('matches the RFC 6052 Table 1 /40 and /56 layouts independently of the encoder helper', () => {
		// Start from the RFC's exact prefixes and public 192.0.2.33 examples:
		//   2001:db8:100::/40     -> 2001:db8:1c0:2:21::
		//   2001:db8:122:300::/56 -> 2001:db8:122:3c0:0:221::
		// Then replace those four IPv4 octets in the same documented bit slots.
		// These literals are deliberately not produced by nat64Embed(): the test
		// oracle is the RFC table, so a mirrored bug in reader and helper cannot
		// make the suite self-consistent.
		const p40 = { nat64Prefix: '2001:db8:100::/40' };
		expect(classifyAddress('2001:db8:1c0:2:21::', p40)).toBeNull();           // 192.0.2.33
		expect(classifyAddress('2001:db8:1c0:a801:1::', p40)).toBe('rfc1918');   // 192.168.1.1
		expect(classifyAddress('2001:db8:1a9:fea9:fe::', p40)).toBe('metadata'); // 169.254.169.254
		expect(classifyAddress('2001:db8:164:6464:c8::', p40)).toBe('cgnat');    // 100.100.100.200

		const p56 = { nat64Prefix: '2001:db8:122:300::/56' };
		expect(classifyAddress('2001:db8:122:3c0:0:221::', p56)).toBeNull();           // 192.0.2.33
		expect(classifyAddress('2001:db8:122:3c0:a8:101::', p56)).toBe('rfc1918');     // 192.168.1.1
		expect(classifyAddress('2001:db8:122:3a9:fe:a9fe::', p56)).toBe('metadata');  // 169.254.169.254
		expect(classifyAddress('2001:db8:122:364:64:64c8::', p56)).toBe('cgnat');     // 100.100.100.200
	});
	it('blocks a private IPv4 embedded under the /56 layout', () => {
		// /56 puts the first octet in the LOW byte of group 3 (bits 56-63) and
		// the remaining three after the u-octet, in the low byte of group 4 plus
		// all of group 5 (bits 72-95). Deleting this reading leaves 192.168.1.1
		// below reading as a public address.
		expect(classifyAddress(nat64Embed(56, '192.168.1.1'))).toBe('rfc1918');
		expect(classifyAddress(nat64Embed(56, '10.0.0.1'))).toBe('rfc1918');
		expect(classifyAddress(nat64Embed(56, '169.254.169.254'))).toBe('metadata');
		expect(classifyAddress(nat64Embed(56, '127.0.0.1'))).toBe('loopback');
		expect(classifyAddress(nat64Embed(56, '100.100.100.200'))).toBe('cgnat');
		expect(checkUrl('http://[' + nat64Embed(56, '192.168.1.1') + ']/')).toEqual({
			safe: false,
			reason: 'rfc1918'
		});
		// Pinned in both directions: a public destination at the same length is
		// still reachable, so the reading cannot be "fixed" by over-blocking.
		expect(classifyAddress(nat64Embed(56, '8.8.8.8'))).toBeNull();
	});

	it('honours a zero reading when every reading is padding', () => {
		// A zero reading is discarded only while some OTHER reading carries a real
		// address. When all six land in 0.0.0.0/8 there is nothing to defer to and
		// the address means what it reads as.
		//
		// These are the only shapes that separate that rule from the bare-prefix
		// guard below it. Every other unspecified case in this file also has
		// nothing at all after the prefix, so the guard answers it and the skip is
		// never consulted - which is why making the skip unconditional used to
		// leave the whole suite green. Here the low groups are non-zero, so the
		// guard cannot fire and only the skip rule decides.
		expect(classifyAddress('64:ff9b::0:1')).toBe('unspecified');
		expect(classifyAddress('64:ff9b:0:0:0:1:0:1')).toBe('unspecified');
		expect(classifyAddress('64:ff9b:0:0:0:0:1:0')).toBe('unspecified');
		expect(checkUrl('http://[64:ff9b::0:1]/')).toEqual({ safe: false, reason: 'unspecified' });
	});

	it('reports the shortest reading that blocks, not an arbitrary one', () => {
		// The readings are consulted shortest-prefix-first so the reported reason
		// is the least-padded interpretation of the address. This vector is built
		// so that every length decodes to a different range AND every reading has
		// a non-zero leading octet, so none of them is discarded as padding:
		//
		//   /32  10.127.169.254   rfc1918      <- shortest, and what is reported
		//   /40  127.169.254.100  loopback
		//   /48  169.254.100.64   link-local
		//   /56  254.100.64.1     reserved
		//   /64  100.64.1.198     cgnat
		//   /96  198.18.1.1       benchmark
		//
		// Promote any one of the six ahead of the rest and the reported reason
		// changes to that row. The non-zero leading octets are load-bearing and
		// not decoration: an earlier version of this vector had a /64 reading of
		// 0.1.0.100, which the padding skip discards before it can ever win, so
		// promoting /64 changed nothing and the case silently pinned five of the
		// six. Note this pins which reading is consulted FIRST; it does not pin
		// the relative order of the other five.
		expect(classifyAddress('64:ff9b:a7f:a9fe:64:4001:c612:101')).toBe('rfc1918');
	});

	it('blocks a /48-embedded private address whose unused groups carry junk', () => {
		// The suffix at a given length is not part of the embedded address at that
		// length, so a sender is free to dirty it. That is precisely why no reading
		// may be gated on a clean suffix: dirtying the bits the private-address
		// reading does not use would discard it and leave a public-looking reading
		// at some other length to acquit the address. These are the /48 encodings
		// of the three addresses the guard exists for, each carrying junk.
		expect(classifyAddress('64:ff9b:1:a9fe:a9:fe00:808:808')).toBe('metadata');
		expect(classifyAddress('64:ff9b:1:7f00:0:100:808:808')).toBe('loopback');
		expect(classifyAddress('64:ff9b:1:a00:0:100:dead:beef')).toBe('rfc1918');
		expect(checkUrl('http://[64:ff9b:1:a9fe:a9:fe00:808:808]/latest/meta-data/')).toEqual({
			safe: false,
			reason: 'metadata'
		});
	});

	it('refuses a bare translation prefix carrying no destination', () => {
		expect(classifyAddress('64:ff9b::')).toBe('unspecified');
		expect(classifyAddress('64:ff9b:1::')).toBe('unspecified');
		expect(checkUrl('http://[64:ff9b::]/')).toEqual({ safe: false, reason: 'unspecified' });
	});

	it('blocks every private IPv4 at every RFC 6052 prefix length', () => {
		// Breadth rather than depth: the cases above pin exact reasons on
		// hand-picked shapes, this walks all six layouts against a spread of
		// blocked ranges. The expectation comes from the RFC layout rather than
		// from what the classifier currently returns.
		//
		// The assertion is EQUALITY against the reason the same IPv4 gets on its
		// own: embedding must not change what an address IS. That is an
		// invariance check, and it is worth being precise about what it can and
		// cannot see - the expected value comes from classifyIpv4, the same code
		// under test, so a change to what a RANGE is called moves both sides
		// together and this case stays green. It catches misalignment (a reading
		// landing on padding or on the wrong octets), which is what this file
		// exists for; the exact reason strings are pinned by the hand-picked
		// cases above, which is where a renamed range would fail.
		const lengths = [32, 40, 48, 56, 64, 96];
		const privates = [
			'10.0.0.1',
			'127.0.0.1',
			'169.254.169.254',
			'192.168.1.1',
			'100.100.100.200',
			'172.16.0.1',
			'198.18.0.1'
		];
		for (const len of lengths) {
			for (const ip of privates) {
				const addr = nat64Embed(len, ip);
				expect(classifyAddress(addr), ip + ' embedded at /' + len + ' (' + addr + ')').toBe(
					classifyAddress(ip)
				);
			}
			// ... and the same layout still carries a public destination.
			expect(classifyAddress(nat64Embed(len, '8.8.8.8'))).toBeNull();
		}
	});

	it('over-blocks a /96 NSP by subnet id, and a declared prefix closes it', () => {
		// A /96 NSP sourced from the RFC 8215 /48 carries a 16-bit subnet id in
		// group 3, and the /48 and /56 readings turn that subnet id into the
		// LEADING octets of a phantom IPv4. Whole subnets therefore refuse every
		// public destination - roughly a quarter of the 65536 ids, and a subnet is
		// either entirely dead or entirely fine.
		//
		// Subnet 0 is the single value whose phantom readings are all padding, so
		// a case pinning only subnet 0 hides the entire problem. These assert the
		// real behaviour so the cost is visible rather than discovered in
		// production:
		expect(classifyAddress('64:ff9b:1:0:0:0:808:808')).toBeNull(); // subnet 0, fine
		expect(classifyAddress('64:ff9b:1:a:0:0:808:808')).toBe('rfc1918'); // phantom 10.x
		expect(classifyAddress('64:ff9b:1:7f:0:0:808:808')).toBe('loopback'); // phantom 127.x
		expect(classifyAddress('64:ff9b:1:ff:0:0:808:808')).toBe('reserved'); // phantom 255.x

		// Declaring the prefix removes the ambiguity outright: one reading is
		// taken, nothing is padding, and every subnet carries public traffic.
		for (const subnet of ['0', 'a', '7f', 'ff', 'abcd']) {
			const opts = { nat64Prefix: '64:ff9b:1:' + subnet + '::/96' };
			expect(classifyAddress('64:ff9b:1:' + subnet + ':0:0:808:808', opts)).toBeNull();
			expect(classifyAddress('64:ff9b:1:' + subnet + ':0:0:8c52:7904', opts)).toBeNull();
			// ... while a private destination through the same NSP is still refused,
			// so this is a disambiguation and not an allow-list.
			expect(classifyAddress('64:ff9b:1:' + subnet + ':0:0:a9fe:a9fe', opts)).toBe('metadata');
		}
	});

	it('honours a declared prefix at every length, and outside 64:ff9b::/32', () => {
		// RFC 6052 lets an operator source a Network-Specific Prefix from their own
		// address space, so the declaration cannot be restricted to the well-known
		// range.
		const own = { nat64Prefix: '2001:db8:1::/96' };
		expect(classifyAddress('2001:db8:1::a9fe:a9fe', own)).toBe('metadata');
		expect(classifyAddress('2001:db8:1::c0a8:101', own)).toBe('rfc1918');
		expect(classifyAddress('2001:db8:1::808:808', own)).toBeNull();
		// An address OUTSIDE the declared prefix is untouched by the declaration.
		expect(classifyAddress('2001:db8:2::a9fe:a9fe', own)).toBeNull();

		// Every RFC 6052 length is usable as a declaration.
		for (const len of [32, 40, 48, 56, 64, 96]) {
			const opts = { nat64Prefix: '64:ff9b::/' + len };
			expect(classifyAddress(nat64Embed(len, '169.254.169.254'), opts)).toBe('metadata');
			expect(classifyAddress(nat64Embed(len, '10.0.0.1'), opts)).toBe('rfc1918');
			expect(classifyAddress(nat64Embed(len, '8.8.8.8'), opts)).toBeNull();
		}

		// A declaration a deployment gets wrong must not weaken the guard: an
		// unusable value is ignored and every length is read, which is the
		// fail-closed direction.
		for (const bad of ['', 'not-a-prefix', '64:ff9b::', '64:ff9b::/97', '64:ff9b::/0', 'zz::/96']) {
			expect(classifyAddress('64:ff9b::a9fe:a9fe', { nat64Prefix: bad })).toBe('metadata');
		}
		expect(checkUrl('http://[64:ff9b::a9fe:a9fe]/', { nat64Prefix: 'garbage' })).toEqual({
			safe: false,
			reason: 'metadata'
		});
		// The length gate specifically. RFC 6052 permits only six lengths, and a
		// value outside them must be REJECTED rather than approximated - an
		// accepted /33 would match this address on its first 33 bits and then read
		// it as a /96, which is the public 8.8.8.8, losing the metadata address
		// its /48 reading carries. The cases above cannot see this, because their
		// bad values fail to match the address at all.
		expect(
			classifyAddress('64:ff9b:1:a9fe:a9:fe00:808:808', { nat64Prefix: '64:ff9b:1:a9fe::/33' })
		).toBe('metadata');
	});

	it('matches a declared prefix on its partial trailing group, not just whole ones', () => {
		// /40 and /56 do not end on a 16-bit boundary, so the last group has to be
		// compared under a mask. Without that mask a declaration would capture
		// addresses outside itself and read them at the wrong length.
		//
		// `64:ff9b:7f08:101::` reads 127.8.1.1 at /32 (loopback) and the public
		// 8.1.1.0 at /40. Under a declaration whose third byte differs it is NOT a
		// declared address, so all six lengths apply and the /32 reading blocks:
		expect(classifyAddress('64:ff9b:7f08:101::', { nat64Prefix: '64:ff9b:aa00::/40' })).toBe(
			'loopback'
		);
		// ... while the declaration that really does contain it reads /40 and lets
		// the public destination through. Same address, same length, different
		// masked byte - which is the whole of what the mask decides.
		expect(classifyAddress('64:ff9b:7f08:101::', { nat64Prefix: '64:ff9b:7f00::/40' })).toBeNull();
	});

	it('applies the u-octet conformance rule on the declared path too', () => {
		// The declared path is a separate branch and needs its own coverage: a
		// deployment that pins its prefix must not thereby accept encodings the
		// RFC forbids.
		//
		// The declaration has to be SHORTER than /96 for this to be reachable at
		// all. At /96 the u-octet sits inside the declared prefix, so an address
		// with a dirty one does not match the declaration in the first place and
		// is answered by the undeclared path instead - a case written against a
		// /96 declaration silently tests the wrong branch.
		//
		// Here the /48 read is the public 8.8.8.8 and the u-octet is 0xff, so only
		// the conformance rule can refuse it.
		expect(classifyAddress('64:ff9b:1:808:ff08:800::', { nat64Prefix: '64:ff9b:1::/48' })).toBe(
			'reserved'
		);
		// The same address with a clean u-octet is allowed, so the refusal is the
		// conformance rule and not something about the destination.
		expect(classifyAddress('64:ff9b:1:808:8:800::', { nat64Prefix: '64:ff9b:1::/48' })).toBeNull();
		// A private destination still reports its own range: the reading is
		// consulted before the conformance check on this path too.
		expect(
			classifyAddress('64:ff9b:1:c0a8:ff01:100::', { nat64Prefix: '64:ff9b:1::/48' })
		).toBe('rfc1918');
	});

	it('refuses a NAT64 address whose reserved u-octet is non-zero', () => {
		// RFC 6052 section 2.2 reserves bits 64-71 and requires them to be zero in
		// every layout, so a non-zero value there is not a legal IPv4-embedded
		// address at any length and is refused outright.
		//
		// The POLARITY is what makes this safe, and it is the opposite of a rule
		// this guard deliberately does not have: discarding a READING when the
		// u-octet is dirty would let a sender disable whichever reading sees the
		// private address, while refusing the whole address cannot be used that
		// way. The two must not be confused.
		expect(classifyAddress('64:ff9b:1:0:100::')).toBe('reserved');
		expect(classifyAddress('64:ff9b::ff00:0:808:808')).toBe('reserved');
		expect(checkUrl('http://[64:ff9b:1:0:100::]/')).toEqual({ safe: false, reason: 'reserved' });
		// A private destination still reports its OWN range rather than being
		// flattened to the conformance reason, because the readings are consulted
		// first - the check only decides addresses nothing else blocked.
		expect(classifyAddress('64:ff9b:1:0:ff7f:0:100:0')).toBe('loopback');
		expect(classifyAddress(nat64LocalUse48('169.254.169.254', 0xff))).toBe('metadata');
		// A clean u-octet is untouched.
		expect(classifyAddress('64:ff9b:1::808:808')).toBeNull();
	});
});

describe('non-NAT64 rules added alongside the transition-prefix work', () => {
	// Each of these is security-relevant behaviour that shipped with a paragraph
	// of justification in the source and no test at all: every one could be
	// deleted outright with the rest of this file green.

	it('blocks the IETF protocol assignment block 192.0.0.0/24', () => {
		// The rule exists for the RFC 7050 NAT64 discovery names, which are the
		// reason it sits in this module rather than being a generic reserved range.
		expect(classifyAddress('192.0.0.170')).toBe('reserved'); // RFC 7050 ipv4only.arpa
		expect(classifyAddress('192.0.0.171')).toBe('reserved');
		expect(classifyAddress('192.0.0.0')).toBe('reserved');
		expect(classifyAddress('192.0.0.255')).toBe('reserved');
		expect(checkUrl('http://192.0.0.170/')).toEqual({ safe: false, reason: 'reserved' });
		// The neighbouring blocks are NOT this rule: 192.0.1.0 is public.
		expect(classifyAddress('192.0.1.0')).toBeNull();
	});

	it('blocks IPv6 multicast ff00::/8', () => {
		expect(classifyAddress('ff02::1')).toBe('multicast'); // all-nodes
		expect(classifyAddress('ff02::fb')).toBe('multicast'); // mDNS
		expect(classifyAddress('ff05::1:3')).toBe('multicast'); // site-local DHCP
		expect(checkUrl('http://[ff02::1]/')).toEqual({ safe: false, reason: 'multicast' });
		// The space immediately below ff00:: is NOT public: fec0::/10 reaches
		// feff:ffff:..., so the boundary neighbour is site-local. A genuinely
		// public address is well clear of both ranges.
		expect(classifyAddress('feff::1')).toBe('ula');
		expect(classifyAddress('2a01:4f8::1')).toBeNull();
	});

	it('unwraps the RFC 2765 IPv4-translated form ::ffff:0:0:0/96', () => {
		// The sibling of IPv4-MAPPED (::ffff:0:0/96), one group longer. Without
		// this branch the same address reads as public through the other spelling.
		expect(classifyAddress('::ffff:0:169.254.169.254')).toBe('metadata');
		expect(classifyAddress('::ffff:0:a9fe:a9fe')).toBe('metadata');
		expect(classifyAddress('::ffff:0:127.0.0.1')).toBe('loopback');
		expect(classifyAddress('::ffff:0:10.0.0.1')).toBe('rfc1918');
		expect(checkUrl('http://[::ffff:0:169.254.169.254]/')).toEqual({
			safe: false,
			reason: 'metadata'
		});
		// A public embedded address through the same form stays allowed.
		expect(classifyAddress('::ffff:0:8.8.8.8')).toBeNull();
	});

	it('blocks the bare `metadata` hostname, not only the fully-qualified one', () => {
		// On GCP the instance search domain makes http://metadata/ reach the same
		// endpoint as metadata.google.internal, so blocking only the FQDN leaves
		// the obvious short spelling open on exactly the platform the rule exists
		// for.
		expect(classifyAddress('metadata')).toBe('metadata');
		expect(checkUrl('http://metadata/computeMetadata/v1/')).toEqual({
			safe: false,
			reason: 'metadata'
		});
		expect(checkUrl('http://METADATA./computeMetadata/v1/')).toEqual({
			safe: false,
			reason: 'metadata'
		});
		// A longer name that merely starts with it is a different host.
		expect(checkUrl('http://metadata.example.com/')).toEqual({ safe: true });
	});

	it('fails closed when a resolver returns no addresses', () => {
		// The rebinding defence is the loop over resolved addresses, and with zero
		// addresses it simply does not run - so a resolver returning [] on NODATA,
		// which is a documented extension point, would mark every host safe.
		return Promise.all([
			expect(checkUrlResolved('http://example.com/', { resolve: async () => [] })).resolves.toEqual(
				{ safe: false, reason: 'unresolved-host' }
			),
			expect(
				checkUrlResolved('http://example.com/', { resolve: async () => ['8.8.8.8'] })
			).resolves.toEqual({ safe: true }),
			expect(
				checkUrlResolved('http://example.com/', { resolve: async () => ['10.0.0.1'] })
			).resolves.toEqual({ safe: false, reason: 'rfc1918' })
		]);
	});
});

describe('nat64Prefix reaches every entry point that documents it', () => {
	// The option is advertised on five exported functions. Threading it through
	// each is a separate line of code, and each could be deleted with the rest of
	// this file green - the declared-prefix cases above all go through
	// classifyAddress. These pin the other four.
	//
	// The discriminating address is 8.8.8.8 carried by a /96 NSP at subnet `a`
	// inside the RFC 8215 /48: undeclared, its phantom /56 reading is 10.0.0.0 and
	// it is refused as rfc1918; declared, the single /96 reading is the real
	// public destination.
	const ADDR = '64:ff9b:1:a:0:0:808:808';
	const URL_ = 'http://[' + ADDR + ']/hook';
	const DECL = { nat64Prefix: '64:ff9b:1:a::/96' };

	it('checkUrl honours it', () => {
		expect(checkUrl(URL_)).toEqual({ safe: false, reason: 'rfc1918' });
		expect(checkUrl(URL_, DECL)).toEqual({ safe: true });
	});

	it('isSafeUrl honours it', () => {
		expect(isSafeUrl(URL_)).toBe(false);
		expect(isSafeUrl(URL_, DECL)).toBe(true);
	});

	it('isAddressSafe honours it', () => {
		expect(isAddressSafe(ADDR)).toBe(false);
		expect(isAddressSafe(ADDR, DECL)).toBe(true);
	});

	it('checkUrlResolved honours it for a RESOLVED address', async () => {
		// The literal check cannot see this one: the host is a DNS name, so the
		// declaration has to reach the loop that re-checks resolved addresses.
		const resolve = async () => [ADDR];
		expect(await checkUrlResolved('http://example.com/', { resolve })).toEqual({
			safe: false,
			reason: 'rfc1918'
		});
		expect(await checkUrlResolved('http://example.com/', { ...DECL, resolve })).toEqual({
			safe: true
		});
		// ... and a genuinely private resolved address is still refused under the
		// same declaration, so this is disambiguation and not an escape hatch.
		expect(
			await checkUrlResolved('http://example.com/', {
				...DECL,
				resolve: async () => ['64:ff9b:1:a:0:0:a9fe:a9fe']
			})
		).toEqual({ safe: false, reason: 'metadata' });
	});

	it('accepts a bracketed prefix, as a copied-from-a-URL value would be', () => {
		expect(classifyAddress(ADDR, { nat64Prefix: '[64:ff9b:1:a::]/96' })).toBeNull();
		expect(checkUrl(URL_, { nat64Prefix: '[64:ff9b:1:a::]/96' })).toEqual({ safe: true });
	});

	it('refuses a length outside the six RFC 6052 values, however it is spelled', () => {
		// The gate is advertised as exactly six lengths, so it must not inherit
		// Number()'s leniency - '0x30', ' 48', '+48' and '96.0' all coerce to a
		// legal length and would silently accept a prefix the RFC does not define.
		for (const bad of ['/0x30', '/ 48', '/+48', '/96.0', '/048', '/96 ']) {
			expect(
				classifyAddress('64:ff9b::a9fe:a9fe', { nat64Prefix: '64:ff9b::' + bad }),
				'nat64Prefix 64:ff9b::' + bad + ' must be rejected'
			).toBe('metadata');
		}
	});

	it('is ignored, not fatal, for a non-string or hostile value', () => {
		for (const bad of [null, 96, {}, [], true, { toString() { throw new Error('no'); } }]) {
			expect(classifyAddress('64:ff9b::a9fe:a9fe', { nat64Prefix: /** @type {any} */ (bad) })).toBe(
				'metadata'
			);
		}
	});
});

describe('a declaration that does not match the network', () => {
	// A parseable declaration is a trusted assertion. A wrong length in either
	// direction can make the configured reading public while the translator's
	// real reading is private. A non-zero suffix proves some mismatches and is
	// refused, but a clean suffix cannot prove that the lengths agree.

	/**
	 * Encode `dest` at `realLen` under a prefix carved from 64:ff9b:1::/48,
	 * following the RFC 6052 section 2.2 byte layout (u octet at byte 8).
	 */
	const encodeAt = (realLen, dest, subnet = 0x2a5d) => {
		const layout = { 32: [4, 5, 6, 7], 40: [5, 6, 7, 9], 48: [6, 7, 9, 10], 56: [7, 9, 10, 11], 64: [9, 10, 11, 12], 96: [12, 13, 14, 15] };
		const b = new Array(16).fill(0);
		b[1] = 0x64; b[2] = 0xff; b[3] = 0x9b; b[5] = 0x01;
		if (realLen > 48) { b[6] = (subnet >> 8) & 0xff; b[7] = subnet & 0xff; }
		layout[realLen].forEach((pos, i) => { b[pos] = dest[i]; });
		const groups = [];
		for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
		return groups.join(':');
	};

	it('refuses a mismatch when a non-zero suffix proves the declaration wrong', () => {
		const addr = encodeAt(96, [169, 254, 169, 254]);
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1:2a5d::/96' })).toBe('metadata');
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1::/48' })).toBe('reserved');
	});

	it('shows why a too-short declaration remains exploitable', () => {
		// Real /64, destination 169.254.0.0, operator declares the parent /48.
		// Both encodings are conformant, so the address text cannot identify which
		// reading is real; the exact prefix has to come from trusted configuration.
		const addr = encodeAt(64, [169, 254, 0, 0]);
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1:2a5d::/64' }), 'correct declaration refuses it').not.toBeNull();
		expect(classifyAddress(addr), 'undeclared refuses it').not.toBeNull();
		expect(
			classifyAddress(addr, { nat64Prefix: '64:ff9b:1::/48' }),
			'a /48 declaration for a /64 network reads different bits and allows it'
		).toBeNull();
	});

	it('refuses a non-zero suffix even under a too-long declaration', () => {
		const addr = '64:ff9b:1:a08:8:800:808:808';
		expect(classifyAddress(addr)).toBe('rfc1918');
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1::/48' })).toBe('rfc1918');
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1:a08::/64' })).toBe('reserved');
	});

	it('shows why a too-long declaration remains exploitable', () => {
		// A conformant real /48 encoding of 10.8.8.8 has a clean suffix. A mistaken
		// /64 declaration reads 8.8.0.0 instead, so no property of the text exposes
		// the mismatch.
		const addr = encodeAt(48, [10, 8, 8, 8]);
		expect(classifyAddress(addr)).toBe('rfc1918');
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1::/48' })).toBe('rfc1918');
		expect(classifyAddress(addr, { nat64Prefix: '64:ff9b:1:a08::/64' })).toBeNull();
	});

	it('leaves a conformant address under a CORRECT declaration untouched', () => {
		// The rule must cost nothing: a conformant encoding has a zero suffix by
		// construction, at every length.
		expect(classifyAddress(nat64Embed(96, '8.8.8.8'), { nat64Prefix: '64:ff9b::/96' })).toBeNull();
		expect(classifyAddress(nat64Embed(48, '8.8.8.8'), { nat64Prefix: '64:ff9b::/48' })).toBeNull();
		// A final zero octet is still an ordinary public address under classless
		// routing. It must not trigger an ambiguous deeper reading: at /56 this
		// conformant /48 encoding happens to look like private 10.0.0.0.
		expect(classifyAddress('200.10.0.0')).toBeNull();
		expect(classifyAddress(nat64Embed(48, '200.10.0.0'), { nat64Prefix: '64:ff9b::/48' })).toBeNull();
		expect(classifyAddress(nat64Embed(56, '8.8.8.8'), { nat64Prefix: '64:ff9b::/56' })).toBeNull();
		expect(classifyAddress(nat64Embed(64, '8.8.8.8'), { nat64Prefix: '64:ff9b::/64' })).toBeNull();
		expect(classifyAddress(nat64Embed(32, '8.8.8.8'), { nat64Prefix: '64:ff9b::/32' })).toBeNull();
		// ... and a private one at the same lengths is still refused.
		expect(classifyAddress(nat64Embed(48, '169.254.169.254'), { nat64Prefix: '64:ff9b::/48' })).toBe('metadata');
	});

	it('still examines an ISATAP identifier inside a declared prefix', () => {
		// The declared branch deliberately FALLS THROUGH on a public reading rather
		// than returning, because an address can carry an ISATAP interface
		// identifier regardless of the prefix it sits under. Reachable at /96, where
		// there is no suffix and the identifier bits are part of the prefix itself.
		const decl = { nat64Prefix: '2a01:4f8:1:2:0:5efe::/96' };
		expect(classifyAddress('2a01:4f8:1:2:0:5efe:a9fe:a9fe', decl)).toBe('metadata');
		expect(classifyAddress('2a01:4f8:1:2:0:5efe:c0a8:1', decl)).toBe('rfc1918');
		expect(classifyAddress('2a01:4f8:1:2:0:5efe:7f00:1', decl)).toBe('loopback');
		// A public embedded address through the same declaration stays allowed, so
		// the identifier alone is not grounds for refusing.
		expect(classifyAddress('2a01:4f8:1:2:0:5efe:808:808', decl)).toBeNull();
	});
});
