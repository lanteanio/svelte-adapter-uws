import { describe, it, expect, vi, beforeAll } from 'vitest';
import { parseCookies, serializeCookie, createCookies } from '../files/cookies.js';
import {
	mimeLookup,
	splitCookiesString,
	parse_as_bytes,
	parse_origin,
	writeChunkWithBackpressure,
	drainCoalesced,
	computePressureReason,
	nextTopicSeq,
	completeEnvelope
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

// -- decodePath (LRU decode cache) ------------------------------------------
// Inline copy of the internal handler.js function - same logic, fresh cache.

function makeDecodePath() {
	const DECODE_CACHE_MAX = 256;
	const cache = new Map();
	return function decodePath(pathname) {
		if (!pathname.includes('%')) return pathname;
		let result = cache.get(pathname);
		if (result !== undefined) return result;
		try {
			result = decodeURIComponent(pathname);
		} catch {
			result = null;
		}
		if (cache.size >= DECODE_CACHE_MAX) {
			cache.delete(cache.keys().next().value);
		}
		cache.set(pathname, result);
		return result;
	};
}

describe('decodePath', () => {
	it('returns pathname unchanged when no %', () => {
		const decodePath = makeDecodePath();
		expect(decodePath('/about')).toBe('/about');
		expect(decodePath('/')).toBe('/');
	});

	it('decodes valid percent-encoded sequences', () => {
		const decodePath = makeDecodePath();
		expect(decodePath('/hello%20world')).toBe('/hello world');
		expect(decodePath('/%C3%A9')).toBe('/é');
	});

	it('returns null for malformed percent-encoding', () => {
		const decodePath = makeDecodePath();
		expect(decodePath('/%ZZ')).toBeNull();
		expect(decodePath('/%')).toBeNull();
	});

	it('caches results (same object returned on repeated calls)', () => {
		const decodePath = makeDecodePath();
		const a = decodePath('/hello%20world');
		const b = decodePath('/hello%20world');
		expect(a).toBe(b); // same string reference from cache
	});

	it('caches null for invalid sequences', () => {
		const decodePath = makeDecodePath();
		const a = decodePath('/%ZZ');
		const b = decodePath('/%ZZ');
		expect(a).toBeNull();
		expect(b).toBeNull();
	});

	it('evicts oldest entry when cache is full', () => {
		const decodePath = makeDecodePath();
		// Fill the cache to DECODE_CACHE_MAX (256)
		for (let i = 0; i < 256; i++) {
			decodePath(`/path%20${i}`);
		}
		// Adding one more evicts the oldest (/path 0)
		decodePath('/path%20new');
		// The evicted entry is decoded again (cache miss → same result)
		expect(decodePath('/path%200')).toBe('/path 0');
	});
});

// -- esc and envelopePrefix --------------------------------------------------
// Inline copies of the internal handler.js functions.

function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

function makeEnvelopePrefix() {
	const ENVELOPE_CACHE_MAX = 256;
	const cache = new Map();
	return function envelopePrefix(topic, event) {
		const key = topic + '\0' + event;
		let prefix = cache.get(key);
		if (prefix === undefined) {
			prefix = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
			if (cache.size >= ENVELOPE_CACHE_MAX) {
				cache.delete(cache.keys().next().value);
			}
			cache.set(key, prefix);
		}
		return prefix;
	};
}

describe('esc', () => {
	it('wraps normal identifiers in quotes', () => {
		expect(esc('todos')).toBe('"todos"');
		expect(esc('created')).toBe('"created"');
	});

	it('allows hyphens, dots, and slashes', () => {
		expect(esc('my-topic')).toBe('"my-topic"');
		expect(esc('v1.chat')).toBe('"v1.chat"');
		expect(esc('room/42')).toBe('"room/42"');
	});

	it('throws for double-quote in name', () => {
		expect(() => esc('bad"name')).toThrow('invalid character');
	});

	it('throws for backslash in name', () => {
		expect(() => esc('bad\\name')).toThrow('invalid character');
	});

	it('throws for control characters', () => {
		expect(() => esc('bad\nname')).toThrow('invalid character');
		expect(() => esc('bad\x00name')).toThrow('invalid character');
	});
});

describe('envelopePrefix', () => {
	it('builds correct prefix string', () => {
		const envelopePrefix = makeEnvelopePrefix();
		expect(envelopePrefix('chat', 'created'))
			.toBe('{"topic":"chat","event":"created","data":');
	});

	it('the prefix + JSON.stringify(data) + } forms valid JSON', () => {
		const envelopePrefix = makeEnvelopePrefix();
		const prefix = envelopePrefix('todos', 'updated');
		const full = prefix + JSON.stringify({ id: 1, text: 'hello' }) + '}';
		expect(() => JSON.parse(full)).not.toThrow();
		const parsed = JSON.parse(full);
		expect(parsed.topic).toBe('todos');
		expect(parsed.event).toBe('updated');
		expect(parsed.data).toEqual({ id: 1, text: 'hello' });
	});

	it('returns the same string reference on cache hit', () => {
		const envelopePrefix = makeEnvelopePrefix();
		const a = envelopePrefix('room', 'join');
		const b = envelopePrefix('room', 'join');
		expect(a).toBe(b);
	});

	it('treats topic+event as a combined key (no cross-collision)', () => {
		const envelopePrefix = makeEnvelopePrefix();
		const a = envelopePrefix('foo', 'bar');
		const b = envelopePrefix('foob', 'ar');
		expect(a).not.toBe(b);
	});

	it('evicts oldest entry when cache is full', () => {
		const envelopePrefix = makeEnvelopePrefix();
		for (let i = 0; i < 256; i++) {
			envelopePrefix(`topic${i}`, 'event');
		}
		// One more evicts topic0/event
		envelopePrefix('topic_new', 'event');
		// topic0/event can still be computed (cache miss)
		expect(envelopePrefix('topic0', 'event'))
			.toBe('{"topic":"topic0","event":"event","data":');
	});

	it('throws when topic contains invalid characters', () => {
		const envelopePrefix = makeEnvelopePrefix();
		expect(() => envelopePrefix('bad"topic', 'event')).toThrow('invalid character');
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

// -- Sensitive userData key detection ----------------------------------------
// Inline copy of the detection predicate from the upgrade handler.

const SENSITIVE_KEY_PATTERNS = ['token', 'secret', 'password', 'key', 'session', 'credential'];

function isSensitiveKey(name) {
	const lower = name.toLowerCase();
	return SENSITIVE_KEY_PATTERNS.some((s) => lower.includes(s));
}

describe('sensitive userData key detection', () => {
	it('flags exact pattern matches', () => {
		expect(isSensitiveKey('token')).toBe(true);
		expect(isSensitiveKey('secret')).toBe(true);
		expect(isSensitiveKey('password')).toBe(true);
		expect(isSensitiveKey('key')).toBe(true);
		expect(isSensitiveKey('session')).toBe(true);
		expect(isSensitiveKey('credential')).toBe(true);
	});

	it('flags keys containing a pattern as a substring', () => {
		expect(isSensitiveKey('accessToken')).toBe(true);
		expect(isSensitiveKey('apiKey')).toBe(true);
		expect(isSensitiveKey('sessionId')).toBe(true);
		expect(isSensitiveKey('userPassword')).toBe(true);
		expect(isSensitiveKey('secretKey')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isSensitiveKey('TOKEN')).toBe(true);
		expect(isSensitiveKey('AccessToken')).toBe(true);
		expect(isSensitiveKey('SESSION_ID')).toBe(true);
	});

	it('does not flag benign keys', () => {
		expect(isSensitiveKey('userId')).toBe(false);
		expect(isSensitiveKey('role')).toBe(false);
		expect(isSensitiveKey('name')).toBe(false);
		expect(isSensitiveKey('plan')).toBe(false);
		expect(isSensitiveKey('locale')).toBe(false);
	});
});

// -- Cache trim algorithm -----------------------------------------------------
// Inline copy of the "delete oldest half when at capacity" logic.

function trimCache(cache, max) {
	if (cache.size >= max) {
		let i = 0;
		for (const k of cache.keys()) {
			if (i++ >= max / 2) break;
			cache.delete(k);
		}
	}
}

describe('cache trim (oldest-half eviction)', () => {
	it('does not trim when below capacity', () => {
		const m = new Map([['a', 1], ['b', 2]]);
		trimCache(m, 10);
		expect(m.size).toBe(2);
	});

	it('removes the oldest half when at capacity', () => {
		const m = new Map();
		for (let i = 0; i < 8; i++) m.set(`k${i}`, i);
		trimCache(m, 8);
		expect(m.size).toBe(4);
		// Newest half survives
		expect(m.has('k4')).toBe(true);
		expect(m.has('k7')).toBe(true);
		// Oldest half evicted
		expect(m.has('k0')).toBe(false);
		expect(m.has('k3')).toBe(false);
	});

	it('is a no-op when cache size is exactly half of max', () => {
		const m = new Map([['a', 1], ['b', 2]]);
		trimCache(m, 4);
		expect(m.size).toBe(2);
	});
});

// -- Worker heartbeat timeout decision ----------------------------------------
// Inline copy of the predicate used in the primary thread's heartbeat interval.

function isWorkerUnresponsive(lastHeartbeat, now, timeoutMs) {
	return lastHeartbeat > 0 && now - lastHeartbeat > timeoutMs;
}

describe('worker heartbeat timeout', () => {
	const TIMEOUT = 30000;

	it('not unresponsive when lastHeartbeat is 0 (still starting)', () => {
		expect(isWorkerUnresponsive(0, Date.now(), TIMEOUT)).toBe(false);
	});

	it('not unresponsive when last ack is within timeout window', () => {
		const now = Date.now();
		expect(isWorkerUnresponsive(now - 5000, now, TIMEOUT)).toBe(false);
	});

	it('not unresponsive exactly at timeout boundary', () => {
		const now = Date.now();
		expect(isWorkerUnresponsive(now - TIMEOUT, now, TIMEOUT)).toBe(false);
	});

	it('unresponsive when last ack is beyond timeout', () => {
		const now = Date.now();
		expect(isWorkerUnresponsive(now - TIMEOUT - 1, now, TIMEOUT)).toBe(true);
	});

	it('unresponsive when worker has been silent for much longer', () => {
		const now = Date.now();
		expect(isWorkerUnresponsive(now - 60000, now, TIMEOUT)).toBe(true);
	});
});

// -- Sliding window rate estimate ---------------------------------------------
// Inline copy of the estimate formula used in the upgrade rate limiter.

function slidingEstimate(entry, now, windowMs) {
	const elapsed = now - entry.windowStart;
	return entry.prev * (1 - elapsed / windowMs) + entry.curr;
}

describe('sliding window rate estimate', () => {
	const WINDOW = 10000; // 10s window for easy arithmetic

	it('at window start, estimate equals curr only (prev=0)', () => {
		const now = 1000000;
		const entry = { prev: 0, curr: 3, windowStart: now };
		expect(slidingEstimate(entry, now, WINDOW)).toBe(3);
	});

	it('prev contributes fully at the start of a new window', () => {
		// Just rotated: prev=5, curr=0, elapsed=0
		const now = 1000000;
		const entry = { prev: 5, curr: 0, windowStart: now };
		expect(slidingEstimate(entry, now, WINDOW)).toBe(5);
	});

	it('prev fades to half at 50% through the window', () => {
		const start = 1000000;
		const now = start + WINDOW / 2;
		const entry = { prev: 10, curr: 2, windowStart: start };
		// 10 * 0.5 + 2 = 7
		expect(slidingEstimate(entry, now, WINDOW)).toBe(7);
	});

	it('prev fades to zero at the end of the window', () => {
		const start = 1000000;
		const now = start + WINDOW;
		const entry = { prev: 10, curr: 4, windowStart: start };
		// 10 * 0 + 4 = 4
		expect(slidingEstimate(entry, now, WINDOW)).toBe(4);
	});

	it('boundary burst: end of window N + start of window N+1 is rate-limited', () => {
		// Fixed window would allow LIMIT requests at the end of window N
		// and another LIMIT at the start of window N+1.
		// Sliding window prevents this.
		const LIMIT = 5;
		const start = 1000000;
		// Fill current window to the limit right before rotation
		const entry = { prev: 0, curr: LIMIT, windowStart: start };
		// Rotate (elapsed >= WINDOW)
		const now = start + WINDOW;
		entry.prev = entry.curr;
		entry.curr = 0;
		entry.windowStart = now;
		// Immediately after rotation, elapsed=0, estimate = prev * 1 + curr = LIMIT
		const estimate = slidingEstimate(entry, now, WINDOW);
		expect(estimate).toBe(LIMIT); // not zero  - previous window still counts
		expect(estimate >= LIMIT).toBe(true); // would be rejected
	});
});

// -- Proportional jitter backoff ----------------------------------------------
// Inline copy of the delay formula from scheduleReconnect().

function getReconnectDelay(attempt, base, max) {
	const b = Math.min(base * Math.pow(1.5, attempt), max);
	const jitter = b * 0.25 * (Math.random() * 2 - 1);
	return Math.max(0, b + jitter);
}

describe('proportional jitter backoff', () => {
	it('delay is always non-negative', () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			const d = getReconnectDelay(attempt, 3000, 30000);
			expect(d).toBeGreaterThanOrEqual(0);
		}
	});

	it('delay stays within ±25% of the base, capped at max', () => {
		const BASE = 3000;
		const MAX = 30000;
		for (let attempt = 0; attempt < 20; attempt++) {
			const base = Math.min(BASE * Math.pow(1.5, attempt), MAX);
			const d = getReconnectDelay(attempt, BASE, MAX);
			expect(d).toBeGreaterThanOrEqual(0);
			// Upper bound: base + 25% jitter (base is capped at MAX already)
			expect(d).toBeLessThanOrEqual(base * 1.25 + 1); // +1 for float rounding
		}
	});

	it('jitter is proportional: spread grows with base delay', () => {
		// Sample many values at attempt=0 (base=3s) vs attempt=10 (base=30s)
		// and verify spread is proportional.
		const samples0 = Array.from({ length: 500 }, () => getReconnectDelay(0, 3000, 30000));
		const samples10 = Array.from({ length: 500 }, () => getReconnectDelay(10, 3000, 30000));
		const range0 = Math.max(...samples0) - Math.min(...samples0);
		const range10 = Math.max(...samples10) - Math.min(...samples10);
		// At attempt=0 base=3000, range ~= 1500 (±25% of 3000)
		// At attempt=10 base=30000, range ~= 15000 (±25% of 30000)
		// So range10 should be significantly larger than range0
		expect(range10).toBeGreaterThan(range0 * 3);
	});
});

// -- Close code classification ------------------------------------------------

describe('classifyCloseCode', () => {
	/** @type {(code: number | undefined) => 'TERMINAL' | 'THROTTLE' | 'RETRY'} */
	let classifyCloseCode;

	beforeAll(async () => {
		({ classifyCloseCode } = await import('../client.js'));
	});

	it('classifies 1008 (policy violation) as TERMINAL', () => {
		expect(classifyCloseCode(1008)).toBe('TERMINAL');
	});

	it('classifies 4401 (unauthorized) as TERMINAL', () => {
		expect(classifyCloseCode(4401)).toBe('TERMINAL');
	});

	it('classifies 4403 (forbidden) as TERMINAL', () => {
		expect(classifyCloseCode(4403)).toBe('TERMINAL');
	});

	it('classifies 4429 (rate limited) as THROTTLE', () => {
		expect(classifyCloseCode(4429)).toBe('THROTTLE');
	});

	it('classifies normal close codes as RETRY', () => {
		for (const code of [1000, 1001, 1006, 1011, 1012]) {
			expect(classifyCloseCode(code)).toBe('RETRY');
		}
	});

	it('classifies undefined as RETRY (best-effort retry on weird disconnect)', () => {
		expect(classifyCloseCode(undefined)).toBe('RETRY');
	});

	it('classifies arbitrary unknown codes as RETRY', () => {
		for (const code of [1002, 3000, 4000, 4500, 5000]) {
			expect(classifyCloseCode(code)).toBe('RETRY');
		}
	});
});

// -- Zombie connection detection ----------------------------------------------
// Inline copy of the predicate used in the activity timer in client.js.

function isZombieConnection(lastServerMessage, now, timeoutMs) {
	return now - lastServerMessage > timeoutMs;
}

describe('zombie connection detection', () => {
	const TIMEOUT = 150000;

	it('not a zombie when a message was just received', () => {
		const now = Date.now();
		expect(isZombieConnection(now, now, TIMEOUT)).toBe(false);
	});

	it('not a zombie within the timeout window', () => {
		const now = Date.now();
		expect(isZombieConnection(now - 60000, now, TIMEOUT)).toBe(false);
	});

	it('not a zombie exactly at the timeout boundary', () => {
		const now = Date.now();
		expect(isZombieConnection(now - TIMEOUT, now, TIMEOUT)).toBe(false);
	});

	it('zombie when server has been silent beyond the timeout', () => {
		const now = Date.now();
		expect(isZombieConnection(now - TIMEOUT - 1, now, TIMEOUT)).toBe(true);
	});

	it('zombie when connection has been dead for a long time', () => {
		const now = Date.now();
		expect(isZombieConnection(now - 300000, now, TIMEOUT)).toBe(true);
	});
});

// -- Content-Disposition for download-type static files ----------------------
// Inline copy of the extension check and header-value builder in cacheDir().

const DOWNLOAD_EXTENSIONS = new Set([
	'.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
	'.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
	'.iso', '.img', '.bin'
]);

function getContentDisposition(relPath) {
	const lastDot = relPath.lastIndexOf('.');
	const ext = lastDot >= 0 ? relPath.slice(lastDot).toLowerCase() : '';
	if (!DOWNLOAD_EXTENSIONS.has(ext)) return null;
	const slash = relPath.lastIndexOf('/');
	const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
	const safe = basename.replace(/["\\]/g, '');
	return `attachment; filename="${safe}"`;
}

describe('content-disposition for download files', () => {
	it('archive extensions get attachment header', () => {
		for (const ext of ['.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar']) {
			expect(getContentDisposition(`files/archive${ext}`)).toBe(`attachment; filename="archive${ext}"`);
		}
	});

	it('installer extensions get attachment header', () => {
		for (const ext of ['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa']) {
			expect(getContentDisposition(`dist/setup${ext}`)).toBe(`attachment; filename="setup${ext}"`);
		}
	});

	it('image/disk extensions get attachment header', () => {
		expect(getContentDisposition('releases/os.iso')).toBe('attachment; filename="os.iso"');
		expect(getContentDisposition('releases/disk.img')).toBe('attachment; filename="disk.img"');
		expect(getContentDisposition('releases/fw.bin')).toBe('attachment; filename="fw.bin"');
	});

	it('web asset extensions do not get attachment header', () => {
		for (const name of ['app.js', 'style.css', 'index.html', 'logo.png', 'font.woff2', 'data.json']) {
			expect(getContentDisposition(name)).toBeNull();
		}
	});

	it('extension check is case-insensitive', () => {
		expect(getContentDisposition('backup.ZIP')).toBe('attachment; filename="backup.ZIP"');
		expect(getContentDisposition('setup.EXE')).toBe('attachment; filename="setup.EXE"');
	});

	it('unsafe filename characters are stripped', () => {
		expect(getContentDisposition('dist/bad"name.zip')).toBe('attachment; filename="badname.zip"');
		expect(getContentDisposition('dist/back\\slash.zip')).toBe('attachment; filename="backslash.zip"');
	});

	it('filename from nested path uses only the basename', () => {
		expect(getContentDisposition('releases/v1.0/package.tar')).toBe('attachment; filename="package.tar"');
	});
});

// -- SSR dedup predicate -------------------------------------------------------
// Inline copy of the canDedup predicate from handleSSR, isolated for unit testing.
// Tests cover: which methods qualify, which headers disqualify, capacity limit.

const MAX_SSR_DEDUP = 500;

/**
 * @param {{ method: string, headers: Record<string, string> }} req
 * @param {number} inflightSize
 */
function canDedup(req, inflightSize) {
	return (
		(req.method === 'GET' || req.method === 'HEAD') &&
		!req.headers.cookie &&
		!req.headers.authorization &&
		!req.headers['x-no-dedup'] &&
		inflightSize < MAX_SSR_DEDUP
	);
}

describe('SSR dedup predicate', () => {
	it('allows GET requests with no auth headers', () => {
		expect(canDedup({ method: 'GET', headers: {} }, 0)).toBe(true);
	});

	it('allows HEAD requests with no auth headers', () => {
		expect(canDedup({ method: 'HEAD', headers: {} }, 0)).toBe(true);
	});

	it('disallows POST', () => {
		expect(canDedup({ method: 'POST', headers: {} }, 0)).toBe(false);
	});

	it('disallows PUT', () => {
		expect(canDedup({ method: 'PUT', headers: {} }, 0)).toBe(false);
	});

	it('disallows PATCH', () => {
		expect(canDedup({ method: 'PATCH', headers: {} }, 0)).toBe(false);
	});

	it('disallows DELETE', () => {
		expect(canDedup({ method: 'DELETE', headers: {} }, 0)).toBe(false);
	});

	it('disallows GET with cookie header', () => {
		expect(canDedup({ method: 'GET', headers: { cookie: 'session=abc' } }, 0)).toBe(false);
	});

	it('disallows GET with authorization header', () => {
		expect(canDedup({ method: 'GET', headers: { authorization: 'Bearer token' } }, 0)).toBe(false);
	});

	it('disallows GET with x-no-dedup header', () => {
		expect(canDedup({ method: 'GET', headers: { 'x-no-dedup': '1' } }, 0)).toBe(false);
	});

	it('disallows when map is at capacity', () => {
		expect(canDedup({ method: 'GET', headers: {} }, MAX_SSR_DEDUP)).toBe(false);
	});

	it('allows when map is one below capacity', () => {
		expect(canDedup({ method: 'GET', headers: {} }, MAX_SSR_DEDUP - 1)).toBe(true);
	});
});

// -- SSR dedup key construction ------------------------------------------------

describe('SSR dedup key', () => {
	it('includes method and url separated by NUL', () => {
		const key = 'GET' + '\0' + '/about?ref=123';
		expect(key).toBe('GET\0/about?ref=123');
	});

	it('GET and HEAD produce distinct keys for the same URL', () => {
		const getKey = 'GET' + '\0' + '/page';
		const headKey = 'HEAD' + '\0' + '/page';
		expect(getKey).not.toBe(headKey);
	});
});

// -- SSR dedup body size cap ---------------------------------------------------

describe('SSR dedup body cap', () => {
	const MAX = 512 * 1024; // 512 KB

	it('body at cap is shareable', () => {
		const ab = new ArrayBuffer(MAX);
		expect(ab.byteLength <= MAX).toBe(true);
	});

	it('body one byte over cap is not shareable', () => {
		const ab = new ArrayBuffer(MAX + 1);
		expect(ab.byteLength <= MAX).toBe(false);
	});

	it('empty body is shareable', () => {
		const ab = new ArrayBuffer(0);
		expect(ab.byteLength <= MAX).toBe(true);
	});
});

// -- SSR dedup Vary header exclusion ------------------------------------------
// Inline copy of the Vary check added to the SSR dedup leader path.

function isDedupExcludedByVary(varyHeader) {
	if (!varyHeader) return false;
	return varyHeader.toLowerCase().split(',').some(
		(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
	);
}

describe('SSR dedup Vary exclusion', () => {
	it('null Vary does not exclude', () => {
		expect(isDedupExcludedByVary(null)).toBe(false);
	});

	it('empty Vary does not exclude', () => {
		expect(isDedupExcludedByVary('')).toBe(false);
	});

	it('Vary: accept-encoding alone does not exclude', () => {
		expect(isDedupExcludedByVary('accept-encoding')).toBe(false);
	});

	it('Vary: Accept-Encoding is case-insensitive', () => {
		expect(isDedupExcludedByVary('Accept-Encoding')).toBe(false);
	});

	it('Vary: accept-language excludes from dedup', () => {
		expect(isDedupExcludedByVary('accept-language')).toBe(true);
	});

	it('Vary: * excludes from dedup', () => {
		expect(isDedupExcludedByVary('*')).toBe(true);
	});

	it('Vary: accept-encoding, accept-language excludes from dedup', () => {
		expect(isDedupExcludedByVary('accept-encoding, accept-language')).toBe(true);
	});

	it('Vary: accept-encoding only (repeated) does not exclude', () => {
		expect(isDedupExcludedByVary('accept-encoding, accept-encoding')).toBe(false);
	});

	it('Vary: x-tenant excludes from dedup', () => {
		expect(isDedupExcludedByVary('x-tenant')).toBe(true);
	});
});

// -- parseRange behavior -------------------------------------------------------
// Inline copy of parseRange from files/handler.js.

// Inline copy of parseRange from files/handler.js.
// Returns { start, end } for a valid range, null for unsatisfiable, false for syntax error.
function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	if (spec.includes(',')) return false;

	const dash = spec.indexOf('-');
	if (dash < 0) return false;

	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);

	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;

	let start, end;
	if (rawStart === '') {
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return false;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}

	if (start >= fileSize) return null;
	end = Math.min(end, fileSize - 1);
	return { start, end };
}

describe('parseRange', () => {
	it('parses a simple byte range', () => {
		expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
	});

	it('parses an open-ended range (bytes=N-)', () => {
		expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
	});

	it('parses a suffix range (bytes=-N)', () => {
		expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
	});

	it('returns false for multi-range (comma-separated)', () => {
		expect(parseRange('bytes=0-499,600-699', 1000)).toBe(false);
	});

	it('returns null for unsatisfiable range (start >= fileSize)', () => {
		expect(parseRange('bytes=1000-1099', 1000)).toBeNull();
	});

	it('returns false for bad prefix', () => {
		expect(parseRange('units=0-499', 1000)).toBe(false);
	});

	it('clamps end to fileSize - 1', () => {
		expect(parseRange('bytes=0-9999', 100)).toEqual({ start: 0, end: 99 });
	});

	it('returns false for malformed end token (bytes=0-1oops)', () => {
		expect(parseRange('bytes=0-1oops', 1000)).toBe(false);
	});

	it('returns false for malformed start token (bytes=1oops-100)', () => {
		expect(parseRange('bytes=1oops-100', 1000)).toBe(false);
	});

	it('returns false for malformed suffix token (bytes=-1oops)', () => {
		expect(parseRange('bytes=-1oops', 1000)).toBe(false);
	});

	it('accepts leading zeros (bytes=007-100 is valid per RFC grammar)', () => {
		expect(parseRange('bytes=007-100', 1000)).toEqual({ start: 7, end: 100 });
	});

	it('null and false have distinct semantics (null = 416, false = 200 fallback)', () => {
		// null: syntactically valid, start >= fileSize -> 416
		expect(parseRange('bytes=1000-1099', 1000)).toBeNull();
		// false: syntactically invalid -> 200 fallback
		expect(parseRange('bytes=0-1oops', 1000)).toBe(false);
		// both are falsy but only null should trigger 416
		expect(parseRange('bytes=1000-1099', 1000) === null).toBe(true);
		expect(parseRange('bytes=0-1oops', 1000) === false).toBe(true);
	});
});

// -- serveStatic multi-range fallback decision ---------------------------------
// Inline copy of the comma-check that gates parseRange in serveStatic.

function shouldServeFullForRange(rangeHeader) {
	return rangeHeader.includes(',');
}

describe('serveStatic multi-range fallback', () => {
	it('single range does not trigger full-content fallback', () => {
		expect(shouldServeFullForRange('bytes=0-499')).toBe(false);
	});

	it('multi-range triggers full-content fallback', () => {
		expect(shouldServeFullForRange('bytes=0-499,600-699')).toBe(true);
	});

	it('open-ended range does not trigger fallback', () => {
		expect(shouldServeFullForRange('bytes=500-')).toBe(false);
	});
});

// -- platform.publish() clustered return value ---------------------------------
// Inline copy of the return-value logic.

function publishResult(localResult, relayed) {
	return localResult || relayed;
}

describe('platform.publish clustered return value', () => {
	it('returns true when local app had subscribers', () => {
		expect(publishResult(true, false)).toBe(true);
	});

	it('returns true when relayed to other workers (even if local had none)', () => {
		expect(publishResult(false, true)).toBe(true);
	});

	it('returns true when both local and relayed delivered', () => {
		expect(publishResult(true, true)).toBe(true);
	});

	it('returns false only when no local subscribers and no relay', () => {
		expect(publishResult(false, false)).toBe(false);
	});
});

// -- resolveClientIp ----------------------------------------------------------
// Inline copy of the helper added to handler.js.

function makeResolveClientIp(address_header, xff_depth) {
	return function resolveClientIp(rawIp, headers) {
		if (!address_header) return rawIp;
		const value = headers[address_header];
		if (!value) return rawIp;
		if (address_header === 'x-forwarded-for') {
			if (value.length > 8192) return rawIp;
			const addresses = value.split(',');
			if (xff_depth > addresses.length) return rawIp;
			return addresses[addresses.length - xff_depth].trim();
		}
		return value;
	};
}

describe('resolveClientIp', () => {
	it('returns raw IP when no address_header configured', () => {
		const resolve = makeResolveClientIp('', 1);
		expect(resolve('1.2.3.4', {})).toBe('1.2.3.4');
	});

	it('returns raw IP when configured header is absent from request', () => {
		const resolve = makeResolveClientIp('x-real-ip', 1);
		expect(resolve('1.2.3.4', {})).toBe('1.2.3.4');
	});

	it('returns the configured header value for non-XFF headers', () => {
		const resolve = makeResolveClientIp('x-real-ip', 1);
		expect(resolve('10.0.0.1', { 'x-real-ip': '203.0.113.5' })).toBe('203.0.113.5');
	});

	it('returns the rightmost-N XFF address per xff_depth=1', () => {
		const resolve = makeResolveClientIp('x-forwarded-for', 1);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })).toBe('3.3.3.3');
	});

	it('returns the correct address for xff_depth=2', () => {
		const resolve = makeResolveClientIp('x-forwarded-for', 2);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })).toBe('2.2.2.2');
	});

	it('falls back to raw IP when XFF has fewer addresses than xff_depth', () => {
		const resolve = makeResolveClientIp('x-forwarded-for', 5);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1' })).toBe('10.0.0.1');
	});

	it('falls back to raw IP when XFF header is absurdly long', () => {
		const resolve = makeResolveClientIp('x-forwarded-for', 1);
		const longValue = '1.2.3.4, '.repeat(1000);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': longValue })).toBe('10.0.0.1');
	});

	it('trims whitespace from XFF result', () => {
		const resolve = makeResolveClientIp('x-forwarded-for', 1);
		expect(resolve('10.0.0.1', { 'x-forwarded-for': '1.1.1.1,  203.0.113.5  ' })).toBe('203.0.113.5');
	});
});

