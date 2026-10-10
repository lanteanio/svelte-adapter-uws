import assert from 'node:assert/strict';
import { startRealRuntime, connectRealClient } from './real-runtime.js';
import { createReuseHandler } from '../fixture/src/reuse-data-handler.js';
const [surface, mode] = process.argv.slice(2);
let server;
if (surface === 'production') server = await startRealRuntime({ variant: 'reusedata' });
else if (surface === 'testing') {
	const { createTestServer } = await import('../../src/testing.js');
	const harness = await createTestServer({ handler: createReuseHandler() });
	server = { wsUrl: harness.wsUrl, stop: () => harness.close() };
} else {
	const { bootViteDev } = await import('./vite-dev.js');
	const dev = await bootViteDev({ handler: createReuseHandler() });
	server = { wsUrl: `ws://127.0.0.1:${dev.port}/ws`, stop: () => dev.close() };
}
let first, second;
try {
	first = await connectRealClient(server.wsUrl);
	const initial = await first.waitFor(frame => frame?.topic === 'probe');
	assert.ok(initial, 'first connection answered');
	assert.equal(initial.parsed.data.first, true);
	second = await connectRealClient(server.wsUrl, { headers: { 'x-reuse-data': mode } });
	const answer = await second.waitFor(frame => frame?.topic === 'probe');
	assert.ok(answer, 'reused-data connection answered');
	assert.deepEqual(answer.parsed.data, {
		first: false, application: 'kept', symbol: 'symbol-kept',
		...(mode === 'spread' ? { additional: 'kept' } : {}),
		freshPlatform: true, freshSession: true, staleMembership: false, staleCaps: false, originalMembership: true
	});
	console.log('USER_DATA_COPY_OK');
} finally { first?.close(); second?.close(); await server.stop(); }
