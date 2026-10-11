const targets = new Map();
const closed = new Map();
const statsKey = Symbol.for('adapter-uws.ws.stats');
const filler = new Uint8Array(4096).fill(0xfe);
const codecs = new Map();
function codec(kind) {
	if (codecs.has(kind)) return codecs.get(kind);
	const wire = {
		capability: 'dropped.' + kind + ':1', schemaVersion: 1,
		encode(event) { return kind.includes('declined') || (kind === 'stateful-split' && event.endsWith('-batch')) ? null : new Uint8Array([0xa5, 42]); }
	};
	if (kind.startsWith('stateful')) wire.state = { onAttach() { return {}; }, onDetach() {} };
	codecs.set(kind, wire);
	return wire;
}
function invoke(platform, target, msg) {
	const topic = 'dropped:' + msg.id;
	const data = { value: 42 };
	if (msg.lane === 'send') return platform.send(target, topic, 'probe', data);
	if (msg.lane === 'wire') return platform.sendWire(target, topic, 'probe', data, codec(msg.kind));
	if (msg.lane === 'batch') return platform.sendWireBatch(target, topic, 'probe', [{ data }, { data }], codec(msg.kind));
	if (msg.lane === 'sendTo') return platform.sendTo((ud) => ud.droppedProbe === msg.id, topic, 'probe', data);
	if (msg.lane === 'advice') return platform.adviseReconnect({ windowMs: 100, close: false, filter: (ud) => ud.droppedProbe === msg.id });
	if (msg.lane === 'game') return platform.publishGame(null, topic, 'probe', data);
	if (msg.lane === 'request') {
		platform.request(target, 'probe', data, { timeoutMs: 1000 }).catch(() => {});
		return null;
	}
	throw new Error('unknown directed lane');
}
function fillUntil(ws, nativeSend, mode) {
	if (mode === 'healthy') return;
	for (let i = 0; i < 16384; i++) {
		const result = nativeSend.call(ws, filler, true, false);
		if (mode === 'queued' ? result === 0 : result === 2) return;
	}
	throw new Error('native socket never reached ' + mode + ' backpressure');
}
export async function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const reply = (event, value = {}) => platform.send(ws, 'observer', event, { ...value, nonce: msg.nonce });
	if (msg.type === 'join') {
		ws.getUserData().droppedProbe = msg.id;
		targets.set(msg.id, ws);
		const denial = await platform.subscribe(ws, 'dropped:' + msg.id);
		reply('joined', { denial });
	} else if (msg.type === 'warm' || msg.type === 'exercise') {
		const target = targets.get(msg.id);
		const stats = target.getUserData()[statsKey];
		const before = { messagesOut: stats.messagesOut, bytesOut: stats.bytesOut };
		const sends = [];
		const nativeSend = target.send;
		// Observe actual native outcomes; never replace a native return value.
		// Paused TCP reads and real filler frames create the backpressure.
		target.send = function(payload, binary, compress) {
			fillUntil(this, nativeSend, msg.type === 'warm' ? 'healthy' : msg.mode);
			const result = nativeSend.call(this, payload, binary, compress);
			const bytes = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
			sends.push({ result, binary: !!binary, hex: bytes.toString('hex'), length: bytes.length });
			return result;
		};
		let error = null;
		try {
			if (msg.delay && msg.type === 'exercise') platform.__chaos({ scenario: 'slow-drain', delayMs: 30 });
			try {
				if (msg.cold && msg.type === 'warm') platform.send(target, 'observer', 'warm', null);
				else invoke(platform, target, msg);
			}
			finally { if (msg.delay) platform.__chaos(null); }
			if (msg.delay && msg.type === 'exercise') await new Promise((resolve) => setTimeout(resolve, 60));
		} catch (cause) { error = String(cause); }
		finally { target.send = nativeSend; }
		reply(msg.type === 'warm' ? 'warmed' : 'exercised', { before, sends, error });
	} else if (msg.type === 'buffered') reply('buffered', { bytes: targets.get(msg.id).getBufferedAmount() });
	else if (msg.type === 'report') reply('reported', { stats: closed.get(msg.id) });
}
export function close(ws, ctx) {
	const id = ws.getUserData().droppedProbe;
	if (!id) return;
	targets.delete(id);
	closed.set(id, { messagesOut: ctx.messagesOut, bytesOut: ctx.bytesOut });
}
