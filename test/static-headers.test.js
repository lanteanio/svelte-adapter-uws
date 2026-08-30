import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	mergeStaticHeaders,
	RESERVED_STATIC_HEADER_KEYS,
	resolveStaticCacheControl
} from '../src/runtime/utils/static-headers.js';
import { normalizeStaticCacheControl, normalizeStaticHeaders } from '../src/build-config.js';

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

describe('staticCacheControl', () => {
	it('normalizes rules by specificity and trims field values', () => {
		expect(normalizeStaticCacheControl([
			{ pattern: '/fonts/', cacheControl: ' public, max-age=86400 ' },
			{ pattern: '/fonts/versioned/', cacheControl: 'public, max-age=31536000, immutable' }
		])).toEqual([
			{ pattern: '/fonts/versioned/', cacheControl: 'public, max-age=31536000, immutable' },
			{ pattern: '/fonts/', cacheControl: 'public, max-age=86400' }
		]);
		expect(normalizeStaticCacheControl([])).toBeNull();
		expect(normalizeStaticCacheControl(null)).toBeNull();
	});

	it('matches directory trees and exact files without broadening exact names', () => {
		const rules = [
			{ pattern: '/fonts/', cacheControl: 'font-policy' },
			{ pattern: '/logo.v2.svg', cacheControl: 'logo-policy' }
		];

		expect(resolveStaticCacheControl('fonts/inter.woff2', rules)).toBe('font-policy');
		expect(resolveStaticCacheControl('/logo.v2.svg', rules)).toBe('logo-policy');
		expect(resolveStaticCacheControl('/logo.v2.svg.map', rules)).toBe('');
		expect(resolveStaticCacheControl('/pictures/hero.webp', rules)).toBe('');
	});

	it('chooses the most specific matching directory independent of rule order', () => {
		const rules = [
			{ pattern: '/', cacheControl: 'fallback' },
			{ pattern: '/fonts/private/', cacheControl: 'private' },
			{ pattern: '/fonts/', cacheControl: 'font' }
		];

		expect(resolveStaticCacheControl('/fonts/private/account.woff2', rules)).toBe('private');
		expect(resolveStaticCacheControl('/fonts/public.woff2', rules)).toBe('font');
		expect(resolveStaticCacheControl('/logo.svg', rules)).toBe('fallback');
	});

	it('rejects ambiguous or unsafe configuration', () => {
		expect(() => normalizeStaticCacheControl({ pattern: '/fonts/' })).toThrow(/must be an array/);
		expect(() => normalizeStaticCacheControl([null])).toThrow(/must be an object/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: 'fonts/', cacheControl: 'public' }
		])).toThrow(/absolute/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: '/fonts/?v=1', cacheControl: 'public' }
		])).toThrow(/query-free/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: '/fonts/*', cacheControl: 'public' }
		])).toThrow(/query-free/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: '/fonts/', cacheControl: 'public\r\nx-forged: yes' }
		])).toThrow(/single-line/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: '/fonts/', cacheControl: 'public', cacheContorl: 'typo' }
		])).toThrow(/unknown key/);
		expect(() => normalizeStaticCacheControl([
			{ pattern: '/fonts/', cacheControl: 'public' },
			{ pattern: '/fonts/', cacheControl: 'private' }
		])).toThrow(/duplicate pattern/);
	});
});

