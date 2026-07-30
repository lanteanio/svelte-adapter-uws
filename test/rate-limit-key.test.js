// How a client is turned into a rate-limit bucket.
//
// Both metered doors keyed on the full address, so an attacker with a routed
// /64 - the standard allocation from every major host and most residential
// ISPs - sourced each request from a fresh /128, never collided with itself,
// and drove either door at full server speed while the limiter recorded one
// request per identity.
// 6to4 sites receive a /48, so that transition prefix is folded one group
// further.
//
// The opposite error is worse, and most of these tests are about not making
// it: folding something that is NOT a global IPv6 address merges unrelated
// clients into one bucket. `::ffff:1.2.3.4` is what an IPv4 client looks like
// on a dual-stack listener, and its /64 is shared by the entire IPv4 internet.

import { describe, it, expect } from 'vitest';
import { rateLimitKey, createSlidingWindowLimiter } from '../src/runtime/utils/rate-limiter.js';

const KEY_LEN = 64;
const key = (ip) => rateLimitKey(ip, KEY_LEN);

describe('rateLimitKey', () => {
	describe('folds global IPv6 to its allocation prefix', () => {
		it('keeps the first four groups', () => {
			expect(key('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::');
		});

		it('gives every address in one /64 the same bucket', () => {
			// The exploit, stated as an assertion.
			expect(key('2001:db8:1:2::1')).toBe(key('2001:db8:1:2:ffff:ffff:ffff:ffff'));
		});

		it('keeps different /64s apart', () => {
			expect(key('2001:db8:1:2::1')).not.toBe(key('2001:db8:1:3::1'));
		});

		it('normalizes case, leading zeros and elision to one key', () => {
			expect(key('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::');
		});

		it('strips brackets and a port', () => {
			expect(key('[2001:db8:1:2::1]:443')).toBe('2001:db8:1:2::');
		});

		it('folds a 6to4 site to its /48 allocation', () => {
			expect(key('2002:c000:0204:1::1')).toBe('2002:c000:204::');
			expect(key('2002:c000:0204:ffff::1')).toBe('2002:c000:204::');
			expect(key('2002:c000:0204::1')).not.toBe(key('2002:c000:0205::1'));
		});
	});

	describe('never folds something that is not a global IPv6 address', () => {
		it('leaves IPv4 alone', () => {
			expect(key('203.0.113.7')).toBe('203.0.113.7');
			expect(key('203.0.113.7')).not.toBe(key('203.0.113.8'));
		});

		it('leaves IPv4-mapped IPv6 alone', () => {
			// A dual-stack listener reports every IPv4 client this way. Folding
			// it would put the whole IPv4 internet in one bucket.
			expect(key('::ffff:203.0.113.7')).not.toBe(key('::ffff:203.0.113.8'));
		});

		it('leaves the hex spelling of IPv4-mapped alone', () => {
			// Same addresses, written without the dotted tail.
			expect(key('::ffff:cb00:7107')).not.toBe(key('::ffff:cb00:7108'));
		});

		it('leaves loopback and the unspecified address alone', () => {
			expect(key('::1')).not.toBe(key('::2'));
		});

		it('leaves the expanded form uWS actually emits alone', () => {
			// On a dual-stack listener `getRemoteAddressAsText()` returns every
			// IPv4 client fully expanded, never the `::ffff:1.2.3.4` shorthand.
			// Folding that would put the whole IPv4 internet in one bucket.
			expect(key('0000:0000:0000:0000:0000:ffff:7f00:0001'))
				.not.toBe(key('0000:0000:0000:0000:0000:ffff:7f00:0002'));
		});

		it('leaves NAT64 alone, where one /64 is the whole translated IPv4 internet', () => {
			// A server behind a translator sees every IPv4 client as
			// 64:ff9b::a.b.c.d; folding would lock out every IPv4 user at the
			// tenth upgrade.
			expect(key('64:ff9b::198.51.100.7')).not.toBe(key('64:ff9b::203.0.113.9'));
			expect(key('64:ff9b:1:0:0:0:8.8.8.8')).not.toBe(key('64:ff9b:1:0:0:0:1.1.1.1'));
		});

		it('leaves Teredo alone, where the /64 identifies the relay', () => {
			expect(key('2001:0:53aa:64c:1c:2b0f:3f57:fefd'))
				.not.toBe(key('2001:0:53aa:64c:28dd:1d2c:3f57:fe01'));
		});

		it('leaves link-local alone, where one /64 is an entire LAN', () => {
			expect(key('fe80::1')).not.toBe(key('fe80::2'));
			expect(key('febf::1')).not.toBe(key('febf::2'));
		});

		it('refuses to fold a malformed tail into a real prefix', () => {
			// With ADDRESS_HEADER set the value is client-supplied, so folding a
			// crafted one would let an attacker land in a real client's bucket
			// and spend its allowance.
			expect(key('2001:db8:1:2:zz:zz:zz:zz')).not.toBe(key('2001:db8:1:2::1'));
		});


		it('refuses to fold a zone-qualified value into a real prefix', () => {
			expect(key('2001:db8:1:2::1%eth0')).not.toBe(key('2001:db8:1:2::2'));
		});

		it('refuses ignored garbage after a bracketed literal', () => {
			const victim = key('[2001:db8:1:2::1]:443');
			expect(key('[2001:db8:1:2::1]attacker')).not.toBe(victim);
			expect(key('[2001:db8:1:2::1]:not-a-port')).not.toBe(victim);
			expect(key('[2001:db8:1:2::1]:65536')).not.toBe(victim);
		});
		it('leaves IPv4 with a port alone', () => {
			expect(key('203.0.113.7:5678')).not.toBe(key('203.0.113.8:5678'));
		});

		it('leaves an opaque header value alone', () => {
			// With ADDRESS_HEADER set the value need not be an address at all.
			expect(key('user-42')).toBe('user-42');
			expect(key('a:b:c')).toBe('a:b:c');
		});

		it('leaves a malformed IPv6 alone rather than guessing', () => {
			expect(key('2001:db8:::1')).toBe('2001:db8:::1');
			expect(key('2001:db8:1:2:3:4:5:6:7:8')).toBe('2001:db8:1:2:3:4:5:6:7:8');
			expect(key('2001:db8:1:2:3:4:5:zz')).toBe('2001:db8:1:2:3:4:5:zz');
		});
	});

	it('still bounds the key length', () => {
		const long = 'x'.repeat(200);
		expect(key(long)).toHaveLength(KEY_LEN);
	});
});

describe('the limiter meters a rotating IPv6 allocation as one client', () => {
	function limiter() {
		return createSlidingWindowLimiter({
			maxPerWindow: 10,
			windowMs: 10000,
			maxEntries: 1000,
			evictionSample: 16,
			maxKeyLen: KEY_LEN
		});
	}

	it('refuses a flood sourced from fresh addresses in one /64', () => {
		const l = limiter();
		let admitted = 0;
		for (let i = 0; i < 100; i++) {
			if (!l.exceeded(`2001:db8:1:2::${i.toString(16)}`, 1000)) admitted++;
		}
		expect(admitted).toBe(10);
		expect(l.map.size).toBe(1);
	});

	it('does not let one /64 consume another /64 allowance', () => {
		const l = limiter();
		for (let i = 0; i < 100; i++) l.exceeded(`2001:db8:1:2::${i.toString(16)}`, 1000);
		expect(l.exceeded('2001:db8:1:3::1', 1000)).toBe(false);
	});

	it('refuses a flood rotating through one 6to4 /48', () => {
		const l = limiter();
		let admitted = 0;
		for (let subnet = 0; subnet < 100; subnet++) {
			if (!l.exceeded(`2002:c000:0204:${subnet.toString(16)}::1`, 1000)) admitted++;
		}
		expect(admitted).toBe(10);
		expect(l.map.size).toBe(1);
	});

	it('still meters distinct IPv4 clients separately', () => {
		// The over-merge check: 100 different IPv4 addresses are 100 buckets.
		const l = limiter();
		let admitted = 0;
		for (let i = 0; i < 100; i++) {
			if (!l.exceeded(`203.0.113.${i}`, 1000)) admitted++;
		}
		expect(admitted).toBe(100);
		expect(l.map.size).toBe(100);
	});

	it('still meters distinct IPv4-mapped clients separately', () => {
		const l = limiter();
		let admitted = 0;
		for (let i = 0; i < 100; i++) {
			if (!l.exceeded(`::ffff:203.0.113.${i}`, 1000)) admitted++;
		}
		expect(admitted).toBe(100);
	});
});
