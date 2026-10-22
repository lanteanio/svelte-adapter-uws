import { upgradeResponse } from 'svelte-adapter-uws/upgrade-response';
import { record } from './lib/probe.js';

export function upgrade({ headers, cookies, url }) {
	const token = cookies?.token;
	if (token === 'reject') return false;
	if (token === 'error') throw new Error('auth error');
	const userData = token ? { token } : {};
	// boom=open / boom=close make that hook throw for this connection only.
	const boom = new URL(url, 'http://localhost').searchParams.get('boom');
	if (boom) userData.boom = boom;
	// A header on the 101 takes the handler's header-writing path.
	if (url.includes('header=1')) return upgradeResponse(userData, { 'x-fixture': 'upgrade' });
	return userData;
}

export function subscribe(ws, topic, { platform }) {
	// Exercise platform.subscribers() and ws wrapper methods
	platform.subscribers(topic);
	ws.isSubscribed(topic);
	ws.getTopics();
	ws.getBufferedAmount();
	ws.getRemoteAddressAsText();
}

// Async, so the failure is a rejected promise: a synchronous throw inside the
// control-message handling is contained by the dev server's own parse
// try/catch and would prove nothing there.
export async function unsubscribe(ws, topic) {
	if (topic === 'boom') throw new Error('unsubscribe boom');
}

export function open(ws, { platform }) {
	if (ws.getUserData().boom === 'open') throw new Error('open boom');
	platform.publish('test-topic', 'connected', { ts: Date.now() });
	// Exercise platform.connections and topic() helpers
	const _ = platform.connections;
	const t = platform.topic('test-topic');
	t.increment(1);
	t.decrement(1);
}

export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'echo') {
		platform.send(ws, 'test-topic', 'echo', msg.payload);
	}
	if (msg.type === 'broadcast') {
		platform.publish(msg.topic || 'test-topic', msg.event || 'broadcast', msg.payload);
	}
	if (msg.type === 'sendto') {
		platform.sendTo(
			(ud) => ud.token === msg.token,
			msg.topic || 'test-topic',
			msg.event || 'dm',
			msg.payload
		);
	}
	if (msg.type === 'cork-test') {
		ws.cork(() => {
			platform.send(ws, 'test-topic', 'corked', msg.payload);
		});
	}
}

export function close(ws, { code, platform }) {
	if (ws.getUserData().boom === 'close') throw new Error('close boom');
	platform.publish('test-topic', 'disconnected', { code });
}

// Registers the authenticate endpoint. `x-auth-response: framing` returns a
// Response carrying its own framing and Date headers, `empty` a bodyless 204,
// `network-error` a Response.error();
// a request carrying `x-probe-id` reads its whole body first and records how
// that read ended: `rejected`, or `resolved:<bytes>`.
export async function authenticate({ request, headers }) {
	const shape = headers['x-auth-response'];
	if (shape === 'framing') {
		return new Response('authenticated', {
			headers: { 'transfer-encoding': 'chunked', date: 'Mon, 01 Jan 2024 00:00:00 GMT' }
		});
	}
	if (shape === 'empty') return new Response(null, { status: 204 });
	if (shape === 'network-error') return Response.error();
	const id = headers['x-probe-id'];
	if (!id) return;
	record(id, 'entered');
	try {
		const body = await request.arrayBuffer();
		record(id, `resolved:${body.byteLength}`);
	} catch (error) {
		record(id, 'rejected');
		throw error;
	}
}
