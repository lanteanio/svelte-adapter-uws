import { describe, it, expect } from 'vitest';
import { createConnectionPermitCarrier } from '../src/runtime/utils/connection-permit.js';
import { WS_CONNECTION_PERMIT_KEY } from '../src/runtime/utils/upgrade-admission.js';
import { WS_CONNECTION_PERMIT } from '../src/runtime/utils/ws-symbols.js';

function shallowUpgradeCopy(userData) {
	return Object.assign({}, userData);
}

describe('connection permit upgrade carrier', () => {
	it('restores a non-configurable application property exactly after an upgrade copy', () => {
		const carrier = createConnectionPermitCarrier();
		const appValue = Object.freeze({ owner: 'application' });
		const descriptor = {
			value: appValue,
			writable: false,
			enumerable: false,
			configurable: false
		};
		const source = {};
		Object.defineProperty(source, WS_CONNECTION_PERMIT_KEY, descriptor);

		carrier.install(source);
		expect(Object.getOwnPropertyDescriptor(source, WS_CONNECTION_PERMIT_KEY)).toEqual(descriptor);
		const opened = shallowUpgradeCopy(source);

		expect(carrier.restore(opened)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(opened, WS_CONNECTION_PERMIT_KEY)).toEqual(descriptor);
		expect(opened[WS_CONNECTION_PERMIT]).toBe(true);
		expect(Object.getOwnPropertyNames(opened).filter((key) => key.startsWith(`${WS_CONNECTION_PERMIT_KEY}:`))).toEqual([]);
	});

	it('restores a configurable accessor descriptor on native-upgrade rollback', () => {
		const carrier = createConnectionPermitCarrier();
		let stored = 1;
		const descriptor = {
			get() { return stored; },
			set(value) { stored = value; },
			enumerable: true,
			configurable: true
		};
		const userData = {};
		Object.defineProperty(userData, WS_CONNECTION_PERMIT_KEY, descriptor);

		const marker = carrier.install(userData);
		expect(carrier.rollback(userData, marker)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(userData, WS_CONNECTION_PERMIT_KEY)).toEqual(descriptor);
		userData[WS_CONNECTION_PERMIT_KEY] = 7;
		expect(stored).toBe(7);
	});

	it('does not mistake application data or another server carrier for its permit', () => {
		const first = createConnectionPermitCarrier();
		const second = createConnectionPermitCarrier();
		const appData = {
			[WS_CONNECTION_PERMIT_KEY]: {
				identity: Object.freeze({}),
				carrierKey: WS_CONNECTION_PERMIT_KEY
			}
		};
		expect(first.restore(appData)).toBe(false);
		expect(appData[WS_CONNECTION_PERMIT]).toBeUndefined();

		const source = {};
		first.install(source);
		const opened = shallowUpgradeCopy(source);
		expect(second.restore(opened)).toBe(false);
		expect(opened[WS_CONNECTION_PERMIT]).toBeUndefined();
		expect(first.restore(opened)).toBe(true);
	});

	it.each(['deleted', 'replaced'])('reports a %s carrier as invalid instead of minting a close permit', (mutation) => {
		const carrier = createConnectionPermitCarrier();
		const userData = {};
		carrier.install(userData);
		if (mutation === 'deleted') {
			delete userData[WS_CONNECTION_PERMIT_KEY];
		} else {
			Object.defineProperty(userData, WS_CONNECTION_PERMIT_KEY, {
				value: { application: true },
				writable: true,
				enumerable: true,
				configurable: true
			});
		}

		expect(carrier.restore(userData)).toBe(false);
		expect(userData[WS_CONNECTION_PERMIT]).toBeUndefined();
	});
});
