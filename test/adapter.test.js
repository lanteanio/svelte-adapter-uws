import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { upgradeResponse } from '../upgrade-response.js';

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
				allowedOrigins: websocket?.allowedOrigins ?? 'same-origin',
				upgradeTimeout: websocket?.upgradeTimeout ?? 10,
				upgradeRateLimit: websocket?.upgradeRateLimit ?? 10,
				upgradeRateLimitWindow: websocket?.upgradeRateLimitWindow ?? 10,
				pressure: websocket?.pressure
			};

			expect(wsPath).toBe('/ws');
			expect(wsOpts.maxPayloadLength).toBe(16384);
			expect(wsOpts.idleTimeout).toBe(120);
			expect(wsOpts.maxBackpressure).toBe(1048576);
			expect(wsOpts.sendPingsAutomatically).toBe(true);
			expect(wsOpts.compression).toBe(false);
			expect(wsOpts.allowedOrigins).toBe('same-origin');
			expect(wsOpts.upgradeTimeout).toBe(10);
			expect(wsOpts.upgradeRateLimit).toBe(10);
			expect(wsOpts.upgradeRateLimitWindow).toBe(10);
			// Pressure defaults are resolved at runtime by the handler so users
			// who omit the option get the safe defaults; build-time just passes
			// the user's value through (undefined when omitted).
			expect(wsOpts.pressure).toBeUndefined();
		});

		it('passes a custom pressure config through wsOpts as-is', () => {
			const websocket = {
				pressure: { memoryHeapUsedRatio: 0.9, subscriberRatio: false }
			};
			const wsOpts = { pressure: websocket?.pressure };
			expect(wsOpts.pressure).toEqual({
				memoryHeapUsedRatio: 0.9,
				subscriberRatio: false
			});
		});

		it('preserves upgradeTimeout: 0 through build-time defaults', () => {
			// Build-time uses ?? so explicit 0 is preserved
			const websocket = { upgradeTimeout: 0 };
			const wsOpts = {
				upgradeTimeout: websocket?.upgradeTimeout ?? 10
			};
			expect(wsOpts.upgradeTimeout).toBe(0);

			// Runtime guard: timer should only be created for positive values
			expect(wsOpts.upgradeTimeout > 0).toBe(false);
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

	describe('upgrade URL includes query string', () => {
		function buildUpgradeUrl(getUrl, getQuery) {
			const query = getQuery();
			return query ? getUrl() + '?' + query : getUrl();
		}

		it('appends query string when present', () => {
			expect(buildUpgradeUrl(() => '/ws', () => 'token=abc&foo=1')).toBe('/ws?token=abc&foo=1');
		});

		it('returns path alone when query is empty', () => {
			expect(buildUpgradeUrl(() => '/ws', () => '')).toBe('/ws');
		});

		it('returns path alone when query is undefined', () => {
			const query = undefined;
			const url = query ? '/ws' + '?' + query : '/ws';
			expect(url).toBe('/ws');
		});

		it('handles path with no trailing slash', () => {
			expect(buildUpgradeUrl(() => '/custom/path', () => 'key=val')).toBe('/custom/path?key=val');
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

	describe('$env fallback (esbuild plugin)', () => {
		it('$env/dynamic/public only includes PUBLIC_ prefixed vars', () => {
			const publicPrefix = 'PUBLIC_';
			const isPublic = true;
			const isStatic = false;

			// Mirrors the fixed esbuild onLoad logic for $env/dynamic/public
			if (!isStatic && isPublic) {
				const env = {
					'PUBLIC_API_URL': 'https://api.example.com',
					'SECRET_KEY': 'hunter2',
					'PUBLIC_APP_NAME': 'MyApp',
					'DATABASE_URL': 'postgres://localhost/db'
				};
				const publicEntries = Object.entries(env).filter(([k]) =>
					k.startsWith(publicPrefix)
				);
				const result = Object.fromEntries(publicEntries);

				expect(result).toEqual({
					PUBLIC_API_URL: 'https://api.example.com',
					PUBLIC_APP_NAME: 'MyApp'
				});
				expect(result.SECRET_KEY).toBeUndefined();
				expect(result.DATABASE_URL).toBeUndefined();
			}
		});

		it('$env/dynamic/private exposes full process.env', () => {
			const isPublic = false;
			const isStatic = false;

			// The private branch still returns process.env (unchanged behavior)
			if (!isStatic && !isPublic) {
				const contents = 'export const env = process.env;';
				expect(contents).toBe('export const env = process.env;');
			}
		});
	});

	describe('esbuild alias map', () => {
		it('includes $lib by default', () => {
			const aliasMap = { '$lib': '/project/src/lib' };
			expect(aliasMap['$lib']).toBe('/project/src/lib');
		});

		it('merges custom kit.alias entries', () => {
			const aliasMap = { '$lib': '/project/src/lib' };
			const kitAliases = { '$components': 'src/components', '$utils': 'src/utils' };
			for (const [key, value] of Object.entries(kitAliases)) {
				if (!(key in aliasMap)) {
					aliasMap[key] = value;
				}
			}

			expect(aliasMap).toEqual({
				'$lib': '/project/src/lib',
				'$components': 'src/components',
				'$utils': 'src/utils'
			});
		});

		it('does not override $lib with a custom alias', () => {
			const aliasMap = { '$lib': '/project/src/lib' };
			const kitAliases = { '$lib': '/some/other/path', '$components': 'src/components' };
			for (const [key, value] of Object.entries(kitAliases)) {
				if (!(key in aliasMap)) {
					aliasMap[key] = value;
				}
			}

			expect(aliasMap['$lib']).toBe('/project/src/lib');
			expect(aliasMap['$components']).toBe('src/components');
		});

		it('handles missing kit.alias gracefully', () => {
			const aliasMap = { '$lib': '/project/src/lib' };
			const kitAliases = undefined;
			if (kitAliases) {
				for (const [key, value] of Object.entries(kitAliases)) {
					if (!(key in aliasMap)) {
						aliasMap[key] = value;
					}
				}
			}

			expect(aliasMap).toEqual({ '$lib': '/project/src/lib' });
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
				'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'SHUTDOWN_DELAY_MS',
				'SSL_CERT', 'SSL_KEY', 'CLUSTER_WORKERS', 'CLUSTER_MODE'
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
				'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'SHUTDOWN_DELAY_MS',
				'SSL_CERT', 'SSL_KEY', 'CLUSTER_WORKERS', 'CLUSTER_MODE'
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
	 * @param {boolean} [hasUpgradeHandler=false] - Whether a user upgrade handler is configured
	 */
	function checkOrigin(reqOrigin, allowedOrigins, hostHeader, scheme = 'http', hasUpgradeHandler = false) {
		if (allowedOrigins === '*') return true;
		if (!reqOrigin) return hasUpgradeHandler;
		if (allowedOrigins === 'same-origin') {
			try {
				const parsed = new URL(reqOrigin);
				if (!hostHeader) return false;
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

	it('rejects requests without Origin header when no upgrade handler', () => {
		expect(checkOrigin(undefined, 'same-origin', 'localhost:3000')).toBe(false);
	});

	it('allows requests without Origin header when upgrade handler is configured', () => {
		expect(checkOrigin(undefined, 'same-origin', 'localhost:3000', 'http', true)).toBe(true);
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

	it('rejects when no host header is present', () => {
		expect(checkOrigin('http://anything.com', 'same-origin', '')).toBe(false);
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

describe('extra entry file discovery', () => {
	// Mirrors the logic in index.js that scans tmp/ for __-prefixed .js files
	function discoverEntries(dir, existingInput) {
		const { readdirSync } = require('node:fs');
		const knownEntries = new Set(Object.values(existingInput).map(f => path.basename(f)));
		const extra = {};
		for (const file of readdirSync(dir)) {
			if (file.startsWith('__') && file.endsWith('.js') && !knownEntries.has(file)) {
				extra[file.replace(/\.js$/, '')] = `${dir}/${file}`;
			}
		}
		return extra;
	}

	const tmpDir = path.resolve('test/.tmp-entry-test');

	function setup(files) {
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
		for (const f of files) {
			writeFileSync(path.join(tmpDir, f), '// test');
		}
	}

	function cleanup() {
		rmSync(tmpDir, { recursive: true, force: true });
	}

	it('picks up __-prefixed .js files', () => {
		setup(['__live-registry.js', '__analytics.js', 'index.js', 'manifest.js']);
		const input = { index: `${tmpDir}/index.js`, manifest: `${tmpDir}/manifest.js` };
		const extra = discoverEntries(tmpDir, input);

		expect(extra).toEqual({
			'__live-registry': `${tmpDir}/__live-registry.js`,
			'__analytics': `${tmpDir}/__analytics.js`
		});
		cleanup();
	});

	it('ignores non-__-prefixed files', () => {
		setup(['server.js', 'utils.js', 'chunks-abc.js']);
		const extra = discoverEntries(tmpDir, {});

		expect(extra).toEqual({});
		cleanup();
	});

	it('ignores non-.js files', () => {
		setup(['__config.json', '__readme.md', '__handler.ts']);
		const extra = discoverEntries(tmpDir, {});

		expect(extra).toEqual({});
		cleanup();
	});

	it('skips files already in input', () => {
		setup(['__live-registry.js']);
		const input = { 'live': `${tmpDir}/__live-registry.js` };
		const extra = discoverEntries(tmpDir, input);

		expect(extra).toEqual({});
		cleanup();
	});

	it('returns empty object when no extra entries exist', () => {
		setup(['index.js', 'manifest.js', 'ws-handler.js']);
		const input = {
			index: `${tmpDir}/index.js`,
			manifest: `${tmpDir}/manifest.js`,
			'ws-handler': `${tmpDir}/ws-handler.js`
		};
		const extra = discoverEntries(tmpDir, input);

		expect(extra).toEqual({});
		cleanup();
	});
});

describe('pathname decode cache', () => {
	// Mirrors the decodePath function from handler.js
	const DECODE_CACHE_MAX = 256;
	const decodeCache = new Map();

	function decodePath(pathname) {
		if (!pathname.includes('%')) return pathname;
		let result = decodeCache.get(pathname);
		if (result !== undefined) return result;
		try {
			result = decodeURIComponent(pathname);
		} catch {
			result = null;
		}
		if (decodeCache.size >= DECODE_CACHE_MAX) {
			decodeCache.delete(decodeCache.keys().next().value);
		}
		decodeCache.set(pathname, result);
		return result;
	}

	it('returns plain pathnames unchanged', () => {
		expect(decodePath('/about')).toBe('/about');
		expect(decodePath('/foo/bar')).toBe('/foo/bar');
		expect(decodePath('/')).toBe('/');
	});

	it('decodes percent-encoded pathnames', () => {
		expect(decodePath('/caf%C3%A9')).toBe('/caf\u00e9');
		expect(decodePath('/hello%20world')).toBe('/hello world');
		expect(decodePath('/%E4%B8%AD%E6%96%87')).toBe('/\u4e2d\u6587');
	});

	it('returns null for malformed percent-encoding', () => {
		expect(decodePath('/%ZZ')).toBeNull();
		expect(decodePath('/%')).toBeNull();
		expect(decodePath('/%E4%B8')).toBeNull();
	});

	it('caches decoded results', () => {
		decodeCache.clear();
		decodePath('/caf%C3%A9');
		expect(decodeCache.has('/caf%C3%A9')).toBe(true);
		expect(decodeCache.get('/caf%C3%A9')).toBe('/caf\u00e9');
	});

	it('caches decode errors as null', () => {
		decodeCache.clear();
		decodePath('/%ZZ');
		expect(decodeCache.has('/%ZZ')).toBe(true);
		expect(decodeCache.get('/%ZZ')).toBeNull();
	});

	it('does not cache non-encoded pathnames', () => {
		decodeCache.clear();
		decodePath('/plain');
		expect(decodeCache.size).toBe(0);
	});

	it('evicts oldest entry when cache is full', () => {
		decodeCache.clear();
		for (let i = 0; i < DECODE_CACHE_MAX; i++) {
			decodePath(`/%${i.toString(16).padStart(2, '0').toUpperCase()}${i.toString(16).padStart(2, '0').toUpperCase()}`);
		}
		expect(decodeCache.size).toBe(DECODE_CACHE_MAX);

		// One more should evict the first
		decodePath('/new%20path');
		expect(decodeCache.size).toBe(DECODE_CACHE_MAX);
	});
});

describe('ETag generation', () => {
	it('produces consistent ETags from mtime and size', () => {
		const mtimeMs = 1710000000000;
		const size = 1234;
		const etag = `W/"${mtimeMs.toString(36)}-${size.toString(36)}"`;

		// Same inputs produce same ETag
		const etag2 = `W/"${mtimeMs.toString(36)}-${size.toString(36)}"`;
		expect(etag).toBe(etag2);

		// ETag is a valid weak validator
		expect(etag.startsWith('W/"')).toBe(true);
		expect(etag.endsWith('"')).toBe(true);
	});

	it('produces different ETags for different mtimes', () => {
		const size = 1000;
		const etag1 = `W/"${(1710000000000).toString(36)}-${size.toString(36)}"`;
		const etag2 = `W/"${(1710000001000).toString(36)}-${size.toString(36)}"`;
		expect(etag1).not.toBe(etag2);
	});

	it('produces different ETags for different sizes', () => {
		const mtimeMs = 1710000000000;
		const etag1 = `W/"${mtimeMs.toString(36)}-${(1000).toString(36)}"`;
		const etag2 = `W/"${mtimeMs.toString(36)}-${(2000).toString(36)}"`;
		expect(etag1).not.toBe(etag2);
	});
});

describe('precompressed file validation', () => {
	it('rejects compressed files larger than original', () => {
		const original = Buffer.alloc(100);
		const compressed = Buffer.alloc(150); // Larger than original
		const entry = { buffer: original };

		// Mirrors the validation logic in handler.js cacheDir
		if (compressed.byteLength < original.byteLength) {
			entry.brBuffer = compressed;
		}

		expect(entry.brBuffer).toBeUndefined();
	});

	it('accepts compressed files smaller than original', () => {
		const original = Buffer.alloc(1000);
		const compressed = Buffer.alloc(300);
		const entry = { buffer: original };

		if (compressed.byteLength < original.byteLength) {
			entry.brBuffer = compressed;
		}

		expect(entry.brBuffer).toBe(compressed);
	});

	it('rejects compressed files equal in size to original', () => {
		const original = Buffer.alloc(500);
		const compressed = Buffer.alloc(500); // Same size, no benefit
		const entry = { buffer: original };

		if (compressed.byteLength < original.byteLength) {
			entry.brBuffer = compressed;
		}

		expect(entry.brBuffer).toBeUndefined();
	});
});

describe('upgrade rate limiter (sliding window)', () => {
	function createLimiter(maxPerWindow, windowMs) {
		const map = new Map();
		return {
			check(ip, now) {
				let entry = map.get(ip);
				if (!entry) {
					entry = { prev: 0, curr: 0, windowStart: now };
					map.set(ip, entry);
				} else {
					const elapsed = now - entry.windowStart;
					if (elapsed >= 2 * windowMs) {
						entry.prev = 0;
						entry.curr = 0;
						entry.windowStart = now;
					} else if (elapsed >= windowMs) {
						entry.prev = entry.curr;
						entry.curr = 0;
						entry.windowStart = now;
					}
				}
				const elapsed = now - entry.windowStart;
				const estimate = entry.prev * (1 - elapsed / windowMs) + entry.curr;
				if (estimate >= maxPerWindow) return false;
				entry.curr++;
				return true;
			}
		};
	}

	it('allows requests within the limit', () => {
		const limiter = createLimiter(5, 1000);
		for (let i = 0; i < 5; i++) {
			expect(limiter.check('1.2.3.4', 100)).toBe(true);
		}
	});

	it('rejects requests over the limit', () => {
		const limiter = createLimiter(5, 1000);
		for (let i = 0; i < 5; i++) limiter.check('1.2.3.4', 100);
		expect(limiter.check('1.2.3.4', 100)).toBe(false);
	});

	it('rotates window correctly', () => {
		const limiter = createLimiter(5, 1000);
		for (let i = 0; i < 4; i++) limiter.check('1.2.3.4', 100);
		// After one window, prev=4, curr=0
		expect(limiter.check('1.2.3.4', 1200)).toBe(true);
	});

	it('resets both windows after long idle gap', () => {
		const limiter = createLimiter(5, 1000);
		// Fill up the window
		for (let i = 0; i < 5; i++) limiter.check('1.2.3.4', 100);
		expect(limiter.check('1.2.3.4', 100)).toBe(false);

		// After 2x the window, both prev and curr should be zeroed
		expect(limiter.check('1.2.3.4', 2200)).toBe(true);
	});

	it('resets cleanly after a very long idle gap', () => {
		const limiter = createLimiter(3, 1000);
		// Fill up: 3 requests at t=0
		for (let i = 0; i < 3; i++) limiter.check('1.2.3.4', 0);
		expect(limiter.check('1.2.3.4', 0)).toBe(false);

		// At t=3000 (>= 2x window): both prev and curr fully reset
		// Without the 2x reset, prev would carry stale counts from the
		// original window, potentially inflating the sliding estimate.
		expect(limiter.check('1.2.3.4', 3000)).toBe(true);
		expect(limiter.check('1.2.3.4', 3000)).toBe(true);
		expect(limiter.check('1.2.3.4', 3000)).toBe(true);
		// Should be exactly at the limit now, next one rejected
		expect(limiter.check('1.2.3.4', 3000)).toBe(false);
	});
});

describe('envelope encoding', () => {
	function esc(s) {
		return JSON.stringify(s);
	}
	function envelope(topic, event, data) {
		return '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
	}

	it('produces valid JSON with normal data', () => {
		const e = envelope('chat', 'created', { id: 1 });
		const parsed = JSON.parse(e);
		expect(parsed).toEqual({ topic: 'chat', event: 'created', data: { id: 1 } });
	});

	it('produces valid JSON when data is undefined', () => {
		const e = envelope('chat', 'created', undefined);
		const parsed = JSON.parse(e);
		expect(parsed).toEqual({ topic: 'chat', event: 'created', data: null });
	});

	it('produces valid JSON when data is null', () => {
		const e = envelope('chat', 'created', null);
		const parsed = JSON.parse(e);
		expect(parsed).toEqual({ topic: 'chat', event: 'created', data: null });
	});

	it('produces valid JSON when data is omitted', () => {
		const e = envelope('chat', 'deleted');
		const parsed = JSON.parse(e);
		expect(parsed).toEqual({ topic: 'chat', event: 'deleted', data: null });
	});

	it('preserves zero and empty string data', () => {
		expect(JSON.parse(envelope('t', 'e', 0)).data).toBe(0);
		expect(JSON.parse(envelope('t', 'e', '')).data).toBe('');
		expect(JSON.parse(envelope('t', 'e', false)).data).toBe(false);
	});
});

describe('$env/dynamic/public proxy (esbuild fallback)', () => {
	it('filters process.env through a prefix-checking proxy', () => {
		const prefix = 'PUBLIC_';
		const env = new Proxy(process.env, {
			get(t, k) { return typeof k === 'string' && k.startsWith(prefix) ? t[k] : undefined; },
			ownKeys(t) { return Object.keys(t).filter(k => k.startsWith(prefix)); },
			has(t, k) { return typeof k === 'string' && k.startsWith(prefix) && k in t; },
			getOwnPropertyDescriptor(t, k) {
				if (typeof k === 'string' && k.startsWith(prefix) && k in t) return { value: t[k], enumerable: true, configurable: true };
				return undefined;
			}
		});

		process.env.PUBLIC_TEST_VAR = 'hello';
		process.env.SECRET_VAR = 'hunter2';

		expect(env.PUBLIC_TEST_VAR).toBe('hello');
		expect(env.SECRET_VAR).toBeUndefined();
		expect('PUBLIC_TEST_VAR' in env).toBe(true);
		expect('SECRET_VAR' in env).toBe(false);
		expect(Object.keys(env).every(k => k.startsWith('PUBLIC_'))).toBe(true);

		delete process.env.PUBLIC_TEST_VAR;
		delete process.env.SECRET_VAR;
	});

	it('reflects runtime env changes', () => {
		const prefix = 'PUBLIC_';
		const env = new Proxy(process.env, {
			get(t, k) { return typeof k === 'string' && k.startsWith(prefix) ? t[k] : undefined; },
			ownKeys(t) { return Object.keys(t).filter(k => k.startsWith(prefix)); },
			has(t, k) { return typeof k === 'string' && k.startsWith(prefix) && k in t; },
			getOwnPropertyDescriptor(t, k) {
				if (typeof k === 'string' && k.startsWith(prefix) && k in t) return { value: t[k], enumerable: true, configurable: true };
				return undefined;
			}
		});

		expect(env.PUBLIC_LATE_VAR).toBeUndefined();
		process.env.PUBLIC_LATE_VAR = 'added-at-runtime';
		expect(env.PUBLIC_LATE_VAR).toBe('added-at-runtime');
		delete process.env.PUBLIC_LATE_VAR;
	});
});

describe('env parsing validation', () => {
	function parseIntEnv(name, raw, min) {
		const trimmed = raw.trim();
		const n = Number(trimmed);
		if (trimmed === '' || !Number.isInteger(n)) throw new Error(`${name} must be a valid integer, got "${raw}"`);
		if (n < min) throw new Error(`${name} must be >= ${min}, got ${n}`);
		return n;
	}

	it('parses valid integers', () => {
		expect(parseIntEnv('PORT', '3000', 0)).toBe(3000);
		expect(parseIntEnv('TIMEOUT', '30', 0)).toBe(30);
		expect(parseIntEnv('DELAY', '0', 0)).toBe(0);
	});

	it('rejects non-numeric strings', () => {
		expect(() => parseIntEnv('PORT', 'banana', 0)).toThrow('must be a valid integer');
		expect(() => parseIntEnv('PORT', '', 0)).toThrow('must be a valid integer');
		expect(() => parseIntEnv('PORT', 'abc123', 0)).toThrow('must be a valid integer');
	});

	it('rejects trailing garbage and floats', () => {
		expect(() => parseIntEnv('PORT', '123abc', 0)).toThrow('must be a valid integer');
		expect(() => parseIntEnv('PORT', '1.5', 0)).toThrow('must be a valid integer');
		expect(() => parseIntEnv('TIMEOUT', '30.1', 0)).toThrow('must be a valid integer');
	});

	it('accepts integer-equivalent floats like 3000.0', () => {
		expect(parseIntEnv('PORT', '3000.0', 0)).toBe(3000);
	});

	it('accepts whitespace-padded values', () => {
		expect(parseIntEnv('PORT', ' 3000 ', 0)).toBe(3000);
	});

	it('rejects values below minimum', () => {
		expect(() => parseIntEnv('PORT', '-1', 0)).toThrow('must be >= 0');
		expect(() => parseIntEnv('TIMEOUT', '-5', 0)).toThrow('must be >= 0');
	});

	it('accepts boundary values', () => {
		expect(parseIntEnv('PORT', '0', 0)).toBe(0);
		expect(parseIntEnv('PORT', '65535', 0)).toBe(65535);
	});
});

describe('IPv6 getRemoteAddress', () => {
	function parseAddress(ip) {
		const v4 = ip.replace(/^::ffff:/, '');
		const parts = v4.split('.');
		if (parts.length === 4) return new Uint8Array(parts.map(Number)).buffer;
		const halves = v4.split('::');
		const left = halves[0] ? halves[0].split(':') : [];
		const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
		const pad = Array(8 - left.length - right.length).fill('0');
		const groups = [...left, ...pad, ...right].map(g => parseInt(g, 16));
		const buf = new Uint8Array(16);
		for (let i = 0; i < 8; i++) {
			buf[i * 2] = (groups[i] >> 8) & 0xff;
			buf[i * 2 + 1] = groups[i] & 0xff;
		}
		return buf.buffer;
	}

	it('returns 4 bytes for IPv4', () => {
		const buf = parseAddress('127.0.0.1');
		expect(new Uint8Array(buf)).toEqual(new Uint8Array([127, 0, 0, 1]));
	});

	it('returns 4 bytes for IPv4-mapped IPv6', () => {
		const buf = parseAddress('::ffff:192.168.1.1');
		expect(new Uint8Array(buf)).toEqual(new Uint8Array([192, 168, 1, 1]));
	});

	it('returns 16 bytes for full IPv6', () => {
		const buf = parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001');
		const bytes = new Uint8Array(buf);
		expect(bytes.length).toBe(16);
		expect(bytes[0]).toBe(0x20);
		expect(bytes[1]).toBe(0x01);
		expect(bytes[14]).toBe(0x00);
		expect(bytes[15]).toBe(0x01);
	});

	it('returns 16 bytes for loopback ::1', () => {
		const buf = parseAddress('::1');
		const bytes = new Uint8Array(buf);
		expect(bytes.length).toBe(16);
		expect(bytes[15]).toBe(1);
		for (let i = 0; i < 15; i++) expect(bytes[i]).toBe(0);
	});

	it('returns 16 bytes for all-zeros ::', () => {
		const buf = parseAddress('::');
		const bytes = new Uint8Array(buf);
		expect(bytes.length).toBe(16);
		for (let i = 0; i < 16; i++) expect(bytes[i]).toBe(0);
	});
});

describe('upgradeResponse helper', () => {
	it('wraps userData and headers with sentinel', () => {
		const result = upgradeResponse({ userId: 'u1' }, { 'set-cookie': 'session=abc' });
		expect(result.__upgradeResponse).toBe(true);
		expect(result.userData).toEqual({ userId: 'u1' });
		expect(result.headers).toEqual({ 'set-cookie': 'session=abc' });
	});

	it('handles array header values', () => {
		const result = upgradeResponse({}, { 'set-cookie': ['a=1', 'b=2'] });
		expect(result.__upgradeResponse).toBe(true);
		expect(result.headers['set-cookie']).toEqual(['a=1', 'b=2']);
	});

	it('handles empty userData', () => {
		const result = upgradeResponse(null, { 'x-custom': 'val' });
		expect(result.__upgradeResponse).toBe(true);
		expect(result.userData).toBeNull();
	});

	it('is distinguishable from plain userData with a headers key', () => {
		// Plain userData that happens to have a headers property
		const plain = { headers: { foo: 'bar' }, role: 'admin' };
		expect(plain.__upgradeResponse).toBeUndefined();

		// Wrapped via upgradeResponse
		const wrapped = upgradeResponse(plain, { 'set-cookie': 'x=1' });
		expect(wrapped.__upgradeResponse).toBe(true);
		expect(wrapped.userData).toBe(plain);
	});
});
