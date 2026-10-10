import { cancelBodyProbe } from './body-cancel-probe.js';

export async function authenticate({ request, headers }) {
	if (headers['x-cancel-mode']) return cancelBodyProbe(request);
	const failure = headers['x-throw-mode'];
	if (failure === 'revoked') {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		throw proxy;
	}
	if (failure === 'prototype') throw new Proxy({}, { getPrototypeOf() { throw new Error('prototype trap'); } });
	if (failure === 'native-prototype') {
		const error = new Error('application failure');
		Object.setPrototypeOf(error, new Proxy({}, { getPrototypeOf() { throw new Error('prototype trap'); } }));
		throw error;
	}
	if (headers['x-read-body']) return new Response(await request.text());
	return {};
}
