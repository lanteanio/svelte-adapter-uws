import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dev } from '$app/env';
import { KIT3_MODULE_TOKEN } from '$app/env/private';
import { state } from './shared.js';

const moduleToken = KIT3_MODULE_TOKEN;
if (moduleToken !== 'fixture-secret') throw new Error('WebSocket module evaluated before environment initialization');
const instance = randomUUID();
const lifecycle = globalThis.__kit3HandlerLifecycle ??= { events: [], active: new Set() };
let captured = null;

export async function init({ platform }) {
	if (dev) await delay(10);
	else if (process.env.KIT3_INIT_DELAY_MS) await delay(Number(process.env.KIT3_INIT_DELAY_MS));
	captured = platform;
	lifecycle.active.add(instance);
	lifecycle.events.push({ type: 'init', instance });
}

export async function shutdown() {
	await delay(50);
	captured = null;
	lifecycle.active.delete(instance);
	lifecycle.events.push({ type: 'shutdown', instance });
}

export function subscribe() { return moduleToken === 'fixture-secret'; }

export function message(ws, { data }) {
	const frame = JSON.parse(Buffer.from(data).toString());
	if (frame.type === 'fixture-lifecycle') {
		ws.send(JSON.stringify({ type: 'fixture-lifecycle', instance, initialized: captured !== null,
			active: [...lifecycle.active], events: lifecycle.events }));
	}
	if (frame.type === 'fixture-publish') {
		state.messages++;
		captured.publish('kit3', 'roundtrip', frame.payload, { seq: false });
	}
}
