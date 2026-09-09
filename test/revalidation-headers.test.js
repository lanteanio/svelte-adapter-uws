// The 304 header set (src/runtime/utils/revalidation-headers.js), derived at
// index time from a representation's 200 tuples.
//
// A 304 used to be assembled field by field - ETag, Vary, Cache-Control,
// Last-Modified, Date - so every app-configured header (HSTS, CSP, frame and
// referrer policy) was absent on every revalidation. The served half is pinned
// in test/static-assets-negotiate.test.js against the built serveStatic.

import { describe, it, expect } from 'vitest';
import { revalidationHeaders } from '../src/runtime/utils/revalidation-headers.js';

const identity = [
	['x-content-type-options', 'nosniff'],
	['vary', 'Accept-Encoding'],
	['accept-ranges', 'bytes'],
	['cache-control', 'no-cache'],
	['etag', 'W/"abc-1"'],
	['last-modified', 'Tue, 01 Jan 2030 00:00:00 GMT'],
	['content-disposition', 'attachment; filename="a.zip"'],
	['strict-transport-security', 'max-age=63072000'],
	['content-security-policy', "default-src 'self'"]
];

describe('revalidationHeaders', () => {
	it('keeps the caching fields and every app-configured header', () => {
		const out = revalidationHeaders(identity);
		const names = out.map((t) => t[0]);
		expect(names).toEqual([
			'x-content-type-options', 'vary', 'accept-ranges', 'cache-control', 'etag',
			'last-modified', 'strict-transport-security', 'content-security-policy'
		]);
		expect(out.find((t) => t[0] === 'etag')?.[1]).toBe('W/"abc-1"');
	});

	it('drops the fields that describe a body the 304 does not carry', () => {
		const coded = identity.concat([['content-encoding', 'br']]);
		const names = revalidationHeaders(coded).map((t) => t[0]);
		expect(names).not.toContain('content-encoding');
		expect(names).not.toContain('content-disposition');
	});

	it('returns a new array and leaves the 200 tuples whole', () => {
		const before = identity.map((t) => t.slice());
		const out = revalidationHeaders(identity);
		expect(out).not.toBe(identity);
		expect(identity).toEqual(before);
	});
});
