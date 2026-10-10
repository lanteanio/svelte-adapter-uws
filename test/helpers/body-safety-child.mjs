import assert from 'node:assert/strict';
import http from 'node:http';
import { startRealRuntime } from './real-runtime.js';

const [kind, mode, framing, lengthText] = process.argv.slice(2);
const server = await startRealRuntime({ variant: 'bodysafety' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('body probe deadline');
		await pause(5);
	}
}
try {
	if (kind === 'limit') {
		const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)); controller.close(); } });
		const answer = await fetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers: { 'x-read-body': '1' }, body, duplex: 'half' });
		assert.equal(answer.status, 413);
		await answer.text();
	} else if (kind === 'throw') {
		const answer = await fetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers: { 'x-throw-mode': mode } });
		assert.equal(answer.status, 500);
		await answer.text();
	} else {
		const length = Number(lengthText);
		const headers = { 'x-cancel-mode': mode, connection: 'close' };
		if (framing === 'known') headers['content-length'] = String(length);
		else headers['transfer-encoding'] = 'chunked';
		let request;
		const response = new Promise((resolve, reject) => {
			request = http.request(server.httpUrl + (kind === 'auth' ? '/__ws/auth' : '/cancel-body'), { method: 'POST', headers, agent: false }, res => {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('error', reject);
				res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
			});
			request.on('error', reject);
			request.flushHeaders();
		});
		response.catch(() => {});
		try {
			await until(() => globalThis.__cancelBodyProbes?.get('active')?.cancel);
			const state = globalThis.__cancelBodyProbes.get('active');
			request.write(Buffer.alloc(3, 65));
			await pause(20);
			state.cancel();
			await until(() => state.cancelled && state.finish);
			request.end(Buffer.alloc(length - 3, 66));
			await pause(30);
			state.finish();
			assert.deepEqual(await response, { status: 200, body: 'cancelled' });
		} finally { request?.destroy(); }
	}
	const healthy = await fetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers: { 'x-read-body': '1' }, body: 'healthy' });
	assert.equal(healthy.status, 200);
	assert.equal(await healthy.text(), 'healthy');
	console.log('BODY_SAFETY_OK');
} finally { await server.stop(); }
