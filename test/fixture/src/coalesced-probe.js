export function coalescedBadValue(kind) {
	if (kind === 'function') return () => {};
	if (kind === 'symbol') return Symbol('data');
	if (kind === 'bigint' || kind === undefined) return { n: 1n };
	return {
		toJSON() {
			if (kind === 'string') throw 'invalid JSON';
			if (kind === 'revoked') { const proxy = Proxy.revocable({}, {}); proxy.revoke(); throw proxy.proxy; }
			if (kind === 'prototype') throw new Proxy({}, { getPrototypeOf() { throw new Error('prototype failed'); } });
			if (kind === 'null') throw null;
			if (kind === 'undefined') throw undefined;
			if (kind === 'false') throw false;
			if (kind === 'number') throw 42;
			throw new TypeError('serialization failed');
		}
	};
}

export function coalescedNameProbe(ws, platform, msg) {
	if (msg.stall) {
		const chunk = new Uint8Array(1024 * 1024);
		for (let i = 0; i < 64 && ws.getBufferedAmount() <= 1024 * 1024; i++) ws.send(chunk, true);
	}
	platform.sendCoalesced(ws, { key: 'keep', topic: 'probe', event: 'coalesced-keep', data: 'original' });
	let threw = false;
	try {
		platform.sendCoalesced(ws, { key: 'keep', topic: 'probe', event: 'invalid', data: 'replacement', [msg.field]: msg.name });
	} catch { threw = true; }
	platform.sendCoalesced(ws, { key: 'report', topic: 'probe', event: 'coalesced-name-report', data: { threw, buffered: ws.getBufferedAmount() } });
}
