// Drive the built runtime over TCP while the route delays consuming its body.
// Content-Length exercises the preallocated path; chunked transfer exercises
// per-chunk copies. Bytes arriving before request.arrayBuffer() must survive.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
		await pause(5);
	}
}

(hasUWS ? describe : describe.skip)('request body before a delayed route read', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'default' }); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it.each(['content-length', 'chunked'])('retains every pre-read byte with %s framing', async (framing) => {
		const id = randomUUID();
		const chunks = [Buffer.from('first-'), Buffer.from([0, 255, 195, 188]), Buffer.from('-last')];
		const expected = Buffer.concat(chunks);
		const headers = { 'content-type': 'application/octet-stream', connection: 'close' };
		if (framing === 'content-length') headers['content-length'] = String(expected.length);
		else headers['transfer-encoding'] = 'chunked';
		let request;
		let deadline;
		let responseStatus;
		const answer = new Promise((resolve, reject) => {
			request = http.request(server.httpUrl + '/delayed-body-read?id=' + id, { method: 'POST', headers, agent: false }, (response) => {
				responseStatus = response.statusCode;
				const received = [];
				response.on('data', (chunk) => received.push(chunk));
				response.once('error', reject);
				response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(received) }));
			});
			request.once('error', reject);
			deadline = setTimeout(() => request.destroy(new Error('Delayed body response timed out')), 3000);
			request.flushHeaders();
		});
		// Observe early failures while driving the upload, then await the same
		// promise for the actual client-visible assertion below.
		answer.catch(() => {});
		try {
			await until(() => globalThis.__delayedBodyReads?.get(id)?.release || responseStatus, 'the suspended route');
			const state = globalThis.__delayedBodyReads?.get(id);
			expect(state, 'route entered before an early response: ' + responseStatus).toBeDefined();
			for (const chunk of chunks) {
				expect(state.reading).toBe(false);
				await new Promise((resolve, reject) => request.write(chunk, (error) => error ? reject(error) : resolve()));
				// Give each write its own transport/event-loop turn while the
				// route remains suspended independently of elapsed time.
				await pause(20);
			}
			request.end();
			await pause(20);
			expect(state.reading).toBe(false);
			state.release();
			const response = await answer;
			expect(state.reading).toBe(true);
			expect(response.status).toBe(200);
			expect(response.body.equals(expected)).toBe(true);
		} finally {
			clearTimeout(deadline);
			globalThis.__delayedBodyReads?.get(id)?.release?.();
			request?.destroy();
			globalThis.__delayedBodyReads?.delete(id);
		}
	});
});