// -- serializeCookie --------------------------------------------------------

describe('serializeCookie', () => {
	it('serializes a minimal cookie', () => {
		expect(serializeCookie('session', 'abc')).toBe('session=abc');
	});

	it('URL-encodes the value by default', () => {
		expect(serializeCookie('name', 'a b&c')).toBe('name=a%20b%26c');
	});

	it('skips URL-encoding when encode:false', () => {
		expect(serializeCookie('name', 'raw.base64+stuff/==', { encode: false })).toBe('name=raw.base64+stuff/==');
	});

	it('adds Path, Domain, and Max-Age', () => {
		expect(serializeCookie('s', 'x', { path: '/', domain: 'example.com', maxAge: 60 }))
			.toBe('s=x; Domain=example.com; Path=/; Max-Age=60');
	});

	it('adds Expires as UTC string', () => {
		const expires = new Date('2026-04-16T12:00:00Z');
		const out = serializeCookie('s', 'x', { expires });
		expect(out).toBe('s=x; Expires=' + expires.toUTCString());
	});

	it('adds HttpOnly, Secure, and Partitioned', () => {
		expect(serializeCookie('s', 'x', { httpOnly: true, secure: true, partitioned: true }))
			.toBe('s=x; HttpOnly; Secure; Partitioned');
	});

	it('normalizes SameSite to Pascal case', () => {
		expect(serializeCookie('s', 'x', { sameSite: 'lax' })).toBe('s=x; SameSite=Lax');
		expect(serializeCookie('s', 'x', { sameSite: 'Strict' })).toBe('s=x; SameSite=Strict');
		expect(serializeCookie('s', 'x', { sameSite: 'none' })).toBe('s=x; SameSite=None');
	});

	it('maps SameSite boolean to string', () => {
		expect(serializeCookie('s', 'x', { sameSite: true })).toBe('s=x; SameSite=Strict');
		expect(serializeCookie('s', 'x', { sameSite: false })).toBe('s=x; SameSite=Lax');
	});

	it('rejects invalid SameSite values', () => {
		// @ts-expect-error intentional invalid input
		expect(() => serializeCookie('s', 'x', { sameSite: 'banana' })).toThrow('SameSite');
	});

	it('rejects invalid cookie names', () => {
		expect(() => serializeCookie('', 'x')).toThrow('Invalid cookie name');
		expect(() => serializeCookie('a b', 'x')).toThrow('Invalid cookie name');
		expect(() => serializeCookie('a;b', 'x')).toThrow('Invalid cookie name');
		expect(() => serializeCookie('a=b', 'x')).toThrow('Invalid cookie name');
	});

	it('rejects invalid values when encode:false', () => {
		expect(() => serializeCookie('s', 'a b', { encode: false })).toThrow('Invalid cookie value');
		expect(() => serializeCookie('s', 'a;b', { encode: false })).toThrow('Invalid cookie value');
	});

	it('rejects non-finite Max-Age', () => {
		expect(() => serializeCookie('s', 'x', { maxAge: Infinity })).toThrow('Max-Age');
		expect(() => serializeCookie('s', 'x', { maxAge: NaN })).toThrow('Max-Age');
	});

	it('floors fractional Max-Age', () => {
		expect(serializeCookie('s', 'x', { maxAge: 60.9 })).toBe('s=x; Max-Age=60');
	});

	it('supports the full session-cookie pattern', () => {
		const out = serializeCookie('session', 'abc.def', {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 7
		});
		expect(out).toBe('session=abc.def; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax');
	});
});

