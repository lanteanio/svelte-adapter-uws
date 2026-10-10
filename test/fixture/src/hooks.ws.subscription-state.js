import { trackedSubscribe } from 'svelte-adapter-uws/subscriptions';

const states = new WeakMap();

function state(ws) {
	let value = states.get(ws);
	if (!value) {
		value = { attempts: [], bypass: false, resumed: [] };
		states.set(ws, value);
	}
	return value;
}

export async function subscribe(ws, topic, { platform }) {
	const current = state(ws);
	if (current.bypass) return null;
	let install;
	let finish;
	const installing = new Promise((resolve) => { install = resolve; });
	const finishing = new Promise((resolve) => { finish = resolve; });
	const index = current.attempts.length;
	current.attempts.push({ install, finish });
	platform.send(ws, 'probe', 'parked', { index, topic });
	if (await installing) {
		trackedSubscribe(ws, topic);
		platform.send(ws, 'probe', 'installed', { index, topic });
	}
	return finishing;
}

export function resume(ws, { platform, lastSeenSeqs, lastSeenEpochs }) {
	const topics = Object.keys(lastSeenSeqs);
	state(ws).resumed.push(...topics);
	platform.send(ws, 'probe', 'history', { topics, epochTopics: Object.keys(lastSeenEpochs || {}), value: 'private-history' });
}

export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const current = state(ws);
	if (msg.type === 'install') current.attempts[msg.index].install(true);
	if (msg.type === 'finish') {
		current.attempts[msg.index].install(false);
		current.attempts[msg.index].finish(msg.denial ?? null);
	}
	if (msg.type === 'revoke') {
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { removed, nonce: msg.nonce });
	}
	if (msg.type === 'grant') {
		current.bypass = true;
		const pending = platform.subscribe(ws, msg.topic);
		const denial = await pending;
		current.bypass = false;
		platform.send(ws, 'probe', 'granted', { denial, nonce: msg.nonce });
	}
	if (msg.type === 'arm') {
		platform.authorizeWireSubscribe('strict');
		platform.send(ws, 'probe', 'armed', { nonce: msg.nonce });
	}
	if (msg.type === 'observe') {
		const denial = await platform.checkSubscribe(ws, msg.topic, { requireGrant: true });
		platform.send(ws, 'probe', 'observed', { denial, nonce: msg.nonce });
	}
	if (msg.type === 'probe') {
		platform.send(ws, 'probe', 'state', {
			count: platform.subscribers(msg.topic),
			held: ws.isSubscribed(msg.topic),
			resumed: current.resumed,
			nonce: msg.nonce
		});
	}
	if (msg.type === 'publish') {
		platform.publish(msg.topic, 'delivery', { nonce: msg.nonce });
		platform.send(ws, 'probe', 'published', { nonce: msg.nonce });
	}
}

export function close(ws) {
	for (const attempt of states.get(ws)?.attempts || []) {
		attempt.install(false);
		attempt.finish('FORBIDDEN');
	}
	states.delete(ws);
}
