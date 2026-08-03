import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';

async function freePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	await new Promise((resolveClose, rejectClose) =>
		server.close((error) => error ? rejectClose(error) : resolveClose())
	);
	return address.port;
}

function waitForFrame(ws, predicate, label) {
	return new Promise((resolveFrame, rejectFrame) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectFrame(new Error('timed out waiting for ' + label));
		}, 5000);
		function cleanup() {
			clearTimeout(timer);
			ws.off('message', onMessage);
			ws.off('error', onError);
			ws.off('close', onClose);
		}
		function onMessage(data) {
			let frame;
			try {
				frame = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (!predicate(frame)) return;
			cleanup();
			resolveFrame(frame);
		}
		function onError(error) {
			cleanup();
			rejectFrame(error);
		}
		function onClose(code) {
			cleanup();
			rejectFrame(new Error('socket closed with code ' + code + ' while waiting for ' + label));
		}
		ws.on('message', onMessage);
		ws.on('error', onError);
		ws.on('close', onClose);
	});
}

async function waitForHttp(url, child, diagnostics) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error('fixture server exited before HTTP was ready\n' + diagnostics());
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
			if (response.ok) return response;
		} catch {
			// Startup is expected to refuse connections briefly.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error('timed out waiting for fixture HTTP\n' + diagnostics());
}

const port = await freePort();
let output = '';
const child = spawn(process.execPath, ['build/index.js'], {
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: String(port),
		ORIGIN: 'http://127.0.0.1:' + port
	},
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true
});
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

let socket;
try {
	const response = await waitForHttp('http://127.0.0.1:' + port + '/', child, () => output);
	const html = await response.text();
	if (!html.includes('Svelte 4 fixture') || !html.includes('id="store">none')) {
		throw new Error('SSR did not render the Svelte 4 data/store contract');
	}

	socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
		headers: { Origin: 'http://127.0.0.1:' + port }
	});
	await once(socket, 'open');
	const subscribed = waitForFrame(
		socket,
		(frame) => frame?.type === 'subscribed' && frame.topic === 'svelte4-floor',
		'Svelte 4 subscribe acknowledgement'
	);
	socket.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
	socket.send(JSON.stringify({ type: 'subscribe', topic: 'svelte4-floor', ref: 'floor' }));
	await subscribed;

	const delivered = waitForFrame(
		socket,
		(frame) => frame?.topic === 'svelte4-floor' && frame.event === 'roundtrip' &&
			frame.data?.profile === 'svelte4',
		'Svelte 4 WebSocket roundtrip'
	);
	socket.send(JSON.stringify({ type: 'fixture-publish', payload: { profile: 'svelte4' } }));
	await delivered;
	console.log('svelte4 smoke OK: SSR/store + WebSocket roundtrip');
} finally {
	socket?.close();
	child.kill('SIGTERM');
	if (child.exitCode === null) {
		await Promise.race([
			once(child, 'exit'),
			new Promise((resolveWait) => setTimeout(resolveWait, 5000))
		]);
	}
	if (child.exitCode === null) child.kill('SIGKILL');
}