// -- createCookies ----------------------------------------------------------

describe('createCookies', () => {
	it('reads cookies from the request Cookie header', () => {
		const c = createCookies('session=abc; theme=dark');
		expect(c.get('session')).toBe('abc');
		expect(c.get('theme')).toBe('dark');
		expect(c.get('missing')).toBeUndefined();
	});

	it('returns all cookies via getAll()', () => {
		const c = createCookies('a=1; b=2');
		expect(c.getAll()).toEqual({ a: '1', b: '2' });
	});

	it('set() accumulates outgoing Set-Cookie strings', () => {
		const c = createCookies();
		c.set('a', '1');
		c.set('b', '2', { path: '/' });
		expect(c._serialize()).toEqual(['a=1', 'b=2; Path=/']);
	});

	it('set() makes subsequent get() return the new value', () => {
		const c = createCookies('a=old');
		c.set('a', 'new');
		expect(c.get('a')).toBe('new');
	});

	it('set() on the same name + path + domain overwrites', () => {
		const c = createCookies();
		c.set('session', 'first', { path: '/', httpOnly: true });
		c.set('session', 'second', { path: '/', httpOnly: true });
		const out = c._serialize();
		expect(out).toHaveLength(1);
		expect(out[0]).toContain('session=second');
	});

	it('set() on the same name but different path does NOT overwrite', () => {
		const c = createCookies();
		c.set('session', 'a', { path: '/' });
		c.set('session', 'b', { path: '/admin' });
		expect(c._serialize()).toHaveLength(2);
	});

	it('delete() emits a zero-Max-Age, expired Set-Cookie', () => {
		const c = createCookies('session=abc');
		c.delete('session', { path: '/' });
		const out = c._serialize();
		expect(out).toHaveLength(1);
		expect(out[0]).toContain('session=');
		expect(out[0]).toContain('Max-Age=0');
		expect(out[0]).toContain('Expires=Thu, 01 Jan 1970');
		expect(c.get('session')).toBeUndefined();
	});

	it('_serialize() returns a fresh array (no mutation leakage)', () => {
		const c = createCookies();
		c.set('a', '1');
		const snapshot = c._serialize();
		c.set('b', '2');
		expect(snapshot).toEqual(['a=1']);
	});

	it('handles empty or missing cookie header', () => {
		const c = createCookies();
		expect(c.getAll()).toEqual({});
		expect(c._serialize()).toEqual([]);
	});
});

