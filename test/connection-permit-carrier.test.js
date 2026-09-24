import { describe, it, expect, afterEach } from 'vitest';
import { createConnectionPermitCarrier } from '../src/runtime/utils/connection-permit.js';
import { WS_CONNECTION_PERMIT } from '../src/runtime/utils/ws-symbols.js';

/**
 * The copy uWS makes across `res.upgrade()`: every enumerable own property,
 * Symbol keys included, assigned onto a fresh object. An assignment is a
 * [[Set]], so an accessor on Object.prototype for a copied key takes the value.
 */
function upgradeCopy(userData) {
	const opened = {};
	for (const key of Reflect.ownKeys(userData)) {
		if (Object.getOwnPropertyDescriptor(userData, key).enumerable) opened[key] = userData[key];
	}
	return opened;
}

/** String keys an earlier carrier rode on, and an accessor that swallows each. */
const OLD_KEYS = ['__adapter_uws_connection_permit__', '__adapter_uws_request_id__', '__uwsTraceContext'];

afterEach(() => {
	for (const key of OLD_KEYS) delete Object.prototype[key];
});

describe('connection permit upgrade carrier', () => {
	it('carries the permit across the copy and leaves no slot behind', () => {
		const carrier = createConnectionPermitCarrier();
		const source = { app: 1 };
		carrier.install(source);
		const opened = upgradeCopy(source);
		expect(carrier.restore(opened)).toBe(true);
		expect(opened[WS_CONNECTION_PERMIT]).toBe(true);
		expect(Reflect.ownKeys(opened)).toEqual(['app', WS_CONNECTION_PERMIT]);
	});

	it('arrives although an accessor on Object.prototype takes every key an application can name', () => {
		// The interception the carrier exists to be immune to: the value goes to
		// the accessor and the far side is left without it. A key nobody can name
		// is a key nobody can install an accessor for.
		const taken = [];
		for (const key of OLD_KEYS) {
			Object.defineProperty(Object.prototype, key, { configurable: true, set(v) { taken.push(key); }, get() { return undefined; } });
		}
		const control = upgradeCopy({ __adapter_uws_connection_permit__: 'marker' });
		expect(Object.hasOwn(control, '__adapter_uws_connection_permit__'), 'the premise: a string key is taken').toBe(false);
		expect(taken).toEqual(['__adapter_uws_connection_permit__']);

		const carrier = createConnectionPermitCarrier();
		const source = {};
		carrier.install(source);
		expect(carrier.restore(upgradeCopy(source))).toBe(true);
	});

	it('keeps an application property of any name and shape untouched', () => {
		const carrier = createConnectionPermitCarrier();
		const source = {};
		const descriptor = { value: Object.freeze({ owner: 'application' }), writable: false, enumerable: true, configurable: false };
		Object.defineProperty(source, '__adapter_uws_connection_permit__', descriptor);
		carrier.install(source);
		expect(Object.getOwnPropertyDescriptor(source, '__adapter_uws_connection_permit__')).toEqual(descriptor);
		const opened = upgradeCopy(source);
		expect(carrier.restore(opened)).toBe(true);
		expect(opened.__adapter_uws_connection_permit__).toBe(descriptor.value);
	});

	it('removes the carrier on native-upgrade rollback, and only its own', () => {
		const carrier = createConnectionPermitCarrier();
		const userData = {};
		const marker = carrier.install(userData);
		expect(carrier.rollback(userData, Object.freeze({}))).toBe(false);
		expect(carrier.rollback(userData, marker)).toBe(true);
		expect(Reflect.ownKeys(userData)).toEqual([]);
		expect(carrier.restore(userData)).toBe(false);
	});

	it('does not honour another server carrier', () => {
		const first = createConnectionPermitCarrier();
		const second = createConnectionPermitCarrier();
		const source = {};
		first.install(source);
		const opened = upgradeCopy(source);
		expect(second.restore(opened)).toBe(false);
		expect(opened[WS_CONNECTION_PERMIT]).toBeUndefined();
		expect(first.restore(opened)).toBe(true);
	});

	it('reports a carrier that did not arrive instead of minting a close permit', () => {
		const carrier = createConnectionPermitCarrier();
		const userData = {};
		carrier.install(userData);
		const opened = {};
		expect(carrier.restore(opened)).toBe(false);
		expect(opened[WS_CONNECTION_PERMIT]).toBeUndefined();
	});
});
