// Real-platform proof of sender exclusion on publishWire, against both the
// vite dev server and the production build - the two platform
// implementations no unit harness drives directly. Two raw sockets subscribe
// to one topic; the sender triggers a server-side publish that excludes its
// own socket; the peer receives the frame and the sender provably does not,
// while the unexcluded control publish reaches both.

import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

function wsUrlFrom(baseURL) {
	return baseURL.replace(/^http/, 'ws') + '/ws';
}

function connectWs(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

function waitFor(ws, predicate, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.removeListener('message', handler);
			reject(new Error('Timed out waiting for message'));
		}, timeoutMs);
		function handler(raw) {
			const msg = JSON.parse(raw.toString());
			if (predicate(msg)) {
				clearTimeout(timeout);
				ws.removeListener('message', handler);
				resolve(msg);
			}
		}
		ws.on('message', handler);
	});
}

function collect(ws, durationMs) {
	return new Promise((resolve) => {
		const messages = [];
		function handler(raw) {
			messages.push(JSON.parse(raw.toString()));
		}
		ws.on('message', handler);
		setTimeout(() => {
			ws.removeListener('message', handler);
			resolve(messages);
		}, durationMs);
	});
}

test('a sender-excluded publish reaches the peer but never the sender', async ({ baseURL }) => {
	const url = wsUrlFrom(baseURL);
	const topic = 'exclude-e2e';
	const sender = await connectWs(url);
	const peer = await connectWs(url);
	sender.send(JSON.stringify({ type: 'subscribe', topic }));
	peer.send(JSON.stringify({ type: 'subscribe', topic }));
	await new Promise((r) => setTimeout(r, 150));

	const senderInbox = collect(sender, 700);
	sender.send(JSON.stringify({ type: 'publish-except-me', topic, event: 'poke', payload: 'not-for-me' }));
	const peerMsg = await waitFor(peer, (m) => m.topic === topic && m.event === 'poke');
	expect(peerMsg.data).toBe('not-for-me');
	const senderMsgs = await senderInbox;
	expect(senderMsgs.filter((m) => m.event === 'poke')).toHaveLength(0);

	// The unexcluded control rides the identical path and reaches both.
	const both = Promise.all([
		waitFor(sender, (m) => m.topic === topic && m.event === 'poke' && m.data === 'for-everyone'),
		waitFor(peer, (m) => m.topic === topic && m.event === 'poke' && m.data === 'for-everyone')
	]);
	sender.send(JSON.stringify({ type: 'publish-except-me', topic, event: 'poke', payload: 'for-everyone', exclude: false }));
	await both;

	sender.close();
	peer.close();
});
