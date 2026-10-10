const closed = new Map();
const codecs = new Map();
function codec(kind) {
	if (codecs.has(kind)) return codecs.get(kind);
	const value = {
		capability: 'stats.' + kind + ':1', schemaVersion: 1,
		encode(_event, data) { return kind.includes('declined') ? null : new Uint8Array([0xa5, data.marker ?? data.updates.at(-1).marker]); }
	};
	if (kind.startsWith('stateful')) value.state = { onAttach() { return {}; }, onDetach() {} };
	if (kind === 'shared') value.shared = true;
	codecs.set(kind, value);
	return value;
}
export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const reply = (event, value = {}) => platform.send(ws, 'probe', event, { ...value, nonce: msg.nonce });
	if (msg.type === 'join') {
		ws.getUserData().statsProbe = msg.id;
		const denial = await platform.subscribe(ws, msg.topic);
		reply('joined', { denial });
	} else if (msg.type === 'cast') {
		const wire = codec(msg.kind);
		// A non-member exclusion forces the JSON fallback through the same walk.
		const options = msg.exclude ? { excludeWs: { getUserData() { return {}; } } } : undefined;
		if (msg.chaos) platform.__chaos(msg.chaos);
		try {
			if (msg.batch) platform.publishWireBatch(msg.topic, 'cast', [{ data: { marker: 42 } }, { data: { marker: 43 } }], wire, options);
			else platform.publishWire(msg.topic, 'cast', { marker: 42 }, wire, options);
		} finally { if (msg.chaos) platform.__chaos(null); }
		reply('cast-done');
	} else if (msg.type === 'direct') platform.sendWire(ws, msg.topic, 'direct', { marker: 17 }, codec(msg.kind));
	else if (msg.type === 'barrier') reply('barrier');
	else if (msg.type === 'report') reply('reported', { stats: closed.get(msg.id) });
}
export function close(ws, ctx) {
	const id = ws.getUserData().statsProbe;
	if (id) closed.set(id, { messagesOut: ctx.messagesOut, bytesOut: ctx.bytesOut });
}
