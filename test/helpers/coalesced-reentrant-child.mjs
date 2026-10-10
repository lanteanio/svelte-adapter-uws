import { WebSocket } from 'ws';
import { startRealRuntime } from './real-runtime.js';
import { createTestServer } from '../../src/testing.js';
import { coalescedReentrantProbe } from '../fixture/src/coalesced-probe.js';
const [surface, repeat] = process.argv.slice(2);
const handler = { message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'coalesce-reentrant-probe') coalescedReentrantProbe(ws, platform, msg);
	if (msg.type === 'echo') platform.send(ws, 'probe', 'echo', { ok: true });
} };
const server = surface === 'production' ? await startRealRuntime({ variant: 'default' }) : await createTestServer({ handler });
const ws = new WebSocket(server.wsUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const echo = new Promise((resolve, reject) => {
	ws.on('error', reject);
	ws.on('message', (raw, binary) => {
		if (binary) return;
		const frame = JSON.parse(raw.toString());
		if (frame.event === 'coalesced-reentrant-report') ws.send(JSON.stringify({ type: 'echo', payload: { ok: true } }));
		if (frame.event === 'echo' && frame.data.ok) resolve();
	});
});
ws.send(JSON.stringify({ type: 'coalesce-reentrant-probe', repeat }));
await echo;
await new Promise((resolve) => { ws.once('close', resolve); ws.close(); });
await (surface === 'production' ? server.stop() : server.close());
console.log('REENTRANT_OK');