// -- writeChunkWithBackpressure ---------------------------------------------

/**
 * Build a fake uWS HttpResponse that records every method call in order.
 * Tracks whether a call happens inside a cork callback so tests can assert
 * that every write and onWritable registration is corked.
 */
function makeFakeRes({ writeReturns = [true], onWritableAction = 'never' } = {}) {
	const calls = [];
	let corked = 0;
	let writeIdx = 0;
	let writableCb = null;
	const res = {
		cork(fn) {
			calls.push({ name: 'cork:enter' });
			corked++;
			try {
				fn();
			} finally {
				corked--;
				calls.push({ name: 'cork:exit' });
			}
		},
		write(value) {
			const ok = writeReturns[Math.min(writeIdx, writeReturns.length - 1)];
			writeIdx++;
			calls.push({ name: 'write', value, corked: corked > 0, ok });
			return ok;
		},
		onWritable(fn) {
			calls.push({ name: 'onWritable', corked: corked > 0 });
			writableCb = fn;
			if (onWritableAction === 'immediate') fn();
		},
		trigger() {
			if (writableCb) writableCb();
		}
	};
	return { res, calls, get corkDepth() { return corked; } };
}

describe('writeChunkWithBackpressure', () => {
	it('writes inside cork and returns true synchronously when write succeeds', () => {
		const { res, calls } = makeFakeRes({ writeReturns: [true] });
		const result = writeChunkWithBackpressure(res, 'chunk');
		expect(result).toBe(true);
		expect(calls.map((c) => c.name)).toEqual(['cork:enter', 'write', 'cork:exit']);
		expect(calls[1].corked).toBe(true);
		expect(calls[1].value).toBe('chunk');
	});

	it('does not register onWritable when write succeeds', () => {
		const { res, calls } = makeFakeRes({ writeReturns: [true] });
		writeChunkWithBackpressure(res, 'chunk');
		expect(calls.some((c) => c.name === 'onWritable')).toBe(false);
	});

	it('registers onWritable inside cork when backpressure builds', () => {
		const { res, calls } = makeFakeRes({ writeReturns: [false] });
		const result = writeChunkWithBackpressure(res, 'chunk');
		expect(result).not.toBe(true);
		expect(result).toBeInstanceOf(Promise);
		const names = calls.map((c) => c.name);
		expect(names).toEqual(['cork:enter', 'write', 'onWritable', 'cork:exit']);
		const writable = calls.find((c) => c.name === 'onWritable');
		expect(writable.corked).toBe(true);
	});

	it('returned promise resolves true when onWritable fires', async () => {
		const { res } = makeFakeRes({ writeReturns: [false] });
		const result = writeChunkWithBackpressure(res, 'chunk', 1000);
		res.trigger();
		await expect(result).resolves.toBe(true);
	});

	it('returned promise resolves false when the timeout elapses', async () => {
		vi.useFakeTimers();
		try {
			const { res } = makeFakeRes({ writeReturns: [false] });
			const result = writeChunkWithBackpressure(res, 'chunk', 50);
			vi.advanceTimersByTime(50);
			await expect(result).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears the drain timeout when onWritable fires first', async () => {
		vi.useFakeTimers();
		try {
			const { res } = makeFakeRes({ writeReturns: [false] });
			const result = writeChunkWithBackpressure(res, 'chunk', 50);
			res.trigger();
			await expect(result).resolves.toBe(true);
			vi.advanceTimersByTime(1000);
			await expect(result).resolves.toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('onWritable callback returns true so uWS keeps the handler registered', () => {
		let cbReturn;
		const res = {
			cork(fn) { fn(); },
			write() { return false; },
			onWritable(fn) { cbReturn = fn(); }
		};
		writeChunkWithBackpressure(res, 'chunk', 1000);
		expect(cbReturn).toBe(true);
	});
});

// -- drainCoalesced ---------------------------------------------------------

describe('drainCoalesced', () => {
	const SUCCESS = 0;
	const BACKPRESSURE = 1;
	const DROPPED = 2;

	function makeSender(results) {
		const sent = [];
		const queue = results.slice();
		return {
			sent,
			send: (value) => {
				sent.push(value);
				return queue.length ? queue.shift() : SUCCESS;
			}
		};
	}

	it('is a no-op on an empty map', () => {
		const pending = new Map();
		const { sent, send } = makeSender([]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([]);
		expect(pending.size).toBe(0);
	});

	it('sends every entry in insertion order on a clean drain', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, SUCCESS, SUCCESS]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2, 3]);
		expect(pending.size).toBe(0);
	});

	it('preserves the original slot when a key is overwritten', () => {
		// Reproduces the latest-wins, order-stable contract: setting an existing
		// key replaces the value but keeps the slot. A user calling sendCoalesced
		// rapid-fire on the same key never reorders the rest of the queue.
		const pending = new Map();
		pending.set('a', 1);
		pending.set('b', 2);
		pending.set('a', 99);
		const { sent, send } = makeSender([SUCCESS, SUCCESS]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([99, 2]);
	});

	it('stops on DROPPED and leaves the entry in the map for retry', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, DROPPED]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2]);
		expect([...pending]).toEqual([
			['b', 2],
			['c', 3]
		]);
	});

	it('removes the entry on BACKPRESSURE but stops pumping', () => {
		// BACKPRESSURE means uWS accepted the bytes into its buffer. The entry is
		// effectively delivered and can be removed, but we stop sending more so
		// the kernel has a chance to drain before we keep pushing.
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, BACKPRESSURE]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2]);
		expect([...pending]).toEqual([['c', 3]]);
	});

	it('resumes from where it stopped on the next call', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const first = makeSender([DROPPED]);
		drainCoalesced(pending, first.send);
		expect(first.sent).toEqual([1]);
		expect([...pending]).toEqual([
			['a', 1],
			['b', 2],
			['c', 3]
		]);

		const second = makeSender([SUCCESS, SUCCESS, SUCCESS]);
		drainCoalesced(pending, second.send);
		expect(second.sent).toEqual([1, 2, 3]);
		expect(pending.size).toBe(0);
	});

	it('overwrites coalesce target across a stalled drain', () => {
		// First flush hits backpressure and leaves 'a' pending. A new
		// sendCoalesced on the same key updates the value in place. The next
		// drain delivers the latest value, not the stale one.
		const pending = new Map();
		pending.set('a', 'v1');
		const stalled = makeSender([DROPPED]);
		drainCoalesced(pending, stalled.send);
		expect(stalled.sent).toEqual(['v1']);

		pending.set('a', 'v2');
		const resumed = makeSender([SUCCESS]);
		drainCoalesced(pending, resumed.send);
		expect(resumed.sent).toEqual(['v2']);
		expect(pending.size).toBe(0);
	});

	it('only invokes send for the latest value when serialization is deferred', () => {
		// Models the lazy-stringify path the platform method uses: the map
		// holds the unserialized triple, the send callback does the work.
		// Rapid overwrites on a single key must materialize exactly once.
		const pending = new Map();
		const stringify = vi.fn((m) => JSON.stringify(m));
		const send = (msg) => { stringify(msg); return SUCCESS; };

		pending.set('price', { v: 1 });
		pending.set('price', { v: 2 });
		pending.set('price', { v: 3 });

		drainCoalesced(pending, send);
		expect(stringify).toHaveBeenCalledTimes(1);
		expect(stringify).toHaveBeenCalledWith({ v: 3 });
	});
});

