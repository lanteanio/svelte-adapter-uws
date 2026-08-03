import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectionSessionId } from '../src/connection.js';
import { WS_SESSION_ID } from '../src/testing.js';

describe('production connection context', () => {
	it('reads the adapter transport session without exposing its storage slot', () => {
		const userData = { [WS_SESSION_ID]: 'transport-session-7' };
		const connection = { getUserData: () => userData };
		expect(connectionSessionId(connection)).toBe('transport-session-7');
	});

	it('returns undefined for absent, malformed, and closed connection state', () => {
		expect(connectionSessionId({ getUserData: () => ({}) })).toBeUndefined();
		expect(connectionSessionId({ getUserData: () => ({ [WS_SESSION_ID]: 7 }) })).toBeUndefined();
		expect(connectionSessionId({ getUserData() { throw new Error('closed'); } })).toBeUndefined();
	});

	it('ships as a tiny production-only subpath with no import graph', async () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		expect(pkg.exports['./connection']).toEqual({
			types: './src/connection.d.ts',
			default: './src/connection.js'
		});
		const source = readFileSync(new URL('../src/connection.js', import.meta.url), 'utf8');
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toContain('./testing.js');
		expect(Object.keys(await import('../src/connection.js'))).toEqual(['connectionSessionId']);
	});
});
