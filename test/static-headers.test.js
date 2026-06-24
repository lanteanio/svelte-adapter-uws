import { describe, it, expect } from 'vitest';
import { mergeStaticHeaders, RESERVED_STATIC_HEADER_KEYS } from '../src/runtime/utils/static-headers.js';
import { normalizeStaticHeaders } from '../src/build-config.js';

// Base header set as cacheDir builds it for a mutable (non-immutable) asset.
function baseHeaders() {
	return /** @type {[string,string][]} */ ([
		['x-content-type-options', 'nosniff'],
		['vary', 'Accept-Encoding'],
		['accept-ranges', 'bytes'],
		['cache-control', 'no-cache'],
		['etag', 'W/"abc-123"']
	]);
}

describe('mergeStaticHeaders (runtime)', () => {
	it('returns the base array unchanged when no staticHeaders are configured', () => {
		const base = baseHeaders();
		expect(mergeStaticHeaders(base, null)).toBe(base);
		expect(mergeStaticHeaders(base, undefined)).toBe(base);
	});

	it('appends new app headers (CSP, HSTS, X-Frame-Options, ...)', () => {
		const merged = mergeStaticHeaders(baseHeaders(), {
			'content-security-policy': "default-src 'self'",
			'strict-transport-security': 'max-age=63072000',
			'x-frame-options': 'DENY'
		});
		const map = Object.fromEntries(merged);
		expect(map['content-security-policy']).toBe("default-src 'self'");
		expect(map['strict-transport-security']).toBe('max-age=63072000');
		expect(map['x-frame-options']).toBe('DENY');
	});

	it('lowercases keys', () => {
		const merged = mergeStaticHeaders(baseHeaders(), { 'X-Frame-Options': 'SAMEORIGIN' });
		expect(merged.some((t) => t[0] === 'x-frame-options' && t[1] === 'SAMEORIGIN')).toBe(true);
		expect(merged.some((t) => t[0] === 'X-Frame-Options')).toBe(false);
	});

	it('replaces an existing non-reserved header in place (user intent wins, no duplicate)', () => {
		const merged = mergeStaticHeaders(baseHeaders(), { 'x-content-type-options': 'nosniff' });
		const hits = merged.filter((t) => t[0] === 'x-content-type-options');
		expect(hits).toHaveLength(1);
		expect(hits[0][1]).toBe('nosniff');
	});

	it('never overrides reserved transfer/caching headers', () => {
		const merged = mergeStaticHeaders(baseHeaders(), {
			'content-type': 'text/evil',
			'content-encoding': 'identity',
			etag: 'W/"forged"',
			'cache-control': 'no-store',
			vary: 'Cookie',
			'accept-ranges': 'none'
		});
		const map = Object.fromEntries(merged);
		expect(map['cache-control']).toBe('no-cache'); // base preserved
		expect(map['vary']).toBe('Accept-Encoding'); // base preserved
		expect(map['accept-ranges']).toBe('bytes');
		expect(map['etag']).toBe('W/"abc-123"');
		// content-type / content-encoding are written per-response by serveStatic,
		// so they must never leak into the entry tuple loop as a duplicate.
		expect(merged.some((t) => t[0] === 'content-type')).toBe(false);
		expect(merged.some((t) => t[0] === 'content-encoding')).toBe(false);
	});

	it('does not mutate the input base array', () => {
		const base = baseHeaders();
		const snapshot = JSON.parse(JSON.stringify(base));
		mergeStaticHeaders(base, { 'x-frame-options': 'DENY', 'x-content-type-options': 'off' });
		expect(base).toEqual(snapshot);
	});
});

describe('normalizeStaticHeaders (build)', () => {
	it('returns null for null/undefined input', () => {
		expect(normalizeStaticHeaders(undefined)).toEqual({ headers: null, dropped: [] });
		expect(normalizeStaticHeaders(null)).toEqual({ headers: null, dropped: [] });
	});

	it('lowercases keys and keeps string values', () => {
		const { headers, dropped } = normalizeStaticHeaders({
			'X-Frame-Options': 'DENY',
			'Referrer-Policy': 'strict-origin-when-cross-origin'
		});
		expect(headers).toEqual({
			'x-frame-options': 'DENY',
			'referrer-policy': 'strict-origin-when-cross-origin'
		});
		expect(dropped).toEqual([]);
	});

	it('strips reserved keys and reports them in `dropped`', () => {
		const { headers, dropped } = normalizeStaticHeaders({
			'x-frame-options': 'DENY',
			'Cache-Control': 'no-store',
			'content-type': 'text/plain'
		});
		expect(headers).toEqual({ 'x-frame-options': 'DENY' });
		expect(dropped.sort()).toEqual(['cache-control', 'content-type']);
	});

	it('returns null headers when only reserved keys were supplied', () => {
		const { headers, dropped } = normalizeStaticHeaders({ etag: 'W/"x"' });
		expect(headers).toBeNull();
		expect(dropped).toEqual(['etag']);
	});

	it('throws on a non-object value', () => {
		expect(() => normalizeStaticHeaders('x-frame-options: DENY')).toThrow(/must be an object/);
		expect(() => normalizeStaticHeaders([['x', 'y']])).toThrow(/must be an object/);
	});

	it('throws on a non-string header value', () => {
		expect(() => normalizeStaticHeaders({ 'x-frame-options': 123 })).toThrow(/must be a string/);
		expect(() => normalizeStaticHeaders({ csp: { nested: true } })).toThrow(/must be a string/);
	});

	it('every reserved key is rejected by the normalizer', () => {
		for (const key of RESERVED_STATIC_HEADER_KEYS) {
			const { headers, dropped } = normalizeStaticHeaders({ [key]: 'x' });
			expect(headers).toBeNull();
			expect(dropped).toEqual([key]);
		}
	});
});
