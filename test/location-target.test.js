// The Location value of a prerendered trailing-slash redirect
// (src/runtime/utils/location-target.js).
//
// The prerendered lookup matches the DECODED path and used to redirect to it
// verbatim, so a route with a non-ASCII name answered with the raw UTF-8 bytes
// of that name in the header. The function spells the target the way a client
// spells a request target. The on-the-wire half is pinned against the built
// runtime in test/http-request-lanes.test.js.

import { describe, it, expect } from 'vitest';
import { locationTarget } from '../src/runtime/utils/location-target.js';

describe('locationTarget', () => {
	it('leaves an ASCII path and its query exactly as they are', () => {
		expect(locationTarget('/about/', '')).toBe('/about/');
		expect(locationTarget('/about', '?a=1&b=2')).toBe('/about?a=1&b=2');
		expect(locationTarget("/a-b_c.d~e!$&'()*+,;=:@/", '')).toBe("/a-b_c.d~e!$&'()*+,;=:@/");
	});

	it('percent-encodes a non-ASCII path the way a browser sends it', () => {
		expect(locationTarget('/café', '')).toBe('/caf%C3%A9');
		expect(locationTarget('/über/', '?x=1')).toBe('/%C3%BCber/?x=1');
		expect(locationTarget('/日本語', '')).toBe('/%E6%97%A5%E6%9C%AC%E8%AA%9E');
	});

	it('encodes the characters that would end or split the target', () => {
		expect(locationTarget('/a b', '')).toBe('/a%20b');
		expect(locationTarget('/a?b', '')).toBe('/a%3Fb');
		expect(locationTarget('/a#b', '')).toBe('/a%23b');
		expect(locationTarget('/100%', '')).toBe('/100%25');
		expect(locationTarget('/a"b<c>d', '')).toBe('/a%22b%3Cc%3Ed');
		expect(locationTarget('/a\u0001b', '')).toBe('/a%01b');
	});

	it('keeps the query as the client spelled it except where it cannot go on the wire', () => {
		expect(locationTarget('/a', '?q=%C3%A9')).toBe('/a?q=%C3%A9');
		expect(locationTarget('/a', '?q=a+b/c?d')).toBe('/a?q=a+b/c?d');
		expect(locationTarget('/a', '?q=é')).toBe('/a?q=%C3%A9');
		expect(locationTarget('/a', '?q=a b')).toBe('/a?q=a%20b');
		expect(locationTarget('/a', '?q=a#b')).toBe('/a?q=a%23b');
	});

	it('replaces an unpaired surrogate instead of throwing', () => {
		expect(locationTarget('/a\ud800b', '')).toBe('/a%EF%BF%BDb');
		expect(locationTarget('/a', '?q=\udc00')).toBe('/a?q=%EF%BF%BD');
	});
});
