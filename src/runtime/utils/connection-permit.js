import { WS_CONNECTION_PERMIT_KEY } from './upgrade-admission.js';
import { WS_CONNECTION_PERMIT } from './ws-symbols.js';

/**
 * Build the upgrade-to-open carrier for one server instance.
 *
 * uWebSockets.js copies enumerable string properties from upgrade userData but
 * does not preserve Symbols. The temporary string slot therefore has to be
 * collision-safe: an application is entitled to return any own property at
 * the adapter's preferred key, including a non-configurable accessor.
 */
export function createConnectionPermitCarrier() {
	const identity = Object.freeze({});
	let fallbackSequence = 0;

	function fallbackKey(userData) {
		let key;
		do {
			key = `${WS_CONNECTION_PERMIT_KEY}:${++fallbackSequence}`;
		} while (Object.prototype.hasOwnProperty.call(userData, key));
		return key;
	}

	function restoreOriginal(userData, marker) {
		if (marker?.identity !== identity) return false;
		const current = Object.getOwnPropertyDescriptor(userData, marker.carrierKey);
		if (current?.value !== marker) return false;

		if (marker.carrierKey !== WS_CONNECTION_PERMIT_KEY) {
			delete userData[marker.carrierKey];
		}
		if (marker.originalDescriptor === undefined) {
			delete userData[WS_CONNECTION_PERMIT_KEY];
		} else {
			Object.defineProperty(userData, WS_CONNECTION_PERMIT_KEY, marker.originalDescriptor);
		}
		return true;
	}

	return Object.freeze({
		install(userData) {
			if (userData === null || (typeof userData !== 'object' && typeof userData !== 'function')) {
				throw new TypeError('WebSocket upgrade userData must be an object.');
			}
			const descriptor = Object.getOwnPropertyDescriptor(userData, WS_CONNECTION_PERMIT_KEY);
			const originalDescriptor = descriptor === undefined
				? undefined
				: Object.freeze({ ...descriptor });
			const carrierKey = descriptor !== undefined && descriptor.configurable === false
				? fallbackKey(userData)
				: WS_CONNECTION_PERMIT_KEY;
			const marker = Object.freeze({ identity, carrierKey, originalDescriptor });
			Object.defineProperty(userData, carrierKey, {
				value: marker,
				writable: false,
				enumerable: true,
				configurable: true
			});
			return marker;
		},

		restore(userData) {
			for (const key of Object.getOwnPropertyNames(userData)) {
				const marker = Object.getOwnPropertyDescriptor(userData, key)?.value;
				if (marker?.identity !== identity || marker.carrierKey !== key) continue;
				if (!restoreOriginal(userData, marker)) return false;
				userData[WS_CONNECTION_PERMIT] = true;
				return true;
			}
			return false;
		},

		rollback(userData, marker) {
			return restoreOriginal(userData, marker);
		}
	});
}
