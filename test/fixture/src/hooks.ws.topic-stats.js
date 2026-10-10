const closed = new Map();
export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const reply = (event, value = {}) => platform.send(ws, 'probe', event, { ...value, nonce: msg.nonce });
	if (msg.type === 'join') {
		ws.getUserData().topicStatsProbe = msg.id;
		const denials = [];
		for (const topic of msg.topics) denials.push(await platform.subscribe(ws, topic));
		reply('joined', { denials });
	} else if (msg.type === 'cast') {
		if (msg.chaos) platform.__chaos(msg.chaos);
		try {
			if (msg.batch) platform.publishBatched(msg.messages);
			else for (const entry of msg.messages) platform.publish(entry.topic, entry.event, entry.data);
		} finally { if (msg.chaos) platform.__chaos(null); }
		reply('cast-done');
	} else if (msg.type === 'direct') reply('direct', { marker: 17 });
	else if (msg.type === 'barrier') reply('barrier');
	else if (msg.type === 'report') reply('reported', { stats: closed.get(msg.id) });
}
export function close(ws, ctx) {
	const id = ws.getUserData().topicStatsProbe;
	if (id) closed.set(id, { messagesOut: ctx.messagesOut, bytesOut: ctx.bytesOut });
}
