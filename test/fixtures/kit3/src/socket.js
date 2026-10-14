import { KIT3_MODULE_TOKEN } from '$app/env/private';
import { state } from './shared.js';

const moduleToken = KIT3_MODULE_TOKEN;
if (moduleToken !== 'fixture-secret') throw new Error('WebSocket module evaluated before environment initialization');

export function subscribe() { return moduleToken === 'fixture-secret'; }

export function message(ws, { data, platform }) {
	const frame = JSON.parse(Buffer.from(data).toString());
	if (frame.type === 'fixture-publish') {
		state.messages++;
		platform.publish('kit3', 'roundtrip', frame.payload, { seq: false });
	}
}
