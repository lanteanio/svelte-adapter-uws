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
