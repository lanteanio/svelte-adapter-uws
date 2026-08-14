// Fixture handler for the per-topic subscribe-hook failure variant.
//
// Exports ONLY `subscribe`, deliberately: runUserSubscribeGate routes every
// subscribe through `subscribeBatch` whenever that export exists, so a build
// carrying both can never reach the per-topic hook from the wire. The failure
// modes ADAPTER-ERR-SUBSCRIBE-HOOK documents live on this path alone, and they
// are keyed by topic name so a real client can select each one with an
// ordinary subscribe frame:
//
// - `hook-throw:*` - the hook throws. The runtime must fail closed with
//   INTERNAL_ERROR, which is the fault signal the registry entry promises.
// - `hook-false:*` - the hook returns false. The runtime denies FORBIDDEN,
//   the refusal signal the entry contrasts against.
// - anything else - allow.

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export function subscribe(_ws, topic) {
	if (topic.startsWith('hook-throw:')) throw new Error('subscribe hook probe fault');
	if (topic.startsWith('hook-false:')) return false;
}

// Membership as the SERVER sees it. A denial frame alone would still be
// satisfied by a runtime that answered the client and subscribed it anyway.
export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'count') {
		platform.send(ws, 'probe', 'count', { topic: msg.topic, count: platform.subscribers(msg.topic) });
	}
}