// -- computePressureReason --------------------------------------------------

describe('computePressureReason', () => {
	const thresholds = {
		memoryHeapUsedRatio: 0.85,
		publishRatePerSec: 10000,
		subscriberRatio: 50
	};
	const calm = { heapUsedRatio: 0.4, publishRate: 100, subscriberRatio: 5 };

	it('returns NONE when every signal is below its threshold', () => {
		expect(computePressureReason(calm, thresholds)).toBe('NONE');
	});

	it('returns MEMORY when heap usage crosses the threshold alone', () => {
		expect(computePressureReason(
			{ ...calm, heapUsedRatio: 0.9 },
			thresholds
		)).toBe('MEMORY');
	});

	it('returns PUBLISH_RATE when only the publish rate crosses', () => {
		expect(computePressureReason(
			{ ...calm, publishRate: 12000 },
			thresholds
		)).toBe('PUBLISH_RATE');
	});

	it('returns SUBSCRIBERS when only the subscriber ratio crosses', () => {
		expect(computePressureReason(
			{ ...calm, subscriberRatio: 80 },
			thresholds
		)).toBe('SUBSCRIBERS');
	});

	it('precedence: MEMORY beats PUBLISH_RATE and SUBSCRIBERS', () => {
		expect(computePressureReason(
			{ heapUsedRatio: 0.9, publishRate: 50000, subscriberRatio: 200 },
			thresholds
		)).toBe('MEMORY');
	});

	it('precedence: PUBLISH_RATE beats SUBSCRIBERS', () => {
		expect(computePressureReason(
			{ heapUsedRatio: 0.4, publishRate: 50000, subscriberRatio: 200 },
			thresholds
		)).toBe('PUBLISH_RATE');
	});

	it('triggers on equality (>=)', () => {
		expect(computePressureReason(
			{ heapUsedRatio: 0.85, publishRate: 0, subscriberRatio: 0 },
			thresholds
		)).toBe('MEMORY');
		expect(computePressureReason(
			{ heapUsedRatio: 0, publishRate: 10000, subscriberRatio: 0 },
			thresholds
		)).toBe('PUBLISH_RATE');
		expect(computePressureReason(
			{ heapUsedRatio: 0, publishRate: 0, subscriberRatio: 50 },
			thresholds
		)).toBe('SUBSCRIBERS');
	});

	it('respects per-signal disable via false', () => {
		// Memory disabled - even Infinity heap usage cannot fire MEMORY.
		// Publish rate fires instead.
		expect(computePressureReason(
			{ heapUsedRatio: Infinity, publishRate: 12000, subscriberRatio: 0 },
			{ ...thresholds, memoryHeapUsedRatio: false }
		)).toBe('PUBLISH_RATE');
	});

	it('returns NONE when every threshold is disabled, regardless of input', () => {
		expect(computePressureReason(
			{ heapUsedRatio: 0.99, publishRate: 1e9, subscriberRatio: 1e9 },
			{ memoryHeapUsedRatio: false, publishRatePerSec: false, subscriberRatio: false }
		)).toBe('NONE');
	});

	it('a single disabled signal does not block the others', () => {
		// Subscribers disabled, memory below, publish rate above - PUBLISH_RATE wins.
		expect(computePressureReason(
			{ heapUsedRatio: 0.4, publishRate: 12000, subscriberRatio: 9999 },
			{ ...thresholds, subscriberRatio: false }
		)).toBe('PUBLISH_RATE');
	});
});

