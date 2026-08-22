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
