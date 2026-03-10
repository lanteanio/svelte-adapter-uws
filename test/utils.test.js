import { describe, it, expect } from 'vitest';
import { parseCookies } from '../files/cookies.js';
import {
	mimeLookup,
	splitCookiesString,
	parse_as_bytes,
	parse_origin
} from '../files/utils.js';

// -- parse_as_bytes ---------------------------------------------------------

describe('parse_as_bytes', () => {
	it('parses plain numbers', () => {
		expect(parse_as_bytes('512')).toBe(512);
		expect(parse_as_bytes('0')).toBe(0);
		expect(parse_as_bytes('1')).toBe(1);
	});

	it('parses K suffix', () => {
		expect(parse_as_bytes('512K')).toBe(512 * 1024);
		expect(parse_as_bytes('1K')).toBe(1024);
	});

	it('parses KB suffix', () => {
		expect(parse_as_bytes('512KB')).toBe(512 * 1024);
	});

	it('parses M suffix', () => {
		expect(parse_as_bytes('10M')).toBe(10 * 1024 * 1024);
		expect(parse_as_bytes('10MB')).toBe(10 * 1024 * 1024);
	});

	it('parses G suffix', () => {
		expect(parse_as_bytes('1G')).toBe(1024 * 1024 * 1024);
		expect(parse_as_bytes('2GB')).toBe(2 * 1024 * 1024 * 1024);
	});

	it('handles whitespace', () => {
		expect(parse_as_bytes('  512K  ')).toBe(512 * 1024);
	});

	it('is case insensitive', () => {
		expect(parse_as_bytes('512k')).toBe(512 * 1024);
		expect(parse_as_bytes('10m')).toBe(10 * 1024 * 1024);
		expect(parse_as_bytes('1g')).toBe(1024 * 1024 * 1024);
		expect(parse_as_bytes('512kb')).toBe(512 * 1024);
	});

	it('returns NaN for non-numeric input', () => {
		expect(parse_as_bytes('abc')).toBeNaN();
	});

	it('returns 0 for empty string', () => {
		expect(parse_as_bytes('')).toBe(0);
	});
});

// -- parse_origin -----------------------------------------------------------

describe('parse_origin', () => {
	it('returns undefined for undefined', () => {
		expect(parse_origin(undefined)).toBeUndefined();
	});

	it('parses valid http origin', () => {
		expect(parse_origin('http://localhost:3000')).toBe('http://localhost:3000');
	});

	it('parses valid https origin', () => {
		expect(parse_origin('https://example.com')).toBe('https://example.com');
	});

	it('strips path from origin', () => {
		expect(parse_origin('https://example.com/some/path')).toBe('https://example.com');
	});

	it('strips trailing whitespace', () => {
		expect(parse_origin('  https://example.com  ')).toBe('https://example.com');
	});

	it('throws for invalid URL', () => {
		expect(() => parse_origin('not-a-url')).toThrow('Invalid ORIGIN');
	});

	it('throws for non-http protocol', () => {
		expect(() => parse_origin('ftp://example.com')).toThrow('Only http:// and https://');
	});
});

// -- splitCookiesString -----------------------------------------------------

describe('splitCookiesString', () => {
	it('returns array as-is', () => {
		const arr = ['a=1', 'b=2'];
		expect(splitCookiesString(arr)).toBe(arr);
	});

	it('returns empty array for non-string', () => {
		expect(splitCookiesString(null)).toEqual([]);
		expect(splitCookiesString(undefined)).toEqual([]);
	});

	it('splits simple Set-Cookie values', () => {
		const result = splitCookiesString('a=1, b=2');
		expect(result).toEqual(['a=1', 'b=2']);
	});

	it('handles single cookie', () => {
		expect(splitCookiesString('session=abc123; Path=/; HttpOnly')).toEqual([
			'session=abc123; Path=/; HttpOnly'
		]);
	});

	it('handles Expires with commas (RFC date)', () => {
		const input = 'a=1; Expires=Thu, 01 Jan 2025 00:00:00 GMT, b=2';
		const result = splitCookiesString(input);
		expect(result).toEqual([
			'a=1; Expires=Thu, 01 Jan 2025 00:00:00 GMT',
			'b=2'
		]);
	});
});

// -- Cookie parsing (imported from files/cookies.js) ------------------------

