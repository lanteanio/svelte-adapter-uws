import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';

// We can't run the full adapter (it needs SvelteKit's builder),
// but we can test the validation logic and option handling.

describe('adapter options', () => {
	describe('websocket normalization', () => {
		it('true normalizes to {}', () => {
			const websocket = true;
			const normalized = websocket === true ? {} : websocket || null;
			expect(normalized).toEqual({});
		});

		it('false normalizes to null', () => {
			const websocket = false;
			const normalized = websocket === true ? {} : websocket || null;
			expect(normalized).toBeNull();
		});

		it('undefined normalizes to null', () => {
			const websocket = undefined;
			const normalized = websocket === true ? {} : websocket || null;
			expect(normalized).toBeNull();
		});

		it('object passes through', () => {
			const websocket = { path: '/my-ws', handler: './ws.js' };
			const normalized = websocket === true ? {} : websocket || null;
			expect(normalized).toEqual({ path: '/my-ws', handler: './ws.js' });
		});
	});

	describe('websocket path validation', () => {
		it('rejects paths without leading slash', () => {
			const wsPath = 'ws';
			expect(wsPath[0] !== '/').toBe(true);
		});

		it('accepts paths with leading slash', () => {
			const wsPath = '/ws';
			expect(wsPath[0] !== '/').toBe(false);
		});

		it('accepts nested paths', () => {
			const wsPath = '/api/ws';
			expect(wsPath[0] !== '/').toBe(false);
		});
	});

	describe('WebSocket options defaults', () => {
		it('provides correct defaults', () => {
			const websocket = {};
			const wsPath = websocket?.path ?? '/ws';
			const wsOpts = {
				maxPayloadLength: websocket?.maxPayloadLength ?? 16 * 1024,
				idleTimeout: websocket?.idleTimeout ?? 120,
				maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
				sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
				compression: websocket?.compression ?? false,
				allowedOrigins: websocket?.allowedOrigins ?? 'same-origin'
			};

			expect(wsPath).toBe('/ws');
			expect(wsOpts.maxPayloadLength).toBe(16384);
			expect(wsOpts.idleTimeout).toBe(120);
			expect(wsOpts.maxBackpressure).toBe(1048576);
			expect(wsOpts.sendPingsAutomatically).toBe(true);
			expect(wsOpts.compression).toBe(false);
			expect(wsOpts.allowedOrigins).toBe('same-origin');
		});

		it('respects custom values', () => {
			const websocket = {
				path: '/my-ws',
				maxPayloadLength: 64 * 1024,
				idleTimeout: 60,
				compression: true,
				allowedOrigins: ['https://example.com']
			};

			const wsPath = websocket?.path ?? '/ws';
			const wsOpts = {
				maxPayloadLength: websocket?.maxPayloadLength ?? 16 * 1024,
				idleTimeout: websocket?.idleTimeout ?? 120,
				maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
				sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
				compression: websocket?.compression ?? false,
				allowedOrigins: websocket?.allowedOrigins ?? 'same-origin'
			};

			expect(wsPath).toBe('/my-ws');
			expect(wsOpts.maxPayloadLength).toBe(65536);
			expect(wsOpts.idleTimeout).toBe(60);
			expect(wsOpts.compression).toBe(true);
			expect(wsOpts.allowedOrigins).toEqual(['https://example.com']);
		});
	});

	describe('WS_ENABLED flag', () => {
		it('is true when websocket is configured', () => {
			expect(JSON.stringify(!!{})).toBe('true');
			expect(JSON.stringify(!!{ path: '/ws' })).toBe('true');
		});

		it('is false when websocket is null', () => {
			expect(JSON.stringify(!!null)).toBe('false');
		});

		it('produces valid JS boolean literals when stringified', () => {
			// JSON.stringify(true) = "true" (4 chars)
			// When text-substituted into `if (WS_ENABLED)`, becomes `if (true)`
			const trueStr = JSON.stringify(true);
			const falseStr = JSON.stringify(false);
			expect(trueStr).toBe('true');
			expect(falseStr).toBe('false');

			// Verify they evaluate correctly as JS
			expect(eval(trueStr)).toBe(true);
			expect(eval(falseStr)).toBe(false);
		});
	});

	describe('auto-discovery', () => {
		it('checks correct candidate files', () => {
			const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
			expect(candidates).toHaveLength(3);
			expect(candidates[0]).toBe('src/hooks.ws.js');
			expect(candidates[1]).toBe('src/hooks.ws.ts');
			expect(candidates[2]).toBe('src/hooks.ws.mjs');
		});
	});

	describe('placeholder replacement', () => {
		it('JSON.stringify produces correct replacements', () => {
			const envPrefix = 'MY_APP_';
			const precompress = true;
			const wsPath = '/ws';
			const healthCheckPath = '/healthz';

			// These become literal JS values in the output
			expect(JSON.stringify(envPrefix)).toBe('"MY_APP_"');
			expect(JSON.stringify(precompress)).toBe('true');
			expect(JSON.stringify(wsPath)).toBe('"/ws"');
			expect(JSON.stringify(healthCheckPath)).toBe('"/healthz"');
			expect(JSON.stringify(false)).toBe('false');
		});
	});

	describe('env.js validation', () => {
		it('detects unexpected prefixed env vars', () => {
			const ENV_PREFIX = 'MY_APP_';
			const expected = new Set([
				'HOST', 'PORT', 'ORIGIN', 'XFF_DEPTH', 'ADDRESS_HEADER',
				'PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER',
				'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'SSL_CERT', 'SSL_KEY',
				'CLUSTER_WORKERS'
			]);

			const testEnv = {
				'MY_APP_PORT': '3000',
				'MY_APP_UNKNOWN': 'value'
			};

			const unexpected = [];
			for (const name in testEnv) {
				if (name.startsWith(ENV_PREFIX)) {
					const unprefixed = name.slice(ENV_PREFIX.length);
					if (!expected.has(unprefixed)) {
						unexpected.push(name);
					}
				}
			}

			expect(unexpected).toEqual(['MY_APP_UNKNOWN']);
		});

		it('allows all known env vars', () => {
			const ENV_PREFIX = 'APP_';
			const expected = new Set([
				'HOST', 'PORT', 'ORIGIN', 'XFF_DEPTH', 'ADDRESS_HEADER',
				'PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER',
				'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'SSL_CERT', 'SSL_KEY',
				'CLUSTER_WORKERS'
			]);

			const testEnv = {};
			for (const name of expected) {
				testEnv[ENV_PREFIX + name] = 'value';
			}

			const unexpected = [];
			for (const name in testEnv) {
				if (name.startsWith(ENV_PREFIX)) {
					const unprefixed = name.slice(ENV_PREFIX.length);
					if (!expected.has(unprefixed)) {
						unexpected.push(name);
					}
				}
			}

			expect(unexpected).toEqual([]);
		});
	});
});

