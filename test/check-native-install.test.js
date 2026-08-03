import { describe, expect, it } from 'vitest';
import {
	NATIVE_CHECK_BYPASS,
	verifyNativeInstall
} from '../scripts/check-native-install.js';

describe('native install verification', () => {
	it('loads the native addon during an ordinary install', async () => {
		let imported = 0;
		await expect(verifyNativeInstall(async () => { imported++; }, {}))
			.resolves.toEqual({ skipped: false });
		expect(imported).toBe(1);
	});

	it('preserves the native loader cause in the actionable failure', async () => {
		const cause = new Error('wrong Node ABI');
		await expect(verifyNativeInstall(async () => { throw cause; }, {}))
			.rejects.toMatchObject({ cause, message: expect.stringContaining(cause.message) });
	});

	it('allows only the explicit client-only bypass', async () => {
		let imported = false;
		await expect(verifyNativeInstall(
			async () => { imported = true; },
			{ [NATIVE_CHECK_BYPASS]: '1' }
		)).resolves.toEqual({ skipped: true });
		expect(imported).toBe(false);
	});
});
