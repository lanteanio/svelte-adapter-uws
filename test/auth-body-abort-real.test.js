import net from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describeUWS('authentication body reads after a client abort', () => {
	let server;
	let state;
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'authAbort' });
		state = await import('./fixture/build-auth-abort/handler/state.js');
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	async function status(id) {
		const response = await fetch(server.httpUrl + '/__ws/auth', {
			method: 'POST', headers: { 'x-body-probe': id, 'x-body-status': '1' }
		});
		expect(response.status).toBe(200);
		return response.json();
	}

	for (const [reader, chunked, body, contentType] of [
		['text', false, 'partial', 'text/plain'],
		['text', true, 'partial', 'text/plain'],
		['json', false, '{"partial":', 'application/json'],
		['formData', false, 'partial=', 'application/x-www-form-urlencoded']
	]) {
		it(`rejects an interrupted ${reader} read (${chunked ? 'chunked' : 'declared length'}) and releases its state`, async () => {
			const id = reader + '-' + chunked;
			const socket = net.connect(server.port, '127.0.0.1');
			socket.on('error', () => {});
			try {
				await once(socket, 'connect');
				socket.write([
					'POST /__ws/auth HTTP/1.1', `Host: 127.0.0.1:${server.port}`,
					'x-body-probe: ' + id, 'x-body-reader: ' + reader,
					'Content-Type: ' + contentType,
					chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: 100', '',
					chunked ? body.length.toString(16) + '\r\n' + body + '\r\n' : body
				].join('\r\n'));
				await expect.poll(async () => (await status(id))?.started).toBe(true);
				expect((await status(id)).settled).toBe(false);
				await wait(0);
				const available = state.statePool.length;
				socket.resetAndDestroy();
				await expect.poll(async () => (await status(id))?.settled).toBe(true);
				const outcome = await status(id);
				expect(outcome.rejected).toBe(true);
				expect(outcome.error).toBe('Request aborted');
				await expect.poll(() => state.statePool.length).toBe(available + 1);
				expect(state.statePool.every(entry => entry.failBody === null && entry.signal === null)).toBe(true);
			} finally { socket.destroy(); }
		});
	}

	it('still reads a complete body and returns the hook response after aborted requests', async () => {
		const response = await fetch(server.httpUrl + '/__ws/auth', {
			method: 'POST', headers: { 'x-body-probe': 'healthy', 'x-body-reader': 'json', 'content-type': 'application/json' },
			body: JSON.stringify({ healthy: true })
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ healthy: true });
		expect(await status('healthy')).toMatchObject({ settled: true, rejected: false });
	});
});
