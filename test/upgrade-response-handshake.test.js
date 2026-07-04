import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

describeUWS('upgradeResponse handshake', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('completes the WebSocket handshake and delivers a custom header from an upgrade hook', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { upgradeResponse } = await import('../src/upgrade-response.js');
		server = await createTestServer({
			handler: {
				upgrade() {
					return upgradeResponse({}, { 'x-custom-header': 'present' });
				}
			}
		});

		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);
		let upgradeHeaders = null;
		ws.on('upgrade', (res) => {
			upgradeHeaders = res.headers;
		});

		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			// The pre-fix bug surfaces exactly here: writing the custom header
			// before res.upgrade made uWS emit an implicit "200 OK", so the `ws`
			// client rejects with "Unexpected server response: 200" - no open,
			// no upgrade event.
			ws.on('error', reject);
			setTimeout(() => reject(new Error('handshake timed out')), 3000);
		});

		expect(upgradeHeaders).not.toBeNull();
		expect(upgradeHeaders['x-custom-header']).toBe('present');

		ws.close();
	});
});