// A configured header value reaches `res.writeHeader` verbatim, so a CR or LF
// inside one ends the field on the wire and starts whatever follows - header
// injection, or a whole second response. Refused where the misconfiguration is
// written rather than sanitised where it is sent: rewriting an operator's value
// at request time would leave them believing the header they configured is the
// header being served.
describe('normalizeStaticHeaders refuses header-splitting input', () => {
	it('refuses a value carrying any byte a header value may not hold', () => {
		// CR, LF and NUL are the ones that split; VT, FF and DEL are in the class
		// because a narrower list was tried on the handshake lane and reverted -
		// it let those three onto the wire, so this package accepted values its
		// own `cookies.set()` refused and a Node-based proxy throws re-emitting.
		// The last three vectors are the ones that fail a CR/LF/NUL-only guard,
		// so they are what keeps this from silently narrowing again.
		for (const evil of [
			'DENY\r\nx-injected: 1',
			'DENY\nx-injected: 1',
			'DENY\rx-injected: 1',
			'DENY\0',
			'\r\n\r\n<html>owned</html>',
			'DENYx',
			'DENYx',
			'DENYx'
		]) {
			expect(
				() => normalizeStaticHeaders({ 'x-frame-options': evil }),
				JSON.stringify(evil)
			).toThrow(/byte a header value may not carry/);
		}
	});

	it('refuses a name that is not an RFC 9110 token', () => {
		// A name is as dangerous as a value: both are written into the same
		// header block. Held to the token grammar rather than scanned for
		// specific bytes, so the SEPARATORS are refused too - a comma, semicolon
		// or equals in a field name is what a downstream parser splits on, and a
		// guard built only from the splitting bytes would pass every one of them.
		for (const evil of [
			'x-bad\r\nx-injected', 'x bad', 'x:bad', 'x"bad', 'x\0bad', '',
			'x,bad', 'x;bad', 'x=bad', 'x(bad)', 'x/bad', 'x\\bad', 'x{bad}', 'x[bad]', 'x@bad', 'x?bad', 'x<bad>'
		]) {
			expect(
				() => normalizeStaticHeaders({ [evil]: 'v' }),
				JSON.stringify(evil)
			).toThrow(/valid HTTP field name/);
		}
	});

	it('keeps a configured __proto__ instead of dropping it into the prototype', () => {
		// `headers['__proto__'] = 'x'` on a plain object hits Object.prototype's
		// setter and is a no-op for a string, so the header would vanish with no
		// throw and no warning. `__proto__` is all tchar, so the name check
		// deliberately does not catch it - the accumulator has to be
		// null-prototype instead.
		// Computed key, because `{ __proto__: 'x' }` in a literal sets the
		// PROTOTYPE rather than an own property - the input has to carry it the
		// way a JSON config or a spread would.
		const out = normalizeStaticHeaders({ ['__proto__']: 'x', 'x-real': 'v' });
		expect(Object.keys(out.headers).sort()).toEqual(['__proto__', 'x-real']);
		expect(out.headers['__proto__'], 'a configured header was silently swallowed').toBe('x');
	});

	it('validates the name the operator wrote, not its lowercased form', () => {
		// The Kelvin sign lowercases to plain `k`, so a name checked after
		// folding would pass and then ship under a name nobody configured.
		expect(() => normalizeStaticHeaders({ 'K-foo': 'v' })).toThrow(/valid HTTP field name/);
	});

	it('still takes every name the grammar allows', () => {
		// The refusal must not cost legal punctuation - a denylist would have
		// let these through by accident, an allowlist can refuse them by
		// accident, so they are pinned.
		const ok = normalizeStaticHeaders({
			'x-frame-options': 'DENY',
			"x-weird!#$%&'*+.^_`|~-name": 'v',
			'X-Upper-Case': 'v'
		});
		expect(ok.headers['x-frame-options']).toBe('DENY');
		expect(ok.headers["x-weird!#$%&'*+.^_`|~-name"]).toBe('v');
		expect(ok.headers['x-upper-case'], 'names are lowercased as before').toBe('v');
	});

	it('refuses before the reserved-key drop, so a reserved name cannot smuggle bytes', () => {
		// The drop is a `continue`, so a reserved key checked FIRST would skip
		// the validation entirely and a value like `content-length: 0\r\n...`
		// would be silently discarded rather than reported - hiding a
		// configuration that was trying to do something dangerous.
		expect(() => normalizeStaticHeaders({ 'content-length': '0\r\nx-injected: 1' }))
			.toThrow(/byte a header value may not carry/);
	});
});

// The refusal is only worth having if the BUILD actually uses its output. The
// unit assertions above all call normalizeStaticHeaders directly, so they hold
// just as well when the build stops consulting it - swapping the placeholder to
// the raw option would ship every splitting value with the whole suite green.
// Pinned on the source, because driving a real build here would mean packing
// and installing the adapter for one line.
describe('the build serves the validated headers, not the raw option', () => {
	const indexSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

	it('feeds the STATIC_HEADERS placeholder from the normalized result', () => {
		const line = indexSource.split('\n').find((l) => l.includes('STATIC_HEADERS:'));
		expect(line, 'the STATIC_HEADERS placeholder moved').toBeTypeOf('string');
		expect(line).toContain('staticHeadersResult.headers');
		expect(line, 'the raw option must never reach the placeholder').not.toContain('opts.staticHeaders');
	});

	it('normalizes before anything is written', () => {
		// A validation that ran after the output directory was populated would
		// leave a half-written build behind on a refusal.
		const normalizeAt = indexSource.indexOf('normalizeStaticHeaders(opts.staticHeaders)');
		const placeholderAt = indexSource.indexOf('STATIC_HEADERS:');
		expect(normalizeAt, 'normalizeStaticHeaders call moved').toBeGreaterThan(-1);
		expect(placeholderAt).toBeGreaterThan(normalizeAt);
	});
});
