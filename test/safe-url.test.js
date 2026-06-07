import { describe, it, expect } from 'vitest';
import { isSafeUrl, checkUrl, checkUrlResolved } from '../safe-url.js';

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
		expect(checkUrl('http://[fec0::1]/')).toEqual({ safe: true });
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