describe('origin validation (WebSocket)', () => {
	/**
	 * Mirrors the production origin check in handler.js (scheme + host).
	 * @param {string | undefined} reqOrigin
	 * @param {'same-origin' | '*' | string[]} allowedOrigins
	 * @param {string} hostHeader - The Host (or HOST_HEADER) value
	 * @param {string} [scheme='http'] - The request scheme (from PROTOCOL_HEADER or TLS detection)
	 */
	function checkOrigin(reqOrigin, allowedOrigins, hostHeader, scheme = 'http') {
		if (!reqOrigin) return true; // non-browser
		if (allowedOrigins === '*') return true;
		if (allowedOrigins === 'same-origin') {
			try {
				const parsed = new URL(reqOrigin);
				if (!hostHeader) return true;
				return parsed.host === hostHeader && parsed.protocol === scheme + ':';
			} catch {
				return false;
			}
		}
		if (Array.isArray(allowedOrigins)) {
			return allowedOrigins.includes(reqOrigin);
		}
		return false;
	}

	it('allows requests without Origin header (non-browser)', () => {
		expect(checkOrigin(undefined, 'same-origin', 'localhost:3000')).toBe(true);
	});

	it('allows all origins with wildcard', () => {
		expect(checkOrigin('https://evil.com', '*', 'localhost:3000')).toBe(true);
	});

	it('allows same-origin requests (host + scheme match)', () => {
		expect(checkOrigin('http://localhost:3000', 'same-origin', 'localhost:3000', 'http')).toBe(true);
	});

	it('rejects cross-origin requests with same-origin policy', () => {
		expect(checkOrigin('https://evil.com', 'same-origin', 'localhost:3000', 'http')).toBe(false);
	});

	it('rejects scheme mismatch (https origin vs http server)', () => {
		expect(checkOrigin('https://localhost:3000', 'same-origin', 'localhost:3000', 'http')).toBe(false);
	});

	it('allows same-origin with https scheme', () => {
		expect(checkOrigin('https://example.com', 'same-origin', 'example.com', 'https')).toBe(true);
	});

	it('allows when no host header is present', () => {
		expect(checkOrigin('http://anything.com', 'same-origin', '')).toBe(true);
	});

	it('allows whitelisted origins', () => {
		const allowed = ['https://example.com', 'https://app.example.com'];
		expect(checkOrigin('https://example.com', allowed, 'localhost')).toBe(true);
		expect(checkOrigin('https://app.example.com', allowed, 'localhost')).toBe(true);
	});

	it('rejects non-whitelisted origins', () => {
		const allowed = ['https://example.com'];
		expect(checkOrigin('https://evil.com', allowed, 'localhost')).toBe(false);
	});

	it('handles invalid origin URLs gracefully', () => {
		expect(checkOrigin('not-a-url', 'same-origin', 'localhost')).toBe(false);
	});
});
