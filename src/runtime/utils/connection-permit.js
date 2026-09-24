import { WS_CONNECTION_PERMIT } from './ws-symbols.js';

/**
 * Build the upgrade-to-open carrier for one server instance.
 *
 * uWS copies the enumerable own properties of the userData passed to
 * `res.upgrade()` onto the object `open` receives - Symbol keys included -
 * with plain assignments. The permit rides a Symbol created here: no other
 * code can name it, so no application property collides with it and no
 * inherited accessor can take it in the copy. Each server gets its own Symbol
 * and marker identity, so a permit carried for one server is never honoured
 * by another.
 */
export function createConnectionPermitCarrier() {
	const identity = Object.freeze({});
	const carry = Symbol('adapter-uws.carry.connection-permit');

	return Object.freeze({
		install(userData) {
			if (userData === null || (typeof userData !== 'object' && typeof userData !== 'function')) {
				throw new TypeError('WebSocket upgrade userData must be an object.');
			}
			const marker = Object.freeze({ identity });
			// Enumerable, or the copy leaves it behind.
			Object.defineProperty(userData, carry, {
				value: marker,
				writable: false,
				enumerable: true,
				configurable: true
			});
			return marker;
		},

		restore(userData) {
			if (Object.getOwnPropertyDescriptor(userData, carry)?.value?.identity !== identity) return false;
			delete userData[carry];
			userData[WS_CONNECTION_PERMIT] = true;
			return true;
		},

		rollback(userData, marker) {
			if (Object.getOwnPropertyDescriptor(userData, carry)?.value !== marker) return false;
			delete userData[carry];
			return true;
		}
	});
}
