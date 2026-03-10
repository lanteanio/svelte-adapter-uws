// WebSocket benchmark client -- connects N clients, sends burst messages,
// measures throughput and fan-out under saturation.
// Usage: node 23-ws-bench-client.mjs [uws|adapter|socketio|ws] [clients] [duration_s]
import WebSocket from 'ws';
import { io as ioClient } from 'socket.io-client';

const MODE = process.argv[2] || 'uws';
const NUM_CLIENTS = parseInt(process.argv[3] || '50');
const DURATION = parseInt(process.argv[4] || '8') * 1000;
const PORT = parseInt(process.env.PORT || '9002');
const NUM_SENDERS = Math.min(10, NUM_CLIENTS);
const PAYLOAD = JSON.stringify({ topic: 'bench', event: 'update', data: { id: 1, value: 'hello world benchmark payload' } });
const SUBSCRIBE_MSG = JSON.stringify({ type: 'subscribe', topic: 'bench' });

// Burst: send multiple messages per setInterval tick to push throughput
const MSGS_PER_TICK = 50;
const TICK_MS = 1;

let totalSent = 0;
let totalReceived = 0;

function connectWs() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

function connectSocketIo() {
	return new Promise((resolve, reject) => {
		const socket = ioClient(`http://127.0.0.1:${PORT}`, {
			transports: ['websocket'],
			forceNew: true,
		});
		socket.on('connect', () => resolve(socket));
		socket.on('connect_error', reject);
	});
}

async function run() {
	console.log(`\n  Mode: ${MODE} | Clients: ${NUM_CLIENTS} | Senders: ${NUM_SENDERS} | Duration: ${DURATION / 1000}s | Burst: ${MSGS_PER_TICK} msg/tick\n`);

	const clients = [];

	const t0 = performance.now();
	for (let i = 0; i < NUM_CLIENTS; i++) {
		if (MODE === 'socketio') {
			clients.push(await connectSocketIo());
		} else {
			clients.push(await connectWs());
		}
	}
	const connectTime = performance.now() - t0;
	console.log(`  Connected ${NUM_CLIENTS} clients in ${connectTime.toFixed(0)}ms`);

	if (MODE === 'adapter') {
		for (const ws of clients) ws.send(SUBSCRIBE_MSG);
		await new Promise(r => setTimeout(r, 100));
		console.log(`  Subscribed ${NUM_CLIENTS} clients to 'bench' topic`);
	}

	for (const client of clients) {
		if (MODE === 'socketio') {
			client.on('message', () => { totalReceived++; });
		} else {
			client.on('message', () => { totalReceived++; });
		}
	}

	const senders = clients.slice(0, NUM_SENDERS);
	const intervals = [];
	const startTime = performance.now();

	for (const sender of senders) {
		const iv = setInterval(() => {
			for (let i = 0; i < MSGS_PER_TICK; i++) {
				if (MODE === 'socketio') {
					sender.emit('message', PAYLOAD);
				} else {
					if (sender.readyState === 1) sender.send(PAYLOAD);
				}
				totalSent++;
			}
		}, TICK_MS);
		intervals.push(iv);
	}

	await new Promise(r => setTimeout(r, DURATION));

	for (const iv of intervals) clearInterval(iv);
	const elapsed = performance.now() - startTime;

	await new Promise(r => setTimeout(r, 500));

	for (const client of clients) {
		if (MODE === 'socketio') client.disconnect();
		else client.close();
	}

	const sendRate = (totalSent / (elapsed / 1000)).toFixed(0);
	const recvRate = (totalReceived / (elapsed / 1000)).toFixed(0);
	const fanout = totalSent > 0 ? (totalReceived / totalSent).toFixed(1) : '0.0';

	console.log(`  Messages sent:     ${totalSent.toLocaleString()} (${Number(sendRate).toLocaleString()}/s)`);
	console.log(`  Messages received: ${totalReceived.toLocaleString()} (${Number(recvRate).toLocaleString()}/s)`);
	console.log(`  Fan-out ratio:     ${fanout}x (expected ~${NUM_CLIENTS}x)`);
	console.log(`  Effective throughput: ${Number(recvRate).toLocaleString()} msg/s delivered`);
	console.log('');
}

run().catch(console.error);
