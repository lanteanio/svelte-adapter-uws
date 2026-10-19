/** @type {NonNullable<import('svelte-adapter-uws').WebSocketHandler['message']>} */
export const message = (ws, { data, platform }) => {
	const frame = JSON.parse(new TextDecoder().decode(data));
	if (frame.type !== 'fixture-publish') return;
	platform.publish('svelte4-floor', 'roundtrip', frame.payload, { seq: false });
};