// -- nextTopicSeq -----------------------------------------------------------

describe('nextTopicSeq', () => {
	it('starts at 1 for an unseen topic', () => {
		const map = new Map();
		expect(nextTopicSeq(map, 'todos')).toBe(1);
	});

	it('increments monotonically per topic', () => {
		const map = new Map();
		expect(nextTopicSeq(map, 'todos')).toBe(1);
		expect(nextTopicSeq(map, 'todos')).toBe(2);
		expect(nextTopicSeq(map, 'todos')).toBe(3);
	});

	it('keeps independent counters per topic', () => {
		const map = new Map();
		expect(nextTopicSeq(map, 'a')).toBe(1);
		expect(nextTopicSeq(map, 'b')).toBe(1);
		expect(nextTopicSeq(map, 'a')).toBe(2);
		expect(nextTopicSeq(map, 'b')).toBe(2);
		expect(nextTopicSeq(map, 'c')).toBe(1);
	});

	it('persists state in the supplied map', () => {
		const map = new Map();
		nextTopicSeq(map, 'todos');
		nextTopicSeq(map, 'todos');
		expect(map.get('todos')).toBe(2);
	});

	it('does not touch other map entries', () => {
		const map = new Map([['untouched', 99]]);
		nextTopicSeq(map, 'todos');
		expect(map.get('untouched')).toBe(99);
	});
});

