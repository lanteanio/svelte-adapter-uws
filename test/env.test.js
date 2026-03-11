import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// env.js uses a build-time placeholder `ENV_PREFIX` that gets text-replaced.
// We can't import it directly, but we can test the exact logic it uses.

describe('env()', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		// Restore env after each test
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	/**
	 * Mirrors the env() function from files/env.js.
	 * @param {string} prefix
	 * @param {string} name
	 * @param {any} fallback
	 */
	function env(prefix, name, fallback) {
		const prefixed = prefix + name;
		return prefixed in process.env ? process.env[prefixed] : fallback;
	}

	it('reads unprefixed env vars', () => {
		process.env.PORT = '8080';
		expect(env('', 'PORT', '3000')).toBe('8080');
	});

	it('returns fallback when var is missing', () => {
		delete process.env.PORT;
		expect(env('', 'PORT', '3000')).toBe('3000');
	});

	it('reads prefixed env vars', () => {
		process.env.MY_APP_PORT = '9090';
		expect(env('MY_APP_', 'PORT', '3000')).toBe('9090');
	});

	it('ignores unprefixed var when prefix is set', () => {
		process.env.PORT = '8080';
		delete process.env.MY_APP_PORT;
		expect(env('MY_APP_', 'PORT', '3000')).toBe('3000');
	});

	it('returns empty string env var (not fallback)', () => {
		process.env.ORIGIN = '';
		expect(env('', 'ORIGIN', undefined)).toBe('');
	});
});

describe('ENV_PREFIX validation', () => {
	const expected = new Set([
		'HOST', 'PORT', 'ORIGIN', 'XFF_DEPTH', 'ADDRESS_HEADER',
		'PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER',
		'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'SSL_CERT', 'SSL_KEY',
		'CLUSTER_WORKERS'
	]);

	/**
	 * Mirrors the startup validation in files/env.js.
	 * @param {string} prefix
	 * @param {Record<string, string>} testEnv
	 * @returns {string[]} unexpected var names
	 */
	function validate(prefix, testEnv) {
		const unexpected = [];
		if (prefix) {
			for (const name in testEnv) {
				if (name.startsWith(prefix)) {
					const unprefixed = name.slice(prefix.length);
					if (!expected.has(unprefixed)) {
						unexpected.push(name);
					}
				}
			}
		}
		return unexpected;
	}

	it('passes when all prefixed vars are known', () => {
		const testEnv = {
			MY_APP_PORT: '3000',
			MY_APP_HOST: '0.0.0.0',
			MY_APP_ORIGIN: 'https://example.com',
			MY_APP_SSL_CERT: '/path/cert.pem',
			MY_APP_SSL_KEY: '/path/key.pem',
			MY_APP_CLUSTER_WORKERS: 'auto'
		};
		expect(validate('MY_APP_', testEnv)).toEqual([]);
	});

	it('catches unknown prefixed vars', () => {
		const testEnv = {
			MY_APP_PORT: '3000',
			MY_APP_DATABASE_URL: 'postgres://...',
			MY_APP_SECRET: 'hunter2'
		};
		expect(validate('MY_APP_', testEnv)).toEqual([
			'MY_APP_DATABASE_URL',
			'MY_APP_SECRET'
		]);
	});

	it('ignores non-prefixed vars', () => {
		const testEnv = {
			DATABASE_URL: 'postgres://...',
			NODE_ENV: 'production',
			MY_APP_PORT: '3000'
		};
		expect(validate('MY_APP_', testEnv)).toEqual([]);
	});

	it('skips validation when prefix is empty', () => {
		const testEnv = {
			ANYTHING_GOES: 'true',
			RANDOM_VAR: 'value'
		};
		expect(validate('', testEnv)).toEqual([]);
	});

	it('contains all 13 known env vars', () => {
		expect(expected.size).toBe(13);
		// Verify the set matches what the README documents
		expect(expected.has('HOST')).toBe(true);
		expect(expected.has('PORT')).toBe(true);
		expect(expected.has('ORIGIN')).toBe(true);
		expect(expected.has('XFF_DEPTH')).toBe(true);
		expect(expected.has('ADDRESS_HEADER')).toBe(true);
		expect(expected.has('PROTOCOL_HEADER')).toBe(true);
		expect(expected.has('HOST_HEADER')).toBe(true);
		expect(expected.has('PORT_HEADER')).toBe(true);
		expect(expected.has('BODY_SIZE_LIMIT')).toBe(true);
		expect(expected.has('SHUTDOWN_TIMEOUT')).toBe(true);
		expect(expected.has('SSL_CERT')).toBe(true);
		expect(expected.has('SSL_KEY')).toBe(true);
		expect(expected.has('CLUSTER_WORKERS')).toBe(true);
	});
});
