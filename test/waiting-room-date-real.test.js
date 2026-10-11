import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { renderWaitingRoom } from './fixture/src/waiting-room.renderer.js';

function get(url) {
	return new Promise((resolve, reject) => {
		const req = request(url, response => {
			let body = '';
			response.on('data', chunk => { body += chunk.toString(); });
			response.on('error', reject);
			response.on('end', () => resolve({ status: response.statusCode, rawHeaders: response.rawHeaders, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('waiting-room Date ownership on ' + surface, () => {
		let server;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'waitingrenderer' });
			else {
				const { createTestServer } = await import('../src/testing.js');
				const app = await createTestServer({ upgradeAdmission: { maxConcurrent: 1, waitingRoom: { renderer: renderWaitingRoom } } });
				server = { httpUrl: app.url, stop: () => app.close() };
			}
		}, 400000);
		afterAll(async () => { await server?.stop(); });
		it.each(['', 'date', 'DATE'])('keeps exactly one transport Date for renderer header %s', async name => {
			const response = await get(server.httpUrl + '/__waiting-room' + (name ? '?date=' + name : ''));
			const dates = [];
			for (let i = 0; i < response.rawHeaders.length; i += 2) {
				if (response.rawHeaders[i].toLowerCase() === 'date') dates.push(response.rawHeaders[i + 1]);
			}
			expect(response.status).toBe(200);
			expect(dates).toHaveLength(1);
			expect(Number.isFinite(Date.parse(dates[0]))).toBe(true);
			expect(dates[0]).not.toBe('Thu, 01 Jan 1970 00:00:00 GMT');
			if (name) expect(response.body).not.toContain('You are in the queue');
			else expect(response.body).toContain('You are in the queue');
		});
	});
}
