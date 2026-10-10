import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('WebSocket protocol required on a plain navigation', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'waitingdefault' }); }, 400000);
	afterAll(async () => { await server?.stop(); });
	it('names websocket in the 426 Upgrade field below capacity', async () => {
		const response = await fetch(server.httpUrl + '/ws');
		expect(response.status).toBe(426);
		expect(response.headers.get('upgrade')).toBe('websocket');
		expect(await response.text()).toBe('WebSocket upgrade required');
	});
});
