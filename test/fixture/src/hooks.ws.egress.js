// Publish-egress ceilings against the built runtime. The upgrade hook copies
// the client's attribution headers into userData (the server-trusted carrier)
// so the game lane's sender tenant is real; the egressTenantOf export maps a
// `t:<tenant>:` topic prefix to its tenant, the way a framework's namespace
// convention would; and the probe lanes invoke the real platform publish
// family server-side, echoing each call's result so the client-observed frame
// is the assertion surface.

export function upgrade({ headers }) {
	return {
		attrTenant: headers['x-attr-tenant'] || ''
	};
}

export function attribution(user) {
	if (!user.attrTenant) return null;
	return { tenantId: user.attrTenant };
}

/**
 * Topic namespace convention for this fixture: `t:<tenant>:<rest>` belongs to
 * `<tenant>`; anything else is unattributed. `t:broken:*` returns an id the
 * shared rule refuses, driving the fail-closed unattributed path.
 * @param {string} topic
 */
export function egressTenantOf(topic) {
	if (!topic.startsWith('t:')) return null;
	const tenant = topic.slice(2, topic.indexOf(':', 2));
	if (tenant === 'broken') return 'not a valid id';
	return tenant || null;
}

export function message(ws, { data, platform }) {
	let msg;
	try {
		msg = JSON.parse(Buffer.from(data).toString());
	} catch {
		return;
	}
	if (msg?.type === 'publish-probe' && typeof msg.topic === 'string') {
		// A server-side publish through the real platform; the result echoes
		// back so the suite asserts on what the caller of publish() sees.
		const result = platform.publish(msg.topic, 'probe-event', { nonce: msg.nonce }, { seq: false });
		platform.send(ws, 'probe', 'publish-probe-result', { nonce: msg.nonce, result });
		return;
	}
	if (msg?.type === 'forge-probe' && typeof msg.topic === 'string') {
		// The forgeries cannot cross the JSON probe boundary, so they are built
		// here and named by the client. The first two guess at the admission
		// marker's key; the rest guess nothing and answer for EVERY key, which
		// is what satisfies a property-shaped marker without naming it. A
		// prototype getter beside the Proxy because it needs no exotic object.
		const forged = msg.forge === 'string-key'
			? { EGRESS_ADMITTED: true }
			: msg.forge === 'registry-symbol'
				? { [Symbol.for('adapter-uws.egress-admitted')]: true }
				: msg.forge === 'proxy-true'
					? new Proxy({}, { get: () => true })
					: msg.forge === 'proto-getter'
						? Object.create(new Proxy({}, { get: () => true }))
						// A `get` trap is handed the key it is asked for, so
						// echoing it satisfies any test comparing the value to
						// the key. Symbols only: echoing string keys hands
						// `seq` back a string and the call is refused for that
						// instead, which looks like the ceiling working.
						: msg.forge === 'key-echo'
							? new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) })
							: msg.forge === 'key-echo-proto'
								? Object.create(new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) }))
								: undefined;
		// Both publish lanes: they read the admission marker from the caller's
		// options independently, and publishWire additionally used to read a
		// relay marker the same way, so a forgery has to be refused on each.
		const result = msg.lane === 'wire'
			? platform.publishWire(msg.topic, 'probe-event', { nonce: msg.nonce }, {
				capability: 'fixture.egress-forge:1', schemaVersion: 1, encode: () => null
			}, forged)
			: platform.publish(msg.topic, 'probe-event', { nonce: msg.nonce }, forged);
		platform.send(ws, 'probe', 'forge-probe-result', { nonce: msg.nonce, result });
		return;
	}
	if (msg?.type === 'seq-probe' && typeof msg.topic === 'string') {
		// The client names the seq and this passes it verbatim, so the suite can
		// drive one publish whose value the wire cannot carry. Both outcomes are
		// echoed: a refusal must reach the caller as a thrown TypeError whether
		// or not the ceiling would have shed this frame, and `false` is what the
		// shed answers - the two must never be confusable.
		let result = null;
		let error = null;
		try {
			result = platform.publish(msg.topic, 'probe-event', { nonce: msg.nonce }, { seq: msg.seq });
		} catch (e) {
			error = { name: e?.constructor?.name || 'Error', message: String(e?.message ?? e) };
		}
		platform.send(ws, 'probe', 'seq-probe-result', { nonce: msg.nonce, result, error });
		return;
	}
	if (msg?.type === 'sendto-probe' && typeof msg.topic === 'string') {
		const count = platform.sendTo(() => true, msg.topic, 'sendto-event', { nonce: msg.nonce });
		platform.send(ws, 'probe', 'sendto-probe-result', { nonce: msg.nonce, count });
		return;
	}
	if (msg?.type === 'game-probe' && typeof msg.topic === 'string') {
		platform.grantPublish(ws, msg.topic);
		const outcome = platform.publishGame(ws, msg.topic, 'game-event', { nonce: msg.nonce }, 1);
		platform.send(ws, 'probe', 'game-probe-result', {
			nonce: msg.nonce,
			seq: outcome.seq,
			delivered: outcome.delivered
		});
		return;
	}
}
