// The trusted attribution contract, at its own seam: resolve-once validation,
// the fail-closed refusals, the frozen result, and the public accessor.
// The three surface suites drive the same module through real connections;
// this one pins the CONTRACT - which inputs resolve, which refuse, and that
// the stored object cannot be altered after the fact.

import { describe, expect, it } from 'vitest';
import {
	attribution,
	installAttribution,
	resolveAttribution
} from '../src/runtime/utils/attribution.js';
import { WS_ATTRIBUTION } from '../src/runtime/utils/ws-symbols.js';
import { attribution as connectionAttribution } from '../src/connection.js';
import { mockWs } from './_helpers.js';

describe('resolveAttribution', () => {
	it('resolves a full result, freezes it, and keeps only the contract fields', () => {
		const resolved = resolveAttribution(
			() => ({ tenantId: 'acme', principalId: 'user_1', entitlement: 'pro' }),
			{}
		);
		expect(resolved).toEqual({ tenantId: 'acme', principalId: 'user_1', entitlement: 'pro' });
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(() => { /** @type {any} */ (resolved).tenantId = 'other'; }).toThrow();
	});

	it('hands the resolver the userData object itself, not a wrapper', () => {
		const user = { orgId: 'acme' };
		let seen = null;
		resolveAttribution((u) => { seen = u; return null; }, user);
		expect(seen).toBe(user);
	});

	it('treats absent resolver, null result, and all-absent fields as unattributed', () => {
		expect(resolveAttribution(undefined, {})).toBeNull();
		expect(resolveAttribution(null, {})).toBeNull();
		expect(resolveAttribution(() => null, {})).toBeNull();
		expect(resolveAttribution(() => undefined, {})).toBeNull();
		expect(resolveAttribution(() => ({}), {})).toBeNull();
		expect(resolveAttribution(() => ({ tenantId: null, principalId: undefined }), {})).toBeNull();
	});

	it('refuses a DEFINED non-function export instead of reading it as "no resolver"', () => {
		// `export const attribution = { tenantId: 'acme' }` - the object where
		// the resolver belongs - must not leave every connection silently
		// unattributed with every tenant-scoped limit stood down.
		for (const bad of [{ tenantId: 'acme' }, 'acme', 42, true, []]) {
			expect(() => resolveAttribution(/** @type {any} */ (bad), {}))
				.toThrow(/attribution export must be a function/);
		}
	});

	it('accepts exactly the realtime id rule and refuses everything outside it', () => {
		expect(resolveAttribution(() => ({ tenantId: 'a' }), {})).toEqual({ tenantId: 'a' });
		expect(resolveAttribution(() => ({ tenantId: 'A-Z_09' }), {})).toEqual({ tenantId: 'A-Z_09' });
		expect(resolveAttribution(() => ({ tenantId: 'x'.repeat(64) }), {}))
			.toEqual({ tenantId: 'x'.repeat(64) });
		for (const bad of ['', 'x'.repeat(65), 'has space', 'a\0b', 'a/b', 'a:b', 'ümlaut', 42, {}, true]) {
			expect(() => resolveAttribution(() => ({ tenantId: /** @type {any} */ (bad) }), {}))
				.toThrow(/attribution\.tenantId/);
		}
		expect(() => resolveAttribution(() => ({ principalId: 'no way' }), {}))
			.toThrow(/attribution\.principalId/);
		expect(() => resolveAttribution(() => ({ entitlement: 'no way' }), {}))
			.toThrow(/attribution\.entitlement/);
	});

	it('refuses a misshaped result: non-object, array, unknown field, thenable', () => {
		expect(() => resolveAttribution(() => 'acme', {})).toThrow(/must return/);
		expect(() => resolveAttribution(() => ['acme'], {})).toThrow(/must return/);
		expect(() => resolveAttribution(() => ({ tenantid: 'acme' }), {}))
			.toThrow(/unknown field "tenantid"/);
		expect(() => resolveAttribution(() => Promise.resolve({ tenantId: 'acme' }), {}))
			.toThrow(/synchronous/);
	});

	it('propagates a throwing resolver instead of absorbing it', () => {
		expect(() => resolveAttribution(() => { throw new Error('boom'); }, {})).toThrow('boom');
	});

	it('does not flood the refusal message with an oversized value', () => {
		let message = '';
		try {
			resolveAttribution(() => ({ tenantId: 'z'.repeat(10_000) }), {});
		} catch (err) {
			message = /** @type {Error} */ (err).message;
		}
		expect(message).toContain('10000 chars');
		expect(message.length).toBeLessThan(300);
	});
});

describe('installAttribution and the public accessor', () => {
	it('stamps the frozen result on the slot and the accessor reads it back', () => {
		const userData = { token: 't' };
		const installed = installAttribution(() => ({ tenantId: 'acme' }), userData);
		expect(userData[WS_ATTRIBUTION]).toBe(installed);
		const ws = mockWs(userData);
		expect(attribution(ws)).toBe(installed);
		expect(Object.isFrozen(attribution(ws))).toBe(true);
	});

	it('leaves the slot absent for an unattributed connection', () => {
		const userData = {};
		expect(installAttribution(() => null, userData)).toBeNull();
		expect(Object.getOwnPropertySymbols(userData)).not.toContain(WS_ATTRIBUTION);
		expect(attribution(mockWs(userData))).toBeNull();
	});

	it('answers null for a handle whose native side already closed', () => {
		expect(attribution({ getUserData() { throw new Error('Invalid access'); } })).toBeNull();
	});

	it('the svelte-adapter-uws/connection accessor reads the exact object the runtime installed', () => {
		// The connection subpath deliberately carries no import graph, so its
		// accessor is a second implementation over the same `Symbol.for` slot.
		// Identity of the READ object is the contract that must hold: what the
		// runtime installed is what the production subpath returns.
		const userData = {};
		const installed = installAttribution(() => ({ tenantId: 'acme', entitlement: 'pro' }), userData);
		const ws = mockWs(userData);
		expect(connectionAttribution(ws)).toBe(installed);
		expect(connectionAttribution(mockWs({}))).toBeNull();
		expect(connectionAttribution({ getUserData() { throw new Error('closed'); } })).toBeNull();
	});
});
