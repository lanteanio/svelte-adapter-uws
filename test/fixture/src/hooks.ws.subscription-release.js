import { releaseSubscription, trackedSubscribe } from 'svelte-adapter-uws/subscriptions';
import 'svelte-adapter-uws/plugins/cursor';

const states = new WeakMap();
let retired;
function state(ws) {
	let value = states.get(ws);
	if (!value) { value = { gates: [], unsubscribes: 0 }; states.set(ws, value); }
	return value;
}
export async function subscribe(ws, topic, { platform }) {
	const current = state(ws);
	let finish;
	const pending = new Promise((resolve) => { finish = resolve; });
	const index = current.gates.length;
	current.gates.push(finish);
	platform.send(ws, 'probe', 'parked', { index, topic });
	return pending;
}
export function unsubscribe(ws) { state(ws).unsubscribes++; }
export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const current = state(ws);
	const reply = (event, value = {}) => platform.send(ws, 'probe', event, { ...value, nonce: msg.nonce });
	if (msg.type === 'begin') reply('admitted', { denial: await platform.subscribe(ws, msg.topic) });
	if (msg.type === 'finish') current.gates[msg.index](msg.denial ?? null);
	if (msg.type === 'install') reply('installed', { installed: trackedSubscribe(ws, msg.topic) });
	if (msg.type === 'decorate') {
		trackedSubscribe(ws, '__cursor:' + msg.topic);
		platform.grantPublish(ws, msg.topic);
		reply('decorated');
	}
	if (msg.type === 'release') reply('released', { removed: releaseSubscription(ws, msg.topic) });
	if (msg.type === 'revoke') reply('revoked', { removed: platform.unsubscribe(ws, msg.topic) });
	if (msg.type === 'retired') reply('retired', { removed: retired ? releaseSubscription(retired, msg.topic) : null });
	if (msg.type === 'probe') {
		let logical = 0;
		platform.forEachSubscriber(msg.topic, () => { logical++; });
		reply('state', { logical, native: platform.subscribers(msg.topic), derived: platform.subscribers('__cursor:' + msg.topic), grant: platform.publishGrant(ws), cohorts: ws.getTopics().filter((topic) => topic.includes('\0')).length, unsubscribes: current.unsubscribes });
	}
	if (msg.type === 'publish') {
		platform.publish(msg.topic, 'base', { nonce: msg.nonce });
		platform.publish('__cursor:' + msg.topic, 'derived', { nonce: msg.nonce });
		platform.publishWire(msg.topic, 'shared', { nonce: msg.nonce }, { capability: 'release.shared:1', schemaVersion: 1, shared: true, encode: () => new Uint8Array([msg.nonce]) });
		reply('published');
	}
}
export function close(ws) {
	retired = ws;
	for (const finish of states.get(ws)?.gates || []) finish('FORBIDDEN');
	states.delete(ws);
}