// -- completeEnvelope -------------------------------------------------------

describe('completeEnvelope', () => {
	const prefix = '{"topic":"chat","event":"created","data":';

	it('completes an envelope without a seq when seq is null', () => {
		const out = completeEnvelope(prefix, { id: 1 }, null);
		expect(out).toBe('{"topic":"chat","event":"created","data":{"id":1}}');
		expect(JSON.parse(out)).toEqual({ topic: 'chat', event: 'created', data: { id: 1 } });
	});

	it('completes an envelope without a seq when seq is undefined', () => {
		const out = completeEnvelope(prefix, { id: 1 }, undefined);
		expect(out).toBe('{"topic":"chat","event":"created","data":{"id":1}}');
	});

	it('appends ,"seq":N before the closing brace when seq is a number', () => {
		const out = completeEnvelope(prefix, { id: 1 }, 7);
		expect(out).toBe('{"topic":"chat","event":"created","data":{"id":1},"seq":7}');
		expect(JSON.parse(out)).toEqual({ topic: 'chat', event: 'created', data: { id: 1 }, seq: 7 });
	});

	it('handles a seq of 0 as a real value (does not omit)', () => {
		// Defensive: 0 is not the disable sentinel; null/undefined is.
		const out = completeEnvelope(prefix, null, 0);
		expect(out).toBe('{"topic":"chat","event":"created","data":null,"seq":0}');
		expect(JSON.parse(out).seq).toBe(0);
	});

	it('handles undefined and null data identically (both serialize to null)', () => {
		expect(completeEnvelope(prefix, undefined, 1))
			.toBe('{"topic":"chat","event":"created","data":null,"seq":1}');
		expect(completeEnvelope(prefix, null, 1))
			.toBe('{"topic":"chat","event":"created","data":null,"seq":1}');
	});

	it('round-trips with nextTopicSeq for an end-to-end stamping flow', () => {
		// Models the production hot path: an empty map, an envelope prefix,
		// and a publish that allocates the next seq and bakes it into the
		// wire string. Three publishes to two topics should produce three
		// independently-monotonic seqs.
		const seqs = new Map();
		const wire = (topic, data) => {
			const p = '{"topic":"' + topic + '","event":"x","data":';
			return completeEnvelope(p, data, nextTopicSeq(seqs, topic));
		};

		expect(JSON.parse(wire('a', { v: 1 })).seq).toBe(1);
		expect(JSON.parse(wire('b', { v: 1 })).seq).toBe(1);
		expect(JSON.parse(wire('a', { v: 2 })).seq).toBe(2);
	});
});
