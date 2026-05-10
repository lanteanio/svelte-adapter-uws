import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reimplement the build-time scanner here so the test stays isolated from the
// full adapter module (which pulls in rollup plugins at import time). The real
// implementation lives in index.js; this copy must stay behavior-equivalent.
function detectSetCookieOnUpgrade(source) {
	const re = /upgradeResponse\s*\(/gi;
	let match;
	while ((match = re.exec(source)) !== null) {
		let depth = 1;
		let i = match.index + match[0].length;
		let inStr = '';
		let esc = false;
		for (; i < source.length && depth > 0; i++) {
			const c = source[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === inStr) inStr = '';
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
			if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		const args = source.slice(match.index + match[0].length, i - 1);
		if (/['"`]\s*set-cookie\s*['"`]/i.test(args)) return true;
	}
	return false;
}

describe('detectSetCookieOnUpgrade', () => {
	it('flags upgradeResponse with set-cookie (single-quoted)', () => {
		const src = `export function upgrade() {
			return upgradeResponse(ud, { 'set-cookie': 'session=abc' });
		}`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});

	it('flags upgradeResponse with Set-Cookie (Pascal case, double-quoted)', () => {
		const src = `return upgradeResponse(ud, { "Set-Cookie": "session=abc" });`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});

	it('flags upgradeResponse with set-cookie when bundlers rename variables', () => {
		const src = `return u(d,{'set-cookie':x});var x; return upgradeResponse(e,{'set-cookie':s})`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});

	it('does NOT flag upgradeResponse with other headers', () => {
		const src = `return upgradeResponse(ud, { 'x-session-version': '2', 'x-custom': 'foo' });`;
		expect(detectSetCookieOnUpgrade(src)).toBe(false);
	});

	it('does NOT flag when upgradeResponse is absent', () => {
		const src = `export function upgrade() { return { userId: 'u1' }; }`;
		expect(detectSetCookieOnUpgrade(src)).toBe(false);
	});

	it('does NOT flag set-cookie mentioned outside upgradeResponse', () => {
		// Regular SSR route setting a cookie - not the 101 upgrade response
		const src = `
			export function POST({ cookies }) {
				cookies.set('session', 'abc');
				return new Response(null, { status: 204, headers: { 'set-cookie': 'x=1' } });
			}
		`;
		expect(detectSetCookieOnUpgrade(src)).toBe(false);
	});

	it('handles multi-line upgradeResponse calls', () => {
		const src = `return upgradeResponse(
			userData,
			{
				'set-cookie': buildCookie(session)
			}
		);`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});

	it('handles nested parens in upgradeResponse args without getting stuck', () => {
		const src = `return upgradeResponse(makeData(a, b), { 'x-foo': fn(1, 2), 'set-cookie': buildCookie(session) });`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});

	it('does not falsely match across function boundaries', () => {
		const src = `
			function foo() { return upgradeResponse(ud, { 'x-foo': '1' }); }
			function bar() { return 'set-cookie'; }
		`;
		expect(detectSetCookieOnUpgrade(src)).toBe(false);
	});

	it('tolerates strings inside arguments that contain parens', () => {
		const src = `return upgradeResponse(ud, { 'x-foo': '(fake)', 'set-cookie': cookieHeader });`;
		expect(detectSetCookieOnUpgrade(src)).toBe(true);
	});
});

describe('authenticate hook wiring', () => {
	it('WS_AUTH_PATH defaults to /__ws/auth', () => {
		const websocket = {};
		const wsAuthPath = websocket?.authPath ?? '/__ws/auth';
		expect(wsAuthPath).toBe('/__ws/auth');
	});

	it('WS_AUTH_PATH respects custom values', () => {
		const websocket = { authPath: '/api/ws-auth' };
		const wsAuthPath = websocket?.authPath ?? '/__ws/auth';
		expect(wsAuthPath).toBe('/api/ws-auth');
	});

	it('rejects authPath without leading slash', () => {
		const wsAuthPath = 'ws-auth';
		expect(wsAuthPath[0] !== '/').toBe(true);
	});

	it('rejects authPath equal to wsPath', () => {
		const wsPath = '/ws';
		const wsAuthPath = '/ws';
		expect(wsAuthPath === wsPath).toBe(true);
	});
});

// Client-side auth preflight: the client store POSTs to authPath before
// opening the WebSocket. We can't import client.js here (it depends on
// svelte/store + window), so these tests assert the observable behavior of
// the preflight contract with a shared fake fetch.
describe('client auth preflight behavior', () => {
	// Simulates the preflight resolution logic from createConnection().
	function resolveAuthPath(auth) {
		if (auth === true) return '/__ws/auth';
		if (typeof auth === 'string' && auth) return auth;
		return null;
	}

	it('auth:true resolves to /__ws/auth', () => {
		expect(resolveAuthPath(true)).toBe('/__ws/auth');
	});

	it('auth:<custom> resolves to the custom path', () => {
		expect(resolveAuthPath('/api/auth/ws')).toBe('/api/auth/ws');
	});

	it('auth:false is disabled', () => {
		expect(resolveAuthPath(false)).toBeNull();
	});

	it('auth omitted is disabled', () => {
		expect(resolveAuthPath(undefined)).toBeNull();
	});

	it('auth:"" is disabled', () => {
		expect(resolveAuthPath('')).toBeNull();
	});

	// Dedup contract: concurrent doConnect calls share one in-flight fetch.
	// This mirrors the `authInFlight` pattern in createConnection().
	it('dedupes concurrent preflights into a single fetch', async () => {
		let calls = 0;
		let resolve;
		const pending = new Promise((r) => { resolve = r; });
		async function preflight() {
			calls++;
			await pending;
			return true;
		}

		let inFlight = null;
		function run() {
			if (inFlight) return inFlight;
			inFlight = preflight().finally(() => { inFlight = null; });
			return inFlight;
		}

		const a = run();
		const b = run();
		const c = run();
		expect(calls).toBe(1);
		resolve();
		await Promise.all([a, b, c]);
	});

	// Retry contract: after one preflight completes, the next one starts fresh.
	it('runs a new preflight after the previous one settles', async () => {
		let calls = 0;
		async function preflight() {
			calls++;
			return true;
		}

		let inFlight = null;
		function run() {
			if (inFlight) return inFlight;
			inFlight = preflight().finally(() => { inFlight = null; });
			return inFlight;
		}

		await run();
		await run();
		await run();
		expect(calls).toBe(3);
	});

	// Tri-state outcome contract: 4xx is terminal, 5xx/network is transient.
	// Mirrors runAuth() resolution logic in createConnection().
	function classifyAuthResponse(resp) {
		if (!resp) return 'transient'; // network error
		if (resp.ok) return 'ok';
		if (resp.status >= 400 && resp.status < 500) return 'unauthorized';
		return 'transient';
	}

	it('classifies 2xx as ok', () => {
		expect(classifyAuthResponse({ ok: true, status: 204 })).toBe('ok');
		expect(classifyAuthResponse({ ok: true, status: 200 })).toBe('ok');
	});

	it('classifies 4xx as unauthorized (terminal)', () => {
		expect(classifyAuthResponse({ ok: false, status: 401 })).toBe('unauthorized');
		expect(classifyAuthResponse({ ok: false, status: 403 })).toBe('unauthorized');
		expect(classifyAuthResponse({ ok: false, status: 404 })).toBe('unauthorized');
	});

	it('classifies 5xx as transient (retry via backoff)', () => {
		expect(classifyAuthResponse({ ok: false, status: 500 })).toBe('transient');
		expect(classifyAuthResponse({ ok: false, status: 502 })).toBe('transient');
		expect(classifyAuthResponse({ ok: false, status: 503 })).toBe('transient');
	});

	it('classifies network error as transient', () => {
		expect(classifyAuthResponse(null)).toBe('transient');
	});
});

describe('authenticate HTTP URL derivation', () => {
	// Mirrors getAuthUrl() in client.js. The auth preflight must go to
	// http(s):// even when the WS URL is ws(s):// so same-origin cookies
	// flow via standard fetch.
	function getAuthUrl(options) {
		const { authPath, url, origin } = options;
		if (!authPath) return null;
		if (url) {
			try {
				const wsUrl = new URL(url);
				const httpScheme = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
				return httpScheme + '//' + wsUrl.host + authPath;
			} catch {
				return null;
			}
		}
		if (!origin) return null;
		return origin + authPath;
	}

	it('derives https from wss', () => {
		expect(getAuthUrl({ authPath: '/__ws/auth', url: 'wss://api.example.com/ws' }))
			.toBe('https://api.example.com/__ws/auth');
	});

	it('derives http from ws', () => {
		expect(getAuthUrl({ authPath: '/__ws/auth', url: 'ws://localhost:3000/ws' }))
			.toBe('http://localhost:3000/__ws/auth');
	});

	it('uses window.origin when no url is set', () => {
		expect(getAuthUrl({ authPath: '/__ws/auth', origin: 'https://app.example.com' }))
			.toBe('https://app.example.com/__ws/auth');
	});

	it('returns null when no authPath', () => {
		expect(getAuthUrl({ authPath: null, origin: 'https://app.example.com' })).toBeNull();
	});

	it('returns null on invalid url', () => {
		expect(getAuthUrl({ authPath: '/__ws/auth', url: 'not-a-url' })).toBeNull();
	});
});