describe('parseCookies', () => {
	it('returns empty object for falsy input', () => {
		expect(parseCookies(undefined)).toEqual({});
		expect(parseCookies('')).toEqual({});
	});

	it('parses simple cookies', () => {
		expect(parseCookies('a=1; b=hello')).toEqual({ a: '1', b: 'hello' });
	});

	it('handles URL-encoded values', () => {
		expect(parseCookies('name=hello%20world')).toEqual({ name: 'hello world' });
	});

	it('handles quoted values (RFC 6265)', () => {
		expect(parseCookies('session="abc123"')).toEqual({ session: 'abc123' });
	});

	it('handles values with = in them', () => {
		expect(parseCookies('data=a=b=c')).toEqual({ data: 'a=b=c' });
	});

	it('ignores pairs without =', () => {
		expect(parseCookies('noseparator')).toEqual({});
	});

	it('handles invalid percent-encoding gracefully', () => {
		expect(parseCookies('bad=%ZZ')).toEqual({ bad: '%ZZ' });
	});
});

// -- MIME lookup ------------------------------------------------------------

describe('mimeLookup', () => {
	it('returns correct MIME types', () => {
		expect(mimeLookup('style.css')).toBe('text/css');
		expect(mimeLookup('app.js')).toBe('text/javascript');
		expect(mimeLookup('data.json')).toBe('application/json');
		expect(mimeLookup('page.html')).toBe('text/html');
		expect(mimeLookup('logo.png')).toBe('image/png');
	});

	it('handles nested paths', () => {
		expect(mimeLookup('assets/fonts/Inter.woff2')).toBe('font/woff2');
	});

	it('handles multiple dots', () => {
		expect(mimeLookup('bundle.min.js')).toBe('text/javascript');
	});

	it('returns octet-stream for unknown extensions', () => {
		expect(mimeLookup('file.xyz')).toBe('application/octet-stream');
	});

	it('returns octet-stream for no extension', () => {
		expect(mimeLookup('LICENSE')).toBe('application/octet-stream');
	});

	it('is case insensitive for extension', () => {
		expect(mimeLookup('image.PNG')).toBe('image/png');
		expect(mimeLookup('style.CSS')).toBe('text/css');
	});
});

// -- get_origin (PORT_HEADER double-port fix) -------------------------------
// This function uses module-level env state in handler.js so we test
// a parameterized version here.

function get_origin(headers, { is_tls, protocol_header, host_header, port_header }) {
	const default_protocol = is_tls ? 'https' : 'http';
	const protocol = protocol_header
		? decodeURIComponent(headers[protocol_header] || default_protocol)
		: default_protocol;

	const host = (host_header && headers[host_header]) || headers['host'];
	if (!host) throw new Error('Could not determine host.');

	const port = port_header ? headers[port_header] : undefined;
	const hostWithoutPort = port ? host.replace(/:\d+$/, '') : host;

	return port ? `${protocol}://${hostWithoutPort}:${port}` : `${protocol}://${host}`;
}

describe('get_origin', () => {
	const defaults = { is_tls: false, protocol_header: '', host_header: '', port_header: '' };

	it('uses http by default', () => {
		expect(get_origin({ host: 'localhost:3000' }, defaults)).toBe('http://localhost:3000');
	});

	it('uses https for TLS', () => {
		expect(get_origin({ host: 'localhost:3000' }, { ...defaults, is_tls: true }))
			.toBe('https://localhost:3000');
	});

	it('uses protocol header', () => {
		expect(get_origin(
			{ host: 'example.com', 'x-forwarded-proto': 'https' },
			{ ...defaults, protocol_header: 'x-forwarded-proto' }
		)).toBe('https://example.com');
	});

	it('uses host header', () => {
		expect(get_origin(
			{ host: 'internal:3000', 'x-forwarded-host': 'example.com' },
			{ ...defaults, host_header: 'x-forwarded-host' }
		)).toBe('http://example.com');
	});

	it('strips existing port when PORT_HEADER is used', () => {
		expect(get_origin(
			{ host: 'example.com:3000', 'x-forwarded-port': '8080' },
			{ ...defaults, port_header: 'x-forwarded-port' }
		)).toBe('http://example.com:8080');
	});

	it('does not double-port when host has port and PORT_HEADER is used', () => {
		const result = get_origin(
			{ host: 'example.com:3000', 'x-forwarded-port': '443' },
			{ ...defaults, port_header: 'x-forwarded-port' }
		);
		expect(result).toBe('http://example.com:443');
		expect(result).not.toContain(':3000');
	});

	it('preserves host port when no PORT_HEADER', () => {
		expect(get_origin(
			{ host: 'example.com:3000' },
			defaults
		)).toBe('http://example.com:3000');
	});

	it('throws when no host header', () => {
		expect(() => get_origin({}, defaults)).toThrow('Could not determine host');
	});
});
